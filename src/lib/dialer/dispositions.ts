export const DISPOSITIONS = [
  "answered",
  "interested",
  "not_interested",
  "callback",
  "voicemail",
  "no_answer",
  "busy",
  "failed",
  "wrong_number",
  "do_not_call",
  "skipped",
] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

export const CONNECTED_DISPOSITIONS: ReadonlySet<string> = new Set([
  "answered",
  "interested",
  "not_interested",
  "callback",
]);

export function isDisposition(value: string): value is Disposition {
  return (DISPOSITIONS as readonly string[]).includes(value);
}

const TERMINAL = new Set(["answered", "interested", "not_interested", "wrong_number", "do_not_call"]);

export type QueueUpdate = {
  attempts: number;
  completed: boolean;
  nextAttemptAt: string | null;
  lastDisposition: string;
};

/**
 * One completed dial updates the campaign queue once.
 * skipped does not consume an attempt.
 * Human outcomes remove the contact from the queue; follow-ups are separate records.
 * no_answer / busy / voicemail / failed / callback retry until max_attempts.
 */
export function nextQueueState(input: {
  attempts: number;
  maxAttempts: number;
  retryMinutes: number;
  disposition: string;
  now: Date;
  callbackAt?: string | null;
}): QueueUpdate {
  if (input.disposition === "skipped") {
    const next = new Date(input.now.getTime() + 30 * 60 * 1000);
    return { attempts: input.attempts, completed: false, nextAttemptAt: next.toISOString(), lastDisposition: "skipped" };
  }
  const attempts = input.attempts + 1;
  if (TERMINAL.has(input.disposition)) {
    return { attempts, completed: true, nextAttemptAt: null, lastDisposition: input.disposition };
  }
  if (attempts >= input.maxAttempts && input.disposition !== "callback") {
    return { attempts, completed: true, nextAttemptAt: null, lastDisposition: input.disposition };
  }
  if (input.disposition === "callback" && input.callbackAt) {
    return { attempts, completed: false, nextAttemptAt: input.callbackAt, lastDisposition: input.disposition };
  }
  const next = new Date(input.now.getTime() + input.retryMinutes * 60 * 1000);
  return { attempts, completed: false, nextAttemptAt: next.toISOString(), lastDisposition: input.disposition };
}

const OPEN = new Set(["manual_open", "requested", "ringing", "in_progress"]);

export function isOpenState(state: string): boolean {
  return OPEN.has(state);
}

/** Provider may skip intermediate webhooks. Terminal states do not regress. */
export function canApplyProviderState(current: string, next: string): boolean {
  const rank: Record<string, number> = {
    manual_open: 1,
    requested: 1,
    ringing: 2,
    in_progress: 3,
    completed: 4,
    failed: 4,
    canceled: 4,
  };
  const from = rank[current] ?? 0;
  const to = rank[next] ?? 0;
  if (from >= 4) return false;
  return to >= from;
}

/**
 * Status of the call Twilio places to the agent.
 * Agent-leg misses are not contact outcomes and must not consume a campaign attempt.
 */
export function mapTwilioParentStatus(status: string): { state: string; disposition: string } {
  switch (status) {
    case "queued":
    case "initiated":
      return { state: "requested", disposition: "" };
    case "ringing":
      return { state: "ringing", disposition: "" };
    case "in-progress":
    case "answered":
      return { state: "in_progress", disposition: "" };
    case "completed":
      return { state: "completed", disposition: "" };
    case "busy":
    case "no-answer":
    case "failed":
    case "canceled":
      return { state: "canceled", disposition: "" };
    default:
      return { state: "requested", disposition: "" };
  }
}

/** DialCallStatus for the contact leg. A conversation still waits for the agent to disposition it. */
export function mapDialCallStatus(status: string): { state: string; disposition: string } | null {
  switch (status) {
    case "completed":
    case "answered":
      return { state: "completed", disposition: "" };
    case "busy":
      return { state: "failed", disposition: "busy" };
    case "no-answer":
      return { state: "failed", disposition: "no_answer" };
    case "failed":
      return { state: "failed", disposition: "failed" };
    case "canceled":
      return { state: "canceled", disposition: "" };
    default:
      return null;
  }
}

/** Parent call is the agent leg. Child is the contact, when Twilio has created one. */
export function interpretBridgeStatus(parent: string, child: string): { state: string; close: boolean } {
  if (parent === "queued" || parent === "initiated" || parent === "ringing") return { state: "ringing", close: false };
  if (parent === "in-progress") return { state: "in_progress", close: false };
  if (parent === "busy" || parent === "no-answer" || parent === "failed" || parent === "canceled") return { state: "canceled", close: true };
  if (parent === "completed") {
    if (child === "busy" || child === "no-answer" || child === "failed" || child === "canceled") return { state: "failed", close: true };
    return { state: "completed", close: true };
  }
  return { state: "ringing", close: false };
}

export function mapTwilioCallStatus(status: string): { state: string; disposition: string } {
  return mapDialCallStatus(status) ?? { state: "requested", disposition: "" };
}

/** Supervisor corrections change the outcome without adding another attempt. */
export function correctedQueueFlags(input: {
  attempts: number;
  maxAttempts: number;
  disposition: string;
}): { completed: boolean } {
  if (input.disposition === "skipped") return { completed: false };
  if (TERMINAL.has(input.disposition)) return { completed: true };
  if (input.attempts >= input.maxAttempts && input.disposition !== "callback") return { completed: true };
  return { completed: false };
}
