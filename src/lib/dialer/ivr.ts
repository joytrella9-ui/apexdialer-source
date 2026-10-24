export type IvrAction = "agent" | "message";

export type IvrOption = {
  digit: string;
  label: string;
  action: IvrAction;
  message: string;
};

export function parseIvrOptions(raw: string): IvrOption[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const options: IvrOption[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const digit = String(row.digit ?? "").trim();
    if (!/^[0-9]$/.test(digit) || seen.has(digit)) continue;
    const label = String(row.label ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!label) continue;
    const action: IvrAction = row.action === "message" ? "message" : "agent";
    const message = String(row.message ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
    if (action === "message" && !message) continue;
    seen.add(digit);
    options.push({ digit, label, action, message });
    if (options.length >= 6) break;
  }
  return options;
}

export function ivrPrompt(greeting: string, options: IvrOption[]): string {
  const hello = greeting.trim().slice(0, 180) || "Thanks for calling.";
  const keys = options.map((option) => `Press ${option.digit} for ${option.label}.`).join(" ");
  return `${hello} ${keys}`.trim().slice(0, 420);
}
