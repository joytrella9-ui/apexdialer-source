import { createHmac, timingSafeEqual } from "node:crypto";

export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const keys = Object.keys(params).sort();
  let data = url;
  for (const key of keys) data += key + params[key];
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  header: string | null,
): boolean {
  if (!header || !authToken) return false;
  const expected = twilioSignature(authToken, url, params);
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function signCallToken(secret: string, callId: string): string {
  return createHmac("sha256", secret).update(callId, "utf8").digest("base64url");
}

export function callTokenMatches(secret: string, callId: string, token: string | null): boolean {
  if (!secret || !token) return false;
  const expected = signCallToken(secret, callId);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Recording callbacks are stored only when they are HTTPS URLs on a Twilio host. */
export function safeRecordingUrl(value: string): string {
  if (!value || value.length > 500) return "";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (url.protocol !== "https:" || url.username || url.password) return "";
  const host = url.hostname.toLowerCase();
  if (host !== "api.twilio.com" && !host.endsWith(".twilio.com")) return "";
  return url.toString();
}

/** Public https origin only. Empty is unset. Null is invalid. */
export function normalizePublicOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

export function twilioStatusUrl(publicUrl: string, orgId: string | null): string {
  const base = `${publicUrl.replace(/\/$/, "")}/api/telephony/twilio`;
  if (!orgId) return base;
  return `${base}?org=${encodeURIComponent(orgId)}`;
}

export function twilioInboundUrl(publicUrl: string, orgId: string): string {
  return `${publicUrl.replace(/\/$/, "")}/api/telephony/inbound?org=${encodeURIComponent(orgId)}`;
}

export function twilioClientUrl(publicUrl: string, orgId: string): string {
  return `${publicUrl.replace(/\/$/, "")}/api/telephony/client?org=${encodeURIComponent(orgId)}`;
}

export function twilioTranscriptionUrl(publicUrl: string, orgId: string): string {
  return `${publicUrl.replace(/\/$/, "")}/api/telephony/transcription?org=${encodeURIComponent(orgId)}`;
}

export function twilioPressUrl(publicUrl: string, orgId: string, callId: string): string {
  return `${publicUrl.replace(/\/$/, "")}/api/telephony/press?org=${encodeURIComponent(orgId)}&call=${encodeURIComponent(callId)}`;
}

export function twilioWhisperUrl(publicUrl: string, orgId: string, callId: string): string {
  return `${publicUrl.replace(/\/$/, "")}/api/telephony/whisper?org=${encodeURIComponent(orgId)}&call=${encodeURIComponent(callId)}`;
}

export function twilioScreenDoneUrl(publicUrl: string, orgId: string, callId: string): string {
  return `${publicUrl.replace(/\/$/, "")}/api/telephony/screen?org=${encodeURIComponent(orgId)}&call=${encodeURIComponent(callId)}`;
}

export function twilioIvrUrl(publicUrl: string, orgId: string): string {
  return `${publicUrl.replace(/\/$/, "")}/api/telephony/ivr?org=${encodeURIComponent(orgId)}`;
}

export function twilioAmdUrl(publicUrl: string, orgId: string, callId: string): string {
  return `${publicUrl.replace(/\/$/, "")}/api/telephony/amd?org=${encodeURIComponent(orgId)}&call=${encodeURIComponent(callId)}`;
}

export function twilioSmsUrl(publicUrl: string, orgId: string): string {
  return `${publicUrl.replace(/\/$/, "")}/api/telephony/sms?org=${encodeURIComponent(orgId)}`;
}
