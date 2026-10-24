import { getSql } from "@/lib/db";
import { isE164, normalizePhone } from "@/lib/dialer/phone";
import { isSmsStop } from "@/lib/dialer/sms";
import {
  canApplyProviderState,
  interpretBridgeStatus,
  mapDialCallStatus,
  mapTwilioParentStatus,
  nextQueueState,
} from "@/lib/dialer/dispositions";
import { callTokenMatches, safeRecordingUrl, signCallToken, twilioAmdUrl, twilioClientUrl, twilioInboundUrl, twilioIvrUrl, twilioPressUrl, twilioScreenDoneUrl, twilioSmsUrl, twilioStatusUrl, twilioTranscriptionUrl, twilioWhisperUrl, verifyTwilioSignature, xmlEscape } from "@/lib/dialer/twilio-sign";
import { isMachineAnswer } from "@/lib/dialer/amd";
import { ivrPrompt, parseIvrOptions } from "@/lib/dialer/ivr";
import { agentWhisper, readTranscriptEvent } from "@/lib/dialer/speech";
import { clientIdentity, signTwilioVoiceToken } from "@/lib/dialer/voice-token";
import { newId, writeAudit } from "./actor";

export type TelephonyPublicStatus = {
  ready: boolean;
  credentialsPresent: boolean;
  publicUrlPresent: boolean;
  fromMasked: string;
  callerIds: string[];
  detail: string;
  softphoneReady: boolean;
};

function maskNumber(value: string): string {
  if (value.length < 4) return "••••";
  return `${value.slice(0, 2)}···${value.slice(-4)}`;
}

type StoredIntegration = {
  twilio_account_sid: string;
  twilio_auth_token: string;
  twilio_from_e164: string;
  twilio_caller_ids: string;
  public_url: string;
  stripe_webhook_secret: string;
  twilio_api_key_sid: string;
  twilio_api_key_secret: string;
  twilio_twiml_app_sid: string;
};

export type TelephonyConfig = {
  accountSid: string;
  authToken: string;
  from: string;
  publicUrl: string;
  callerIds: string[];
  credentialsPresent: boolean;
  publicUrlPresent: boolean;
  ready: boolean;
  stripeSecret: string;
  apiKeySid: string;
  apiKeySecret: string;
  twimlAppSid: string;
  softphoneReady: boolean;
};

function assembleTelephony(input: {
  accountSid: string;
  authToken: string;
  fromRaw: string;
  extraRaw: string;
  publicUrl: string;
  stripeSecret: string;
  apiKeySid: string;
  apiKeySecret: string;
  twimlAppSid: string;
}): TelephonyConfig {
  const from = normalizePhone(input.fromRaw) ?? "";
  const extra = input.extraRaw
    .split(",")
    .map((item) => normalizePhone(item))
    .filter((item): item is string => Boolean(item));
  const callerIds = [...new Set([from, ...extra].filter((item) => item && isE164(item)))];
  const publicUrl = input.publicUrl.trim().replace(/\/$/, "");
  const credentialsPresent = Boolean(input.accountSid && input.authToken && from);
  const publicUrlPresent = publicUrl.startsWith("https://");
  const apiKeySid = input.apiKeySid.trim();
  const apiKeySecret = input.apiKeySecret.trim();
  const twimlAppSid = input.twimlAppSid.trim();
  const ready = credentialsPresent;
  const softphoneReady = credentialsPresent && /^SK[0-9a-f]{32}$/i.test(apiKeySid) && Boolean(apiKeySecret);
  return {
    accountSid: input.accountSid.trim(),
    authToken: input.authToken.trim(),
    from,
    publicUrl,
    callerIds,
    credentialsPresent,
    publicUrlPresent,
    ready,
    stripeSecret: input.stripeSecret.trim(),
    apiKeySid,
    apiKeySecret,
    twimlAppSid,
    softphoneReady,
  };
}

function envTelephony(): TelephonyConfig {
  return assembleTelephony({
    accountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
    authToken: process.env.TWILIO_AUTH_TOKEN ?? "",
    fromRaw: process.env.TWILIO_FROM_NUMBER ?? "",
    extraRaw: process.env.TWILIO_CALLER_IDS ?? "",
    publicUrl: process.env.APEX_PUBLIC_URL ?? "",
    stripeSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
    apiKeySid: process.env.TWILIO_API_KEY_SID ?? "",
    apiKeySecret: process.env.TWILIO_API_KEY_SECRET ?? "",
    twimlAppSid: process.env.TWILIO_TWIML_APP_SID ?? "",
  });
}

export function telephonySecrets(): TelephonyConfig {
  return envTelephony();
}

export async function loadTelephony(orgId: string | null): Promise<TelephonyConfig> {
  const env = envTelephony();
  if (!orgId) return env;
  const sql = await getSql();
  const rows = await sql<StoredIntegration>`
    select twilio_account_sid, twilio_auth_token, twilio_from_e164, twilio_caller_ids, public_url, stripe_webhook_secret,
           twilio_api_key_sid, twilio_api_key_secret, twilio_twiml_app_sid
    from org_integrations where org_id = ${orgId} limit 1`;
  const row = rows[0];
  if (!row?.twilio_account_sid) {
    return assembleTelephony({
      accountSid: env.accountSid,
      authToken: env.authToken,
      fromRaw: env.from,
      extraRaw: process.env.TWILIO_CALLER_IDS ?? "",
      publicUrl: row?.public_url || env.publicUrl,
      stripeSecret: row?.stripe_webhook_secret || env.stripeSecret,
      apiKeySid: row?.twilio_api_key_sid || env.apiKeySid,
      apiKeySecret: row?.twilio_api_key_secret || env.apiKeySecret,
      twimlAppSid: row?.twilio_twiml_app_sid || env.twimlAppSid,
    });
  }
  return assembleTelephony({
    accountSid: row.twilio_account_sid,
    authToken: row.twilio_auth_token || env.authToken,
    fromRaw: row.twilio_from_e164,
    extraRaw: row.twilio_caller_ids,
    publicUrl: row.public_url || env.publicUrl,
    stripeSecret: row.stripe_webhook_secret || env.stripeSecret,
    apiKeySid: row.twilio_api_key_sid || env.apiKeySid,
    apiKeySecret: row.twilio_api_key_secret || env.apiKeySecret,
    twimlAppSid: row.twilio_twiml_app_sid || env.twimlAppSid,
  });
}

export async function telephonyPublicStatus(orgId: string | null = null): Promise<TelephonyPublicStatus> {
  const cfg = await loadTelephony(orgId);
  let detail = "Twilio is not connected. Add your account in Settings, or keep using device dialing. No live call is placed until then.";
  if (cfg.credentialsPresent && !cfg.softphoneReady) {
    detail = "The account can ring your phone. Add an API key, or press Create the browser phone, to talk in this browser. A public address is not required for that.";
  } else if (cfg.softphoneReady && !cfg.publicUrlPresent) {
    detail = "The browser phone can place calls. Inbound calls, text replies, and recordings still need the published https address.";
  } else if (cfg.ready && cfg.softphoneReady && cfg.publicUrlPresent) {
    detail = "Twilio is connected, including the browser phone. A test only proves the account lookup, not that a call connected.";
  } else if (cfg.ready && cfg.publicUrlPresent) {
    detail = "Twilio is connected for phone bridging. Add an API key in Settings to talk in the browser.";
  }
  return {
    ready: cfg.ready,
    credentialsPresent: cfg.credentialsPresent,
    publicUrlPresent: cfg.publicUrlPresent,
    fromMasked: cfg.from ? maskNumber(cfg.from) : "",
    callerIds: cfg.callerIds,
    detail,
    softphoneReady: cfg.softphoneReady,
  };
}

export async function testTwilioAccount(orgId: string | null): Promise<{ ok: true; friendlyName: string }> {
  const cfg = await loadTelephony(orgId);
  if (!cfg.credentialsPresent) {
    throw new Error("Twilio credentials are not configured.");
  }
  if (!/^AC[0-9a-f]{32}$/i.test(cfg.accountSid)) {
    throw new Error("The Account SID is not a Twilio account SID.");
  }
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}.json`, {
    headers: { Authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(8000),
  });
  const body = (await response.json().catch(() => null)) as { friendly_name?: string; message?: string } | null;
  if (!response.ok) {
    throw new Error(body?.message || `Twilio rejected the account lookup (${response.status}).`);
  }
  return { ok: true, friendlyName: body?.friendly_name || "Twilio account" };
}

export async function placeTwilioAgentBridge(input: {
  orgId: string;
  callId: string;
  agentPhone: string;
  callerId: string;
  contactTo: string;
  transcribe?: boolean;
}): Promise<{ sid: string }> {
  const cfg = await loadTelephony(input.orgId);
  if (!cfg.credentialsPresent) throw new Error("Twilio is not configured. Save the account SID, auth token, and from number.");
  if (!cfg.callerIds.includes(input.callerId)) throw new Error("That caller ID is not in the allow list.");
  if (!isE164(input.contactTo)) throw new Error("The contact number is not E.164.");
  const fields: Record<string, string> = {
    To: input.agentPhone,
    From: input.callerId,
    Twiml: bridgeTwiml(input.callerId, input.contactTo, input.transcribe && cfg.publicUrlPresent ? twilioTranscriptionUrl(cfg.publicUrl, input.orgId) : ""),
  };
  if (cfg.publicUrlPresent) {
    const statusUrl = twilioStatusUrl(cfg.publicUrl, input.orgId);
    fields.StatusCallback = statusUrl;
    fields.StatusCallbackMethod = "POST";
  }
  const sid = await twilioCreateCall(cfg, fields);
  return { sid };
}

export async function placeBrowserCall(input: {
  orgId: string;
  identity: string;
  callerId: string;
  contactTo: string;
  transcribe?: boolean;
}): Promise<{ sid: string }> {
  const cfg = await loadTelephony(input.orgId);
  if (!cfg.credentialsPresent) throw new Error("Twilio is not configured. Save the account SID, auth token, and from number.");
  if (!cfg.softphoneReady) throw new Error("The browser phone needs an API key. Create it in Settings.");
  if (!cfg.callerIds.includes(input.callerId)) throw new Error("That caller ID is not in the allow list.");
  if (!isE164(input.contactTo)) throw new Error("The contact number is not E.164.");
  const fields: Record<string, string> = {
    To: `client:${input.identity}`,
    From: input.callerId,
    Twiml: bridgeTwiml(input.callerId, input.contactTo, input.transcribe && cfg.publicUrlPresent ? twilioTranscriptionUrl(cfg.publicUrl, input.orgId) : ""),
  };
  if (cfg.publicUrlPresent) {
    fields.StatusCallback = twilioStatusUrl(cfg.publicUrl, input.orgId);
    fields.StatusCallbackMethod = "POST";
  }
  return { sid: await twilioCreateCall(cfg, fields) };
}

/** Dial the contact first. Twilio reports a person or a machine before anyone's phone rings. */
export async function placeAmdCall(input: {
  orgId: string;
  callId: string;
  callerId: string;
  contactTo: string;
}): Promise<{ sid: string }> {
  const cfg = await loadTelephony(input.orgId);
  if (!cfg.credentialsPresent) throw new Error("Twilio is not configured. No live call was placed.");
  if (!cfg.publicUrlPresent) throw new Error("Predictive dialing needs the published https address. Twilio has to call back when it knows a person answered.");
  if (!cfg.callerIds.includes(input.callerId)) throw new Error("That caller ID is not in the allow list.");
  if (!isE164(input.contactTo)) throw new Error("The contact number is not E.164.");
  const fields: Record<string, string> = {
    To: input.contactTo,
    From: input.callerId,
    Twiml: `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="40"/></Response>`,
    MachineDetection: "Enable",
    AsyncAmd: "true",
    AsyncAmdStatusCallback: twilioAmdUrl(cfg.publicUrl, input.orgId, input.callId),
    AsyncAmdStatusCallbackMethod: "POST",
    MachineDetectionTimeout: "30",
    StatusCallback: twilioStatusUrl(cfg.publicUrl, input.orgId),
    StatusCallbackMethod: "POST",
  };
  return { sid: await twilioCreateCall(cfg, fields) };
}

export async function handleAmd(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const orgId = url.searchParams.get("org") ?? "";
  const callId = url.searchParams.get("call") ?? "";
  if (!orgId || !callId) return new Response("Missing call", { status: 400 });
  const cfg = await loadTelephony(orgId);
  if (!cfg.authToken || !cfg.publicUrlPresent) return new Response("Twilio is not configured", { status: 503 });
  const params = await readTwilioForm(request);
  if (!verifyTwilioSignature(cfg.authToken, twilioAmdUrl(cfg.publicUrl, orgId, callId), params, request.headers.get("x-twilio-signature"))) {
    return new Response("Invalid signature", { status: 403 });
  }
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    org_id: string;
    campaign_id: string | null;
    contact_id: string | null;
    agent_user_id: string;
    from_number: string;
    disposition: string;
    state: string;
    provider_call_sid: string | null;
  }>`
    select id, org_id, campaign_id, contact_id, agent_user_id, from_number, disposition, state, provider_call_sid
    from calls where id = ${callId} and org_id = ${orgId} limit 1`;
  const call = rows[0];
  const callSid = params.CallSid || call?.provider_call_sid || "";
  if (!call || !callSid) return new Response("ok");
  if (call.disposition || ["completed", "failed", "canceled"].includes(call.state)) return new Response("ok");
  if (isMachineAnswer(params.AnsweredBy ?? "")) {
    await sql`
      update calls
      set disposition = 'voicemail', state = 'completed', ended_at = now(), provider_verified = true, provider_status = 'amd-machine'
      where id = ${call.id} and disposition = ''`;
    await advanceQueue(call, "voicemail");
    await setPresence(call.org_id, call.agent_user_id, "available");
    await redirectLiveCall(cfg, callSid, `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
    return new Response("ok");
  }
  const taken = await sql<{ id: string }>`
    select id from calls
    where org_id = ${orgId} and burst_id <> '' and burst_id = (select burst_id from calls where id = ${call.id})
      and id <> ${call.id} and state = 'in_progress'
    limit 1`;
  if (taken[0]) {
    await sql`
      update calls
      set state = 'canceled', disposition = 'skipped', failure_reason = 'other_line_answered', ended_at = now()
      where id = ${call.id} and disposition = ''`;
    await redirectLiveCall(cfg, callSid, `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
    return new Response("ok");
  }
  const agents = await sql<{ callback_e164: string }>`
    select callback_e164 from memberships where org_id = ${orgId} and user_id = ${call.agent_user_id} and status = 'active' limit 1`;
  const callback = agents[0]?.callback_e164 ?? "";
  const identity = cfg.softphoneReady ? clientIdentity(call.agent_user_id) : null;
  if (!callback && !identity) {
    await redirectLiveCall(cfg, callSid, `<?xml version="1.0" encoding="UTF-8"?><Response><Say>No one is available.</Say><Hangup/></Response>`);
    return new Response("ok");
  }
  await sql`
    update calls
    set state = 'in_progress', answered_at = coalesce(answered_at, now()), provider_status = 'amd-human', provider_verified = true
    where id = ${call.id} and disposition = ''`;
  await dropRingingSiblings(orgId, call.id);
  const whisper = xmlEscape(twilioWhisperUrl(cfg.publicUrl, orgId, call.id));
  const legs = `${identity ? `<Client url="${whisper}">${xmlEscape(identity)}</Client>` : ""}${callback && isE164(callback) ? `<Number url="${whisper}">${xmlEscape(callback)}</Number>` : ""}`;
  await redirectLiveCall(
    cfg,
    callSid,
    `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${xmlEscape(call.from_number)}" timeout="20">${legs}</Dial></Response>`,
  );
  return new Response("ok");
}

async function redirectLiveCall(cfg: TelephonyConfig, callSid: string, twiml: string): Promise<void> {
  if (!/^CA[0-9a-f]{32}$/i.test(callSid)) return;
  await twilioAccountPost(cfg, `/Calls/${callSid}.json`, { Twiml: twiml });
}

export async function placePressOneCall(input: {
  orgId: string;
  callId: string;
  callerId: string;
  contactTo: string;
  say: string;
}): Promise<{ sid: string }> {
  const cfg = await loadTelephony(input.orgId);
  if (!cfg.credentialsPresent) throw new Error("Twilio is not configured. No live call was placed.");
  if (!cfg.publicUrlPresent) throw new Error("Save the published https address in Settings. Press 1 has to call back into this app when they answer.");
  if (!cfg.callerIds.includes(input.callerId)) throw new Error("That caller ID is not in the allow list.");
  if (!isE164(input.contactTo)) throw new Error("The contact number is not E.164.");
  const action = xmlEscape(twilioPressUrl(cfg.publicUrl, input.orgId, input.callId));
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" action="${action}" method="POST" timeout="10"><Say>${xmlEscape(input.say)}</Say></Gather><Say>Goodbye.</Say><Hangup/></Response>`;
  const fields: Record<string, string> = {
    To: input.contactTo,
    From: input.callerId,
    Twiml: twiml,
    StatusCallback: twilioStatusUrl(cfg.publicUrl, input.orgId),
    StatusCallbackMethod: "POST",
  };
  return { sid: await twilioCreateCall(cfg, fields) };
}

function bridgeTwiml(callerId: string, destination: string, transcriptionUrl = ""): string {
  const start = transcriptionUrl
    ? `<Start><Transcription statusCallbackUrl="${xmlEscape(transcriptionUrl)}" statusCallbackMethod="POST" track="both_tracks" /></Start>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${start}<Dial callerId="${xmlEscape(callerId)}" timeout="30"><Number>${xmlEscape(destination)}</Number></Dial></Response>`;
}

async function twilioCreateCall(cfg: TelephonyConfig, fields: Record<string, string>): Promise<string> {
  const created = await twilioAccountPost(cfg, "/Calls.json", fields);
  if (!created.sid) throw new Error(created.message || "Twilio did not create a call.");
  return created.sid;
}

export async function readTwilioBridge(orgId: string, callSid: string): Promise<{ state: string; close: boolean; duration: number | null; failure: string } | null> {
  const cfg = await loadTelephony(orgId);
  if (!cfg.credentialsPresent || !/^CA[0-9a-f]{32}$/i.test(callSid)) return null;
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");
  const headers = { Authorization: `Basic ${auth}` };
  const parentRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls/${callSid}.json`, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!parentRes.ok) return null;
  const parent = (await parentRes.json().catch(() => null)) as { status?: string; duration?: string } | null;
  const childRes = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls.json?ParentCallSid=${encodeURIComponent(callSid)}&PageSize=5`,
    { headers, signal: AbortSignal.timeout(8000) },
  );
  const childBody = childRes.ok ? ((await childRes.json().catch(() => null)) as { calls?: Array<{ status?: string; start_time?: string }> } | null) : null;
  const child = [...(childBody?.calls ?? [])].sort((a, b) => String(b.start_time ?? "").localeCompare(String(a.start_time ?? "")))[0];
  const interpreted = interpretBridgeStatus(parent?.status ?? "", child?.status ?? "");
  const duration = durationSeconds(parent?.duration ?? "");
  const failure = interpreted.state === "failed" ? child?.status || parent?.status || "" : interpreted.state === "canceled" ? parent?.status || "" : "";
  return { ...interpreted, duration, failure };
}

export async function cancelTwilioCall(orgId: string, callSid: string): Promise<void> {
  const cfg = await loadTelephony(orgId);
  if (!cfg.credentialsPresent || !/^CA[0-9a-f]{32}$/i.test(callSid)) return;
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");
  const form = new URLSearchParams({ Status: "completed" });
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls/${callSid}.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(8000),
  }).catch(() => undefined);
}

async function dropRingingSiblings(orgId: string, callId: string) {
  const sql = await getSql();
  const mine = await sql<{ burst_id: string; campaign_id: string | null }>`
    select burst_id, campaign_id from calls where id = ${callId} and org_id = ${orgId} limit 1`;
  const burst = mine[0]?.burst_id ?? "";
  if (!burst) return;
  const others = await sql<{ id: string; provider_call_sid: string | null; contact_id: string | null; campaign_id: string | null }>`
    select id, provider_call_sid, contact_id, campaign_id
    from calls
    where org_id = ${orgId} and burst_id = ${burst} and id <> ${callId}
      and state in ('requested', 'ringing') and disposition = ''`;
  for (const other of others) {
    if (other.provider_call_sid) await cancelTwilioCall(orgId, other.provider_call_sid);
    await sql`
      update calls
      set state = 'canceled', disposition = 'skipped', failure_reason = 'other_line_answered', ended_at = now()
      where id = ${other.id} and org_id = ${orgId} and state in ('requested', 'ringing')`;
    if (other.campaign_id && other.contact_id) {
      await sql`
        update campaign_contacts
        set last_disposition = 'skipped', next_attempt_at = now() + interval '30 minutes'
        where campaign_id = ${other.campaign_id} and contact_id = ${other.contact_id}`;
    }
  }
}

export async function handleTranscription(request: Request): Promise<Response> {
  const orgId = new URL(request.url).searchParams.get("org") ?? "";
  if (!orgId) return new Response("Missing org", { status: 400 });
  const cfg = await loadTelephony(orgId);
  if (!cfg.authToken) return new Response("Twilio is not configured", { status: 503 });
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }
  const signedUrl = twilioTranscriptionUrl(cfg.publicUrl, orgId);
  if (!verifyTwilioSignature(cfg.authToken, signedUrl, params, request.headers.get("x-twilio-signature"))) {
    return new Response("Invalid signature", { status: 403 });
  }
  const line = readTranscriptEvent({
    event: params.TranscriptionEvent ?? "",
    data: params.TranscriptionData ?? "",
    track: params.Track ?? "",
    finalFlag: params.Final ?? "",
  });
  if (!line) return new Response("ok", { status: 200 });
  const callSid = params.CallSid ?? "";
  const sql = await getSql();
  const calls = await sql<{ id: string }>`
    select id from calls where org_id = ${orgId} and provider_call_sid = ${callSid} limit 1`;
  const call = calls[0];
  if (!call) return new Response("ok", { status: 200 });
  if (!line.final) {
    await sql`delete from call_transcripts where call_id = ${call.id} and org_id = ${orgId} and speaker = ${line.speaker} and final = false`;
  }
  await sql`
    insert into call_transcripts (id, org_id, call_id, speaker, body, final)
    values (${newId()}, ${orgId}, ${call.id}, ${line.speaker}, ${line.text}, ${line.final})`;
  return new Response("ok", { status: 200 });
}

export async function handlePressOne(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const orgId = url.searchParams.get("org") ?? "";
  const callId = url.searchParams.get("call") ?? "";
  if (!orgId || !callId) return new Response("Missing call", { status: 400 });
  const cfg = await loadTelephony(orgId);
  if (!cfg.authToken || !cfg.publicUrlPresent) return new Response("Twilio is not configured", { status: 503 });
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }
  if (!verifyTwilioSignature(cfg.authToken, twilioPressUrl(cfg.publicUrl, orgId, callId), params, request.headers.get("x-twilio-signature"))) {
    return new Response("Invalid signature", { status: 403 });
  }
  const sql = await getSql();
  const rows = await sql<{
    id: string;
    org_id: string;
    campaign_id: string | null;
    contact_id: string | null;
    agent_user_id: string;
    from_number: string;
    disposition: string;
    state: string;
  }>`
    select id, org_id, campaign_id, contact_id, agent_user_id, from_number, disposition, state
    from calls where id = ${callId} and org_id = ${orgId} limit 1`;
  const call = rows[0];
  if (!call || call.disposition) return hangupTwiml();
  const digit = (params.Digits ?? "").trim();
  if (digit === "2") {
    await sql`
      update calls
      set disposition = 'do_not_call', state = 'completed', ended_at = now(), provider_verified = true, provider_status = 'pressed-2'
      where id = ${call.id} and disposition = ''`;
    if (call.contact_id) {
      await sql`update contacts set dnc = true, dnc_reason = 'pressed 2', updated_at = now() where id = ${call.contact_id} and org_id = ${orgId}`;
    }
    await advanceQueue(call, "do_not_call");
    return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>You will not be called again. Goodbye.</Say><Hangup/></Response>`);
  }
  if (digit !== "1") {
    await sql`
      update calls
      set disposition = 'no_answer', state = 'completed', ended_at = now(), provider_verified = true, provider_status = 'no-digit'
      where id = ${call.id} and disposition = ''`;
    await advanceQueue(call, "no_answer");
    return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Goodbye.</Say><Hangup/></Response>`);
  }
  const agents = await sql<{ callback_e164: string }>`
    select callback_e164 from memberships where org_id = ${orgId} and user_id = ${call.agent_user_id} and status = 'active' limit 1`;
  const callback = agents[0]?.callback_e164 ?? "";
  const identity = cfg.softphoneReady ? clientIdentity(call.agent_user_id) : null;
  if (!callback && !identity) {
    return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>No one is available to take this call.</Say><Hangup/></Response>`);
  }
  await sql`
    update calls set state = 'in_progress', answered_at = coalesce(answered_at, now()), provider_status = 'pressed-1'
    where id = ${call.id} and disposition = ''`;
  const done = xmlEscape(twilioScreenDoneUrl(cfg.publicUrl, orgId, call.id));
  const whisper = xmlEscape(twilioWhisperUrl(cfg.publicUrl, orgId, call.id));
  const legs = `${identity ? `<Client url="${whisper}">${xmlEscape(identity)}</Client>` : ""}${callback && isE164(callback) ? `<Number url="${whisper}">${xmlEscape(callback)}</Number>` : ""}`;
  return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>One moment while we connect you.</Say><Dial callerId="${xmlEscape(call.from_number)}" action="${done}" method="POST" timeout="20">${legs}</Dial></Response>`);
}

async function readTwilioForm(request: Request): Promise<Record<string, string>> {
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }
  return params;
}

export async function handleWhisper(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const orgId = url.searchParams.get("org") ?? "";
  const callId = url.searchParams.get("call") ?? "";
  if (!orgId || !callId) return hangupTwiml();
  const cfg = await loadTelephony(orgId);
  if (!cfg.authToken) return hangupTwiml();
  const params = await readTwilioForm(request);
  if (!verifyTwilioSignature(cfg.authToken, twilioWhisperUrl(cfg.publicUrl, orgId, callId), params, request.headers.get("x-twilio-signature"))) {
    return new Response("Invalid signature", { status: 403 });
  }
  const sql = await getSql();
  const rows = await sql<{ first_name: string; last_name: string; company: string }>`
    select coalesce(ct.first_name, '') as first_name, coalesce(ct.last_name, '') as last_name, coalesce(ct.company, '') as company
    from calls c
    left join contacts ct on ct.id = c.contact_id
    where c.id = ${callId} and c.org_id = ${orgId}
    limit 1`;
  const row = rows[0];
  const name = [row?.first_name, row?.last_name].filter(Boolean).join(" ") || row?.company || "";
  return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xmlEscape(agentWhisper(name))}</Say></Response>`);
}

export async function handleScreenDone(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const orgId = url.searchParams.get("org") ?? "";
  const callId = url.searchParams.get("call") ?? "";
  if (!orgId || !callId) return hangupTwiml();
  const cfg = await loadTelephony(orgId);
  if (!cfg.authToken) return hangupTwiml();
  const params = await readTwilioForm(request);
  if (!verifyTwilioSignature(cfg.authToken, twilioScreenDoneUrl(cfg.publicUrl, orgId, callId), params, request.headers.get("x-twilio-signature"))) {
    return new Response("Invalid signature", { status: 403 });
  }
  const dialStatus = (params.DialCallStatus ?? "").toLowerCase();
  const reached = dialStatus === "completed" || dialStatus === "answered";
  if (!reached) {
    const sql = await getSql();
    const rows = await sql<{ id: string; org_id: string; campaign_id: string | null; contact_id: string | null; disposition: string }>`
      select id, org_id, campaign_id, contact_id, disposition from calls where id = ${callId} and org_id = ${orgId} limit 1`;
    const call = rows[0];
    if (call && !call.disposition) {
      await sql`
        update calls
        set disposition = 'no_answer', state = 'completed', ended_at = coalesce(ended_at, now()), provider_status = ${dialStatus || "agent-missed"}, provider_verified = true
        where id = ${call.id} and disposition = ''`;
      await advanceQueue(call, "no_answer");
    }
    return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>No one is available right now. Goodbye.</Say><Hangup/></Response>`);
  }
  return hangupTwiml();
}

export async function placeTestRing(orgId: string, to: string): Promise<{ sid: string }> {
  const cfg = await loadTelephony(orgId);
  if (!cfg.credentialsPresent) throw new Error("Save the Twilio account first.");
  if (!isE164(to)) throw new Error("Save your own phone as the callback number first, in international form.");
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>This is ApexDialer. Your Twilio number can reach this phone. You can hang up.</Say></Response>`;
  const sid = await twilioCreateCall(cfg, { To: to, From: cfg.from, Twiml: twiml });
  return { sid };
}

type BridgeCall = {
  id: string;
  org_id: string;
  campaign_id: string | null;
  contact_id: string | null;
  agent_user_id: string;
  state: string;
  disposition: string;
  to_number: string;
  from_number: string;
  recording_policy: string;
  recording_consent: boolean;
  dnc: boolean;
  archived_at: unknown;
};

const LIVE_STATES = new Set(["requested", "ringing", "in_progress"]);

function xmlResponse(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/xml; charset=utf-8" } });
}

function hangupTwiml(): Response {
  return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>This contact cannot be dialed.</Say>
  <Hangup/>
</Response>`);
}

function durationSeconds(raw: string): number | null {
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 8 * 60 * 60) return null;
  return Math.round(value);
}

async function setPresence(orgId: string, userId: string, status: "available" | "wrap_up") {
  const sql = await getSql();
  await sql`
    insert into agent_presence (org_id, user_id, status, updated_at)
    values (${orgId}, ${userId}, ${status}, now())
    on conflict (org_id, user_id) do update set status = ${status}, updated_at = now()`;
}

async function storeRecording(callId: string, orgId: string, rawUrl: string) {
  const safe = safeRecordingUrl(rawUrl);
  if (!safe) return;
  const sql = await getSql();
  await sql`
    update calls set recording_url = ${safe}
    where id = ${callId} and org_id = ${orgId}`;
}

export async function handleTwiml(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const callId = url.searchParams.get("callId") ?? "";
  const token = url.searchParams.get("t");
  const sql = await getSql();
  const rows = await sql<BridgeCall>`
    select c.id, c.org_id, c.campaign_id, c.contact_id, c.agent_user_id, c.state, c.disposition,
           c.to_number, c.from_number, o.recording_policy,
           coalesce(ct.recording_consent, false) as recording_consent,
           coalesce(ct.dnc, false) as dnc,
           ct.archived_at
    from calls c
    join organizations o on o.id = c.org_id
    left join contacts ct on ct.id = c.contact_id
    where c.id = ${callId} and c.channel = 'twilio'
    limit 1`;
  const call = rows[0];
  if (!call) return new Response("Not found", { status: 404 });
  const cfg = await loadTelephony(call.org_id);
  if (!cfg.authToken || !callTokenMatches(cfg.authToken, callId, token)) {
    return new Response("Forbidden", { status: 403 });
  }
  const live = LIVE_STATES.has(call.state) && !call.disposition;
  const dialable = live && !call.dnc && !call.archived_at;
  if (!dialable) {
    if (live) {
      const reason = call.dnc ? "dnc" : call.archived_at ? "archived" : "not_dialable";
      await sql`
        update calls
        set state = 'canceled', ended_at = coalesce(ended_at, now()), failure_reason = ${reason}
        where id = ${call.id} and org_id = ${call.org_id} and disposition = ''
          and state in ('requested', 'ringing', 'in_progress')`;
      await setPresence(call.org_id, call.agent_user_id, "available");
    }
    return hangupTwiml();
  }
  const record = call.recording_policy === "provider_if_consented" && call.recording_consent === true;
  const say = record
    ? "This ApexDialer call may be recorded and transcribed. Connecting you now."
    : "Connecting your ApexDialer call.";
  const recordAttr = record ? ' record="record-from-answer-dual"' : "";
  const action = xmlEscape(twilioStatusUrl(cfg.publicUrl, call.org_id));
  const start = record && cfg.publicUrl ? `<Start><Transcription statusCallbackUrl="${xmlEscape(twilioTranscriptionUrl(cfg.publicUrl, call.org_id))}" statusCallbackMethod="POST" track="both_tracks" /></Start>` : "";
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>${xmlEscape(say)}</Say>
  ${start}
  <Dial callerId="${xmlEscape(call.from_number)}" action="${action}" method="POST"${recordAttr} timeout="30">
    <Number>${xmlEscape(call.to_number)}</Number>
  </Dial>
</Response>`;
  return xmlResponse(xml);
}

async function advanceQueue(
  call: { org_id: string; campaign_id: string | null; contact_id: string | null },
  disposition: string,
) {
  if (!call.campaign_id || !call.contact_id || !disposition || disposition === "skipped") return;
  const sql = await getSql();
  const rows = await sql<{
    attempts: number;
    max_attempts: number;
    retry_minutes: number;
    completed: boolean;
  }>`
    select cc.attempts, c.max_attempts, c.retry_minutes, cc.completed
    from campaign_contacts cc
    join campaigns c on c.id = cc.campaign_id
    where cc.campaign_id = ${call.campaign_id} and cc.contact_id = ${call.contact_id} and c.org_id = ${call.org_id}
    limit 1`;
  const row = rows[0];
  if (!row || row.completed) return;
  const next = nextQueueState({
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    retryMinutes: Number(row.retry_minutes),
    disposition,
    now: new Date(),
  });
  await sql`
    update campaign_contacts
    set attempts = ${next.attempts},
        completed = ${next.completed},
        last_disposition = ${next.lastDisposition},
        next_attempt_at = ${next.nextAttemptAt}
    where campaign_id = ${call.campaign_id} and contact_id = ${call.contact_id}`;
  if (disposition === "do_not_call") {
    await sql`
      update contacts
      set dnc = true, dnc_reason = 'disposition', updated_at = now()
      where id = ${call.contact_id} and org_id = ${call.org_id}`;
  }
}

type TrackedCall = {
  id: string;
  org_id: string;
  campaign_id: string | null;
  contact_id: string | null;
  state: string;
  disposition: string;
  agent_user_id: string;
  provider_status: string;
};

async function applyParentStatus(call: TrackedCall, status: string) {
  const mapped = mapTwilioParentStatus(status);
  const sql = await getSql();
  const agentMiss =
    mapped.state === "canceled" &&
    (call.state === "requested" || call.state === "ringing") &&
    !call.disposition;
  if (agentMiss) {
    const updated = await sql<{ id: string }>`
      update calls
      set state = 'canceled',
          provider_status = ${status},
          ended_at = coalesce(ended_at, now()),
          failure_reason = ${`agent_leg:${status}`.slice(0, 240)}
      where id = ${call.id} and org_id = ${call.org_id} and disposition = ''
        and state in ('requested', 'ringing')
      returning id`;
    if (updated[0]) await setPresence(call.org_id, call.agent_user_id, "available");
    return mapped.state;
  }
  if (!canApplyProviderState(call.state, mapped.state)) return mapped.state;
  const terminal = mapped.state === "completed" || mapped.state === "canceled";
  await sql`
    update calls
    set state = ${mapped.state},
        provider_status = ${status},
        ended_at = case when ${terminal} and ended_at is null then now() else ended_at end
    where id = ${call.id} and org_id = ${call.org_id}`;
  if (mapped.state === "in_progress" && !(call.provider_status ?? "").startsWith("amd")) await dropRingingSiblings(call.org_id, call.id);
  if (mapped.state === "completed") await setPresence(call.org_id, call.agent_user_id, "wrap_up");
  return mapped.state;
}

async function applyDialOutcome(call: TrackedCall, dialStatus: string, durationRaw: string) {
  const mapped = mapDialCallStatus(dialStatus);
  if (!mapped) return "ignored";
  const sql = await getSql();
  const duration = durationSeconds(durationRaw);
  if (call.disposition) {
    if (duration != null) {
      await sql`
        update calls
        set duration_seconds = coalesce(duration_seconds, ${duration}),
            provider_verified = true,
            provider_status = ${dialStatus}
        where id = ${call.id} and org_id = ${call.org_id}`;
    }
    return mapped.state;
  }
  if (mapped.disposition) {
    const claimed = await sql<{ id: string }>`
      update calls
      set disposition = ${mapped.disposition},
          state = ${mapped.state},
          provider_status = ${dialStatus},
          provider_verified = true,
          duration_seconds = coalesce(duration_seconds, ${duration}::int),
          ended_at = coalesce(ended_at, now()),
          failure_reason = case when failure_reason = '' then ${dialStatus} else failure_reason end
      where id = ${call.id} and org_id = ${call.org_id} and disposition = ''
      returning id`;
    if (claimed[0]) {
      await advanceQueue(call, mapped.disposition);
      await setPresence(call.org_id, call.agent_user_id, "wrap_up");
    }
    return mapped.state;
  }
  if (mapped.state === "canceled") {
    await sql`
      update calls
      set state = 'canceled',
          provider_status = ${dialStatus},
          ended_at = coalesce(ended_at, now()),
          failure_reason = case when failure_reason = '' then 'dial_canceled' else failure_reason end
      where id = ${call.id} and org_id = ${call.org_id} and disposition = ''
        and state in ('requested', 'ringing', 'in_progress')`;
    await setPresence(call.org_id, call.agent_user_id, "available");
    return mapped.state;
  }
  await sql`
    update calls
    set state = case when state in ('completed', 'failed', 'canceled') then state else 'completed' end,
        provider_status = ${dialStatus},
        provider_verified = true,
        duration_seconds = coalesce(duration_seconds, ${duration}::int),
        answered_at = coalesce(answered_at, now()),
        ended_at = coalesce(ended_at, now())
    where id = ${call.id} and org_id = ${call.org_id}`;
  await setPresence(call.org_id, call.agent_user_id, "wrap_up");
  return mapped.state;
}

export async function handleTwilioWebhook(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const orgId = requestUrl.searchParams.get("org");
  const cfg = await loadTelephony(orgId);
  if (!cfg.ready) return new Response("Twilio is not configured", { status: 503 });
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }
  const signedUrl = twilioStatusUrl(cfg.publicUrl, orgId);
  const header = request.headers.get("x-twilio-signature");
  if (!verifyTwilioSignature(cfg.authToken, signedUrl, params, header)) {
    return new Response("Invalid signature", { status: 403 });
  }
  const callSid = params.CallSid ?? "";
  const parentSid = params.ParentCallSid ?? "";
  const status = params.CallStatus ?? "";
  const dialStatus = params.DialCallStatus ?? "";
  const recordingUrl = params.RecordingUrl ?? "";
  if (!callSid && !parentSid) return new Response("Missing call", { status: 400 });
  const sql = await getSql();
  const rows = await sql<TrackedCall>`
    select id, org_id, campaign_id, contact_id, state, disposition, agent_user_id, provider_status
    from calls
    where provider_call_sid = ${callSid}
       or (${parentSid} <> '' and provider_call_sid = ${parentSid})
    limit 1`;
  const call = rows[0];
  if (!call) {
    // The agent-leg SID can arrive before we store it. Ack so Twilio does not retry forever.
    return new Response("ignored", { status: 200 });
  }
  if (recordingUrl) await storeRecording(call.id, call.org_id, recordingUrl);
  let nextState = call.state;
  if (dialStatus) {
    nextState = await applyDialOutcome(call, dialStatus, params.DialCallDuration ?? "");
  } else if (status) {
    nextState = await applyParentStatus(call, status);
  } else if (!recordingUrl) {
    return new Response("Missing call", { status: 400 });
  }
  await writeAudit(sql, { orgId: call.org_id, userId: "twilio" }, "call.provider_status", "call", call.id, {
    status: dialStatus || status || "recording",
    state: nextState,
  });
  return new Response("ok", { status: 200 });
}

export async function scrubExpiredRecordings(orgId: string, actorUserId: string, retentionDays: number) {
  const sql = await getSql();
  const rows = await sql<{ n: number }>`
    with updated as (
      update calls
      set recording_url = null
      where org_id = ${orgId}
        and started_at < now() - (${retentionDays}::int * interval '1 day')
        and recording_url is not null
      returning 1
    )
    select count(*)::int as n from updated`;
  const n = Number(rows[0]?.n ?? 0);
  await writeAudit(sql, { orgId, userId: actorUserId }, "retention.scrub", "organization", orgId, {
    rows: n,
    retentionDays,
  });
  return n;
}

function sayHangup(message: string): Response {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xmlEscape(message)}</Say><Hangup/></Response>`;
  return new Response(xml, { status: 200, headers: { "Content-Type": "text/xml" } });
}

/** Inbound voice webhook. Point the Twilio number's "A call comes in" URL here. */
export async function handleInboundCall(request: Request): Promise<Response> {
  const orgId = new URL(request.url).searchParams.get("org") ?? "";
  if (!orgId) return new Response("Missing org", { status: 400 });
  const cfg = await loadTelephony(orgId);
  if (!cfg.ready) return new Response("Twilio is not configured", { status: 503 });
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }
  if (!verifyTwilioSignature(cfg.authToken, twilioInboundUrl(cfg.publicUrl, orgId), params, request.headers.get("x-twilio-signature"))) {
    return new Response("Invalid signature", { status: 403 });
  }
  const from = normalizePhone(params.From ?? "") ?? "";
  const to = normalizePhone(params.To ?? "") ?? "";
  const sid = params.CallSid ?? "";
  if (!from || !to || !cfg.callerIds.includes(to)) return sayHangup("This number is not accepting calls.");
  const sql = await getSql();
  const suppressed = await sql<{ id: string }>`
    select id from contacts
    where org_id = ${orgId} and phone_e164 = ${from} and dnc = true and archived_at is null
    limit 1`;
  if (suppressed[0]) return sayHangup("This number cannot be connected.");
  const menu = await loadIvrMenu(orgId);
  if (menu.options.length > 0) {
    const action = xmlEscape(twilioIvrUrl(cfg.publicUrl, orgId));
    return xmlResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" action="${action}" method="POST" timeout="8"><Say>${xmlEscape(ivrPrompt(menu.greeting, menu.options))}</Say></Gather><Say>Goodbye.</Say></Response>`,
    );
  }
  return connectInboundCaller(orgId, from, to, sid);
}

async function loadIvrMenu(orgId: string): Promise<{ greeting: string; options: ReturnType<typeof parseIvrOptions> }> {
  const sql = await getSql();
  const rows = await sql<{ ivr_greeting: string; ivr_options: string }>`
    select ivr_greeting, ivr_options from org_integrations where org_id = ${orgId} limit 1`;
  return { greeting: rows[0]?.ivr_greeting ?? "", options: parseIvrOptions(rows[0]?.ivr_options ?? "[]") };
}

async function connectInboundCaller(orgId: string, from: string, to: string, sid: string): Promise<Response> {
  const sql = await getSql();
  const agents = await sql<{ user_id: string; callback_e164: string; softphone_until: string | null }>`
    select m.user_id, m.callback_e164, p.softphone_until
    from memberships m
    left join agent_presence p on p.org_id = m.org_id and p.user_id = m.user_id
    where m.org_id = ${orgId} and m.status = 'active'
      and (m.callback_e164 <> '' or p.softphone_until > now())
      and not exists (
        select 1 from calls k
        where k.org_id = m.org_id and k.agent_user_id = m.user_id
          and k.state in ('manual_open', 'requested', 'ringing', 'in_progress')
      )
    order by case when p.softphone_until > now() then 0 when p.status = 'available' then 1 else 2 end, m.created_at asc
    limit 1`;
  const agent = agents[0];
  const fresh = Boolean(agent?.softphone_until && new Date(agent.softphone_until).getTime() > Date.now());
  const identity = agent && fresh ? clientIdentity(agent.user_id) : null;
  const callback = agent && isE164(agent.callback_e164) ? agent.callback_e164 : "";
  const reachable = Boolean(identity || callback);
  const callId = newId();
  try {
    if (!agent || !reachable) {
      await sql`
        insert into calls (
          id, org_id, agent_user_id, direction, channel, state, disposition, from_number, to_number, provider_call_sid, provider_verified, failure_reason, idempotency_key, ended_at
        ) values (
          ${callId}, ${orgId}, ${""}, 'inbound', 'twilio', 'canceled', '', ${to}, ${from}, ${sid || null}, true, 'no_agent', ${sid || callId}, now()
        )`;
      return sayHangup("No agent is available. Please call again later.");
    }
    await sql`
      insert into calls (
        id, org_id, agent_user_id, direction, channel, state, from_number, to_number, provider_call_sid, provider_verified, idempotency_key
      ) values (
        ${callId}, ${orgId}, ${agent.user_id}, 'inbound', 'twilio', 'ringing', ${to}, ${from}, ${sid || null}, true, ${sid || callId}
      )`;
  } catch {
    if (!agent || !reachable) return sayHangup("No agent is available. Please call again later.");
  }
  if (!agent || !reachable) return sayHangup("No agent is available. Please call again later.");
  const leg = identity ? `<Client>${xmlEscape(identity)}</Client>` : `<Number>${xmlEscape(callback)}</Number>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Connecting you now.</Say><Dial callerId="${xmlEscape(to)}" timeout="25">${leg}</Dial></Response>`;
  return new Response(xml, { status: 200, headers: { "Content-Type": "text/xml" } });
}

export async function handleIvr(request: Request): Promise<Response> {
  const orgId = new URL(request.url).searchParams.get("org") ?? "";
  if (!orgId) return new Response("Missing org", { status: 400 });
  const cfg = await loadTelephony(orgId);
  if (!cfg.authToken || !cfg.publicUrlPresent) return new Response("Twilio is not configured", { status: 503 });
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }
  if (!verifyTwilioSignature(cfg.authToken, twilioIvrUrl(cfg.publicUrl, orgId), params, request.headers.get("x-twilio-signature"))) {
    return new Response("Invalid signature", { status: 403 });
  }
  const menu = await loadIvrMenu(orgId);
  const choice = menu.options.find((option) => option.digit === (params.Digits ?? "").trim());
  if (!choice) {
    const action = xmlEscape(twilioIvrUrl(cfg.publicUrl, orgId));
    return xmlResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" action="${action}" method="POST" timeout="8"><Say>${xmlEscape(`That key is not on the menu. ${ivrPrompt("", menu.options)}`)}</Say></Gather><Say>Goodbye.</Say></Response>`,
    );
  }
  if (choice.action === "message") {
    return xmlResponse(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xmlEscape(choice.message)}</Say><Hangup/></Response>`);
  }
  const from = normalizePhone(params.From ?? "") ?? "";
  const to = normalizePhone(params.To ?? "") ?? "";
  const sid = params.CallSid ?? "";
  if (!from || !to) return sayHangup("This call cannot be connected.");
  return connectInboundCaller(orgId, from, to, sid);
}

export async function mintVoiceToken(orgId: string, userId: string): Promise<string> {
  const cfg = await loadTelephony(orgId);
  if (!cfg.softphoneReady) throw new Error("The browser phone needs an API key in Settings.");
  const identity = clientIdentity(userId);
  if (!identity) throw new Error("This user id cannot be a Twilio client identity.");
  return signTwilioVoiceToken({
    accountSid: cfg.accountSid,
    apiKeySid: cfg.apiKeySid,
    apiKeySecret: cfg.apiKeySecret,
    twimlAppSid: cfg.twimlAppSid,
    identity,
  });
}

export async function handleClientVoice(request: Request): Promise<Response> {
  const orgId = new URL(request.url).searchParams.get("org") ?? "";
  if (!orgId) return new Response("Missing org", { status: 400 });
  const cfg = await loadTelephony(orgId);
  if (!cfg.ready) return new Response("Twilio is not configured", { status: 503 });
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }
  if (!verifyTwilioSignature(cfg.authToken, twilioClientUrl(cfg.publicUrl, orgId), params, request.headers.get("x-twilio-signature"))) {
    return new Response("Invalid signature", { status: 403 });
  }
  const callId = params.ApexCallId ?? "";
  const from = params.From ?? "";
  const sid = params.CallSid ?? "";
  const sql = await getSql();
  const rows = await sql<BridgeCall>`
    select c.id, c.org_id, c.campaign_id, c.contact_id, c.agent_user_id, c.state, c.disposition,
           c.to_number, c.from_number, o.recording_policy,
           coalesce(ct.recording_consent, false) as recording_consent,
           coalesce(ct.dnc, false) as dnc,
           ct.archived_at
    from calls c
    join organizations o on o.id = c.org_id
    left join contacts ct on ct.id = c.contact_id
    where c.id = ${callId} and c.org_id = ${orgId} and c.channel = 'twilio'
    limit 1`;
  const call = rows[0];
  const identity = call ? clientIdentity(call.agent_user_id) : null;
  if (!call || !identity || from !== `client:${identity}`) return hangupTwiml();
  const live = LIVE_STATES.has(call.state) && !call.disposition && !call.dnc && !call.archived_at;
  if (!live) return hangupTwiml();
  if (sid) {
    await sql`
      update calls set provider_call_sid = ${sid}, provider_status = 'ringing', state = 'ringing'
      where id = ${call.id} and org_id = ${call.org_id} and disposition = ''`;
  }
  const record = call.recording_policy === "provider_if_consented" && call.recording_consent === true;
  const recordAttr = record ? ' record="record-from-answer-dual"' : "";
  const action = xmlEscape(twilioStatusUrl(cfg.publicUrl, call.org_id));
  const start = record && cfg.publicUrl ? `<Start><Transcription statusCallbackUrl="${xmlEscape(twilioTranscriptionUrl(cfg.publicUrl, call.org_id))}" statusCallbackMethod="POST" track="both_tracks" /></Start>` : "";
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${start}
  <Dial callerId="${xmlEscape(call.from_number)}" action="${action}" method="POST"${recordAttr} timeout="30">
    <Number>${xmlEscape(call.to_number)}</Number>
  </Dial>
</Response>`;
  return xmlResponse(xml);
}

export async function ensureBrowserPhone(orgId: string): Promise<{ apiKeySid: string; twimlAppSid: string; voiceUrl: string; createdKey: boolean }> {
  const cfg = await loadTelephony(orgId);
  if (!cfg.credentialsPresent) throw new Error("Save the Twilio account SID, auth token, and from number first.");
  const voiceUrl = cfg.publicUrlPresent ? twilioClientUrl(cfg.publicUrl, orgId) : "";
  let apiKeySid = cfg.apiKeySid;
  let apiKeySecret = cfg.apiKeySecret;
  let createdKey = false;
  if (!/^SK[0-9a-f]{32}$/i.test(apiKeySid) || !apiKeySecret) {
    const created = await twilioAccountPost(cfg, "/Keys.json", { FriendlyName: "ApexDialer browser phone" });
    apiKeySid = String(created.sid ?? "");
    apiKeySecret = String(created.secret ?? "");
    createdKey = true;
    if (!/^SK[0-9a-f]{32}$/i.test(apiKeySid) || !apiKeySecret) throw new Error("Twilio did not return a usable API key.");
    await storeBrowserPhone(orgId, apiKeySid, apiKeySecret, cfg.twimlAppSid);
  }
  const appFields = { FriendlyName: "ApexDialer voice", VoiceUrl: voiceUrl, VoiceMethod: "POST" };
  let twimlAppSid = cfg.twimlAppSid;
  if (voiceUrl) {
    if (/^AP[0-9a-f]{32}$/i.test(twimlAppSid)) {
      await twilioAccountPost(cfg, `/Applications/${twimlAppSid}.json`, appFields);
    } else {
      const created = await twilioAccountPost(cfg, "/Applications.json", appFields);
      twimlAppSid = String(created.sid ?? "");
      if (!/^AP[0-9a-f]{32}$/i.test(twimlAppSid)) throw new Error("Twilio did not return a TwiML app.");
    }
  }
  await storeBrowserPhone(orgId, apiKeySid, apiKeySecret, twimlAppSid);
  return { apiKeySid, twimlAppSid, voiceUrl, createdKey };
}

async function storeBrowserPhone(orgId: string, apiKeySid: string, apiKeySecret: string, twimlAppSid: string) {
  const sql = await getSql();
  await sql`
    insert into org_integrations (org_id, twilio_api_key_sid, twilio_api_key_secret, twilio_twiml_app_sid)
    values (${orgId}, ${apiKeySid}, ${apiKeySecret}, ${twimlAppSid})
    on conflict (org_id) do update set
      twilio_api_key_sid = excluded.twilio_api_key_sid,
      twilio_api_key_secret = excluded.twilio_api_key_secret,
      twilio_twiml_app_sid = excluded.twilio_twiml_app_sid,
      updated_at = now()`;
}

async function twilioAccountPost(cfg: TelephonyConfig, path: string, fields: Record<string, string>): Promise<{ sid?: string; secret?: string; message?: string }> {
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}${path}`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(12000),
  });
  const body = (await response.json().catch(() => null)) as { sid?: string; secret?: string; message?: string } | null;
  if (!response.ok) throw new Error(body?.message || `Twilio returned ${response.status}.`);
  return body ?? {};
}

export async function transferLiveCall(orgId: string, callSid: string, to: string, callerId: string): Promise<void> {
  const cfg = await loadTelephony(orgId);
  if (!cfg.credentialsPresent) throw new Error("Twilio is not configured.");
  if (!isE164(to) || !isE164(callerId)) throw new Error("Transfer needs two E.164 numbers.");
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${xmlEscape(callerId)}"><Number>${xmlEscape(to)}</Number></Dial></Response>`;
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");
  const form = new URLSearchParams({ Twiml: twiml });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls/${callSid}.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message || `Twilio did not transfer the call (${response.status}).`);
  }
}

export function freshAuditId(): string {
  return newId();
}

export async function sendTwilioSms(orgId: string, to: string, body: string, fromOverride = ""): Promise<{ sid: string; from: string }> {
  const cfg = await loadTelephony(orgId);
  if (!cfg.credentialsPresent) throw new Error("Save your Twilio account in Settings before sending a text.");
  const whatsapp = to.startsWith("whatsapp:");
  const rawTo = whatsapp ? to.slice("whatsapp:".length) : to;
  if (!isE164(rawTo)) throw new Error("The contact number is not E.164.");
  const from = fromOverride || cfg.from;
  if (!from) throw new Error("A From number is required to send a text.");
  const fields: Record<string, string> = { To: whatsapp ? `whatsapp:${rawTo}` : rawTo, From: from, Body: body.slice(0, 320) };
  if (cfg.publicUrlPresent) fields.StatusCallback = twilioSmsUrl(cfg.publicUrl, orgId);
  const result = await twilioAccountPost(cfg, "/Messages.json", fields);
  if (!result.sid) throw new Error(result.message || "Twilio did not accept the text.");
  return { sid: result.sid, from: cfg.from };
}

export async function playVoicemailOnCall(orgId: string, callSid: string, script: string, audioUrl = ""): Promise<void> {
  const cfg = await loadTelephony(orgId);
  if (!cfg.credentialsPresent) throw new Error("Twilio is not configured.");
  if (!/^CA[0-9a-f]{32}$/i.test(callSid)) throw new Error("That call has no Twilio id yet.");
  const spoken = script.replace(/\s+/g, " ").trim().slice(0, 500);
  const play = audioUrl ? `<Play>${xmlEscape(audioUrl)}</Play>` : "";
  if (!play && spoken.length < 8) throw new Error("Add a voicemail script or an https audio clip.");
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response>${play || `<Say>${xmlEscape(spoken)}</Say>`}<Hangup/></Response>`;
  const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString("base64");
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls/${callSid}.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ Twiml: twiml }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message || `Twilio did not play the voicemail (${response.status}).`);
  }
}

/** Inbound SMS webhook. Point the Twilio number's "A message comes in" URL here. */
export async function handleInboundSms(request: Request): Promise<Response> {
  const orgId = new URL(request.url).searchParams.get("org") ?? "";
  if (!orgId) return new Response("Missing org", { status: 400 });
  const cfg = await loadTelephony(orgId);
  if (!cfg.credentialsPresent) return new Response("Twilio is not configured", { status: 503 });
  const form = await request.formData();
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") params[key] = value;
  }
  const signedUrl = cfg.publicUrl ? twilioSmsUrl(cfg.publicUrl, orgId) : "";
  if (!verifyTwilioSignature(cfg.authToken, signedUrl, params, request.headers.get("x-twilio-signature"))) {
    return new Response("Invalid signature", { status: 403 });
  }
  const from = normalizePhone(params.From ?? "") ?? "";
  const to = normalizePhone(params.To ?? "") ?? "";
  const body = (params.Body ?? "").replace(/\s+/g, " ").trim().slice(0, 1000);
  const sid = (params.MessageSid ?? "").slice(0, 64);
  if (!from || !body) return new Response("", { status: 200 });
  const sql = await getSql();
  const contacts = await sql<{ id: string }>`
    select id from contacts
    where org_id = ${orgId} and phone_e164 = ${from} and archived_at is null
    limit 1`;
  const contactId = contacts[0]?.id ?? null;
  const stop = isSmsStop(body);
  if (stop && contactId) {
    await sql`update contacts set sms_consent = false, updated_at = now() where id = ${contactId} and org_id = ${orgId}`;
  }
  try {
    await sql`
      insert into messages (
        id, org_id, contact_id, agent_user_id, direction, body, from_number, to_number, status, provider_sid
      ) values (
        ${newId()}, ${orgId}, ${contactId}, ${""}, 'inbound', ${body}, ${from}, ${to}, 'received', ${sid || null}
      )`;
  } catch {
    return new Response("", { status: 200 });
  }
  if (!stop) return new Response("", { status: 200 });
  const reply = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>You are unsubscribed and will not get more texts from this number.</Message></Response>`;
  return new Response(reply, { status: 200, headers: { "Content-Type": "text/xml" } });
}
