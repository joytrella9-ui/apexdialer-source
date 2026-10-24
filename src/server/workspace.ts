import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql, dbSource } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { planLimits } from "@/lib/dialer/plans";
import { isE164, normalizePhone } from "@/lib/dialer/phone";
import { normalizePublicOrigin, twilioClientUrl, twilioInboundUrl, twilioSmsUrl, twilioStatusUrl } from "@/lib/dialer/twilio-sign";
import { parseIvrOptions, type IvrOption } from "@/lib/dialer/ivr";
import { twilioSetupChecks } from "@/lib/dialer/twilio-setup";
import { isValidTimeZone, validateOrgWindow } from "@/lib/dialer/windows";
import { assertMutable, findActor, newId, requireActor, writeAudit } from "./actor";
import { parseInput } from "./validate";

const orgSchema = z.object({
  name: z.string().trim().min(2).max(80),
  timezone: z.string().trim().min(1).max(80),
});

export const getBootstrap = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(z.object({ orgId: z.string().max(80).nullable().optional() }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await findActor(context.userId, data.orgId ?? null);
    const { telephonyPublicStatus } = await import("./telephony.server");
    const telephony = await telephonyPublicStatus(actor?.orgId ?? null);
    if (!actor) return { membership: null, telephony, usage: null, limits: null };
    const sql = await getSql();
    const usageRows = await sql<{ contacts: number; campaigns: number; agents: number; calls_month: number }>`
      select
        (select count(*)::int from contacts c where c.org_id = ${actor.orgId} and c.archived_at is null) as contacts,
        (select count(*)::int from campaigns g where g.org_id = ${actor.orgId} and g.status <> 'archived') as campaigns,
        (select count(*)::int from memberships m where m.org_id = ${actor.orgId} and m.status = 'active') as agents,
        (select count(*)::int from calls k where k.org_id = ${actor.orgId} and k.started_at >= date_trunc('month', now())) as calls_month`;
    const usage = usageRows[0];
    const unread = await sql<{ n: number }>`
      select count(*)::int as n from notifications
      where org_id = ${actor.orgId} and user_id = ${actor.userId} and read_at is null`;
    return {
      membership: {
        orgId: actor.orgId,
        orgName: actor.orgName,
        role: actor.role,
        timezone: actor.timezone,
        plan: actor.plan,
        billingStatus: actor.billingStatus,
        windowStart: actor.windowStart,
        windowEnd: actor.windowEnd,
        callingDays: actor.callingDays,
        recordingPolicy: actor.recordingPolicy,
        retentionDays: actor.retentionDays,
        callbackPhone: actor.callbackPhone,
      },
      telephony,
      usage: {
        contacts: Number(usage?.contacts ?? 0),
        campaigns: Number(usage?.campaigns ?? 0),
        agents: Number(usage?.agents ?? 0),
        callsThisMonth: Number(usage?.calls_month ?? 0),
        unread: Number(unread[0]?.n ?? 0),
      },
      limits: planLimits(actor.plan),
    };
  });

export const createOrganization = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    if (!isValidTimeZone(data.timezone)) throw new Error("Timezone is not a valid IANA zone.");
    const existing = await findActor(context.userId, null);
    if (existing) throw new Error("You already belong to a workspace.");
    const sql = await getSql();
    const orgId = newId();
    const memberId = newId();
    await sql`
      with org as (
        insert into organizations (id, name, timezone, created_by)
        values (${orgId}, ${data.name}, ${data.timezone}, ${context.userId})
        returning id
      )
      insert into memberships (id, org_id, user_id, role)
      select ${memberId}, id, ${context.userId}, 'owner' from org`;
    await sql`
      insert into agent_presence (org_id, user_id, status)
      values (${orgId}, ${context.userId}, 'available')
      on conflict (org_id, user_id) do nothing`;
    await writeAudit(sql, { orgId, userId: context.userId }, "org.create", "organization", orgId, { name: data.name });
    return { orgId };
  });

const settingsSchema = z.object({
  orgId: z.string().min(8).max(80),
  name: z.string().trim().min(2).max(80),
  timezone: z.string().trim().min(1).max(80),
  windowStart: z.string(),
  windowEnd: z.string(),
  callingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  recordingPolicy: z.enum(["disabled", "provider_if_consented"]),
  retentionDays: z.number().int().min(30).max(2555),
});

export const updateOrgSettings = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(settingsSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_settings");
    const errors = validateOrgWindow(data.windowStart, data.windowEnd, data.callingDays, data.timezone);
    if (errors.length) throw new Error(errors.join(" "));
    const sql = await getSql();
    const days = `{${[...new Set(data.callingDays)].sort((a, b) => a - b).join(",")}}`;
    await sql`
      update organizations
      set name = ${data.name},
          timezone = ${data.timezone},
          window_start = ${data.windowStart},
          window_end = ${data.windowEnd},
          calling_days = ${days}::smallint[],
          recording_policy = ${data.recordingPolicy},
          retention_days = ${data.retentionDays},
          updated_at = now()
      where id = ${actor.orgId}`;
    await writeAudit(sql, actor, "org.settings", "organization", actor.orgId, {
      recordingPolicy: data.recordingPolicy,
      retentionDays: data.retentionDays,
    });
    return { ok: true as const };
  });

export const testTelephony = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(z.object({ orgId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "test_telephony");
    const { testTwilioAccount } = await import("./telephony.server");
    const result = await testTwilioAccount(actor.orgId);
    const sql = await getSql();
    await writeAudit(sql, actor, "telephony.test", "organization", actor.orgId, { ok: true });
    return result;
  });

export const ringMyPhone = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(z.object({ orgId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "test_telephony");
    if (!actor.callbackPhone) throw new Error("Save your own phone as the callback number first.");
    const { placeTestRing } = await import("./telephony.server");
    const result = await placeTestRing(actor.orgId, actor.callbackPhone);
    const sql = await getSql();
    await writeAudit(sql, actor, "telephony.test_ring", "organization", actor.orgId, { sid: result.sid });
    return { sid: result.sid };
  });

export const runTwilioSetup = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(z.object({ orgId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "test_telephony");
    const { loadTelephony, testTwilioAccount } = await import("./telephony.server");
    const tel = await loadTelephony(actor.orgId);
    const checks = twilioSetupChecks({
      accountSid: tel.accountSid,
      authTokenPresent: Boolean(tel.authToken),
      from: tel.from,
      callerIds: tel.callerIds,
      publicUrl: tel.publicUrl,
      callbackPhone: actor.callbackPhone,
    });
    let live: { ok: boolean; detail: string };
    if (!tel.credentialsPresent) {
      try {
        const response = await fetch("https://api.twilio.com/2010-04-01/Accounts.json", { signal: AbortSignal.timeout(8000) });
        live = {
          ok: false,
          detail: response.status === 401 ? "Twilio's API is reachable. No credentials are saved, so the account was not opened." : `Twilio's API returned ${response.status} before credentials were checked.`,
        };
      } catch (error) {
        live = { ok: false, detail: error instanceof Error ? error.message : "Twilio's API could not be reached." };
      }
    } else {
      try {
        const result = await testTwilioAccount(actor.orgId);
        live = { ok: true, detail: `Twilio answered as ${result.friendlyName}. That is an account lookup, not a placed call.` };
      } catch (error) {
        live = { ok: false, detail: error instanceof Error ? error.message : "Account lookup failed." };
      }
    }
    return { checks, live, ready: tel.ready && checks.every((check) => check.ok) && live.ok };
  });

const integrationSchema = z.object({
  orgId: z.string().min(8).max(80),
  accountSid: z.string().trim().max(40).default(""),
  authToken: z.string().max(200).default(""),
  fromNumber: z.string().max(32).default(""),
  callerIds: z.string().max(500).default(""),
  publicUrl: z.string().trim().max(200).default(""),
  stripeWebhookSecret: z.string().max(200).default(""),
  apiKeySid: z.string().trim().max(40).default(""),
  apiKeySecret: z.string().max(200).default(""),
  twimlAppSid: z.string().trim().max(40).default(""),
});

function integrationView(orgId: string, row: {
  twilio_account_sid: string;
  twilio_auth_token: string;
  twilio_from_e164: string;
  twilio_caller_ids: string;
  public_url: string;
  stripe_webhook_secret: string;
  xai_api_key: string;
  twilio_api_key_sid: string;
  twilio_api_key_secret: string;
  twilio_twiml_app_sid: string;
  ivr_greeting: string;
  ivr_options: string;
} | undefined) {
  const publicUrl = row?.public_url ?? "";
  return {
    accountSid: row?.twilio_account_sid ?? "",
    authTokenSet: Boolean(row?.twilio_auth_token),
    fromNumber: row?.twilio_from_e164 ?? "",
    callerIds: row?.twilio_caller_ids ?? "",
    publicUrl,
    stripeSecretSet: Boolean(row?.stripe_webhook_secret),
    aiKeySet: Boolean(row?.xai_api_key),
    apiKeySid: row?.twilio_api_key_sid ?? "",
    apiKeySet: Boolean(row?.twilio_api_key_secret),
    twimlAppSid: row?.twilio_twiml_app_sid ?? "",
    statusUrl: publicUrl ? twilioStatusUrl(publicUrl, orgId) : "",
    inboundUrl: publicUrl ? twilioInboundUrl(publicUrl, orgId) : "",
    smsUrl: publicUrl ? twilioSmsUrl(publicUrl, orgId) : "",
    clientVoiceUrl: publicUrl ? twilioClientUrl(publicUrl, orgId) : "",
    stripeUrl: publicUrl ? `${publicUrl}/api/billing/stripe?org=${encodeURIComponent(orgId)}` : "",
    ivrGreeting: row?.ivr_greeting ?? "",
    ivrOptions: row?.ivr_options ?? "[]",
  };
}

export const getTelephonyConnection = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(z.object({ orgId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_settings");
    const sql = await getSql();
    const rows = await sql<{
      twilio_account_sid: string;
      twilio_auth_token: string;
      twilio_from_e164: string;
      twilio_caller_ids: string;
      public_url: string;
      stripe_webhook_secret: string;
      xai_api_key: string;
      twilio_api_key_sid: string;
      twilio_api_key_secret: string;
      twilio_twiml_app_sid: string;
      ivr_greeting: string;
      ivr_options: string;
    }>`
      select twilio_account_sid, twilio_auth_token, twilio_from_e164, twilio_caller_ids, public_url, stripe_webhook_secret, xai_api_key,
             twilio_api_key_sid, twilio_api_key_secret, twilio_twiml_app_sid, ivr_greeting, ivr_options
      from org_integrations where org_id = ${actor.orgId} limit 1`;
    return integrationView(actor.orgId, rows[0]);
  });

export const saveIvrMenu = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    parseInput(
      z.object({
        orgId: z.string().min(8).max(80),
        greeting: z.string().max(180).default(""),
        options: z.array(z.object({
          digit: z.string().max(2),
          label: z.string().max(40),
          action: z.enum(["agent", "message"]),
          message: z.string().max(240).default(""),
        })).max(6),
      }),
      input,
    ),
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_settings");
    assertMutable(actor);
    const options: IvrOption[] = parseIvrOptions(JSON.stringify(data.options));
    const sql = await getSql();
    await sql`
      insert into org_integrations (org_id, ivr_greeting, ivr_options)
      values (${actor.orgId}, ${data.greeting.trim()}, ${JSON.stringify(options)})
      on conflict (org_id) do update
      set ivr_greeting = ${data.greeting.trim()}, ivr_options = ${JSON.stringify(options)}, updated_at = now()`;
    await writeAudit(sql, actor, "ivr.save", "organization", actor.orgId, { options: options.length });
    return { greeting: data.greeting.trim(), options };
  });

export const saveAssistKey = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(z.object({ orgId: z.string().min(8).max(80), apiKey: z.string().min(8).max(200) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_settings");
    const apiKey = data.apiKey.trim();
    const sql = await getSql();
    await sql`
      insert into org_integrations (org_id, xai_api_key)
      values (${actor.orgId}, ${apiKey})
      on conflict (org_id) do update set xai_api_key = excluded.xai_api_key, updated_at = now()`;
    await writeAudit(sql, actor, "assist.connect", "organization", actor.orgId, {});
    return { aiKeySet: true as const };
  });

export const clearAssistKey = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(z.object({ orgId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_settings");
    const sql = await getSql();
    await sql`update org_integrations set xai_api_key = '', updated_at = now() where org_id = ${actor.orgId}`;
    await writeAudit(sql, actor, "assist.disconnect", "organization", actor.orgId, {});
    return { aiKeySet: false as const };
  });

export const saveTelephonyConnection = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(integrationSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_settings");
    const accountSid = data.accountSid.trim();
    if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) throw new Error("Account SID must look like AC followed by 32 hex characters.");
    const from = normalizePhone(data.fromNumber);
    if (!from || !isE164(from)) throw new Error("From number must be E.164, like +13125550100.");
    const extras: string[] = [];
    for (const part of data.callerIds.split(",").map((item) => item.trim()).filter(Boolean)) {
      const phone = normalizePhone(part);
      if (!phone || !isE164(phone)) throw new Error(`${part} is not an E.164 caller ID.`);
      if (phone !== from) extras.push(phone);
    }
    const publicUrl = normalizePublicOrigin(data.publicUrl);
    if (publicUrl == null) throw new Error("Public address must be an https origin, with no path, such as https://dial.example.com.");
    const sql = await getSql();
    const existing = await sql<{
      twilio_auth_token: string;
      stripe_webhook_secret: string;
      twilio_api_key_sid: string;
      twilio_api_key_secret: string;
      twilio_twiml_app_sid: string;
    }>`
      select twilio_auth_token, stripe_webhook_secret, twilio_api_key_sid, twilio_api_key_secret, twilio_twiml_app_sid
      from org_integrations where org_id = ${actor.orgId} limit 1`;
    const authToken = data.authToken.trim() || existing[0]?.twilio_auth_token || "";
    if (!authToken) throw new Error("Enter the Twilio auth token. It is stored for this workspace and is not shown again.");
    const stripeSecret = data.stripeWebhookSecret.trim() || existing[0]?.stripe_webhook_secret || "";
    const apiKeySid = data.apiKeySid.trim() || existing[0]?.twilio_api_key_sid || "";
    const twimlAppSid = data.twimlAppSid.trim() || existing[0]?.twilio_twiml_app_sid || "";
    let apiKeySecret = data.apiKeySecret.trim() || existing[0]?.twilio_api_key_secret || "";
    if (apiKeySid || twimlAppSid || apiKeySecret) {
      if (!/^SK[0-9a-f]{32}$/i.test(apiKeySid)) throw new Error("API Key SID must start with SK and have 32 hex characters.");
      if (!/^AP[0-9a-f]{32}$/i.test(twimlAppSid)) throw new Error("TwiML App SID must start with AP and have 32 hex characters.");
      if (!apiKeySecret) throw new Error("Enter the API key secret. It is stored for this workspace and is not shown again.");
    }
    const callerIds = [...new Set(extras)].join(",");
    await sql`
      insert into org_integrations (
        org_id, twilio_account_sid, twilio_auth_token, twilio_from_e164, twilio_caller_ids, public_url, stripe_webhook_secret,
        twilio_api_key_sid, twilio_api_key_secret, twilio_twiml_app_sid
      ) values (
        ${actor.orgId}, ${accountSid}, ${authToken}, ${from}, ${callerIds}, ${publicUrl}, ${stripeSecret},
        ${apiKeySid}, ${apiKeySecret}, ${twimlAppSid}
      )
      on conflict (org_id) do update set
        twilio_account_sid = excluded.twilio_account_sid,
        twilio_auth_token = excluded.twilio_auth_token,
        twilio_from_e164 = excluded.twilio_from_e164,
        twilio_caller_ids = excluded.twilio_caller_ids,
        public_url = excluded.public_url,
        stripe_webhook_secret = excluded.stripe_webhook_secret,
        twilio_api_key_sid = excluded.twilio_api_key_sid,
        twilio_api_key_secret = excluded.twilio_api_key_secret,
        twilio_twiml_app_sid = excluded.twilio_twiml_app_sid,
        updated_at = now()`;
    await writeAudit(sql, actor, "telephony.connect", "organization", actor.orgId, {
      from,
      publicUrl: publicUrl || null,
      stripe: Boolean(stripeSecret),
    });
    const rows = await sql<{
      twilio_account_sid: string;
      twilio_auth_token: string;
      twilio_from_e164: string;
      twilio_caller_ids: string;
      public_url: string;
      stripe_webhook_secret: string;
      xai_api_key: string;
      twilio_api_key_sid: string;
      twilio_api_key_secret: string;
      twilio_twiml_app_sid: string;
      ivr_greeting: string;
      ivr_options: string;
    }>`
      select twilio_account_sid, twilio_auth_token, twilio_from_e164, twilio_caller_ids, public_url, stripe_webhook_secret, xai_api_key,
             twilio_api_key_sid, twilio_api_key_secret, twilio_twiml_app_sid, ivr_greeting, ivr_options
      from org_integrations where org_id = ${actor.orgId} limit 1`;
    return integrationView(actor.orgId, rows[0]);
  });

export const provisionBrowserPhone = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(z.object({ orgId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_settings");
    const { ensureBrowserPhone } = await import("./telephony.server");
    const result = await ensureBrowserPhone(actor.orgId);
    const sql = await getSql();
    await writeAudit(sql, actor, "telephony.softphone", "organization", actor.orgId, {
      apiKeySid: result.apiKeySid,
      twimlAppSid: result.twimlAppSid,
      createdKey: result.createdKey,
    });
    return { apiKeySid: result.apiKeySid, twimlAppSid: result.twimlAppSid, voiceUrl: result.voiceUrl, createdKey: result.createdKey };
  });

export const clearTelephonyConnection = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(z.object({ orgId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_settings");
    const sql = await getSql();
    await sql`delete from org_integrations where org_id = ${actor.orgId}`;
    await writeAudit(sql, actor, "telephony.disconnect", "organization", actor.orgId, {});
    return integrationView(actor.orgId, undefined);
  });

export const runRetention = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(z.object({ orgId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_settings");
    const { scrubExpiredRecordings } = await import("./telephony.server");
    const rows = await scrubExpiredRecordings(actor.orgId, actor.userId, actor.retentionDays);
    return { scrubbed: rows };
  });

export const healthPayload = async () => {
  const sql = await getSql();
  await sql`select 1 as ok`;
  const { telephonyPublicStatus } = await import("./telephony.server");
  const telephony = await telephonyPublicStatus(null);
  return {
    status: "ok" as const,
    database: dbSource,
    telephony: telephony.ready ? ("configured" as const) : ("not_configured" as const),
  };
};
