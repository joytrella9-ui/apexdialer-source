import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { formatPhone } from "@/lib/dialer/phone";
import { planLimits } from "@/lib/dialer/plans";
import { fillSmsTemplate, smsProblems } from "@/lib/dialer/sms";
import { asIso, assertMutable, newId, requireActor, writeAudit } from "./actor";
import { parseInput } from "./validate";

const orgSchema = z.object({ orgId: z.string().min(8).max(80) });

type MessageRow = {
  id: string;
  contact_id: string | null;
  direction: string;
  body: string;
  from_number: string;
  to_number: string;
  status: string;
  failure_reason: string;
  created_at: unknown;
  contact_name: string | null;
};

function mapMessage(row: MessageRow) {
  return {
    id: row.id,
    contactId: row.contact_id,
    direction: row.direction,
    body: row.body,
    fromDisplay: formatPhone(row.from_number),
    toDisplay: formatPhone(row.to_number),
    status: row.status,
    failureReason: row.failure_reason,
    createdAt: asIso(row.created_at),
    contactName: row.contact_name ?? "",
  };
}

const MESSAGE_SELECT = `
  select m.id, m.contact_id, m.direction, m.body, m.from_number, m.to_number, m.status, m.failure_reason, m.created_at,
         nullif(trim(concat(c.first_name, ' ', c.last_name)), '') as contact_name
  from messages m
  left join contacts c on c.id = m.contact_id
`;

export const listMessages = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ contactId: z.string().max(80).default("") }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "dial");
    const sql = await getSql();
    const rows = await sql.query<MessageRow>(
      `${MESSAGE_SELECT}
       where m.org_id = $1 and ($2 = '' or m.contact_id = $2)
       order by m.created_at desc
       limit 40`,
      [actor.orgId, data.contactId],
    );
    return { messages: rows.map(mapMessage) };
  });

export const sendSms = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    parseInput(
      orgSchema.extend({
        contactId: z.string().min(8).max(80),
        body: z.string().max(800),
        channel: z.enum(["sms", "whatsapp"]).default("sms"),
      }),
      input,
    ),
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "dial");
    assertMutable(actor);
    const sql = await getSql();
    const contacts = await sql<{ id: string; first_name: string; company: string; phone_e164: string; dnc: boolean; sms_consent: boolean }>`
      select id, first_name, company, phone_e164, dnc, sms_consent
      from contacts
      where id = ${data.contactId} and org_id = ${actor.orgId} and archived_at is null
      limit 1`;
    const contact = contacts[0];
    if (!contact) throw new Error("Contact not found.");
    const names = await sql<{ name: string }>`select "name" as name from "user" where "id" = ${actor.userId} limit 1`;
    const body = fillSmsTemplate(data.body, {
      firstName: contact.first_name,
      company: contact.company,
      agent: names[0]?.name ?? "",
    });
    const problems = smsProblems({ body, smsConsent: Boolean(contact.sms_consent), dnc: Boolean(contact.dnc) });
    if (problems.length) throw new Error(problems[0]);
    const burst = await sql<{ n: number }>`
      select count(*)::int as n from messages
      where org_id = ${actor.orgId} and agent_user_id = ${actor.userId} and created_at > now() - interval '1 minute'`;
    if (Number(burst[0]?.n ?? 0) >= 8) throw new Error("Slow down. Eight texts a minute is the cap.");
    const day = await sql<{ n: number }>`
      select count(*)::int as n from messages
      where org_id = ${actor.orgId} and direction = 'outbound' and status = 'accepted' and created_at > now() - interval '1 day'`;
    const cap = planLimits(actor.plan).maxSmsPerDay;
    if (Number(day[0]?.n ?? 0) >= cap) throw new Error(`This workspace has hit the ${actor.plan} text cap of ${cap} a day.`);
    const id = newId();
    const { sendTwilioSms } = await import("./telephony.server");
    let destination = contact.phone_e164;
    let fromOverride = "";
    if (data.channel === "whatsapp") {
      const { whatsappSender } = await import("./adapters");
      const sender = await whatsappSender(actor.orgId);
      if (!sender) throw new Error("Save a WhatsApp sender under Settings → Connections. It must be a Twilio WhatsApp number.");
      destination = `whatsapp:${contact.phone_e164}`;
      fromOverride = `whatsapp:${sender}`;
    }
    try {
      const sent = await sendTwilioSms(actor.orgId, destination, body, fromOverride);
      await sql`
        insert into messages (
          id, org_id, contact_id, agent_user_id, direction, body, from_number, to_number, status, provider_sid
        ) values (
          ${id}, ${actor.orgId}, ${contact.id}, ${actor.userId}, 'outbound', ${body}, ${sent.from}, ${contact.phone_e164}, 'accepted', ${sent.sid}
        )`;
      await writeAudit(sql, actor, "sms.send", "contact", contact.id, { sid: sent.sid });
      return { id, status: "accepted" as const };
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 300) : "Twilio did not accept the text.";
      await sql`
        insert into messages (
          id, org_id, contact_id, agent_user_id, direction, body, from_number, to_number, status, failure_reason
        ) values (
          ${id}, ${actor.orgId}, ${contact.id}, ${actor.userId}, 'outbound', ${body}, ${""}, ${contact.phone_e164}, 'failed', ${reason}
        )`;
      throw error instanceof Error ? error : new Error(reason);
    }
  });
