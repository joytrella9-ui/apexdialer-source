import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { interpretContactCsv, csvCell } from "@/lib/dialer/csv";
import { formatPhone, normalizePhone } from "@/lib/dialer/phone";
import { planLimits } from "@/lib/dialer/plans";
import { can } from "@/lib/dialer/permissions";
import { isValidTimeZone } from "@/lib/dialer/windows";
import {
  asIso,
  asTags,
  assertMutable,
  countActiveContacts,
  isUniqueViolation,
  likePattern,
  newId,
  requireActor,
  writeAudit,
} from "./actor";
import { parseInput } from "./validate";

const orgSchema = z.object({ orgId: z.string().min(8).max(80) });

type ContactRow = {
  id: string;
  first_name: string;
  last_name: string;
  phone_e164: string;
  email: string;
  company: string;
  address: string;
  timezone: string;
  status: string;
  dnc: boolean;
  dnc_reason: string;
  recording_consent: boolean;
  sms_consent: boolean;
  consent_note: string;
  tags: unknown;
  custom_fields: unknown;
  notes: string;
  created_at: unknown;
  updated_at: unknown;
};

function mapContact(row: ContactRow) {
  const custom = row.custom_fields && typeof row.custom_fields === "object" ? (row.custom_fields as Record<string, string>) : {};
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    phoneE164: row.phone_e164,
    phoneDisplay: formatPhone(row.phone_e164),
    email: row.email,
    company: row.company,
    address: row.address ?? "",
    timezone: row.timezone,
    status: row.status,
    dnc: Boolean(row.dnc),
    dncReason: row.dnc_reason,
    recordingConsent: Boolean(row.recording_consent),
    smsConsent: Boolean(row.sms_consent),
    consentNote: row.consent_note,
    tags: asTags(row.tags),
    customFields: custom,
    notes: row.notes,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

const listSchema = orgSchema.extend({
  query: z.string().max(120).default(""),
  dnc: z.enum(["all", "only", "exclude"]).default("all"),
  status: z.enum(["all", "new", "working", "qualified", "closed"]).default("all"),
  tag: z.string().trim().max(32).default(""),
  page: z.number().int().min(1).max(10000).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
});

export const listContacts = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(listSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId);
    const sql = await getSql();
    const offset = (data.page - 1) * data.pageSize;
    const q = data.query.trim();
    const like = likePattern(q);
    const rows = await sql<ContactRow & { total: number }>`
      select c.*, count(*) over()::int as total
      from contacts c
      where c.org_id = ${actor.orgId}
        and c.archived_at is null
        and (${data.dnc} = 'all' or (${data.dnc} = 'only' and c.dnc = true) or (${data.dnc} = 'exclude' and c.dnc = false))
        and (${data.status} = 'all' or c.status = ${data.status})
        and (${data.tag} = '' or ${data.tag} = any(c.tags))
        and (
          ${q} = ''
          or c.first_name ilike ${like} escape '\\'
          or c.last_name ilike ${like} escape '\\'
          or c.phone_e164 ilike ${like} escape '\\'
          or c.company ilike ${like} escape '\\'
          or c.email ilike ${like} escape '\\'
        )
      order by c.updated_at desc
      limit ${data.pageSize} offset ${offset}`;
    return {
      contacts: rows.map(mapContact),
      total: Number(rows[0]?.total ?? 0),
      page: data.page,
      pageSize: data.pageSize,
    };
  });

export const lookupContact = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ phone: z.string().trim().min(3).max(32) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId);
    const phone = normalizePhone(data.phone);
    if (!phone) return { contact: null, reason: "That is not a usable phone number." };
    const sql = await getSql();
    const rows = await sql<{ id: string; first_name: string; last_name: string; dnc: boolean; phone_e164: string }>`
      select id, first_name, last_name, dnc, phone_e164
      from contacts
      where org_id = ${actor.orgId} and phone_e164 = ${phone} and archived_at is null
      limit 1`;
    const row = rows[0];
    if (!row) return { contact: null, reason: "That number is not on a list. Add the contact before dialing." };
    return {
      contact: {
        id: row.id,
        name: `${row.first_name} ${row.last_name}`.trim(),
        dnc: row.dnc,
        phone: row.phone_e164,
      },
      reason: row.dnc ? "This contact is on the do-not-call list." : "",
    };
  });

export const getContact = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ contactId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId);
    const sql = await getSql();
    const elevated = can(actor.role, "view_all_calls");
    const rows = await sql<ContactRow>`
      select * from contacts where id = ${data.contactId} and org_id = ${actor.orgId} and archived_at is null limit 1`;
    const row = rows[0];
    if (!row) throw new Error("Contact not found.");
    const calls = await sql<{
      id: string;
      state: string;
      disposition: string;
      started_at: unknown;
      duration_seconds: number | null;
      provider_verified: boolean;
      channel: string;
    }>`
      select id, state, disposition, started_at, duration_seconds, provider_verified, channel
      from calls
      where org_id = ${actor.orgId} and contact_id = ${row.id}
        and (${elevated} = true or agent_user_id = ${actor.userId})
      order by started_at desc
      limit 20`;
    return {
      contact: mapContact(row),
      calls: calls.map((call) => ({
        id: call.id,
        state: call.state,
        disposition: call.disposition,
        startedAt: asIso(call.started_at),
        durationSeconds: call.duration_seconds == null ? null : Number(call.duration_seconds),
        providerVerified: Boolean(call.provider_verified),
        channel: call.channel,
      })),
    };
  });

const contactBody = {
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().max(80).default(""),
  phone: z.string().trim().min(7).max(32),
  email: z.string().trim().max(160).default(""),
  company: z.string().trim().max(120).default(""),
  address: z.string().trim().max(200).default(""),
  timezone: z.string().trim().max(80).default(""),
  status: z.enum(["new", "working", "qualified", "closed"]).default("new"),
  notes: z.string().max(4000).default(""),
  tags: z.array(z.string().trim().regex(/^[\w .+-]{1,32}$/)).max(12).default([]),
  recordingConsent: z.boolean().default(false),
  smsConsent: z.boolean().default(false),
  consentNote: z.string().max(500).default(""),
  customFields: z.record(z.string(), z.string()).default({}),
};

export const importCrmContacts = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "import_contacts");
    assertMutable(actor);
    const { listCrmPeople } = await import("./adapters");
    const pulled = await listCrmPeople(actor.orgId);
    const sql = await getSql();
    const limits = planLimits(actor.plan);
    const existing = await sql<{ phone_e164: string }>`
      select phone_e164 from contacts where org_id = ${actor.orgId} and archived_at is null`;
    const seen = new Set(existing.map((row) => row.phone_e164));
    let added = 0;
    let skipped = 0;
    let invalid = 0;
    let room = limits.maxContacts - existing.length;
    for (const person of pulled.people) {
      const phone = normalizePhone(person.phone);
      if (!phone) {
        invalid += 1;
        continue;
      }
      if (seen.has(phone)) {
        skipped += 1;
        continue;
      }
      if (room <= 0) break;
      const id = newId();
      const first = person.firstName.trim().slice(0, 80) || "Unknown";
      const last = person.lastName.trim().slice(0, 80);
      try {
        await sql`
          insert into contacts (
            id, org_id, first_name, last_name, phone_e164, email, company, notes, created_by
          ) values (
            ${id}, ${actor.orgId}, ${first}, ${last}, ${phone}, ${person.email.slice(0, 160)}, ${person.company.slice(0, 160)},
            ${"Imported from CRM. SMS consent was not copied."}, ${actor.userId}
          )`;
        seen.add(phone);
        added += 1;
        room -= 1;
      } catch (error) {
        if (isUniqueViolation(error)) skipped += 1;
        else throw error;
      }
    }
    await writeAudit(sql, actor, "contact.import_crm", "organization", actor.orgId, { added, skipped, sources: pulled.sources.join(",") });
    return { added, skipped, invalid, sources: pulled.sources };
  });

export const createContact = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend(contactBody), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_contacts");
    assertMutable(actor);
    const phone = normalizePhone(data.phone);
    if (!phone) throw new Error("Enter a valid E.164 number or a 10-digit US number.");
    if (data.timezone && !isValidTimeZone(data.timezone)) throw new Error("Timezone is not a valid IANA zone.");
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw new Error("Email is not valid.");
    const sql = await getSql();
    const limits = planLimits(actor.plan);
    if ((await countActiveContacts(sql, actor.orgId)) >= limits.maxContacts) {
      throw new Error(`The ${actor.plan} plan is limited to ${limits.maxContacts} active contacts.`);
    }
    const id = newId();
    const tags = `{${data.tags.map((tag) => `"${tag.replaceAll('"', "")}"`).join(",")}}`;
    try {
      await sql`
        insert into contacts (
          id, org_id, first_name, last_name, phone_e164, email, company, address, timezone, status, notes, tags,
          recording_consent, sms_consent, consent_note, created_by
        ) values (
          ${id}, ${actor.orgId}, ${data.firstName}, ${data.lastName}, ${phone}, ${data.email}, ${data.company}, ${data.address},
          ${data.timezone}, ${data.status}, ${data.notes}, ${tags}::text[], ${data.recordingConsent}, ${data.smsConsent}, ${data.consentNote},
          ${actor.userId}
        )`;
    } catch (error) {
      if (isUniqueViolation(error)) throw new Error("A contact with that phone number already exists in this workspace.");
      throw error;
    }
    await writeAudit(sql, actor, "contact.create", "contact", id, {});
    return { id };
  });

export const updateContact = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ contactId: z.string().min(8).max(80) }).extend(contactBody), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_contacts");
    assertMutable(actor);
    const phone = normalizePhone(data.phone);
    if (!phone) throw new Error("Enter a valid E.164 number or a 10-digit US number.");
    if (data.timezone && !isValidTimeZone(data.timezone)) throw new Error("Timezone is not a valid IANA zone.");
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw new Error("Email is not valid.");
    const sql = await getSql();
    const tags = `{${data.tags.map((tag) => `"${tag.replaceAll('"', "")}"`).join(",")}}`;
    const customFields = Object.fromEntries(
      Object.entries(data.customFields)
        .map(([key, value]) => [key.trim().slice(0, 40), value.trim().slice(0, 200)] as const)
        .filter(([key, value]) => /^[\w .+-]{1,40}$/.test(key) && value)
        .slice(0, 20),
    );
    let rows: { id: string }[];
    try {
      rows = await sql<{ id: string }>`
        update contacts
        set first_name = ${data.firstName},
            last_name = ${data.lastName},
            phone_e164 = ${phone},
            email = ${data.email},
            company = ${data.company},
            address = ${data.address},
            timezone = ${data.timezone},
            status = ${data.status},
            notes = ${data.notes},
            tags = ${tags}::text[],
            custom_fields = ${JSON.stringify(customFields)}::jsonb,
            recording_consent = ${data.recordingConsent},
            sms_consent = ${data.smsConsent},
            consent_note = ${data.consentNote},
            updated_at = now()
        where id = ${data.contactId} and org_id = ${actor.orgId} and archived_at is null
        returning id`;
    } catch (error) {
      if (isUniqueViolation(error)) throw new Error("A contact with that phone number already exists in this workspace.");
      throw error;
    }
    if (!rows[0]) throw new Error("Contact not found.");
    await writeAudit(sql, actor, "contact.update", "contact", data.contactId, {});
    return { ok: true as const };
  });

export const archiveContact = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ contactId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_contacts");
    assertMutable(actor);
    const sql = await getSql();
    const rows = await sql<{ id: string }>`
      update contacts set archived_at = now(), updated_at = now()
      where id = ${data.contactId} and org_id = ${actor.orgId} and archived_at is null
      returning id`;
    if (!rows[0]) throw new Error("Contact not found.");
    await writeAudit(sql, actor, "contact.archive", "contact", data.contactId, {});
    return { ok: true as const };
  });

export const setDoNotCall = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    parseInput(orgSchema.extend({ contactId: z.string().min(8).max(80), dnc: z.boolean(), reason: z.string().max(160).default("") }), input),
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_dnc");
    assertMutable(actor);
    const sql = await getSql();
    const rows = await sql<{ id: string }>`
      update contacts
      set dnc = ${data.dnc}, dnc_reason = ${data.dnc ? data.reason || "manual" : ""}, updated_at = now()
      where id = ${data.contactId} and org_id = ${actor.orgId} and archived_at is null
      returning id`;
    if (!rows[0]) throw new Error("Contact not found.");
    await writeAudit(sql, actor, data.dnc ? "contact.dnc_on" : "contact.dnc_off", "contact", data.contactId, {});
    return { ok: true as const };
  });

export const previewContactImport = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ csv: z.string().max(1_500_000) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "import_contacts");
    const parsed = interpretContactCsv(data.csv);
    const phones = parsed.rows.map((row) => row.phoneE164);
    let alreadyOnFile = 0;
    if (phones.length) {
      const sql = await getSql();
      const existing = await sql<{ phone_e164: string }>`
        select phone_e164 from contacts
        where org_id = ${actor.orgId} and archived_at is null and phone_e164 = any(${phones}::text[])`;
      alreadyOnFile = existing.length;
    }
    return {
      ready: parsed.rows.length,
      issues: parsed.issues.slice(0, 40),
      warnings: parsed.warnings.slice(0, 40),
      issueCount: parsed.issues.length,
      warningCount: parsed.warnings.length,
      alreadyOnFile,
      truncated: parsed.truncated,
      sample: parsed.rows.slice(0, 5).map((row) => ({
        line: row.line,
        name: `${row.firstName} ${row.lastName}`.trim(),
        phone: formatPhone(row.phoneE164),
      })),
    };
  });

export const commitContactImport = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ csv: z.string().max(1_500_000) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "import_contacts");
    assertMutable(actor);
    const parsed = interpretContactCsv(data.csv);
    const sql = await getSql();
    const limits = planLimits(actor.plan);
    const existing = await countActiveContacts(sql, actor.orgId);
    if (existing + parsed.rows.length > limits.maxContacts) {
      throw new Error(`This import would exceed the ${limits.maxContacts} contact limit on the ${actor.plan} plan.`);
    }
    let inserted = 0;
    let skipped = 0;
    const contactIds: string[] = [];
    for (const row of parsed.rows) {
      const tags = `{${row.tags.map((tag) => `"${tag.replaceAll('"', "")}"`).join(",")}}`;
      const result = await sql<{ id: string }>`
        insert into contacts (
          id, org_id, first_name, last_name, phone_e164, email, company, address, timezone, notes, tags, custom_fields, created_by
        )
        select ${newId()}, ${actor.orgId}, ${row.firstName}, ${row.lastName}, ${row.phoneE164}, ${row.email},
               ${row.company}, ${row.address}, ${row.timezone}, ${row.notes}, ${tags}::text[], ${JSON.stringify(row.customFields)}::jsonb,
               ${actor.userId}
        where not exists (
          select 1 from contacts c
          where c.org_id = ${actor.orgId} and c.phone_e164 = ${row.phoneE164} and c.archived_at is null
        )
        returning id`;
      if (result[0]) {
        inserted += 1;
        if (contactIds.length < 500) contactIds.push(result[0].id);
      } else skipped += 1;
    }
    await writeAudit(sql, actor, "contact.import", "organization", actor.orgId, { inserted, skipped });
    return { inserted, skipped, issues: parsed.issues.length, contactIds };
  });

export const exportContacts = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "export_contacts");
    const sql = await getSql();
    const rows = await sql<ContactRow>`
      select * from contacts
      where org_id = ${actor.orgId} and archived_at is null
      order by created_at asc
      limit 5000`;
    const header = "phone,first_name,last_name,email,company,address,timezone,status,dnc,sms_consent,tags,notes";
    const lines = rows.map((row) =>
      [row.phone_e164, row.first_name, row.last_name, row.email, row.company, row.address ?? "", row.timezone, row.status, row.dnc ? "true" : "false", row.sms_consent ? "true" : "false", asTags(row.tags).join("|"), row.notes]
        .map(csvCell)
        .join(","),
    );
    await writeAudit(sql, actor, "contact.export", "organization", actor.orgId, { rows: rows.length });
    return { csv: `${header}\n${lines.join("\n")}\n`, rows: rows.length, truncated: rows.length === 5000 };
  });

