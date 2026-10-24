/** E.164 normalization. US 10-digit numbers are accepted; everything else needs a leading +. */

const E164 = /^\+[1-9]\d{7,14}$/;

export function normalizePhone(input: string, defaultCountry: "US" | "none" = "US"): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  let candidate = "";
  if (hasPlus) candidate = `+${digits}`;
  else if (defaultCountry === "US" && digits.length === 10) candidate = `+1${digits}`;
  else if (defaultCountry === "US" && digits.length === 11 && digits.startsWith("1")) candidate = `+${digits}`;
  else return null;
  return E164.test(candidate) ? candidate : null;
}

export function formatPhone(e164: string): string {
  if (/^\+1\d{10}$/.test(e164)) {
    return `+1 (${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
  }
  return e164;
}

export function isE164(value: string): boolean {
  return E164.test(value);
}
