import { isE164 } from "./phone";

/** Prefer an allow-listed caller ID with the same US area code. Otherwise the preferred number, then the first allow-listed number. */
export function chooseCallerId(destination: string, allowList: string[], preferred = ""): string {
  const list = [...new Set(allowList.filter((item) => isE164(item)))];
  const fallback = isE164(preferred) && list.includes(preferred) ? preferred : (list[0] ?? "");
  if (!/^\+1\d{10}$/.test(destination)) return fallback;
  const area = destination.slice(2, 5);
  return list.find((item) => /^\+1\d{10}$/.test(item) && item.slice(2, 5) === area) ?? fallback;
}
