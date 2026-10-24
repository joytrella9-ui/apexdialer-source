import { useEffect, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { archiveContact, getContact, setDoNotCall, updateContact } from "@/server/contacts";
import { useWorkspace, PageTitle } from "@/components/workspace";
import { SmsThread } from "@/components/sms-box";
import { Banner, Button, Field, Panel, SelectInput, TextArea, TextInput } from "@/components/bits";
import { DISPOSITION_LABEL, STATE_LABEL } from "@/lib/dialer/labels";
import { errorText, formatDuration, formatWhen } from "@/lib/dialer/format";

export const Route = createFileRoute("/app/contacts/$contactId")({ component: ContactPage });

function ContactPage() {
  const { contactId } = Route.useParams();
  const { membership, allow } = useWorkspace();
  const client = useQueryClient();
  const navigate = useNavigate();
  const detail = useQuery({
    queryKey: ["contact", membership.orgId, contactId],
    queryFn: () => getContact({ data: { orgId: membership.orgId, contactId } }),
  });
  const contact = detail.data?.contact;
  const [form, setForm] = useState({ firstName: "", lastName: "", phone: "", email: "", company: "", address: "", timezone: "", status: "new", notes: "", tags: "", customFields: "", recordingConsent: false, smsConsent: false, consentNote: "" });
  useEffect(() => {
    if (!contact) return;
    setForm({
      firstName: contact.firstName,
      lastName: contact.lastName,
      phone: contact.phoneE164,
      email: contact.email,
      company: contact.company,
      address: contact.address,
      timezone: contact.timezone,
      status: contact.status,
      notes: contact.notes,
      tags: contact.tags.join(", "),
      customFields: Object.entries(contact.customFields).map(([key, value]) => `${key}: ${value}`).join("\n"),
      recordingConsent: contact.recordingConsent,
      smsConsent: contact.smsConsent,
      consentNote: contact.consentNote,
    });
  }, [contact]);
  if (detail.isError) return <Banner tone="bad">{errorText(detail.error)}</Banner>;
  if (!contact) return <p className="text-sm text-fog">Loading contact…</p>;
  return (
    <>
      <PageTitle title={`${contact.firstName} ${contact.lastName}`.trim()} lane="Work" steps={[{ label: "Record", href: "#record" }, { label: "Text", href: "#text" }, { label: "Dial", href: `/app/dial?contactId=${contact.id}` }]}>
        <Link to="/app/dial" search={{ contactId: contact.id, campaignId: "" }} className="inline-flex min-h-11 items-center rounded-lg bg-teal px-4 text-sm font-medium text-paper-ink">
          Call
        </Link>
      </PageTitle>
      {contact.dnc ? <Banner tone="bad">Do not call{contact.dncReason ? ` — ${contact.dncReason}` : ""}. Dialing is blocked.</Banner> : null}
      <Panel title="Record" id="record">
        <form
          className="grid gap-3 md:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            const tags = form.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
            const customFields = Object.fromEntries(
              form.customFields
                .split("\n")
                .map((line) => {
                  const split = line.indexOf(":");
                  if (split < 1) return null;
                  return [line.slice(0, split).trim(), line.slice(split + 1).trim()] as const;
                })
                .filter((pair): pair is readonly [string, string] => Boolean(pair && pair[0] && pair[1])),
            );
            void updateContact({
              data: {
                orgId: membership.orgId,
                contactId,
                firstName: form.firstName,
                lastName: form.lastName,
                phone: form.phone,
                email: form.email,
                company: form.company,
                address: form.address,
                timezone: form.timezone,
                status: form.status as "new" | "working" | "qualified" | "closed",
                notes: form.notes,
                tags,
                customFields,
                recordingConsent: form.recordingConsent,
                smsConsent: form.smsConsent,
                consentNote: form.consentNote,
              },
            })
              .then(() => {
                toast.success("Saved");
                void client.invalidateQueries({ queryKey: ["contact", membership.orgId, contactId] });
              })
              .catch((error: unknown) => toast.error(errorText(error)));
          }}
        >
          <Field label="First name">
            <TextInput value={form.firstName} disabled={!allow("manage_contacts")} onChange={(event) => setForm({ ...form, firstName: event.target.value })} />
          </Field>
          <Field label="Last name">
            <TextInput value={form.lastName} disabled={!allow("manage_contacts")} onChange={(event) => setForm({ ...form, lastName: event.target.value })} />
          </Field>
          <Field label="Phone">
            <TextInput value={form.phone} disabled={!allow("manage_contacts")} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
          </Field>
          <Field label="Email">
            <TextInput value={form.email} disabled={!allow("manage_contacts")} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </Field>
          <Field label="Address">
            <TextInput value={form.address} disabled={!allow("manage_contacts")} onChange={(event) => setForm({ ...form, address: event.target.value })} placeholder="Street, city" />
          </Field>
          <Field label="Company">
            <TextInput value={form.company} disabled={!allow("manage_contacts")} onChange={(event) => setForm({ ...form, company: event.target.value })} />
          </Field>
          <Field label="Timezone">
            <TextInput value={form.timezone} disabled={!allow("manage_contacts")} onChange={(event) => setForm({ ...form, timezone: event.target.value })} placeholder="America/Chicago" />
          </Field>
          <Field label="Status">
            <SelectInput value={form.status} disabled={!allow("manage_contacts")} onChange={(event) => setForm({ ...form, status: event.target.value })}>
              <option value="new">New</option>
              <option value="working">Working</option>
              <option value="qualified">Qualified</option>
              <option value="closed">Closed</option>
            </SelectInput>
          </Field>
          <Field label="Tags" hint="Comma separated. Letters, numbers, spaces.">
            <TextInput value={form.tags} disabled={!allow("manage_contacts")} onChange={(event) => setForm({ ...form, tags: event.target.value })} />
          </Field>
          <Field label="Custom fields" hint="One per line, like source: web. Saved with the contact, not sent to Twilio.">
            <TextArea value={form.customFields} disabled={!allow("manage_contacts")} onChange={(event) => setForm({ ...form, customFields: event.target.value })} />
          </Field>
          <Field label="Notes">
            <TextArea value={form.notes} disabled={!allow("manage_contacts")} onChange={(event) => setForm({ ...form, notes: event.target.value })} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.recordingConsent} disabled={!allow("manage_contacts")} onChange={(event) => setForm({ ...form, recordingConsent: event.target.checked })} />
            Recording consent on file
          </label>
          <label className="flex items-center gap-2 text-sm md:col-span-2">
            <input type="checkbox" checked={form.smsConsent} disabled={!allow("manage_contacts")} onChange={(event) => setForm({ ...form, smsConsent: event.target.checked })} />
            SMS consent on file. Required before any text. A call is not consent to text.
          </label>
          {allow("manage_contacts") ? <Button type="submit">Save</Button> : <p className="text-sm text-fog">Agents can view this record. Editing is limited to supervisors.</p>}
        </form>
        <div className="mt-4 flex flex-wrap gap-2">
          {allow("manage_dnc") ? (
            <Button
              type="button"
              variant={contact.dnc ? "ghost" : "danger"}
              onClick={() => {
                void setDoNotCall({ data: { orgId: membership.orgId, contactId, dnc: !contact.dnc, reason: contact.dnc ? "" : "manual" } })
                  .then(() => client.invalidateQueries({ queryKey: ["contact", membership.orgId, contactId] }))
                  .catch((error: unknown) => toast.error(errorText(error)));
              }}
            >
              {contact.dnc ? "Remove do-not-call" : "Mark do-not-call"}
            </Button>
          ) : null}
          {allow("manage_contacts") ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                if (!window.confirm("Archive this contact? They leave the active book and queues.")) return;
                void archiveContact({ data: { orgId: membership.orgId, contactId } })
                  .then(async () => {
                    toast.success("Archived");
                    await navigate({ to: "/app/contacts" });
                  })
                  .catch((error: unknown) => toast.error(errorText(error)));
              }}
            >
              Archive
            </Button>
          ) : null}
        </div>
      </Panel>
      <Panel title="Texts" id="text">
        <SmsThread
          orgId={membership.orgId}
          contactId={contact.id}
          firstName={contact.firstName}
          company={contact.company}
          smsConsent={contact.smsConsent}
          dnc={contact.dnc}
        />
      </Panel>
      <Panel title="Recent calls">
        <ul className="grid gap-2 text-sm">
          {(detail.data?.calls ?? []).map((call) => (
            <li key={call.id} className="flex flex-wrap justify-between gap-2 border-b border-line py-2">
              <span>{formatWhen(call.startedAt)}</span>
              <span>{STATE_LABEL[call.state] ?? call.state}</span>
              <span>{DISPOSITION_LABEL[call.disposition] ?? (call.disposition || "Open")}</span>
              <span>{formatDuration(call.durationSeconds)}</span>
              <span className="text-fog">{call.providerVerified ? "Verified" : call.channel}</span>
            </li>
          ))}
          {(detail.data?.calls.length ?? 0) === 0 ? <li className="text-fog">No calls on this contact.</li> : null}
        </ul>
      </Panel>
    </>
  );
}
