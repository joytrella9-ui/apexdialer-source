import { SignJWT } from "jose";

export function clientIdentity(userId: string): string | null {
  if (/^[A-Za-z0-9_@.\-]{1,121}$/.test(userId)) return userId;
  return null;
}

/** Twilio Voice access token. The browser can register a softphone; it cannot read the API secret. */
export async function signTwilioVoiceToken(input: {
  accountSid: string;
  apiKeySid: string;
  apiKeySecret: string;
  twimlAppSid: string;
  identity: string;
  nowSeconds?: number;
  ttlSeconds?: number;
}): Promise<string> {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? 60 * 60;
  const voice: { incoming: { allow: boolean }; outgoing?: { application_sid: string } } = {
    incoming: { allow: true },
  };
  if (/^AP[0-9a-f]{32}$/i.test(input.twimlAppSid)) {
    voice.outgoing = { application_sid: input.twimlAppSid };
  }
  return new SignJWT({
    grants: {
      identity: input.identity,
      voice,
    },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT", cty: "twilio-fpa;v=1" })
    .setIssuer(input.apiKeySid)
    .setSubject(input.accountSid)
    .setJti(`${input.apiKeySid}-${now}`)
    .setIssuedAt(now)
    .setNotBefore(now - 30)
    .setExpirationTime(now + ttl)
    .sign(new TextEncoder().encode(input.apiKeySecret));
}
