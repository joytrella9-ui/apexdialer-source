import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { followUpText } from "@/lib/dialer/library";
import { fillSmsTemplate } from "@/lib/dialer/sms";
import { canApplyProviderState, correctedQueueFlags, isDisposition, isOpenState, nextQueueState } from "@/lib/dialer/dispositions";
import { formatPhone, isE164, normalizePhone } from "@/lib/dialer/phone";
import { can } from "@/lib/dialer/permissions";
import { isWithinCallingWindow } from "@/lib/dialer/windows";
import { buildBrief, rankLead } from "@/lib/dialer/assist";
import { spokenPressOne } from "@/server/assist";
import { chooseCallerId } from "@/lib/dialer/caller-id";
import { planLimits } from "@/lib/dialer/plans";
import { asDays, asIso, asTags, assertMutable, countActiveContacts, isUniqueViolation, newId, requireActor, writeAudit, type Actor } from "./actor";
import { parseInput } from "./validate";

const orgSchema = z.object({ orgId: z.string().min(8).max(80) });

type CallRow = {
  id: string;
  campaign_id: string | null;
  contact_id: string | null;
  agent_user_id: string;
  channel: string;
  state: string;
  disposition: string;
  notes: string;
  from_number: string;
  to_number: string;
  provider_call_sid: string | null;
  provider_verified: boolean;
  failure_reason: string;
  started_at: unknown;
  answered_at: unknown;
  ended_at: unknown;
  duration_seconds: number | null;
  contact_name: string | null;
  has_recording?: boolean;
};

function mapCall(row: CallRow) {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    contactId: row.contact_id,
    agentUserId: row.agent_user_id,
    channel: row.channel,
    state: row.state,
    disposition: row.disposition,
    notes: row.notes,
    fromNumber: row.from_number,
    toNumber: row.to_number,
    toDisplay: formatPhone(row.to_number),
    providerCallSid: row.provider_call_sid ? "set" : "",
    providerVerified: Boolean(row.provider_verified),
    failureReason: row.failure_reason,
    startedAt: asIso(row.started_at),
    answeredAt: asIso(row.answered_at),
    endedAt: asIso(row.ended_at),
    durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    contactName: row.contact_name ?? "",
    hasRecording: Boolean(row.has_recording),
  };
}

const CALL_SELECT = `
  select k.id, k.campaign_id, k.contact_id, k.agent_user_id, k.channel, k.state, k.disposition, k.notes,
         k.from_number, k.to_number, k.provider_call_sid, k.provider_verified, k.failure_reason,
         k.started_at, k.answered_at, k.ended_at, k.duration_seconds,
         (k.recording_url is not null and length(trim(k.recording_url)) > 0) as has_recording,
         nullif(trim(concat(ct.first_name, ' ', ct.last_name)), '') as contact_name
  from calls k
  left join contacts ct on ct.id = k.contact_id
`;

async function mayTranscribe(sql: Awaited<ReturnType<typeof getSql>>, orgId: string, contactId: string): Promise<boolean> {
  const rows = await sql<{ ok: boolean }>`
    select (o.recording_policy = 'provider_if_consented' and ct.recording_consent) as ok
    from organizations o
    join contacts ct on ct.id = ${contactId}
    where o.id = ${orgId}
    limit 1`;
  return Boolean(rows[0]?.ok);
}

async function assertDialRate(orgId: string, userId: string) {
  if (typeof process !== "undefined" && process.env.APEX_DIALING_DISABLED === "true") {
    throw new Error("Dialing is stopped for this deployment.");
  }
  const sql = await getSql();
  const rows = await sql<{ n: number }>`
    select count(*)::int as n from calls
    where org_id = ${orgId} and agent_user_id = ${userId} and created_at > now() - interval '1 minute'`;
  if (Number(rows[0]?.n ?? 0) >= 24) throw new Error("Too many dial attempts. Wait a minute and try again.");
  const rawCap = Number(typeof process !== "undefined" ? process.env.APEX_DAILY_DIAL_CAP : "");
  const cap = Number.isFinite(rawCap) && rawCap > 0 ? Math.min(Math.floor(rawCap), 10000) : 500;
  const day = await sql<{ n: number }>`
    select count(*)::int as n from calls
    where org_id = ${orgId} and created_at > now() - interval '1 day'`;
  if (Number(day[0]?.n ?? 0) >= cap) {
    throw new Error(`This workspace reached the daily dial cap of ${cap}. It is a safety limit, not a phone bill.`);
  }
}

async function loadOpenCall(orgId: string, userId: string) {
  const sql = await getSql();
  const rows = await sql.query<CallRow>(
    `${CALL_SELECT}
     where k.org_id = $1 and k.agent_user_id = $2
       and (
         k.state in ('manual_open', 'requested', 'ringing', 'in_progress')
         or (k.disposition = '' and k.state in ('completed', 'failed') and k.ended_at > now() - interval '4 hours')
       )
     order by case when k.state = 'in_progress' then 0 when k.state in ('ringing', 'requested', 'manual_open') then 1 else 2 end, k.started_at desc
     limit 1`,
    [orgId, userId],
  );
  return rows[0] ? mapCall(rows[0]) : null;
}

export const getOpenCall = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "dial");
    const sql = await getSql();
    const open = await sql<{ id: string; provider_call_sid: string | null; state: string; disposition: string }>`
      select id, provider_call_sid, state, disposition
      from calls
      where org_id = ${actor.orgId} and agent_user_id = ${actor.userId}
        and state in ('requested', 'ringing', 'in_progress')
        and provider_call_sid is not null
      order by case when state = 'in_progress' then 0 else 1 end, started_at desc
      limit 1`;
    const live = open[0];
    if (live?.provider_call_sid && !live.disposition) {
      const { readTwilioBridge } = await import("./telephony.server");
      const bridge = await readTwilioBridge(actor.orgId, live.provider_call_sid).catch(() => null);
      if (bridge && canApplyProviderState(live.state, bridge.state)) {
        await sql`
          update calls
          set state = ${bridge.state},
              provider_status = ${bridge.state},
              provider_verified = true,
              answered_at = case when ${bridge.state} in ('in_progress', 'completed') then coalesce(answered_at, now()) else answered_at end,
              ended_at = case when ${bridge.close} then coalesce(ended_at, now()) else ended_at end,
              duration_seconds = coalesce(${bridge.duration}, duration_seconds),
              failure_reason = case when ${bridge.failure} = '' then failure_reason else ${bridge.failure} end
          where id = ${live.id} and org_id = ${actor.orgId} and disposition = ''`;
      }
    }
    const ringingRows = await sql<{ n: number }>`
      select count(*)::int as n from calls
      where org_id = ${actor.orgId} and agent_user_id = ${actor.userId}
        and state in ('requested', 'ringing')`;
    return { call: await loadOpenCall(actor.orgId, actor.userId), ringing: Number(ringingRows[0]?.n ?? 0) };
  });

export const nextLead = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ campaignId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "dial");
    const sql = await getSql();
    const elevated = can(actor.role, "manage_campaigns");
    const rows = await sql<{
      id: string;
      first_name: string;
      last_name: string;
      phone_e164: string;
      company: string;
      timezone: string;
      notes: string;
      dnc: boolean;
      sms_consent: boolean;
      attempts: number;
      last_disposition: string;
      tags: unknown;
      callback_due: boolean;
      script: string;
      dial_mode: string;
      timezone_campaign: string;
      window_start: string;
      window_end: string;
      calling_days: unknown;
      status: string;
    }>`
      select ct.id, ct.first_name, ct.last_name, ct.phone_e164, ct.company, ct.timezone, ct.notes, ct.dnc, ct.sms_consent, ct.tags,
             cc.attempts, cc.last_disposition, g.script, g.dial_mode, g.timezone as timezone_campaign, g.window_start, g.window_end,
             g.calling_days, g.status,
             exists (
               select 1 from follow_ups f
               where f.org_id = ${actor.orgId} and f.contact_id = ct.id and f.done_at is null and f.due_at <= now()
                 and (${elevated} = true or f.assigned_user_id = ${actor.userId})
             ) as callback_due
      from campaign_contacts cc
      join contacts ct on ct.id = cc.contact_id
      join campaigns g on g.id = cc.campaign_id
      where g.id = ${data.campaignId}
        and g.org_id = ${actor.orgId}
        and g.status = 'active'
        and ct.archived_at is null
        and ct.dnc = false
        and cc.completed = false
        and cc.attempts < g.max_attempts
        and (cc.next_attempt_at is null or cc.next_attempt_at <= now())
        and (
          ${elevated} = true
          or exists (select 1 from campaign_agents a where a.campaign_id = g.id and a.user_id = ${actor.userId})
        )
        and not exists (
          select 1 from calls k
          where k.org_id = ${actor.orgId} and k.contact_id = ct.id
            and k.state in ('manual_open', 'requested', 'ringing', 'in_progress')
        )
      order by cc.attempts asc, cc.next_attempt_at asc nulls first, ct.created_at asc
      limit 40`;
    if (!rows[0]) return { lead: null as null };
    const ranked = rows
      .map((row) => {
        const zone = row.timezone || row.timezone_campaign;
        const window = isWithinCallingWindow({
          now: new Date(),
          timeZone: zone,
          start: row.window_start,
          end: row.window_end,
          days: asDays(row.calling_days),
        });
        const rank = rankLead({
          attempts: Number(row.attempts),
          lastDisposition: row.last_disposition,
          callbackDue: Boolean(row.callback_due),
          callable: window.ok,
        });
        return { row, zone, window, rank };
      })
      .sort((a, b) => b.rank.score - a.rank.score || Number(a.row.attempts) - Number(b.row.attempts));
    const best = ranked[0];
    if (!best) return { lead: null as null };
    const row = best.row;
    const history = await sql<{ disposition: string }>`
      select disposition from calls
      where org_id = ${actor.orgId} and contact_id = ${row.id} and disposition <> ''
      order by started_at desc
      limit 5`;
    const brief = buildBrief({
      firstName: row.first_name,
      company: row.company,
      timezone: best.zone,
      notes: row.notes,
      tags: asTags(row.tags),
      attempts: Number(row.attempts),
      lastDisposition: row.last_disposition,
      history: history.map((item) => item.disposition),
      script: row.script,
    });
    const { maybePolishOpener } = await import("./assist");
    const polished = await maybePolishOpener(
      actor.orgId,
      brief,
      JSON.stringify({
        name: row.first_name,
        company: row.company,
        timezone: best.zone,
        notes: row.notes.slice(0, 400),
        lastDisposition: row.last_disposition,
        attempts: Number(row.attempts),
        script: row.script.slice(0, 400),
        opener: brief.opener,
      }),
    );
    return {
      lead: {
        contactId: row.id,
        name: `${row.first_name} ${row.last_name}`.trim(),
        firstName: row.first_name,
        phoneE164: row.phone_e164,
        phoneDisplay: formatPhone(row.phone_e164),
        company: row.company,
        timezone: best.zone,
        notes: row.notes,
        smsConsent: Boolean(row.sms_consent),
        attempts: Number(row.attempts),
        script: row.script,
        dialMode: row.dial_mode,
        callable: best.window.ok,
        windowReason: best.window.ok ? "" : best.window.reason,
        rankReason: best.rank.reason,
        brief: polished,
      },
    };
  });

const startSchema = orgSchema.extend({
  contactId: z.string().min(8).max(80),
  campaignId: z.string().min(8).max(80).nullable(),
  idempotencyKey: z.string().uuid(),
  burstId: z.string().max(80).default(""),
  amd: z.boolean().default(false),
});

async function prepareDial(userId: string, data: { orgId: string; contactId: string; campaignId: string | null; burstId?: string }, channel: "manual_device" | "twilio") {
  const actor = await requireActor(userId, data.orgId, "dial");
  assertMutable(actor);
  await assertDialRate(actor.orgId, actor.userId);
  const sql = await getSql();
  const openRows = await sql<{ id: string; state: string; disposition: string; burst_id: string }>`
    select id, state, disposition, burst_id from calls
    where org_id = ${actor.orgId} and agent_user_id = ${actor.userId}
      and (
        state in ('manual_open', 'requested', 'ringing', 'in_progress')
        or (disposition = '' and state in ('completed', 'failed') and ended_at > now() - interval '4 hours')
      )`;
  const live = openRows.filter((row) => isOpenState(row.state));
  const burst = data.burstId?.trim() ?? "";
  const sameBurst = burst !== "" && live.length > 0 && live.every((row) => row.burst_id === burst && row.state !== "in_progress" && row.state !== "manual_open");
  if (live.length > 0 && !sameBurst) throw new Error("Finish or cancel the open call before dialing again.");
  if (live.length >= 10) throw new Error("Ten lines are already ringing. Predictive dialing stops there.");
  if (openRows.some((row) => !isOpenState(row.state) && !row.disposition)) throw new Error("Set a disposition on the current call before starting another.");
  const contacts = await sql<{
    id: string;
    phone_e164: string;
    dnc: boolean;
    timezone: string;
    first_name: string;
    archived_at: unknown;
  }>`
    select id, phone_e164, dnc, timezone, first_name, archived_at
    from contacts where id = ${data.contactId} and org_id = ${actor.orgId} limit 1`;
  const contact = contacts[0];
  if (!contact || contact.archived_at) throw new Error("Contact not found.");
  if (contact.dnc) throw new Error("This contact is on the do-not-call list.");
  let campaign: {
    id: string;
    status: string;
    dial_mode: string;
    timezone: string;
    window_start: string;
    window_end: string;
    calling_days: unknown;
    caller_id: string;
    local_presence: boolean;
    max_attempts: number;
  } | null = null;
  if (data.campaignId) {
    const elevated = can(actor.role, "manage_campaigns");
    const rows = await sql<{
      id: string;
      status: string;
      dial_mode: string;
      timezone: string;
      window_start: string;
      window_end: string;
      calling_days: unknown;
      caller_id: string;
      local_presence: boolean;
      max_attempts: number;
      attempts: number;
      completed: boolean;
      next_attempt_at: unknown;
      assigned: boolean;
    }>`
      select g.id, g.status, g.dial_mode, g.timezone, g.window_start, g.window_end, g.calling_days, g.caller_id, g.local_presence,
             g.max_attempts, cc.attempts, cc.completed, cc.next_attempt_at,
             exists (select 1 from campaign_agents a where a.campaign_id = g.id and a.user_id = ${actor.userId}) as assigned
      from campaigns g
      join campaign_contacts cc on cc.campaign_id = g.id and cc.contact_id = ${contact.id}
      where g.id = ${data.campaignId} and g.org_id = ${actor.orgId}
      limit 1`;
    const row = rows[0];
    if (!row) throw new Error("That contact is not on this campaign.");
    if (!elevated && !row.assigned) throw new Error("You are not assigned to this campaign.");
    if (row.status !== "active") throw new Error("The campaign is not active.");
    if (row.completed) throw new Error("This contact is already finished on the campaign.");
    if (Number(row.attempts) >= Number(row.max_attempts)) throw new Error("This contact has reached the attempt limit.");
    if (row.next_attempt_at && new Date(String(row.next_attempt_at)).getTime() > Date.now()) {
      throw new Error("This contact is not due for another attempt yet.");
    }
    campaign = row;
  }
  const zone = contact.timezone || campaign?.timezone || actor.timezone;
  const window = isWithinCallingWindow({
    now: new Date(),
    timeZone: zone,
    start: campaign?.window_start ?? actor.windowStart,
    end: campaign?.window_end ?? actor.windowEnd,
    days: campaign ? asDays(campaign.calling_days) : actor.callingDays,
  });
  const testingOwnLine = Boolean(actor.callbackPhone) && contact.phone_e164 === actor.callbackPhone;
  if (!window.ok && !testingOwnLine) throw new Error(`${window.reason} You can still call your own callback number to test the line.`);
  return { actor, sql, contact, campaign, zone };
}

async function ensureCallableContact(actor: Awaited<ReturnType<typeof requireActor>>, phoneRaw: string): Promise<string> {
  const phone = normalizePhone(phoneRaw);
  if (!phone) throw new Error("Enter a real phone number, like 3125550100.");
  const sql = await getSql();
  const existing = await sql<{ id: string; dnc: boolean }>`
    select id, dnc from contacts where org_id = ${actor.orgId} and phone_e164 = ${phone} and archived_at is null limit 1`;
  if (existing[0]?.dnc) throw new Error("This number is on the do-not-call list.");
  if (existing[0]) return existing[0].id;
  if ((await countActiveContacts(sql, actor.orgId)) >= planLimits(actor.plan).maxContacts) {
    throw new Error("This workspace is at its contact limit. Add the number from Lists after you archive one.");
  }
  const id = newId();
  try {
    await sql`
      insert into contacts (
        id, org_id, first_name, last_name, phone_e164, email, company, timezone, status, notes, tags, created_by
      ) values (
        ${id}, ${actor.orgId}, 'Keypad', '', ${phone}, '', '', ${actor.timezone}, 'new', 'Added from the softphone keypad.', '{}'::text[], ${actor.userId}
      )`;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const again = await sql<{ id: string; dnc: boolean }>`
      select id, dnc from contacts where org_id = ${actor.orgId} and phone_e164 = ${phone} and archived_at is null limit 1`;
    if (again[0]?.dnc) throw new Error("This number is on the do-not-call list.");
    if (again[0]) return again[0].id;
    throw error;
  }
  await writeAudit(sql, actor, "contact.create", "contact", id, { source: "keypad" });
  return id;
}

const keypadSchema = orgSchema.extend({
  phone: z.string().trim().min(3).max(32),
  campaignId: z.string().min(8).max(80).nullable().default(null),
});

export const ensureDialContact = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(keypadSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "dial");
    assertMutable(actor);
    const contactId = await ensureCallableContact(actor, data.phone);
    return { contactId };
  });

export const startPressOneCall = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(startSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { actor, sql, contact, campaign } = await prepareDial(context.userId, data, "twilio");
    const { loadTelephony, placePressOneCall } = await import("./telephony.server");
    const tel = await loadTelephony(actor.orgId);
    if (!tel.credentialsPresent) throw new Error("Twilio is not configured. No live call was placed.");
    if (!tel.publicUrlPresent) throw new Error("Save the published https address in Settings. Press 1 has to reach this app after they answer.");
    if (!actor.callbackPhone && !tel.softphoneReady) throw new Error("Add your callback number in Settings, or create the browser phone, so the answered call has somewhere to go.");
    const callerId = campaign?.local_presence ? chooseCallerId(contact.phone_e164, tel.callerIds, campaign.caller_id || tel.from) : campaign?.caller_id || tel.from;
    if (!tel.callerIds.includes(callerId)) throw new Error("The caller ID is not on the allow list. No live call was placed.");
    const scriptRows = campaign
      ? await sql<{ script: string }>`select script from campaigns where id = ${campaign.id} limit 1`
      : [];
    const spoken = await spokenPressOne(actor.orgId, actor.orgName, scriptRows[0]?.script ?? "");
    const id = newId();
    const inserted = await sql<{ id: string }>`
      insert into calls (
        id, org_id, campaign_id, contact_id, agent_user_id, channel, state, from_number, to_number, idempotency_key
      ) values (
        ${id}, ${actor.orgId}, ${data.campaignId}, ${contact.id}, ${actor.userId}, 'twilio', 'requested',
        ${callerId}, ${contact.phone_e164}, ${data.idempotencyKey}
      )
      on conflict (org_id, idempotency_key) do nothing
      returning id`;
    if (!inserted[0]) throw new Error("That dial request was already used.");
    try {
      const placed = await placePressOneCall({ orgId: actor.orgId, callId: id, callerId, contactTo: contact.phone_e164, say: spoken });
      await sql`update calls set provider_call_sid = ${placed.sid}, provider_status = 'requested' where id = ${id}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Twilio did not start the press-1 call.";
      await sql`
        update calls set state = 'failed', disposition = 'failed', failure_reason = ${message.slice(0, 240)}, ended_at = now()
        where id = ${id}`;
      throw new Error(message);
    }
    await sql`
      insert into agent_presence (org_id, user_id, status, updated_at)
      values (${actor.orgId}, ${actor.userId}, 'on_call', now())
      on conflict (org_id, user_id) do update set status = 'on_call', updated_at = now()`;
    const loaded = await sql.query<CallRow>(`${CALL_SELECT} where k.id = $1 limit 1`, [id]);
    return { call: mapCall(loaded[0]!), spoken };
  });

export const startManualCall = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(startSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { actor, sql, contact, campaign } = await prepareDial(context.userId, data, "manual_device");
    const id = newId();
    const inserted = await sql<{ id: string }>`
      insert into calls (
        id, org_id, campaign_id, contact_id, agent_user_id, channel, state, to_number, idempotency_key
      ) values (
        ${id}, ${actor.orgId}, ${data.campaignId}, ${contact.id}, ${actor.userId}, 'manual_device', 'manual_open',
        ${contact.phone_e164}, ${data.idempotencyKey}
      )
      on conflict (org_id, idempotency_key) do nothing
      returning id`;
    const callId = inserted[0]?.id ?? id;
    if (!inserted[0]) {
      const existing = await sql.query<CallRow>(`${CALL_SELECT} where k.org_id = $1 and k.idempotency_key = $2 limit 1`, [
        actor.orgId,
        data.idempotencyKey,
      ]);
      const row = existing[0];
      if (!row || row.contact_id !== contact.id) throw new Error("That dial request was already used.");
      return { call: mapCall(row), tel: `tel:${row.to_number}` };
    }
    await sql`
      insert into agent_presence (org_id, user_id, status, updated_at)
      values (${actor.orgId}, ${actor.userId}, 'on_call', now())
      on conflict (org_id, user_id) do update set status = 'on_call', updated_at = now()`;
    await sql`update contacts set status = case when status = 'new' then 'working' else status end, updated_at = now() where id = ${contact.id}`;
    const loaded = await sql.query<CallRow>(`${CALL_SELECT} where k.id = $1 limit 1`, [callId]);
    return { call: mapCall(loaded[0]!), tel: `tel:${contact.phone_e164}`, campaignId: campaign?.id ?? null };
  });

export const startProviderCall = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(startSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { actor, sql, contact, campaign } = await prepareDial(context.userId, data, "twilio");
    if (!actor.callbackPhone || !isE164(actor.callbackPhone)) {
      throw new Error("Add your callback phone in Settings. Twilio calls you first, then bridges the contact.");
    }
    const { loadTelephony, placeAmdCall, placeTwilioAgentBridge } = await import("./telephony.server");
    const tel = await loadTelephony(actor.orgId);
    if (!tel.credentialsPresent) throw new Error("Twilio is not configured. No live call was placed.");
    const callerId = campaign?.local_presence ? chooseCallerId(contact.phone_e164, tel.callerIds, campaign.caller_id || tel.from) : campaign?.caller_id || tel.from;
    if (!tel.callerIds.includes(callerId)) throw new Error("The campaign caller ID is not authorized. No live call was placed.");
    const id = newId();
    const inserted = await sql<{ id: string }>`
      insert into calls (
        id, org_id, campaign_id, contact_id, agent_user_id, channel, state, from_number, to_number, idempotency_key, burst_id
      ) values (
        ${id}, ${actor.orgId}, ${data.campaignId}, ${contact.id}, ${actor.userId}, 'twilio', 'requested',
        ${callerId}, ${contact.phone_e164}, ${data.idempotencyKey}, ${data.burstId}
      )
      on conflict (org_id, idempotency_key) do nothing
      returning id`;
    if (!inserted[0]) {
      const existing = await sql.query<CallRow>(`${CALL_SELECT} where k.org_id = $1 and k.idempotency_key = $2 limit 1`, [
        actor.orgId,
        data.idempotencyKey,
      ]);
      const row = existing[0];
      if (!row || row.contact_id !== contact.id) throw new Error("That dial request was already used.");
      return { call: mapCall(row) };
    }
    try {
      const placed = data.amd
        ? await placeAmdCall({ orgId: actor.orgId, callId: id, callerId, contactTo: contact.phone_e164 })
        : await placeTwilioAgentBridge({
            orgId: actor.orgId,
            callId: id,
            agentPhone: actor.callbackPhone,
            callerId,
            contactTo: contact.phone_e164,
            transcribe: await mayTranscribe(sql, actor.orgId, contact.id),
          });
      await sql`
        update calls set provider_call_sid = ${placed.sid}, provider_status = ${data.amd ? "amd-detect" : "requested"}
        where id = ${id} and org_id = ${actor.orgId}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Twilio request failed.";
      await sql`
        update calls
        set state = 'failed', disposition = 'failed', failure_reason = ${message.slice(0, 240)}, ended_at = now()
        where id = ${id} and org_id = ${actor.orgId}`;
      throw new Error(message);
    }
    await sql`
      insert into agent_presence (org_id, user_id, status, updated_at)
      values (${actor.orgId}, ${actor.userId}, 'on_call', now())
      on conflict (org_id, user_id) do update set status = 'on_call', updated_at = now()`;
    const loaded = await sql.query<CallRow>(`${CALL_SELECT} where k.id = $1 limit 1`, [id]);
    return { call: mapCall(loaded[0]!) };
  });

export const startBrowserCall = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(startSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const { actor, sql, contact, campaign } = await prepareDial(context.userId, data, "twilio");
    const { loadTelephony, placeAmdCall, placeBrowserCall } = await import("./telephony.server");
    const { clientIdentity } = await import("@/lib/dialer/voice-token");
    const tel = await loadTelephony(actor.orgId);
    if (!tel.softphoneReady) throw new Error("The browser phone is not set up. In Settings, save an API key or press Create the browser phone.");
    const identity = clientIdentity(actor.userId);
    if (!identity) throw new Error("This account id cannot register a browser phone.");
    const callerId = campaign?.local_presence ? chooseCallerId(contact.phone_e164, tel.callerIds, campaign.caller_id || tel.from) : campaign?.caller_id || tel.from;
    if (!tel.callerIds.includes(callerId)) throw new Error("The caller ID is not on the allow list. No live call was placed.");
    const id = newId();
    const inserted = await sql<{ id: string }>`
      insert into calls (
        id, org_id, campaign_id, contact_id, agent_user_id, channel, state, from_number, to_number, idempotency_key, burst_id
      ) values (
        ${id}, ${actor.orgId}, ${data.campaignId}, ${contact.id}, ${actor.userId}, 'twilio', 'ringing',
        ${callerId}, ${contact.phone_e164}, ${data.idempotencyKey}, ${data.burstId}
      )
      on conflict (org_id, idempotency_key) do nothing
      returning id`;
    const callId = inserted[0]?.id ?? id;
    if (!inserted[0]) {
      const existing = await sql.query<CallRow>(`${CALL_SELECT} where k.org_id = $1 and k.idempotency_key = $2 limit 1`, [
        actor.orgId,
        data.idempotencyKey,
      ]);
      const row = existing[0];
      if (!row || row.contact_id !== contact.id) throw new Error("That dial request was already used.");
      return { call: mapCall(row) };
    }
    await sql`
      insert into agent_presence (org_id, user_id, status, updated_at, softphone_until)
      values (${actor.orgId}, ${actor.userId}, 'on_call', now(), now() + interval '45 seconds')
      on conflict (org_id, user_id) do update set status = 'on_call', updated_at = now(), softphone_until = now() + interval '45 seconds'`;
    await sql`update contacts set status = case when status = 'new' then 'working' else status end, updated_at = now() where id = ${contact.id}`;
    try {
      const placed = data.amd
        ? await placeAmdCall({ orgId: actor.orgId, callId, callerId, contactTo: contact.phone_e164 })
        : await placeBrowserCall({
            orgId: actor.orgId,
            identity,
            callerId,
            contactTo: contact.phone_e164,
            transcribe: await mayTranscribe(sql, actor.orgId, contact.id),
          });
      await sql`
        update calls set provider_call_sid = ${placed.sid}, provider_status = ${data.amd ? "amd-detect" : "ringing"}, provider_verified = true
        where id = ${callId} and org_id = ${actor.orgId}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Twilio did not call the browser.";
      await sql`
        update calls
        set state = 'failed', disposition = 'failed', failure_reason = ${message.slice(0, 240)}, ended_at = now()
        where id = ${callId} and org_id = ${actor.orgId}`;
      await sql`
        update agent_presence set status = 'available', updated_at = now()
        where org_id = ${actor.orgId} and user_id = ${actor.userId}`;
      throw new Error(message);
    }
    const loaded = await sql.query<CallRow>(`${CALL_SELECT} where k.id = $1 limit 1`, [callId]);
    return { call: mapCall(loaded[0]!) };
  });

export const voiceToken = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "dial");
    const { mintVoiceToken } = await import("./telephony.server");
    const token = await mintVoiceToken(actor.orgId, actor.userId);
    return { token };
  });

export const pulseSoftphone = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "dial");
    const sql = await getSql();
    await sql`
      insert into agent_presence (org_id, user_id, status, updated_at, softphone_until)
      values (${actor.orgId}, ${actor.userId}, 'available', now(), now() + interval '45 seconds')
      on conflict (org_id, user_id) do update
      set updated_at = now(),
          softphone_until = now() + interval '45 seconds',
          status = case when agent_presence.status = 'offline' then 'available' else agent_presence.status end`;
    return { ok: true as const };
  });

export const markConnected = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ callId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "dial");
    const sql = await getSql();
    const rows = await sql<{ id: string }>`
      update calls
      set state = 'in_progress', answered_at = coalesce(answered_at, now())
      where id = ${data.callId} and org_id = ${actor.orgId} and agent_user_id = ${actor.userId}
        and channel = 'manual_device' and state = 'manual_open'
      returning id`;
    if (!rows[0]) throw new Error("Only an open device-dial session can be marked connected. This does not verify a carrier connection.");
    return { ok: true as const };
  });

export const submitDisposition = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    parseInput(
      orgSchema.extend({
        callId: z.string().min(8).max(80),
        disposition: z.string(),
        notes: z.string().max(4000).default(""),
        followUpAt: z.string().max(40).nullable().default(null),
      }),
      input,
    ),
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    if (!isDisposition(data.disposition)) throw new Error("Choose a valid disposition.");
    const actor = await requireActor(context.userId, data.orgId, "dial");
    const sql = await getSql();
    const rows = await sql<{
      id: string;
      campaign_id: string | null;
      contact_id: string | null;
      state: string;
      disposition: string;
      channel: string;
      answered_at: unknown;
      provider_verified: boolean;
      duration_seconds: number | null;
      agent_user_id: string;
    }>`
      select id, campaign_id, contact_id, state, disposition, channel, answered_at, provider_verified, duration_seconds, agent_user_id
      from calls where id = ${data.callId} and org_id = ${actor.orgId} limit 1`;
    const call = rows[0];
    if (!call) throw new Error("Call not found.");
    if (call.agent_user_id !== actor.userId) throw new Error("You can only disposition your own calls.");
    if (call.disposition) {
      if (call.disposition !== data.disposition) {
        throw new Error("This call already has a disposition. A supervisor can correct it.");
      }
      await sql`update calls set notes = ${data.notes} where id = ${call.id} and org_id = ${actor.orgId}`;
      if (data.followUpAt && call.contact_id) {
        const due = new Date(data.followUpAt);
        if (!Number.isNaN(due.getTime()) && due.getTime() > Date.now() - 60_000) {
          const existing = await sql<{ id: string }>`
            select id from follow_ups
            where org_id = ${actor.orgId} and call_id = ${call.id} and done_at is null
            limit 1`;
          if (!existing[0]) {
            await sql`
              insert into follow_ups (id, org_id, contact_id, call_id, assigned_user_id, due_at, note, created_by)
              values (${newId()}, ${actor.orgId}, ${call.contact_id}, ${call.id}, ${actor.userId}, ${due.toISOString()}, ${data.notes.slice(0, 500)}, ${actor.userId})`;
          }
        }
      }
      return { ok: true as const };
    }
    if (call.state === "canceled") throw new Error("Canceled calls do not take a disposition.");
    const now = new Date();
    let duration = call.duration_seconds == null ? null : Number(call.duration_seconds);
    if (!(call.provider_verified && duration != null) && call.answered_at) {
      duration = Math.max(0, Math.round((now.getTime() - new Date(String(call.answered_at)).getTime()) / 1000));
    }
    if (data.disposition === "skipped") duration = null;
    const nextState = data.disposition === "skipped" ? "canceled" : data.disposition === "failed" ? "failed" : "completed";
    const updated = await sql<{ id: string }>`
      update calls
      set disposition = ${data.disposition},
          notes = ${data.notes},
          state = ${nextState},
          ended_at = coalesce(ended_at, now()),
          duration_seconds = ${duration}
      where id = ${call.id} and org_id = ${actor.orgId} and disposition = ''
      returning id`;
    if (!updated[0]) throw new Error("This call was already dispositioned.");
    if (call.campaign_id && call.contact_id) {
      const queue = await sql<{ attempts: number; max_attempts: number; retry_minutes: number; completed: boolean }>`
        select cc.attempts, g.max_attempts, g.retry_minutes, cc.completed
        from campaign_contacts cc
        join campaigns g on g.id = cc.campaign_id
        where cc.campaign_id = ${call.campaign_id} and cc.contact_id = ${call.contact_id} and g.org_id = ${actor.orgId}
        limit 1`;
      const row = queue[0];
      if (row && !row.completed) {
        const next = nextQueueState({
          attempts: Number(row.attempts),
          maxAttempts: Number(row.max_attempts),
          retryMinutes: Number(row.retry_minutes),
          disposition: data.disposition,
          now,
          callbackAt: data.followUpAt,
        });
        await sql`
          update campaign_contacts
          set attempts = ${next.attempts},
              completed = ${next.completed},
              last_disposition = ${next.lastDisposition},
              next_attempt_at = ${next.nextAttemptAt}
          where campaign_id = ${call.campaign_id} and contact_id = ${call.contact_id}`;
      }
    }
    if (data.disposition === "do_not_call" && call.contact_id) {
      await sql`
        update contacts set dnc = true, dnc_reason = 'disposition', updated_at = now()
        where id = ${call.contact_id} and org_id = ${actor.orgId}`;
      await writeAudit(sql, actor, "contact.dnc_on", "contact", call.contact_id, { source: "disposition" });
    }
    if (data.followUpAt && call.contact_id) {
      const due = new Date(data.followUpAt);
      if (!Number.isNaN(due.getTime()) && due.getTime() > Date.now() - 60_000) {
        await sql`
          insert into follow_ups (id, org_id, contact_id, call_id, assigned_user_id, due_at, note, created_by)
          values (${newId()}, ${actor.orgId}, ${call.contact_id}, ${call.id}, ${actor.userId}, ${due.toISOString()}, ${data.notes.slice(0, 500)}, ${actor.userId})`;
      }
    }
    await sql`
      insert into agent_presence (org_id, user_id, status, updated_at)
      values (${actor.orgId}, ${actor.userId}, 'wrap_up', now())
      on conflict (org_id, user_id) do update set status = 'wrap_up', updated_at = now()`;
    await writeAudit(sql, actor, "call.disposition", "call", call.id, { disposition: data.disposition });
    let followUpNote = "";
    if (call.contact_id && call.campaign_id) {
      followUpNote = await sendMissText(actor, call.id, call.contact_id, call.campaign_id, data.disposition);
    }
    const pushed = await logCallAdapters(actor.orgId, call.id, data.disposition, data.notes);
    return { ok: true as const, followUpText: [followUpNote, ...pushed].filter(Boolean).join(" ") };
  });

export const cancelCall = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ callId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "dial");
    const sql = await getSql();
    const rows = await sql<{ id: string; provider_call_sid: string | null; channel: string }>`
      select id, provider_call_sid, channel from calls
      where id = ${data.callId} and org_id = ${actor.orgId} and agent_user_id = ${actor.userId}
        and state in ('manual_open', 'requested', 'ringing') and disposition = ''
      limit 1`;
    const call = rows[0];
    if (!call) throw new Error("There is no cancelable call.");
    if (call.channel === "twilio" && call.provider_call_sid) {
      const { cancelTwilioCall } = await import("./telephony.server");
      await cancelTwilioCall(actor.orgId, call.provider_call_sid);
    }
    await sql`
      update calls set state = 'canceled', ended_at = now(), failure_reason = 'canceled'
      where id = ${call.id} and org_id = ${actor.orgId}`;
    await sql`
      insert into agent_presence (org_id, user_id, status, updated_at)
      values (${actor.orgId}, ${actor.userId}, 'available', now())
      on conflict (org_id, user_id) do update set status = 'available', updated_at = now()`;
    await writeAudit(sql, actor, "call.cancel", "call", call.id, {});
    return { ok: true as const };
  });

export const correctDisposition = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    parseInput(orgSchema.extend({ callId: z.string().min(8).max(80), disposition: z.string() }), input),
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    if (!isDisposition(data.disposition) || data.disposition === "skipped") throw new Error("Choose a valid disposition.");
    const actor = await requireActor(context.userId, data.orgId, "correct_disposition");
    const sql = await getSql();
    const rows = await sql<{ id: string; disposition: string; contact_id: string | null; campaign_id: string | null }>`
      select id, disposition, contact_id, campaign_id from calls
      where id = ${data.callId} and org_id = ${actor.orgId} and disposition <> '' limit 1`;
    const call = rows[0];
    if (!call) throw new Error("Only a dispositioned call can be corrected.");
    await sql`update calls set disposition = ${data.disposition} where id = ${call.id} and org_id = ${actor.orgId}`;
    if (call.campaign_id && call.contact_id) {
      const queue = await sql<{ attempts: number; max_attempts: number }>`
        select cc.attempts, g.max_attempts
        from campaign_contacts cc
        join campaigns g on g.id = cc.campaign_id
        where cc.campaign_id = ${call.campaign_id} and cc.contact_id = ${call.contact_id} and g.org_id = ${actor.orgId}
        limit 1`;
      const row = queue[0];
      if (row) {
        const flags = correctedQueueFlags({
          attempts: Number(row.attempts),
          maxAttempts: Number(row.max_attempts),
          disposition: data.disposition,
        });
        await sql`
          update campaign_contacts
          set last_disposition = ${data.disposition},
              completed = ${flags.completed},
              next_attempt_at = case when ${flags.completed} then null else coalesce(next_attempt_at, now()) end
          where campaign_id = ${call.campaign_id} and contact_id = ${call.contact_id}`;
      }
    }
    if (data.disposition === "do_not_call" && call.contact_id) {
      await sql`
        update contacts set dnc = true, dnc_reason = 'supervisor correction', updated_at = now()
        where id = ${call.contact_id} and org_id = ${actor.orgId}`;
    } else if (call.disposition === "do_not_call" && call.contact_id) {
      const cleared = await sql<{ id: string }>`
        update contacts set dnc = false, dnc_reason = '', updated_at = now()
        where id = ${call.contact_id} and org_id = ${actor.orgId}
          and dnc = true and dnc_reason in ('disposition', 'supervisor correction')
        returning id`;
      if (cleared[0]) await writeAudit(sql, actor, "contact.dnc_off", "contact", call.contact_id, { source: "correction" });
    }
    await writeAudit(sql, actor, "call.disposition_correct", "call", call.id, {
      from: call.disposition,
      to: data.disposition,
    });
    return { ok: true as const };
  });

const listSchema = orgSchema.extend({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  campaignId: z.string().max(80).default(""),
  disposition: z.string().max(40).default(""),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
});

export const listCalls = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(listSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId);
    const sql = await getSql();
    const elevated = can(actor.role, "view_all_calls");
    const offset = (data.page - 1) * data.pageSize;
    const rows = await sql.query<CallRow & { total: number }>(
      `select k.id, k.campaign_id, k.contact_id, k.agent_user_id, k.channel, k.state, k.disposition, k.notes,
              k.from_number, k.to_number, k.provider_call_sid, k.provider_verified, k.failure_reason,
              k.started_at, k.answered_at, k.ended_at, k.duration_seconds,
              (k.recording_url is not null and length(trim(k.recording_url)) > 0) as has_recording,
              nullif(trim(concat(ct.first_name, ' ', ct.last_name)), '') as contact_name,
              count(*) over()::int as total
       from calls k
       left join contacts ct on ct.id = k.contact_id
       where k.org_id = $1
         and k.started_at >= ($2::date::timestamp at time zone $3)
         and k.started_at < (($4::date + 1)::timestamp at time zone $3)
         and ($5 = '' or k.campaign_id = $5)
         and ($6 = '' or k.disposition = $6)
         and ($7::boolean = true or k.agent_user_id = $8)
       order by k.started_at desc
       limit $9 offset $10`,
      [actor.orgId, data.from, actor.timezone, data.to, data.campaignId, data.disposition, elevated, actor.userId, data.pageSize, offset],
    );
    return { calls: rows.map(mapCall), total: Number(rows[0]?.total ?? 0), page: data.page, pageSize: data.pageSize };
  });

export const setPresence = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ status: z.enum(["available", "wrap_up", "break", "offline"]) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "dial");
    const open = await loadOpenCall(actor.orgId, actor.userId);
    if (open && (isOpenState(open.state) || !open.disposition) && data.status === "available") {
      throw new Error("Disposition the open call before going available.");
    }
    const sql = await getSql();
    await sql`
      insert into agent_presence (org_id, user_id, status, updated_at)
      values (${actor.orgId}, ${actor.userId}, ${data.status}, now())
      on conflict (org_id, user_id) do update set status = ${data.status}, updated_at = now()`;
    return { ok: true as const };
  });

export const postponeLead = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ campaignId: z.string().min(8).max(80), contactId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "dial");
    assertMutable(actor);
    const sql = await getSql();
    const open = await loadOpenCall(actor.orgId, actor.userId);
    if (open && isOpenState(open.state)) throw new Error("Finish the open call before skipping a lead.");
    const elevated = can(actor.role, "manage_campaigns");
    const rows = await sql<{ attempts: number; max_attempts: number; completed: boolean; assigned: boolean }>`
      select cc.attempts, g.max_attempts, cc.completed,
             exists (select 1 from campaign_agents a where a.campaign_id = g.id and a.user_id = ${actor.userId}) as assigned
      from campaign_contacts cc
      join campaigns g on g.id = cc.campaign_id
      where cc.campaign_id = ${data.campaignId} and cc.contact_id = ${data.contactId} and g.org_id = ${actor.orgId} and g.status = 'active'
      limit 1`;
    const row = rows[0];
    if (!row || row.completed) throw new Error("That lead is not waiting in an active campaign.");
    if (!elevated && !row.assigned) throw new Error("You are not assigned to this campaign.");
    const next = nextQueueState({
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      retryMinutes: 30,
      disposition: "skipped",
      now: new Date(),
    });
    await sql`
      update campaign_contacts
      set attempts = ${next.attempts},
          completed = ${next.completed},
          last_disposition = ${next.lastDisposition},
          next_attempt_at = ${next.nextAttemptAt}
      where campaign_id = ${data.campaignId} and contact_id = ${data.contactId}`;
    await writeAudit(sql, actor, "lead.postponed", "contact", data.contactId, { campaignId: data.campaignId });
    return { nextAttemptAt: next.nextAttemptAt };
  });

export const listFollowUps = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId);
    const sql = await getSql();
    const elevated = can(actor.role, "view_all_calls");
    const rows = await sql<{
      id: string;
      contact_id: string | null;
      due_at: unknown;
      note: string;
      name: string | null;
      phone_e164: string | null;
      assigned_user_id: string;
    }>`
      select f.id, f.contact_id, f.due_at, f.note, f.assigned_user_id,
             nullif(trim(concat(ct.first_name, ' ', ct.last_name)), '') as name,
             ct.phone_e164
      from follow_ups f
      left join contacts ct on ct.id = f.contact_id
      where f.org_id = ${actor.orgId} and f.done_at is null
        and (${elevated} = true or f.assigned_user_id = ${actor.userId})
      order by f.due_at asc
      limit 50`;
    for (const row of rows) {
      if (new Date(String(row.due_at)).getTime() > Date.now()) continue;
      const marker = `followup:${row.id}`;
      await sql`
        insert into notifications (id, org_id, user_id, title, body)
        select ${newId()}, ${actor.orgId}, ${row.assigned_user_id}, 'Follow-up is due', ${marker}
        where not exists (
          select 1 from notifications n
          where n.org_id = ${actor.orgId} and n.user_id = ${row.assigned_user_id} and n.body = ${marker}
            and n.created_at > now() - interval '20 hours'
        )`;
    }
    return {
      followUps: rows.map((row) => ({
        id: row.id,
        contactId: row.contact_id,
        dueAt: asIso(row.due_at),
        note: row.note,
        name: row.name ?? "Contact",
        phoneDisplay: row.phone_e164 ? formatPhone(row.phone_e164) : "",
      })),
    };
  });

export const completeFollowUp = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ followUpId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId);
    const sql = await getSql();
    const elevated = can(actor.role, "view_all_calls");
    const rows = await sql<{ id: string }>`
      update follow_ups set done_at = now()
      where id = ${data.followUpId} and org_id = ${actor.orgId} and done_at is null
        and (${elevated} = true or assigned_user_id = ${actor.userId})
      returning id`;
    if (!rows[0]) throw new Error("Follow-up not found.");
    return { ok: true as const };
  });

export const transferCall = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ callId: z.string().min(8).max(80), to: z.string().min(7).max(32) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "dial");
    const to = normalizePhone(data.to);
    if (!to) throw new Error("Enter an E.164 number to transfer to.");
    const sql = await getSql();
    const rows = await sql<{ provider_call_sid: string | null; from_number: string; state: string; channel: string }>`
      select provider_call_sid, from_number, state, channel
      from calls
      where id = ${data.callId} and org_id = ${actor.orgId} and agent_user_id = ${actor.userId}
      limit 1`;
    const call = rows[0];
    if (!call || call.channel !== "twilio" || !call.provider_call_sid) throw new Error("Only a live Twilio call can be transferred.");
    if (!["ringing", "in_progress"].includes(call.state)) throw new Error("That call is not connected.");
    const { transferLiveCall } = await import("./telephony.server");
    await transferLiveCall(actor.orgId, call.provider_call_sid, to, call.from_number);
    await writeAudit(sql, actor, "call.transfer", "call", data.callId, { to });
    return { ok: true as const };
  });

export const dropVoicemail = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ callId: z.string().min(8).max(80), clipId: z.string().max(80).default("") }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "dial");
    const sql = await getSql();
    const rows = await sql<{ provider_call_sid: string | null; state: string; channel: string; campaign_id: string | null }>`
      select provider_call_sid, state, channel, campaign_id
      from calls
      where id = ${data.callId} and org_id = ${actor.orgId} and agent_user_id = ${actor.userId}
      limit 1`;
    const call = rows[0];
    if (!call || call.channel !== "twilio" || !call.provider_call_sid) throw new Error("Voicemail drop only works on a live Twilio call, not a device dial.");
    if (!["ringing", "in_progress"].includes(call.state)) throw new Error("That call is no longer connected.");
    let script = "";
    let audioUrl = "";
    if (data.clipId) {
      const clips = await sql<{ audio_url: string; script: string }>`
        select audio_url, script from voicemail_clips where id = ${data.clipId} and org_id = ${actor.orgId} limit 1`;
      script = clips[0]?.script ?? "";
      audioUrl = clips[0]?.audio_url ?? "";
      if (!clips[0]) throw new Error("That voicemail clip is not in this workspace.");
    } else if (call.campaign_id) {
      const scripts = await sql<{ voicemail_script: string }>`
        select voicemail_script from campaigns where id = ${call.campaign_id} and org_id = ${actor.orgId} limit 1`;
      script = scripts[0]?.voicemail_script ?? "";
    }
    const { playVoicemailOnCall } = await import("./telephony.server");
    await playVoicemailOnCall(actor.orgId, call.provider_call_sid, script, audioUrl);
    await writeAudit(sql, actor, "call.voicemail_drop", "call", data.callId, { clipId: data.clipId });
    return { ok: true as const };
  });

async function logCallAdapters(orgId: string, callId: string, disposition: string, notes: string): Promise<string[]> {
  const sql = await getSql();
  const rows = await sql<{ from_number: string; to_number: string; duration_seconds: number | null; first_name: string | null; last_name: string | null }>`
    select k.from_number, k.to_number, k.duration_seconds, ct.first_name, ct.last_name
    from calls k
    left join contacts ct on ct.id = k.contact_id
    where k.id = ${callId} and k.org_id = ${orgId}
    limit 1`;
  const row = rows[0];
  if (!row) return [];
  const { pushCallAdapters } = await import("./adapters");
  return pushCallAdapters(orgId, {
    callId,
    disposition,
    notes,
    from: row.from_number,
    to: row.to_number,
    durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    contactName: `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim(),
    at: new Date().toISOString(),
  });
}

async function sendMissText(actor: Actor, callId: string, contactId: string, campaignId: string, disposition: string): Promise<string> {
  const sql = await getSql();
  const rows = await sql<{
    first_name: string;
    company: string;
    phone_e164: string;
    dnc: boolean;
    sms_consent: boolean;
    sms_template: string;
    miss_sms: boolean;
  }>`
    select ct.first_name, ct.company, ct.phone_e164, ct.dnc, ct.sms_consent, g.sms_template, g.miss_sms
    from contacts ct
    join campaigns g on g.id = ${campaignId} and g.org_id = ct.org_id
    where ct.id = ${contactId} and ct.org_id = ${actor.orgId}
    limit 1`;
  const row = rows[0];
  if (!row) return "";
  const prior = await sql<{ id: string }>`
    select id from messages where org_id = ${actor.orgId} and call_id = ${callId} and direction = 'outbound' limit 1`;
  const decision = followUpText({
    disposition,
    missSms: Boolean(row.miss_sms),
    template: row.sms_template,
    smsConsent: Boolean(row.sms_consent),
    dnc: Boolean(row.dnc),
    alreadySent: Boolean(prior[0]),
  });
  if (!decision.send) return decision.reason;
  const names = await sql<{ name: string }>`select "name" as name from "user" where "id" = ${actor.userId} limit 1`;
  const body = fillSmsTemplate(row.sms_template, {
    firstName: row.first_name,
    company: row.company,
    agent: names[0]?.name ?? actor.orgName,
  });
  try {
    const { sendTwilioSms } = await import("./telephony.server");
    const sent = await sendTwilioSms(actor.orgId, row.phone_e164, body);
    await sql`
      insert into messages (
        id, org_id, contact_id, agent_user_id, direction, body, from_number, to_number, status, provider_sid, call_id
      ) values (
        ${newId()}, ${actor.orgId}, ${contactId}, ${actor.userId}, 'outbound', ${body}, ${sent.from}, ${row.phone_e164}, 'accepted', ${sent.sid}, ${callId}
      )`;
    return "Text sent.";
  } catch (error) {
    return error instanceof Error ? error.message : "The follow-up text was not sent.";
  }
}

export const openCallBrief = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ callId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "dial");
    const sql = await getSql();
    const rows = await sql<{
      contact_id: string | null;
      first_name: string | null;
      company: string | null;
      timezone: string | null;
      notes: string | null;
      tags: unknown;
      script: string | null;
      attempts: number | null;
      last_disposition: string | null;
    }>`
      select k.contact_id, ct.first_name, ct.company, ct.timezone, ct.notes, ct.tags, g.script, cc.attempts, cc.last_disposition
      from calls k
      left join contacts ct on ct.id = k.contact_id
      left join campaigns g on g.id = k.campaign_id
      left join campaign_contacts cc on cc.campaign_id = k.campaign_id and cc.contact_id = k.contact_id
      where k.id = ${data.callId} and k.org_id = ${actor.orgId} and k.agent_user_id = ${actor.userId}
      limit 1`;
    const row = rows[0];
    if (!row?.contact_id) return { brief: null as null };
    const history = await sql<{ disposition: string }>`
      select disposition from calls
      where org_id = ${actor.orgId} and contact_id = ${row.contact_id} and id <> ${data.callId} and disposition <> ''
      order by started_at desc limit 5`;
    const brief = buildBrief({
      firstName: row.first_name ?? "",
      company: row.company ?? "",
      timezone: row.timezone ?? actor.timezone,
      notes: row.notes ?? "",
      tags: asTags(row.tags),
      attempts: Number(row.attempts ?? 0),
      lastDisposition: row.last_disposition ?? "",
      history: history.map((item) => item.disposition),
      script: row.script ?? "",
    });
    const { maybePolishOpener } = await import("./assist");
    const polished = await maybePolishOpener(actor.orgId, brief, JSON.stringify({ ...brief, notes: (row.notes ?? "").slice(0, 400) }));
    return { brief: polished };
  });

export const getCallRecording = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ callId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId);
    const sql = await getSql();
    const elevated = can(actor.role, "view_all_calls");
    const rows = await sql<{ recording_url: string | null }>`
      select recording_url from calls
      where id = ${data.callId} and org_id = ${actor.orgId}
        and (${elevated} = true or agent_user_id = ${actor.userId})
      limit 1`;
    const { safeRecordingUrl } = await import("@/lib/dialer/twilio-sign");
    const safe = safeRecordingUrl(rows[0]?.recording_url ?? "");
    if (!safe) throw new Error("This call has no playable recording.");
    const { loadTelephony } = await import("./telephony.server");
    const tel = await loadTelephony(actor.orgId);
    if (!tel.credentialsPresent) throw new Error("Twilio credentials are required to play the recording.");
    const audioUrl = /\.(mp3|wav)$/i.test(safe) ? safe : `${safe}.mp3`;
    const auth = Buffer.from(`${tel.accountSid}:${tel.authToken}`).toString("base64");
    const response = await fetch(audioUrl, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`Twilio did not return the recording (${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 6_000_000) throw new Error("That recording is too large to play in the browser.");
    return { audioBase64: bytes.toString("base64"), mime: "audio/mpeg" };
  });

