import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { jwtVerify } from "jose";
import { signTwilioVoiceToken } from "./voice-token";
import { buildBrief, coachCall, importRowWarnings, rankLead, reviewScriptCoverage, suggestFromNotes } from "./assist";
import { chooseCallerId } from "./caller-id";
import { interpretContactCsv, csvCell } from "./csv";
import { canApplyProviderState, correctedQueueFlags, interpretBridgeStatus, mapDialCallStatus, mapTwilioCallStatus, mapTwilioParentStatus, nextQueueState } from "./dispositions";
import { summarizeCalls } from "./metrics";
import { can, canEditMember, canGrantRole } from "./permissions";
import { normalizePhone } from "./phone";
import { billingAllowsMutation, planLimits } from "./plans";
import { verifyStripeSignature } from "./stripe-sign";
import { normalizePublicOrigin, safeRecordingUrl, twilioSignature, twilioStatusUrl, verifyTwilioSignature, xmlEscape } from "./twilio-sign";
import { fillSmsTemplate, isSmsStop, smsProblems } from "./sms";
import { safeOutboundUrl, salesforceBase } from "./adapters";
import { isMachineAnswer } from "./amd";
import { predictiveLines } from "./pace";
import { audioClipUrl, callerIdLoad, followUpText } from "./library";
import { ivrPrompt, parseIvrOptions } from "./ivr";
import { agentWhisper, pressOneLine, readTranscriptEvent, summarizeTranscript } from "./speech";
import { replyToObjection } from "./talk";
import { twilioSetupChecks } from "./twilio-setup";
import { isWithinCallingWindow, validateCampaignConfig } from "./windows";

test("normalizes US and E.164 numbers and rejects junk", () => {
  assert.equal(normalizePhone("(312) 555-0100"), "+13125550100");
  assert.equal(normalizePhone("13125550100"), "+13125550100");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("555-0100"), null);
  assert.equal(normalizePhone("not a phone"), null);
  assert.equal(normalizePhone("+012345678"), null);
});

test("enforces calling windows in the contact timezone", () => {
  const wednesdayMorning = new Date("2026-04-15T15:00:00Z");
  const ok = isWithinCallingWindow({
    now: wednesdayMorning,
    timeZone: "America/Chicago",
    start: "09:00",
    end: "20:00",
    days: [1, 2, 3, 4, 5],
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.localTime, "10:00");

  const tooEarly = isWithinCallingWindow({
    now: new Date("2026-04-15T13:00:00Z"),
    timeZone: "America/Chicago",
    start: "09:00",
    end: "20:00",
    days: [1, 2, 3, 4, 5],
  });
  assert.equal(tooEarly.ok, false);

  const sunday = isWithinCallingWindow({
    now: new Date("2026-04-12T15:00:00Z"),
    timeZone: "America/Chicago",
    start: "09:00",
    end: "20:00",
    days: [1, 2, 3, 4, 5],
  });
  assert.equal(sunday.ok, false);
});

test("rejects aggressive or overnight campaign windows", () => {
  const errors = validateCampaignConfig({
    name: "Spring",
    dialMode: "manual",
    windowStart: "07:00",
    windowEnd: "22:00",
    callingDays: [1],
    maxAttempts: 12,
    retryMinutes: 1,
    callerId: "",
    timezone: "America/Chicago",
  });
  assert.ok(errors.some((e) => e.includes("08:00")));
  assert.ok(errors.some((e) => e.includes("Max attempts")));
  assert.ok(errors.some((e) => e.includes("Retry")));
});

test("queue updates do not double-count skips and stop at max attempts", () => {
  const now = new Date("2026-04-15T15:00:00Z");
  const skipped = nextQueueState({
    attempts: 1,
    maxAttempts: 3,
    retryMinutes: 60,
    disposition: "skipped",
    now,
  });
  assert.equal(skipped.attempts, 1);
  assert.equal(skipped.completed, false);

  const capped = nextQueueState({
    attempts: 2,
    maxAttempts: 3,
    retryMinutes: 60,
    disposition: "no_answer",
    now,
  });
  assert.equal(capped.attempts, 3);
  assert.equal(capped.completed, true);

  const dnc = nextQueueState({
    attempts: 0,
    maxAttempts: 3,
    retryMinutes: 60,
    disposition: "do_not_call",
    now,
  });
  assert.equal(dnc.completed, true);
  assert.equal(dnc.attempts, 1);
});

test("connection rate is null when nothing was attempted", () => {
  const empty = summarizeCalls([{ state: "manual_open", disposition: "", providerVerified: false, durationSeconds: null }]);
  assert.equal(empty.attempts, 0);
  assert.equal(empty.reportedConnectionRate, null);
  assert.equal(empty.verifiedConnectionRate, null);

  const mixed = summarizeCalls([
    { state: "completed", disposition: "answered", providerVerified: false, durationSeconds: 30 },
    { state: "failed", disposition: "no_answer", providerVerified: true, durationSeconds: 0 },
    { state: "canceled", disposition: "", providerVerified: false, durationSeconds: null },
  ]);
  assert.equal(mixed.attempts, 2);
  assert.equal(mixed.connects, 1);
  assert.equal(mixed.verifiedAttempts, 1);
  assert.equal(mixed.verifiedConnects, 0);
  assert.equal(mixed.reportedConnectionRate, 0.5);
});

test("csv import reports invalid phones and keeps valid rows", () => {
  const csv = "phone,first_name,tags\n3125550100,Ada,vip|north\nbad,Grace,\n3125550100,Dup,\n";
  const result = interpretContactCsv(csv);
  const named = interpretContactCsv("name,phone,address\nAda Lovelace,3125550199,14 King Street\n");
  assert.equal(named.rows[0]?.firstName, "Ada Lovelace");
  assert.equal(named.rows[0]?.address, "14 King Street");
  assert.equal(named.issues.length, 0);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.phoneE164, "+13125550100");
  assert.deepEqual(result.rows[0]?.tags, ["vip", "north"]);
  assert.equal(result.issues.length, 2);
});

test("permissions are enforced by role rank", () => {
  assert.equal(can("agent", "dial"), true);
  assert.equal(can("agent", "export_contacts"), false);
  assert.equal(can("agent", "manage_settings"), false);
  assert.equal(can("supervisor", "view_audit"), true);
  assert.equal(can("supervisor", "manage_team"), false);
  assert.equal(can("admin", "manage_dnc"), true);
  assert.equal(can("owner", "test_telephony"), true);
});

test("billing gate blocks past_due mutations and trial limits are finite", () => {
  assert.equal(billingAllowsMutation("trial"), true);
  assert.equal(billingAllowsMutation("active"), true);
  assert.equal(billingAllowsMutation("past_due"), false);
  assert.equal(billingAllowsMutation("canceled"), false);
  assert.equal(planLimits("trial").maxContacts, 500);
  assert.equal(planLimits("nope").maxAgents, 3);
});

test("twilio signatures accept the official payload and reject tampering", () => {
  const token = "test-token";
  const url = "https://example.com/api/telephony/twilio";
  const params = { CallSid: "CA123", CallStatus: "completed" };
  const sig = twilioSignature(token, url, params);
  assert.equal(verifyTwilioSignature(token, url, params, sig), true);
  assert.equal(verifyTwilioSignature(token, url, params, "nope"), false);
  assert.equal(verifyTwilioSignature(token, url, { ...params, CallStatus: "failed" }, sig), false);
});

test("stripe signatures expire and reject a wrong secret", () => {
  const secret = "whsec_test";
  const body = '{"id":"evt_1"}';
  const t = 1_700_000_000;
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  const header = `t=${t},v1=${v1}`;
  assert.equal(verifyStripeSignature(secret, body, header, t).ok, true);
  assert.equal(verifyStripeSignature(secret, body, header, t + 301).ok, false);
  assert.equal(verifyStripeSignature("other", body, header, t).ok, false);
  assert.equal(verifyStripeSignature("", body, header, t).ok, false);
});

test("xml escape neutralizes twiml injection", () => {
  const escaped = xmlEscape('say <a & "x">');
  assert.equal(escaped.includes("<"), false);
  assert.equal(escaped.includes(">"), false);
  assert.equal(escaped.includes("&amp;"), true);
  assert.equal(escaped.includes("&lt;"), true);
  assert.equal(escaped.includes("&gt;"), true);
  assert.equal(escaped.includes("&quot;"), true);
});

test("provider state cannot regress after a terminal webhook", () => {
  assert.equal(canApplyProviderState("requested", "completed"), true);
  assert.equal(canApplyProviderState("ringing", "in_progress"), true);
  assert.equal(canApplyProviderState("completed", "ringing"), false);
  assert.equal(canApplyProviderState("failed", "completed"), false);
  assert.deepEqual(mapTwilioCallStatus("no-answer"), { state: "failed", disposition: "no_answer" });
  assert.deepEqual(mapTwilioParentStatus("no-answer"), { state: "canceled", disposition: "" });
  assert.deepEqual(mapDialCallStatus("completed"), { state: "completed", disposition: "" });
  assert.equal(mapDialCallStatus("in-progress"), null);
});

test("supervisor correction does not add an attempt and reopens a non-terminal outcome", () => {
  assert.equal(correctedQueueFlags({ attempts: 1, maxAttempts: 3, disposition: "interested" }).completed, true);
  assert.equal(correctedQueueFlags({ attempts: 1, maxAttempts: 3, disposition: "no_answer" }).completed, false);
  assert.equal(correctedQueueFlags({ attempts: 3, maxAttempts: 3, disposition: "no_answer" }).completed, true);
  assert.equal(correctedQueueFlags({ attempts: 3, maxAttempts: 3, disposition: "callback" }).completed, false);
});

test("only an owner can grant admin, and admins cannot edit peers", () => {
  assert.equal(canGrantRole("owner", "admin"), true);
  assert.equal(canGrantRole("admin", "admin"), false);
  assert.equal(canGrantRole("admin", "supervisor"), true);
  assert.equal(canEditMember("admin", "admin"), false);
  assert.equal(canEditMember("admin", "agent"), true);
  assert.equal(canEditMember("owner", "owner"), true);
});

test("csv export neutralizes spreadsheet formulas", () => {
  assert.equal(csvCell("=cmd|'/c calc'!A1"), "'=cmd|'/c calc'!A1");
  assert.equal(csvCell("+13125550100"), "'+13125550100");
  assert.equal(csvCell("Ada"), "Ada");
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
});

test("recording urls must be https on a twilio host", () => {
  assert.equal(safeRecordingUrl("https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1"), "https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1");
  assert.equal(safeRecordingUrl("http://api.twilio.com/recording"), "");
  assert.equal(safeRecordingUrl("https://evil.example/recording"), "");
  assert.equal(safeRecordingUrl("not a url"), "");
});

test("public origin is https with no path", () => {
  assert.equal(normalizePublicOrigin("https://dial.example.com/"), "https://dial.example.com");
  assert.equal(normalizePublicOrigin("http://dial.example.com"), null);
  assert.equal(normalizePublicOrigin("https://dial.example.com/app"), null);
  assert.equal(normalizePublicOrigin(""), "");
  assert.equal(twilioStatusUrl("https://dial.example.com", "org-1"), "https://dial.example.com/api/telephony/twilio?org=org-1");
});

test("next lead prefers a due callback over a first attempt outside the window", () => {
  const due = rankLead({ attempts: 2, lastDisposition: "callback", callbackDue: true, callable: true });
  const fresh = rankLead({ attempts: 0, lastDisposition: "", callbackDue: false, callable: false });
  assert.ok(due.score > fresh.score);
  assert.match(due.reason, /follow-up/i);
});

test("brief uses the campaign line and does not invent a product", () => {
  const brief = buildBrief({
    firstName: "Ada",
    company: "Northline",
    timezone: "America/Chicago",
    notes: "Asked about hours",
    tags: ["vip"],
    attempts: 1,
    lastDisposition: "no_answer",
    history: ["no_answer"],
    script: "Hi Ada, this is Northline about your request.",
  });
  assert.equal(brief.opener, "Hi Ada, this is Northline about your request.");
  assert.equal(brief.source, "rules");
  assert.match(brief.headline, /Attempt 2/);
});

test("script check only flags lines the campaign marked as required", () => {
  const empty = reviewScriptCoverage("They asked for pricing.", "Hello there.\nThanks for your time.");
  assert.equal(empty.items.length, 0);
  const review = reviewScriptCoverage("They asked about the pricing sheet next week.", "* Mention the pricing sheet\nMUST: Confirm the callback day\nJust chatter");
  assert.equal(review.missing.includes("Confirm the callback day"), true);
  assert.equal(review.covered.some((item) => item.includes("pricing")), true);
});

test("note draft suggests do-not-call and coach flags a thin callback", () => {
  const draft = suggestFromNotes("please do not call this person", "answered");
  assert.equal(draft.disposition, "do_not_call");
  const flags = coachCall({ notes: "later", disposition: "callback", durationSeconds: 40 });
  assert.ok(flags.some((flag) => /follow-up/i.test(flag)));
  assert.ok(importRowWarnings({ email: "nope", timezone: "", notes: "DNC" }).length >= 2);
});

test("local presence keeps the area code when that caller ID is allow-listed", () => {
  assert.equal(chooseCallerId("+13125550100", ["+14155550100", "+13125550999"], "+14155550100"), "+13125550999");
  assert.equal(chooseCallerId("+442071234567", ["+14155550100", "+13125550999"], "+13125550999"), "+13125550999");
});

test("connection addresses stay on the public internet", () => {
  assert.equal(safeOutboundUrl("http://example.com/hook"), null);
  assert.equal(safeOutboundUrl("https://127.0.0.1/hook"), null);
  assert.equal(safeOutboundUrl("https://10.0.0.5/hook"), null);
  assert.ok(safeOutboundUrl("https://hooks.example.com/apex"));
  assert.equal(salesforceBase("https://evil.example.com"), null);
  assert.ok(salesforceBase("https://acme.my.salesforce.com")?.includes("salesforce.com"));
});

test("answering machine detection leaves people connected", () => {
  assert.equal(isMachineAnswer("machine_start"), false);
  assert.equal(isMachineAnswer("machine_end_beep"), true);
  assert.equal(isMachineAnswer("machine_end_silence"), true);
  assert.equal(isMachineAnswer("machine_end_other"), true);
  assert.equal(isMachineAnswer("fax"), true);
  assert.equal(isMachineAnswer("human"), false);
  assert.equal(isMachineAnswer("unknown"), false);
});

test("predictive pace stays at four lines and slows down when people answer", () => {
  assert.equal(predictiveLines(0, 0), 3);
  assert.equal(predictiveLines(20, 12), 3);
  assert.equal(predictiveLines(20, 2), 10);
});

test("a missed call texts only with consent, a template, and one send", () => {
  const base = { disposition: "no_answer", missSms: true, template: "Hi {{first_name}}", smsConsent: true, dnc: false, alreadySent: false };
  assert.equal(followUpText(base).send, true);
  assert.equal(followUpText({ ...base, smsConsent: false }).send, false);
  assert.equal(followUpText({ ...base, disposition: "answered" }).send, false);
  assert.equal(followUpText({ ...base, alreadySent: true }).send, false);
  assert.equal(audioClipUrl("http://example.com/a.mp3"), null);
  assert.equal(audioClipUrl("https://cdn.example.com/drop.mp3"), "https://cdn.example.com/drop.mp3");
  assert.equal(callerIdLoad(90).label, "Rest this number");
  assert.equal(callerIdLoad(10).tone, "quiet");
});

test("an inbound menu ignores a blank key and speaks the ones that are filled in", () => {
  const options = parseIvrOptions(JSON.stringify([
    { digit: "1", label: "Sales", action: "agent" },
    { digit: "1", label: "Duplicate", action: "agent" },
    { digit: "2", label: "Hours", action: "message", message: "We are open until five." },
    { digit: "3", label: "", action: "agent" },
  ]));
  assert.equal(options.length, 2);
  assert.match(ivrPrompt("Thanks for calling.", options), /Press 1 for Sales/);
  assert.match(ivrPrompt("Thanks for calling.", options), /Press 2 for Hours/);
});

test("press 1 line always tells them which key connects", () => {
  const line = pressOneLine("Northline", "Hi Ada, this is about your request.");
  assert.match(line, /Press 1/);
  assert.match(line, /Press 2/);
  assert.match(line, /Ada/);
  assert.match(agentWhisper("Ada Chen"), /Ada Chen/);
});

test("transcript events ignore anything that is not a content line", () => {
  assert.equal(readTranscriptEvent({ event: "transcription-started", data: "", track: "", finalFlag: "" }), null);
  const line = readTranscriptEvent({
    event: "transcription-content",
    data: JSON.stringify({ transcript: "Can you send pricing?" }),
    track: "outbound_track",
    finalFlag: "true",
  });
  assert.equal(line?.speaker, "contact");
  assert.equal(line?.final, true);
  const summary = summarizeTranscript(["agent: Hello", "contact: Can you send pricing?"]);
  assert.match(summary.summary, /Hello/);
  assert.equal(summary.points.length, 1);
});

test("twilio setup fails closed until every required value is present", () => {
  const empty = twilioSetupChecks({ accountSid: "", authTokenPresent: false, from: "", callerIds: [], publicUrl: "", callbackPhone: "" });
  assert.equal(empty.some((check) => check.ok), false);
  const ready = twilioSetupChecks({
    accountSid: `AC${"ab".repeat(16)}`,
    authTokenPresent: true,
    from: "+13125550100",
    callerIds: ["+13125550100"],
    publicUrl: "https://dial.example.com",
    callbackPhone: "+13125550199",
  });
  assert.equal(ready.every((check) => check.ok), true);
});

test("browser phone token grants voice without exposing the secret", async () => {
  const secret = "browser-phone-secret";
  const apiKeySid = `SK${"cd".repeat(16)}`;
  const appSid = `AP${"ef".repeat(16)}`;
  const token = await signTwilioVoiceToken({
    accountSid: `AC${"ab".repeat(16)}`,
    apiKeySid,
    apiKeySecret: secret,
    twimlAppSid: appSid,
    identity: "agent_1",
    nowSeconds: 1_700_000_000,
  });
  assert.equal(token.includes(secret), false);
  const checked = await jwtVerify(token, new TextEncoder().encode(secret), {
    currentDate: new Date(1_700_000_000 * 1000),
  });
  assert.equal(checked.protectedHeader.cty, "twilio-fpa;v=1");
  assert.equal(checked.payload.iss, apiKeySid);
  const grants = checked.payload.grants as { identity: string; voice: { outgoing: { application_sid: string }; incoming: { allow: boolean } } };
  assert.equal(grants.identity, "agent_1");
  assert.equal(grants.voice.outgoing.application_sid, appSid);
  assert.equal(grants.voice.incoming.allow, true);
});

test("a browser token can register without a TwiML app", async () => {
  const token = await signTwilioVoiceToken({
    accountSid: `AC${"ab".repeat(16)}`,
    apiKeySid: `SK${"cd".repeat(16)}`,
    apiKeySecret: "browser-phone-secret",
    twimlAppSid: "",
    identity: "agent_1",
    nowSeconds: 1_700_000_000,
  });
  const checked = await jwtVerify(token, new TextEncoder().encode("browser-phone-secret"), {
    currentDate: new Date(1_700_000_000 * 1000),
  });
  const grants = checked.payload.grants as { voice: { outgoing?: { application_sid: string }; incoming: { allow: boolean } } };
  assert.equal(grants.voice.incoming.allow, true);
  assert.equal(grants.voice.outgoing, undefined);
});

test("bridge status follows the contact leg when the agent already answered", () => {
  assert.equal(interpretBridgeStatus("in-progress", "").state, "in_progress");
  assert.equal(interpretBridgeStatus("completed", "no-answer").state, "failed");
  assert.equal(interpretBridgeStatus("no-answer", "").state, "canceled");
  assert.equal(interpretBridgeStatus("completed", "completed").state, "completed");
});

test("texts fill tokens, refuse unconsented numbers, and recognize STOP", () => {
  assert.equal(
    fillSmsTemplate("Hi {{first_name}}, from {{agent}} at {{company}}.", { firstName: "Ada", company: "North", agent: "Lee" }),
    "Hi Ada, from Lee at North.",
  );
  assert.deepEqual(smsProblems({ body: "Hi", smsConsent: false, dnc: false }), ["Texting needs SMS consent saved on the contact."]);
  assert.equal(smsProblems({ body: "Hi", smsConsent: true, dnc: false }).length, 0);
  assert.equal(isSmsStop("STOP please"), true);
  assert.equal(isSmsStop("please stop"), false);
});

test("objection desk stays specific and does not invent a price", () => {
  const price = replyToObjection("this is too expensive");
  assert.match(price.line, /time today/);
  assert.equal(/\$|discount|percent/i.test(price.line), false);
  const blank = replyToObjection("   ");
  assert.match(blank.line, /stop talking/);
});

