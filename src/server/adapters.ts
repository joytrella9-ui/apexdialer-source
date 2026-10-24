import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { adapterStatus, parseAdapters, safeOutboundUrl, salesforceBase, type AdapterSecrets, type CallPush } from "@/lib/dialer/adapters";
import { isE164 } from "@/lib/dialer/phone";
import { assertMutable, requireActor, writeAudit } from "./actor";
import { parseInput } from "./validate";

const orgSchema = z.object({ orgId: z.string().min(8).max(80) });

async function loadSecrets(orgId: string): Promise<AdapterSecrets> {
  const sql = await getSql();
  const rows = await sql<{ adapter_config: string }>`
    select adapter_config from org_integrations where org_id = ${orgId} limit 1`;
  return parseAdapters(rows[0]?.adapter_config ?? "{}");
}

async function storeSecrets(orgId: string, secrets: AdapterSecrets): Promise<void> {
  const sql = await getSql();
  const raw = JSON.stringify(secrets);
  await sql`
    insert into org_integrations (org_id, adapter_config)
    values (${orgId}, ${raw})
    on conflict (org_id) do update set adapter_config = ${raw}, updated_at = now()`;
}

export const getAdapters = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "dial");
    const secrets = await loadSecrets(actor.orgId);
    return adapterStatus(secrets);
  });

export const saveAdapters = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    parseInput(
      orgSchema.extend({
        webhookUrl: z.string().max(300).default(""),
        webhookSecret: z.string().max(200).default(""),
        hubspotToken: z.string().max(400).default(""),
        salesforceUrl: z.string().max(200).default(""),
        salesforceToken: z.string().max(2000).default(""),
        whatsappFrom: z.string().max(24).default(""),
        clear: z.array(z.enum(["webhook", "hubspot", "salesforce", "whatsapp"])).max(4).default([]),
      }),
      input,
    ),
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_settings");
    assertMutable(actor);
    const current = await loadSecrets(actor.orgId);
    const next: AdapterSecrets = { ...current };
    if (data.clear.includes("webhook")) {
      next.webhookUrl = "";
      next.webhookSecret = "";
    } else {
      if (data.webhookUrl.trim()) {
        if (!safeOutboundUrl(data.webhookUrl)) throw new Error("The webhook must be a public https address.");
        next.webhookUrl = safeOutboundUrl(data.webhookUrl) ?? "";
      }
      if (data.webhookSecret.trim()) next.webhookSecret = data.webhookSecret.trim();
    }
    if (data.clear.includes("hubspot")) next.hubspotToken = "";
    else if (data.hubspotToken.trim()) next.hubspotToken = data.hubspotToken.trim();
    if (data.clear.includes("salesforce")) {
      next.salesforceUrl = "";
      next.salesforceToken = "";
    } else {
      if (data.salesforceUrl.trim()) {
        if (!salesforceBase(data.salesforceUrl)) throw new Error("Salesforce address must be https on salesforce.com or force.com.");
        next.salesforceUrl = salesforceBase(data.salesforceUrl) ?? "";
      }
      if (data.salesforceToken.trim()) next.salesforceToken = data.salesforceToken.trim();
    }
    if (data.clear.includes("whatsapp")) next.whatsappFrom = "";
    else if (data.whatsappFrom.trim()) {
      if (!isE164(data.whatsappFrom.trim())) throw new Error("WhatsApp sender must be E.164, like +14155550100.");
      next.whatsappFrom = data.whatsappFrom.trim();
    }
    await storeSecrets(actor.orgId, next);
    await writeAudit(await getSql(), actor, "adapters.save", "organization", actor.orgId, adapterStatus(next));
    return adapterStatus(next);
  });

export const testAdapter = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ which: z.enum(["webhook", "hubspot", "salesforce", "whatsapp"]) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_settings");
    const secrets = await loadSecrets(actor.orgId);
    const status = adapterStatus(secrets);
    if (!status[data.which]) throw new Error("Save that connection first.");
    if (data.which === "whatsapp") return { ok: true as const, detail: `WhatsApp sender ${secrets.whatsappFrom} is saved. A real message is sent from a contact.` };
    if (data.which === "webhook") {
      const detail = await postJson(secrets.webhookUrl, { source: "apexdialer", event: "ping", at: new Date().toISOString() }, secrets.webhookSecret);
      return { ok: true as const, detail };
    }
    if (data.which === "hubspot") {
      const detail = await authed("https://api.hubapi.com/crm/v3/objects/calls?limit=1", secrets.hubspotToken);
      return { ok: true as const, detail };
    }
    const detail = await authed(`${salesforceBase(secrets.salesforceUrl)}/services/data/v59.0/`, secrets.salesforceToken);
    return { ok: true as const, detail };
  });

export async function pushCallAdapters(orgId: string, call: CallPush): Promise<string[]> {
  const secrets = await loadSecrets(orgId);
  const status = adapterStatus(secrets);
  const notes: string[] = [];
  if (status.webhook) {
    notes.push(await attempt("Webhook", () => postJson(secrets.webhookUrl, { source: "apexdialer", event: "call.logged", call }, secrets.webhookSecret)));
  }
  if (status.hubspot) {
    notes.push(await attempt("HubSpot", () => hubspotCall(secrets.hubspotToken, call)));
  }
  if (status.salesforce) {
    notes.push(await attempt("Salesforce", () => salesforceTask(secrets.salesforceUrl, secrets.salesforceToken, call)));
  }
  return notes.filter(Boolean);
}

export async function whatsappSender(orgId: string): Promise<string> {
  const secrets = await loadSecrets(orgId);
  return adapterStatus(secrets).whatsapp ? secrets.whatsappFrom : "";
}

async function attempt(name: string, run: () => Promise<string>): Promise<string> {
  try {
    const detail = await run();
    return `${name} ${detail}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "did not accept the call";
    return `${name}: ${message.slice(0, 160)}`;
  }
}

async function signPayload(secret: string, body: string): Promise<string> {
  const { createHmac } = await import("node:crypto");
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function postJson(url: string, payload: unknown, secret: string): Promise<string> {
  const safe = safeOutboundUrl(url);
  if (!safe) throw new Error("Webhook address is not a public https URL.");
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["X-Apex-Signature"] = await signPayload(secret, body);
  const response = await fetch(safe, { method: "POST", headers, body, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`answered ${response.status}`);
  return "accepted";
}

async function authed(url: string, token: string, init?: RequestInit): Promise<string> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text.slice(0, 140) || `answered ${response.status}`);
  }
  return "accepted";
}

async function hubspotCall(token: string, call: CallPush): Promise<string> {
  const duration = call.durationSeconds == null ? "" : String(call.durationSeconds * 1000);
  const match = await hubspotContact(token, call.to);
  const properties = {
    hs_timestamp: call.at,
    hs_call_title: `ApexDialer ${call.disposition}`,
    hs_call_body: `${call.contactName}\n${call.notes}`.slice(0, 2000),
    hs_call_direction: "OUTBOUND",
    hs_call_status: "COMPLETED",
    hs_call_duration: duration,
    hs_call_from_number: call.from,
    hs_call_to_number: call.to,
  };
  const body: Record<string, unknown> = { properties };
  if (match) {
    body.associations = [
      {
        to: { id: match.id },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 194 }],
      },
    ];
  }
  await authed("https://api.hubapi.com/crm/v3/objects/calls", token, { method: "POST", body: JSON.stringify(body) });
  return match ? `logged on ${match.name}` : "logged. No contact matched that number";
}

async function salesforceTask(instance: string, token: string, call: CallPush): Promise<string> {
  const base = salesforceBase(instance);
  if (!base) throw new Error("Salesforce address is not valid.");
  const match = await salesforceWho(base, token, call.to);
  const record: Record<string, string> = {
    Subject: `Call · ${call.disposition}`.slice(0, 80),
    Status: "Completed",
    Description: `${call.contactName} ${call.to}\n${call.notes}`.slice(0, 2000),
    CallType: "Outbound",
    CallDisposition: call.disposition.slice(0, 255),
    ActivityDate: call.at.slice(0, 10),
  };
  if (match) record.WhoId = match.id;
  await authed(`${base}/services/data/v59.0/sobjects/Task`, token, { method: "POST", body: JSON.stringify(record) });
  return match ? `logged on ${match.name}` : "logged. No contact or lead matched that number";
}

async function hubspotContact(token: string, phone: string): Promise<{ id: string; name: string } | null> {
  const payload = await authedJson("https://api.hubapi.com/crm/v3/objects/contacts/search", token, {
    method: "POST",
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "phone", operator: "EQ", value: phone }] }],
      properties: ["firstname", "lastname", "phone"],
      limit: 1,
    }),
  });
  const row = payload.results?.[0];
  if (!row?.id) return null;
  const props = row.properties ?? {};
  const name = `${props.firstname ?? ""} ${props.lastname ?? ""}`.trim() || phone;
  return { id: row.id, name };
}

async function salesforceWho(base: string, token: string, phone: string): Promise<{ id: string; name: string } | null> {
  const safe = phone.replace(/'/g, "");
  for (const object of ["Contact", "Lead"]) {
    const soql = `SELECT Id, Name FROM ${object} WHERE Phone = '${safe}' OR MobilePhone = '${safe}' LIMIT 1`;
    const payload = await authedJson(`${base}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`, token);
    const row = payload.records?.[0];
    if (row?.Id) return { id: row.Id, name: row.Name || phone };
  }
  return null;
}

async function authedJson(url: string, token: string, init?: RequestInit): Promise<{
  results?: { id: string; properties?: Record<string, string> }[];
  records?: { Id: string; Name?: string; FirstName?: string; LastName?: string; Phone?: string; Email?: string; Company?: string }[];
}> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(8000),
  });
  const payload = (await response.json().catch(() => null)) as { results?: { id: string; properties?: Record<string, string> }[]; records?: { Id: string; Name?: string }[]; message?: string } | null;
  if (!response.ok) throw new Error(payload?.message || `answered ${response.status}`);
  return payload ?? {};
}

export type CrmPerson = {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  company: string;
};

export async function listCrmPeople(orgId: string): Promise<{ people: CrmPerson[]; sources: string[] }> {
  const secrets = await loadSecrets(orgId);
  const status = adapterStatus(secrets);
  const people: CrmPerson[] = [];
  const sources: string[] = [];
  if (!status.hubspot && !status.salesforce) {
    throw new Error("Save a HubSpot or Salesforce token under Settings → Connections.");
  }
  if (status.hubspot) {
    sources.push("HubSpot");
    const payload = await authedJson(
      "https://api.hubapi.com/crm/v3/objects/contacts?limit=100&properties=firstname,lastname,phone,email,company",
      secrets.hubspotToken,
    );
    for (const row of payload.results ?? []) {
      const props = row.properties ?? {};
      people.push({
        firstName: props.firstname ?? "",
        lastName: props.lastname ?? "",
        phone: props.phone ?? "",
        email: props.email ?? "",
        company: props.company ?? "",
      });
    }
  }
  if (status.salesforce) {
    sources.push("Salesforce");
    const base = salesforceBase(secrets.salesforceUrl);
    if (base) {
      const contactQuery = "SELECT FirstName, LastName, Phone, Email FROM Contact WHERE Phone != null LIMIT 80";
      const contacts = await authedJson(`${base}/services/data/v59.0/query?q=${encodeURIComponent(contactQuery)}`, secrets.salesforceToken);
      for (const row of contacts.records ?? []) {
        people.push({
          firstName: row.FirstName ?? "",
          lastName: row.LastName ?? "",
          phone: row.Phone ?? "",
          email: row.Email ?? "",
          company: "",
        });
      }
      const leadQuery = "SELECT FirstName, LastName, Phone, Email, Company FROM Lead WHERE Phone != null AND IsConverted = false LIMIT 80";
      const leads = await authedJson(`${base}/services/data/v59.0/query?q=${encodeURIComponent(leadQuery)}`, secrets.salesforceToken);
      for (const row of leads.records ?? []) {
        people.push({
          firstName: row.FirstName ?? "",
          lastName: row.LastName ?? "",
          phone: row.Phone ?? "",
          email: row.Email ?? "",
          company: row.Company ?? "",
        });
      }
    }
  }
  return { people, sources };
}

export const lookupCrm = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ phone: z.string().max(24) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "dial");
    const secrets = await loadSecrets(actor.orgId);
    const status = adapterStatus(secrets);
    const lines: string[] = [];
    if (status.hubspot) {
      try {
        const match = await hubspotContact(secrets.hubspotToken, data.phone);
        lines.push(match ? `HubSpot · ${match.name}` : "HubSpot · no contact with this number");
      } catch (error) {
        lines.push(`HubSpot · ${error instanceof Error ? error.message : "lookup failed"}`);
      }
    }
    if (status.salesforce) {
      try {
        const base = salesforceBase(secrets.salesforceUrl);
        const match = base ? await salesforceWho(base, secrets.salesforceToken, data.phone) : null;
        lines.push(match ? `Salesforce · ${match.name}` : "Salesforce · no contact or lead with this number");
      } catch (error) {
        lines.push(`Salesforce · ${error instanceof Error ? error.message : "lookup failed"}`);
      }
    }
    return { lines };
  });
