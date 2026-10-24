import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { isE164 } from "@/lib/dialer/phone";
import { can } from "@/lib/dialer/permissions";
import { planLimits } from "@/lib/dialer/plans";
import { validateCampaignConfig } from "@/lib/dialer/windows";
import { audioClipUrl } from "@/lib/dialer/library";
import { asDays, asIso, assertMutable, newId, requireActor, writeAudit } from "./actor";
import { parseInput } from "./validate";

const orgSchema = z.object({ orgId: z.string().min(8).max(80) });

const campaignBody = {
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(""),
  dialMode: z.enum(["manual", "provider"]).default("manual"),
  timezone: z.string().trim().min(1).max(80),
  windowStart: z.string(),
  windowEnd: z.string(),
  callingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  maxAttempts: z.number().int().min(1).max(6).default(3),
  retryMinutes: z.number().int().min(30).max(10080).default(120),
  callerId: z.string().max(24).default(""),
  localPresence: z.boolean().default(false),
  script: z.string().max(4000).default(""),
  voicemailScript: z.string().max(500).default(""),
  smsTemplate: z.string().max(320).default(""),
  missSms: z.boolean().default(false),
};

type CampaignRow = {
  id: string;
  name: string;
  description: string;
  status: string;
  dial_mode: string;
  timezone: string;
  window_start: string;
  window_end: string;
  calling_days: unknown;
  max_attempts: number;
  retry_minutes: number;
  caller_id: string;
  local_presence: boolean;
  script: string;
  voicemail_script: string;
  sms_template: string;
  miss_sms: boolean;
  created_at: unknown;
  total_contacts: number;
  remaining: number;
};

async function providerDialErrors(orgId: string, dialMode: string, callerId: string, localPresence: boolean): Promise<string[]> {
  const errors: string[] = [];
  if (callerId && !isE164(callerId)) errors.push("Caller ID must be E.164.");
  if (dialMode !== "provider") return errors;
  const { telephonyPublicStatus } = await import("./telephony.server");
  const tel = await telephonyPublicStatus(orgId);
  if (!tel.ready) errors.push("Provider dialing stays unavailable until Twilio is connected in Settings.");
  if (localPresence) {
    if (tel.callerIds.length < 1) errors.push("Local presence needs at least one allow-listed caller ID.");
    if (callerId && !tel.callerIds.includes(callerId)) errors.push("The fallback caller ID is not on this workspace's allow list.");
  } else if (!callerId || !tel.callerIds.includes(callerId)) {
    errors.push("Caller ID is not on this workspace's allow list.");
  }
  return errors;
}

function mapCampaign(row: CampaignRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    dialMode: row.dial_mode,
    timezone: row.timezone,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    callingDays: asDays(row.calling_days),
    maxAttempts: Number(row.max_attempts),
    retryMinutes: Number(row.retry_minutes),
    callerId: row.caller_id,
    localPresence: Boolean(row.local_presence),
    script: row.script,
    voicemailScript: row.voicemail_script ?? "",
    smsTemplate: row.sms_template ?? "",
    missSms: Boolean(row.miss_sms),
    createdAt: asIso(row.created_at),
    totalContacts: Number(row.total_contacts ?? 0),
    remaining: Number(row.remaining ?? 0),
  };
}

const CAMPAIGN_SELECT = `
  select c.*,
    (select count(*)::int from campaign_contacts cc where cc.campaign_id = c.id) as total_contacts,
    (select count(*)::int from campaign_contacts cc
      join contacts ct on ct.id = cc.contact_id
      where cc.campaign_id = c.id and cc.completed = false and ct.dnc = false and ct.archived_at is null) as remaining
  from campaigns c
`;

export const listCampaigns = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ status: z.enum(["all", "draft", "active", "paused", "archived"]).default("all") }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId);
    const sql = await getSql();
    const elevated = can(actor.role, "manage_campaigns");
    const rows = await sql.query<CampaignRow>(
      `${CAMPAIGN_SELECT}
       where c.org_id = $1
         and ($2 = 'all' or c.status = $2)
         and (
           $3::boolean = true
           or exists (select 1 from campaign_agents a where a.campaign_id = c.id and a.user_id = $4)
         )
       order by c.created_at desc
       limit 100`,
      [actor.orgId, data.status, elevated, actor.userId],
    );
    return { campaigns: rows.map(mapCampaign) };
  });

export const getCampaign = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ campaignId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId);
    const sql = await getSql();
    const elevated = can(actor.role, "manage_campaigns");
    const rows = await sql.query<CampaignRow>(
      `${CAMPAIGN_SELECT}
       where c.org_id = $1 and c.id = $2
         and ($3::boolean = true or exists (select 1 from campaign_agents a where a.campaign_id = c.id and a.user_id = $4))
       limit 1`,
      [actor.orgId, data.campaignId, elevated, actor.userId],
    );
    const row = rows[0];
    if (!row) throw new Error("Campaign not found.");
    const agents = await sql<{ user_id: string; name: string; email: string }>`
      select a.user_id, u."name" as name, u."email" as email
      from campaign_agents a
      join "user" u on u."id" = a.user_id
      where a.campaign_id = ${row.id}`;
    return {
      campaign: mapCampaign(row),
      agents: agents.map((agent) => ({ userId: agent.user_id, name: agent.name, email: agent.email })),
    };
  });

export const createCampaign = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend(campaignBody), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_campaigns");
    assertMutable(actor);
    const errors = validateCampaignConfig({
      name: data.name,
      dialMode: data.dialMode,
      windowStart: data.windowStart,
      windowEnd: data.windowEnd,
      callingDays: data.callingDays,
      maxAttempts: data.maxAttempts,
      retryMinutes: data.retryMinutes,
      callerId: data.callerId,
      timezone: data.timezone,
    });
    if (data.callerId && !isE164(data.callerId)) errors.push("Caller ID must be E.164.");
    errors.push(...(await providerDialErrors(actor.orgId, data.dialMode, data.callerId, data.localPresence)));
    if (errors.length) throw new Error(errors.join(" "));
    const sql = await getSql();
    const count = await sql<{ n: number }>`
      select count(*)::int as n from campaigns where org_id = ${actor.orgId} and status <> 'archived'`;
    const limits = planLimits(actor.plan);
    if (Number(count[0]?.n ?? 0) >= limits.maxCampaigns) {
      throw new Error(`The ${actor.plan} plan is limited to ${limits.maxCampaigns} open campaigns.`);
    }
    const id = newId();
    const days = `{${[...new Set(data.callingDays)].join(",")}}`;
    await sql`
      insert into campaigns (
        id, org_id, name, description, dial_mode, timezone, window_start, window_end, calling_days,
        max_attempts, retry_minutes, caller_id, local_presence, script, voicemail_script, sms_template, miss_sms, created_by
      ) values (
        ${id}, ${actor.orgId}, ${data.name}, ${data.description}, ${data.dialMode}, ${data.timezone},
        ${data.windowStart}, ${data.windowEnd}, ${days}::smallint[], ${data.maxAttempts}, ${data.retryMinutes},
        ${data.callerId}, ${data.localPresence}, ${data.script}, ${data.voicemailScript}, ${data.smsTemplate}, ${data.missSms}, ${actor.userId}
      )`;
    await sql`insert into campaign_agents (campaign_id, user_id) values (${id}, ${actor.userId})`;
    await writeAudit(sql, actor, "campaign.create", "campaign", id, { dialMode: data.dialMode });
    return { id };
  });

export const updateCampaign = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ campaignId: z.string().min(8).max(80) }).extend(campaignBody), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_campaigns");
    assertMutable(actor);
    const errors = validateCampaignConfig({
      name: data.name,
      dialMode: data.dialMode,
      windowStart: data.windowStart,
      windowEnd: data.windowEnd,
      callingDays: data.callingDays,
      maxAttempts: data.maxAttempts,
      retryMinutes: data.retryMinutes,
      callerId: data.callerId,
      timezone: data.timezone,
    });
    if (data.callerId && !isE164(data.callerId)) errors.push("Caller ID must be E.164.");
    errors.push(...(await providerDialErrors(actor.orgId, data.dialMode, data.callerId, data.localPresence)));
    if (errors.length) throw new Error(errors.join(" "));
    const sql = await getSql();
    const days = `{${[...new Set(data.callingDays)].join(",")}}`;
    const rows = await sql<{ id: string }>`
      update campaigns
      set name = ${data.name}, description = ${data.description}, dial_mode = ${data.dialMode}, timezone = ${data.timezone},
          window_start = ${data.windowStart}, window_end = ${data.windowEnd}, calling_days = ${days}::smallint[],
          max_attempts = ${data.maxAttempts}, retry_minutes = ${data.retryMinutes}, caller_id = ${data.callerId},
          local_presence = ${data.localPresence}, script = ${data.script},
          voicemail_script = ${data.voicemailScript}, sms_template = ${data.smsTemplate}, miss_sms = ${data.missSms}, updated_at = now()
      where id = ${data.campaignId} and org_id = ${actor.orgId} and status <> 'archived'
      returning id`;
    if (!rows[0]) throw new Error("Campaign not found or it is archived.");
    await writeAudit(sql, actor, "campaign.update", "campaign", data.campaignId, {});
    return { ok: true as const };
  });

export const setCampaignStatus = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    parseInput(orgSchema.extend({ campaignId: z.string().min(8).max(80), status: z.enum(["draft", "active", "paused", "archived"]) }), input),
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_campaigns");
    assertMutable(actor);
    const sql = await getSql();
    const current = await sql<{ status: string; dial_mode: string; name: string; timezone: string; window_start: string; window_end: string; calling_days: unknown; max_attempts: number; retry_minutes: number; caller_id: string; local_presence: boolean }>`
      select status, dial_mode, name, timezone, window_start, window_end, calling_days, max_attempts, retry_minutes, caller_id, local_presence
      from campaigns where id = ${data.campaignId} and org_id = ${actor.orgId} limit 1`;
    const row = current[0];
    if (!row) throw new Error("Campaign not found.");
    const from = row.status;
    const to = data.status;
    const allowed =
      (from === "draft" && (to === "active" || to === "archived")) ||
      (from === "active" && (to === "paused" || to === "archived")) ||
      (from === "paused" && (to === "active" || to === "archived")) ||
      (from === "archived" && to === "draft");
    if (!allowed) throw new Error(`Cannot move a campaign from ${from} to ${to}.`);
    if (to === "active") {
      const errors = validateCampaignConfig({
        name: row.name,
        dialMode: row.dial_mode === "provider" ? "provider" : "manual",
        timezone: row.timezone,
        windowStart: row.window_start,
        windowEnd: row.window_end,
        callingDays: asDays(row.calling_days),
        maxAttempts: Number(row.max_attempts),
        retryMinutes: Number(row.retry_minutes),
        callerId: row.caller_id,
      });
      const ready = await sql<{ n: number }>`
        select count(*)::int as n
        from campaign_contacts cc
        join contacts ct on ct.id = cc.contact_id
        where cc.campaign_id = ${data.campaignId} and cc.completed = false and ct.dnc = false and ct.archived_at is null`;
      if (Number(ready[0]?.n ?? 0) < 1) errors.push("Add at least one callable contact before starting.");
      if (row.dial_mode === "provider") {
        const { telephonyPublicStatus } = await import("./telephony.server");
        const tel = await telephonyPublicStatus(actor.orgId);
        if (!tel.ready) errors.push("Provider mode cannot start until Twilio is configured.");
        if (row.local_presence) {
          if (tel.callerIds.length < 1) errors.push("Local presence needs at least one allow-listed caller ID.");
          if (row.caller_id && !tel.callerIds.includes(row.caller_id)) errors.push("The fallback caller ID is not authorized.");
        } else if (!tel.callerIds.includes(row.caller_id)) errors.push("Campaign caller ID is not authorized on the server.");
      }
      if (errors.length) throw new Error(errors.join(" "));
    }
    await sql`update campaigns set status = ${to}, updated_at = now() where id = ${data.campaignId} and org_id = ${actor.orgId}`;
    await writeAudit(sql, actor, "campaign.status", "campaign", data.campaignId, { from, to });
    return { ok: true as const };
  });

export const addCampaignContacts = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    parseInput(orgSchema.extend({ campaignId: z.string().min(8).max(80), contactIds: z.array(z.string().min(8).max(80)).min(1).max(500) }), input),
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_campaigns");
    assertMutable(actor);
    const sql = await getSql();
    let added = 0;
    for (const contactId of data.contactIds) {
      const rows = await sql<{ ok: number }>`
        insert into campaign_contacts (campaign_id, contact_id)
        select ${data.campaignId}, c.id
        from contacts c
        join campaigns g on g.id = ${data.campaignId} and g.org_id = c.org_id
        where c.id = ${contactId} and c.org_id = ${actor.orgId} and c.archived_at is null and g.status <> 'archived'
        on conflict do nothing
        returning 1 as ok`;
      if (rows[0]) added += 1;
    }
    await writeAudit(sql, actor, "campaign.contacts_add", "campaign", data.campaignId, { added });
    return { added };
  });

export const setCampaignAgents = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    parseInput(orgSchema.extend({ campaignId: z.string().min(8).max(80), userIds: z.array(z.string().min(1).max(80)).max(100) }), input),
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_campaigns");
    assertMutable(actor);
    const sql = await getSql();
    const campaign = await sql<{ id: string }>`
      select id from campaigns where id = ${data.campaignId} and org_id = ${actor.orgId} limit 1`;
    if (!campaign[0]) throw new Error("Campaign not found.");
    const unique = [...new Set(data.userIds)];
    let found = 0;
    for (const userId of unique) {
      const member = await sql<{ ok: number }>`
        select 1 as ok from memberships
        where org_id = ${actor.orgId} and status = 'active' and user_id = ${userId} limit 1`;
      if (member[0]) found += 1;
    }
    if (found !== unique.length) throw new Error("Every assignee must be an active member of this workspace.");
    await sql`delete from campaign_agents where campaign_id = ${data.campaignId}`;
    for (const userId of unique) {
      await sql`insert into campaign_agents (campaign_id, user_id) values (${data.campaignId}, ${userId})`;
      if (userId !== actor.userId) {
        await sql`
          insert into notifications (id, org_id, user_id, title, body)
          values (${newId()}, ${actor.orgId}, ${userId}, 'Campaign assignment', 'You were added to a campaign.')`;
      }
    }
    await writeAudit(sql, actor, "campaign.agents", "campaign", data.campaignId, { agents: unique.length });
    return { ok: true as const };
  });

export const listVoicemailClips = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "dial");
    const sql = await getSql();
    const rows = await sql<{ id: string; name: string; audio_url: string; script: string }>`
      select id, name, audio_url, script from voicemail_clips
      where org_id = ${actor.orgId}
      order by created_at desc
      limit 20`;
    return { clips: rows.map((row) => ({ id: row.id, name: row.name, audioUrl: row.audio_url, script: row.script })) };
  });

export const saveVoicemailClip = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    parseInput(orgSchema.extend({ name: z.string().trim().min(1).max(60), audioUrl: z.string().max(400).default(""), script: z.string().max(500).default("") }), input),
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_campaigns");
    assertMutable(actor);
    const audioUrl = audioClipUrl(data.audioUrl) ?? "";
    if (data.audioUrl.trim() && !audioUrl) throw new Error("The audio address must be an https URL.");
    if (!audioUrl && data.script.trim().length < 8) throw new Error("Add an https audio address or a script of a few words.");
    const sql = await getSql();
    const count = await sql<{ n: number }>`select count(*)::int as n from voicemail_clips where org_id = ${actor.orgId}`;
    if (Number(count[0]?.n ?? 0) >= 20) throw new Error("Twenty clips is the library limit. Delete one first.");
    const id = newId();
    await sql`
      insert into voicemail_clips (id, org_id, name, audio_url, script)
      values (${id}, ${actor.orgId}, ${data.name}, ${audioUrl}, ${data.script.trim()})`;
    return { id };
  });

export const listCallerIdHealth = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "dial");
    const sql = await getSql();
    const rows = await sql<{ from_number: string; dials: number }>`
      select from_number, count(*)::int as dials
      from calls
      where org_id = ${actor.orgId} and from_number <> '' and started_at > now() - interval '1 day'
      group by from_number
      order by dials desc
      limit 12`;
    const { callerIdLoad } = await import("@/lib/dialer/library");
    const { formatPhone } = await import("@/lib/dialer/phone");
    return {
      lines: rows.map((row) => {
        const load = callerIdLoad(Number(row.dials));
        return { number: formatPhone(row.from_number), dials: Number(row.dials), label: load.label, tone: load.tone };
      }),
    };
  });

