const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isValidTime(value: string): boolean {
  return TIME_RE.test(value);
}

export function minutesOfDay(value: string): number | null {
  if (!TIME_RE.test(value)) return null;
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

export type WindowInput = {
  now: Date;
  timeZone: string;
  start: string;
  end: string;
  days: number[];
};

export type WindowResult = {
  ok: boolean;
  reason: string;
  localTime: string;
  localDay: number;
};

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function localParts(now: Date, timeZone: string): { minutes: number; day: number; label: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return { minutes: hour * 60 + minute, day: WEEKDAY[weekday] ?? 0, label: `${hh}:${mm}` };
}

/** Permitted calling window. End is exclusive. Overnight windows are rejected by config validation. */
export function isWithinCallingWindow(input: WindowInput): WindowResult {
  if (!isValidTimeZone(input.timeZone)) {
    return { ok: false, reason: "Contact or campaign timezone is not a valid IANA zone.", localTime: "", localDay: -1 };
  }
  const start = minutesOfDay(input.start);
  const end = minutesOfDay(input.end);
  if (start == null || end == null || end <= start) {
    return { ok: false, reason: "Calling window is not configured.", localTime: "", localDay: -1 };
  }
  const local = localParts(input.now, input.timeZone);
  if (!input.days.includes(local.day)) {
    return { ok: false, reason: `Outside permitted calling days (${local.label} local).`, localTime: local.label, localDay: local.day };
  }
  if (local.minutes < start || local.minutes >= end) {
    return {
      ok: false,
      reason: `Outside calling hours ${input.start}–${input.end} (${local.label} local).`,
      localTime: local.label,
      localDay: local.day,
    };
  }
  return { ok: true, reason: "", localTime: local.label, localDay: local.day };
}

export type CampaignConfig = {
  name: string;
  dialMode: "manual" | "provider";
  windowStart: string;
  windowEnd: string;
  callingDays: number[];
  maxAttempts: number;
  retryMinutes: number;
  callerId: string;
  timezone: string;
};

/** Product safeguards, not a legal opinion. Windows must sit inside 08:00–21:00 local. */
export function validateCampaignConfig(c: CampaignConfig): string[] {
  const errors: string[] = [];
  if (!c.name.trim()) errors.push("Name is required.");
  if (!isValidTimeZone(c.timezone)) errors.push("Timezone is not a valid IANA zone.");
  const start = minutesOfDay(c.windowStart);
  const end = minutesOfDay(c.windowEnd);
  if (start == null || end == null) errors.push("Calling window must use HH:MM.");
  else {
    if (start < 8 * 60 || end > 21 * 60) errors.push("Calling window must sit inside 08:00–21:00 local.");
    if (end <= start) errors.push("Window end must be after the start. Overnight windows are not allowed.");
    if (end - start < 60) errors.push("Calling window must be at least 60 minutes.");
  }
  const days = [...new Set(c.callingDays)].filter((d) => d >= 0 && d <= 6);
  if (days.length !== c.callingDays.length || days.length === 0) errors.push("Select at least one valid calling day.");
  if (!Number.isInteger(c.maxAttempts) || c.maxAttempts < 1 || c.maxAttempts > 6) {
    errors.push("Max attempts must be an integer from 1 to 6.");
  }
  if (!Number.isInteger(c.retryMinutes) || c.retryMinutes < 30 || c.retryMinutes > 10080) {
    errors.push("Retry delay must be between 30 minutes and 7 days.");
  }
  if (c.dialMode === "provider" && !c.callerId.trim()) {
    errors.push("Provider dialing requires an authorized caller ID.");
  }
  return errors;
}

export function validateOrgWindow(start: string, end: string, days: number[], timezone: string): string[] {
  return validateCampaignConfig({
    name: "org",
    dialMode: "manual",
    windowStart: start,
    windowEnd: end,
    callingDays: days,
    maxAttempts: 3,
    retryMinutes: 60,
    callerId: "",
    timezone,
  }).filter((e) => !e.startsWith("Name") && !e.startsWith("Max") && !e.startsWith("Retry") && !e.startsWith("Provider"));
}
