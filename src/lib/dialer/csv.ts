import { normalizePhone } from "./phone";
import { isValidTimeZone } from "./windows";
import { importRowWarnings } from "./assist";

export type CsvContactDraft = {
  line: number;
  firstName: string;
  lastName: string;
  phoneE164: string;
  email: string;
  company: string;
  address: string;
  timezone: string;
  tags: string[];
  notes: string;
  customFields: Record<string, string>;
};

export type CsvIssue = { line: number; message: string };

export type CsvParseResult = {
  rows: CsvContactDraft[];
  issues: CsvIssue[];
  warnings: CsvIssue[];
  truncated: boolean;
};

const MAX_ROWS = 2000;
const MAX_CHARS = 1_500_000;

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let inQuotes = false;
  const s = text.replace(/^\uFEFF/, "");
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    cell += c;
    i += 1;
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  return rows;
}

function headerKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

export function interpretContactCsv(text: string): CsvParseResult {
  if (text.length > MAX_CHARS) {
    return { rows: [], issues: [{ line: 0, message: "File exceeds 1.5 MB. Split it and import again." }], warnings: [], truncated: true };
  }
  const table = parseCsv(text);
  if (table.length === 0) {
    return { rows: [], issues: [{ line: 0, message: "The file is empty." }], warnings: [], truncated: false };
  }
  const headers = table[0].map(headerKey);
  const phoneIdx = headers.findIndex((h) => h === "phone" || h === "phone_number" || h === "mobile");
  if (phoneIdx < 0) {
    return { rows: [], issues: [{ line: 1, message: "A phone column is required." }], warnings: [], truncated: false };
  }
  const idx = (name: string) => headers.indexOf(name);
  const firstIdx = idx("first_name") >= 0 ? idx("first_name") : idx("firstname");
  const lastIdx = idx("last_name") >= 0 ? idx("last_name") : idx("lastname");
  const emailIdx = idx("email");
  const companyIdx = idx("company");
  const nameIdx = idx("name");
  const addressIdx = idx("address") >= 0 ? idx("address") : idx("street");
  const tzIdx = idx("timezone");
  const tagsIdx = idx("tags");
  const notesIdx = idx("notes");
  const customIdx = headers
    .map((h, i) => ({ h, i }))
    .filter((item) => item.h.startsWith("cf_") && item.h.length > 3 && item.h.length <= 43);

  const rows: CsvContactDraft[] = [];
  const issues: CsvIssue[] = [];
  const warnings: CsvIssue[] = [];
  let truncated = false;
  const body = table.slice(1);
  const limited = body.slice(0, MAX_ROWS);
  if (body.length > MAX_ROWS) {
    truncated = true;
    issues.push({ line: 0, message: `Only the first ${MAX_ROWS} data rows are accepted per import.` });
  }
  const seen = new Set<string>();
  limited.forEach((cells, offset) => {
    const line = offset + 2;
    const rawPhone = cells[phoneIdx] ?? "";
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      issues.push({ line, message: `Invalid phone "${rawPhone.trim() || "(blank)"}". Use E.164 or a 10-digit US number.` });
      return;
    }
    if (seen.has(phone)) {
      issues.push({ line, message: `${phone} is duplicated in this file and was skipped.` });
      return;
    }
    seen.add(phone);
    const timezone = (tzIdx >= 0 ? (cells[tzIdx] ?? "") : "").trim();
    if (timezone && !isValidTimeZone(timezone)) {
      issues.push({ line, message: `Invalid timezone "${timezone}".` });
      return;
    }
    const tags = (tagsIdx >= 0 ? (cells[tagsIdx] ?? "") : "")
      .split("|")
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 12);
    if (tags.some((tag) => !/^[\w .+-]{1,32}$/.test(tag))) {
      issues.push({ line, message: "Tags must be 1–32 characters (letters, numbers, space, . + -) separated by |." });
      return;
    }
    const customFields: Record<string, string> = {};
    for (const column of customIdx) {
      const value = (cells[column.i] ?? "").trim().slice(0, 200);
      if (value) customFields[column.h.slice(3).slice(0, 40)] = value;
    }
    const named = (firstIdx >= 0 ? (cells[firstIdx] ?? "") : nameIdx >= 0 ? (cells[nameIdx] ?? "") : "").trim().slice(0, 80);
    rows.push({
      line,
      firstName: named || "Unknown",
      lastName: (lastIdx >= 0 ? (cells[lastIdx] ?? "") : "").trim().slice(0, 80),
      phoneE164: phone,
      email: (emailIdx >= 0 ? (cells[emailIdx] ?? "") : "").trim().slice(0, 160),
      company: (companyIdx >= 0 ? (cells[companyIdx] ?? "") : "").trim().slice(0, 120),
      address: (addressIdx >= 0 ? (cells[addressIdx] ?? "") : "").trim().slice(0, 200),
      timezone,
      tags,
      notes: (notesIdx >= 0 ? (cells[notesIdx] ?? "") : "").trim().slice(0, 2000),
      customFields,
    });
    const draft = rows[rows.length - 1];
    for (const message of importRowWarnings({ email: draft.email, timezone: draft.timezone, notes: draft.notes })) {
      warnings.push({ line, message });
    }
  });
  return { rows, issues, warnings, truncated };
}

/** Excel treats cells that start with =, +, -, or @ as formulas. Prefix those. */
export function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(guarded)) return `"${guarded.replaceAll('"', '""')}"`;
  return guarded;
}
