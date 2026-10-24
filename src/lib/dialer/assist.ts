import { isDisposition } from "./dispositions";
import { DISPOSITION_LABEL } from "./labels";

export type LeadRankInput = {
  attempts: number;
  lastDisposition: string;
  callbackDue: boolean;
  callable: boolean;
};

export function rankLead(input: LeadRankInput): { score: number; reason: string } {
  let score = 100 - input.attempts * 8;
  const parts: string[] = [];
  if (input.callbackDue) {
    score += 80;
    parts.push("A follow-up is due");
  }
  if (input.lastDisposition === "callback") {
    score += 40;
    if (!input.callbackDue) parts.push("Last outcome was a callback");
  } else if (input.lastDisposition === "no_answer" || input.lastDisposition === "busy" || input.lastDisposition === "voicemail") {
    score += 12;
    parts.push(`Retry after ${(DISPOSITION_LABEL[input.lastDisposition] ?? input.lastDisposition).toLowerCase()}`);
  } else if (!input.lastDisposition) {
    score += 25;
    parts.push("Never attempted");
  }
  if (input.callable) parts.push("Inside the calling window");
  else {
    score -= 500;
    parts.push("Outside the calling window");
  }
  return { score, reason: parts.join(" · ") };
}

export type BriefInput = {
  firstName: string;
  company: string;
  timezone: string;
  notes: string;
  tags: string[];
  attempts: number;
  lastDisposition: string;
  history: string[];
  script: string;
};

export type CallBrief = {
  headline: string;
  bullets: string[];
  opener: string;
  source: "rules" | "model";
};

export function buildBrief(input: BriefInput): CallBrief {
  const name = input.firstName.trim() || "there";
  const last = input.lastDisposition ? (DISPOSITION_LABEL[input.lastDisposition] ?? input.lastDisposition) : "";
  const headline = input.attempts === 0 ? "First attempt" : `Attempt ${input.attempts + 1}${last ? ` · last was ${last}` : ""}`;
  const bullets: string[] = [];
  if (input.company) bullets.push(input.company);
  if (input.timezone) bullets.push(`Their clock is ${input.timezone}`);
  if (input.tags.length) bullets.push(input.tags.slice(0, 4).join(", "));
  if (input.notes.trim()) bullets.push(input.notes.trim().slice(0, 180));
  const recent = input.history.filter(Boolean).slice(0, 3).map((item) => DISPOSITION_LABEL[item] ?? item);
  if (recent.length) bullets.push(`Recent: ${recent.join(" → ")}`);
  let opener = `Hi ${name}, I'll keep this short.`;
  const scriptLine = input.script.trim().split(/\n+/)[0]?.trim() ?? "";
  if (scriptLine) opener = scriptLine.slice(0, 280);
  else if (input.lastDisposition === "callback") opener = `Hi ${name}, I'm calling back as we arranged.`;
  else if (input.attempts > 0) opener = `Hi ${name}, we missed each other last time. Is now a bad time?`;
  return { headline, bullets, opener, source: "rules" };
}

const NOTE_RULES: Array<{ pattern: RegExp; disposition: string }> = [
  { pattern: /\b(do not call|don't call|dont call|stop calling|remove me|dnc)\b/i, disposition: "do_not_call" },
  { pattern: /\bwrong number\b/i, disposition: "wrong_number" },
  { pattern: /\b(voicemail|left a message|left voicemail)\b/i, disposition: "voicemail" },
  { pattern: /\bnot interested\b|\bno thanks\b/i, disposition: "not_interested" },
  { pattern: /\b(call ?back|tomorrow|next week)\b/i, disposition: "callback" },
  { pattern: /\b(interested|send (me )?(info|pricing)|pricing)\b/i, disposition: "interested" },
  { pattern: /\bbusy\b/i, disposition: "busy" },
  { pattern: /\b(no answer|didn't answer|did not answer|didn't pick up)\b/i, disposition: "no_answer" },
];

export function suggestFromNotes(notes: string, current: string): { summary: string; disposition: string; followUp: string } {
  const trimmed = notes.trim().replace(/\s+/g, " ");
  const summary = trimmed ? trimmed.slice(0, 240) : "";
  const hit = NOTE_RULES.find((rule) => rule.pattern.test(trimmed));
  const disposition = hit && isDisposition(hit.disposition) ? hit.disposition : current;
  const followUp = disposition === "callback" ? "Set a follow-up time before you save." : "";
  return { summary, disposition, followUp };
}

export function reviewScriptCoverage(notes: string, script: string): { items: string[]; missing: string[]; covered: string[] } {
  const stop = new Set(["about", "their", "there", "would", "could", "should", "please", "thanks", "thank", "hello", "calling", "this", "that", "with", "from", "your", "have"]);
  const marked = script
    .split(/\n/)
    .map((line) => line.trim().match(/^(?:\*|[-•]|MUST:|Say:)\s*(.+)$/i)?.[1]?.trim() ?? "")
    .filter((item) => item.length >= 8)
    .slice(0, 8);
  if (marked.length === 0) return { items: [], missing: [], covered: [] };
  const note = notes.toLowerCase();
  const covered: string[] = [];
  const missing: string[] = [];
  for (const item of marked) {
    const words = item
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3 && !stop.has(word));
    const hits = words.filter((word) => note.includes(word));
    if (words.length > 0 && hits.length >= Math.min(2, words.length)) covered.push(item);
    else missing.push(item);
  }
  return { items: marked, missing, covered };
}

export function coachCall(input: { notes: string; disposition: string; durationSeconds: number | null }): string[] {
  const notes = input.notes.trim();
  const flags: string[] = [];
  const connected = ["answered", "interested", "not_interested", "callback"].includes(input.disposition);
  if (connected && notes.length < 20) flags.push("Connected call with almost no notes. Write what they said and the next step.");
  if (input.disposition === "callback" && !/\d|am|pm|tomorrow|monday|tuesday|wednesday|thursday|friday/i.test(notes)) {
    flags.push("Callback with no time in the notes. Use the follow-up field.");
  }
  if (input.disposition === "interested" && notes.length < 40) flags.push("Marked interested, but the note does not say what they want.");
  if (input.disposition === "do_not_call" && notes.length < 8) flags.push("Do-not-call should say who asked and why.");
  if (connected && input.durationSeconds != null && input.durationSeconds > 0 && input.durationSeconds < 8) {
    flags.push("Very short connected call. Confirm it was a real conversation.");
  }
  return flags;
}

export function importRowWarnings(input: { email: string; timezone: string; notes: string }): string[] {
  const warnings: string[] = [];
  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) warnings.push(`Email "${input.email}" does not look valid. It will still import.`);
  if (!input.timezone) warnings.push("No timezone. The campaign timezone will be used for the calling window.");
  if (/\b(do not call|don't call|dont call|stop calling|remove me|\bdnc\b)/i.test(input.notes)) {
    warnings.push("Notes look like a do-not-call request. Import does not set DNC by itself.");
  }
  return warnings;
}
