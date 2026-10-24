import { CONNECTED_DISPOSITIONS } from "./dispositions";

export type CallFact = {
  state: string;
  disposition: string;
  providerVerified: boolean;
  durationSeconds: number | null;
};

export type MetricSnapshot = {
  attempts: number;
  connects: number;
  verifiedAttempts: number;
  verifiedConnects: number;
  noAnswer: number;
  voicemail: number;
  failed: number;
  busy: number;
  durationSeconds: number;
  durationSamples: number;
  /** Null when there are no attempts — never render this as 0%. */
  reportedConnectionRate: number | null;
  /** Null when no provider-verified attempts exist. */
  verifiedConnectionRate: number | null;
  averageDurationSeconds: number | null;
};

const ATTEMPT_STATES = new Set(["completed", "failed"]);

export function isAttempt(call: CallFact): boolean {
  return ATTEMPT_STATES.has(call.state);
}

export function isConnect(call: CallFact): boolean {
  return isAttempt(call) && CONNECTED_DISPOSITIONS.has(call.disposition);
}

/**
 * Formulas (each call row is one attempt; redials are new rows):
 * - Attempt: state is completed or failed. Open, canceled, and manual_open rows are excluded.
 * - Reported connect: an attempt whose disposition is answered, interested, not_interested, or callback.
 * - Provider-verified attempt/connect: the same, restricted to provider_verified rows.
 * - Connection rate: connects / attempts. Null when the denominator is 0.
 * - Average duration: sum(duration_seconds) / count(rows with a duration), among attempts only.
 */
export function summarizeCalls(calls: CallFact[]): MetricSnapshot {
  let attempts = 0;
  let connects = 0;
  let verifiedAttempts = 0;
  let verifiedConnects = 0;
  let noAnswer = 0;
  let voicemail = 0;
  let failed = 0;
  let busy = 0;
  let durationSeconds = 0;
  let durationSamples = 0;
  for (const call of calls) {
    if (!isAttempt(call)) continue;
    attempts += 1;
    if (isConnect(call)) connects += 1;
    if (call.providerVerified) {
      verifiedAttempts += 1;
      if (isConnect(call)) verifiedConnects += 1;
    }
    if (call.disposition === "no_answer") noAnswer += 1;
    if (call.disposition === "voicemail") voicemail += 1;
    if (call.disposition === "failed" || call.state === "failed") failed += 1;
    if (call.disposition === "busy") busy += 1;
    if (call.durationSeconds != null) {
      durationSeconds += call.durationSeconds;
      durationSamples += 1;
    }
  }
  return {
    attempts,
    connects,
    verifiedAttempts,
    verifiedConnects,
    noAnswer,
    voicemail,
    failed,
    busy,
    durationSeconds,
    durationSamples,
    reportedConnectionRate: attempts > 0 ? connects / attempts : null,
    verifiedConnectionRate: verifiedAttempts > 0 ? verifiedConnects / verifiedAttempts : null,
    averageDurationSeconds: durationSamples > 0 ? Math.round(durationSeconds / durationSamples) : null,
  };
}

export function formatRate(rate: number | null): string {
  if (rate == null) return "Unavailable";
  return `${Math.round(rate * 1000) / 10}%`;
}
