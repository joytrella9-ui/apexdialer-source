import { smsProblems } from "./sms";

const MISS = new Set(["no_answer", "busy", "voicemail"]);

export function followUpText(input: {
  disposition: string;
  missSms: boolean;
  template: string;
  smsConsent: boolean;
  dnc: boolean;
  alreadySent: boolean;
}): { send: boolean; reason: string } {
  if (!MISS.has(input.disposition) || !input.missSms) return { send: false, reason: "" };
  if (input.alreadySent) return { send: false, reason: "Already texted for this call." };
  const problems = smsProblems({ body: input.template, smsConsent: input.smsConsent, dnc: input.dnc });
  if (problems.length) return { send: false, reason: problems[0] ?? "" };
  return { send: true, reason: "" };
}

/** A clip Twilio can fetch. Spoken text is the fallback when this is empty. */
export function audioClipUrl(value: string): string | null {
  const url = value.trim();
  if (!url) return null;
  if (!/^https:\/\/[^\s]{8,400}$/i.test(url)) return null;
  return url;
}

/** Dials today on one caller ID. This is our count, not a carrier spam score. */
export function callerIdLoad(dials: number): { tone: "quiet" | "steady" | "hot"; label: string } {
  if (dials >= 80) return { tone: "hot", label: "Rest this number" };
  if (dials >= 40) return { tone: "steady", label: "In use" };
  return { tone: "quiet", label: "Light" };
}
