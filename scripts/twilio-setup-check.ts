import { twilioSetupChecks } from "../src/lib/dialer/twilio-setup";

const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() ?? "";
const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() ?? "";
const from = process.env.TWILIO_FROM_NUMBER?.trim() ?? "";
const publicUrl = (process.env.APEX_PUBLIC_URL ?? "").trim().replace(/\/$/, "");
const checks = twilioSetupChecks({
  accountSid,
  authTokenPresent: Boolean(authToken),
  from,
  callerIds: from ? [from] : [],
  publicUrl,
  callbackPhone: process.env.TWILIO_TEST_CALLBACK?.trim() ?? "",
});

let live = "not checked";
try {
  if (!accountSid || !authToken) {
    const response = await fetch("https://api.twilio.com/2010-04-01/Accounts.json", { signal: AbortSignal.timeout(8000) });
    live = response.status === 401 ? "API reachable, credentials unset" : `API returned ${response.status} before credentials were sent`;
  } else {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(8000),
    });
    const body = (await response.json().catch(() => null)) as { friendly_name?: string; message?: string } | null;
    live = response.ok ? `account lookup ok: ${body?.friendly_name || "unnamed"}` : `account lookup failed: ${body?.message || response.status}`;
  }
} catch (error) {
  live = error instanceof Error ? error.message : "request failed";
}

console.log(JSON.stringify({ live, checks }, null, 2));
if (!checks.every((check) => check.ok) || !live.startsWith("account lookup ok")) {
  process.exitCode = 2;
}
