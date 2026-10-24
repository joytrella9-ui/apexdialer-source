export const SMS_TEMPLATES = [
  {
    id: "intro",
    name: "Short intro",
    body: "Hi {{first_name}}, this is {{agent}}. I tried to reach you. Is there a better time to talk?",
  },
  {
    id: "missed",
    name: "Missed you",
    body: "Hi {{first_name}}, I called and missed you. Reply with a time that works and I will call then.",
  },
  {
    id: "follow",
    name: "Callback",
    body: "Hi {{first_name}}, following up as we discussed. What time should I call?",
  },
] as const;

const TOKEN = /\{\{\s*(first_name|company|agent)\s*\}\}/gi;

export function fillSmsTemplate(body: string, values: { firstName: string; company: string; agent: string }): string {
  const map: Record<string, string> = {
    first_name: values.firstName.trim() || "there",
    company: values.company.trim() || "your team",
    agent: values.agent.trim() || "me",
  };
  return body
    .replace(TOKEN, (_match, key: string) => map[key.toLowerCase()] ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

/** A phone conversation is not permission to text. */
export function smsProblems(input: { body: string; smsConsent: boolean; dnc: boolean }): string[] {
  const problems: string[] = [];
  const body = input.body.trim();
  if (!body) problems.push("Write a message.");
  if (body.length > 320) problems.push("Keep the text to 320 characters.");
  if (input.dnc) problems.push("This contact is do-not-call. Texting is blocked.");
  if (!input.smsConsent) problems.push("Texting needs SMS consent saved on the contact.");
  return problems;
}

export function isSmsStop(body: string): boolean {
  return /^(stop|stopall|unsubscribe|cancel|end|quit)\b/i.test(body.trim());
}
