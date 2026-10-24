import { useState } from "react";
import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { commitContactImport, createContact, exportContacts, listContacts, previewContactImport, importCrmContacts } from "@/server/contacts";
import { useWorkspace, PageTitle } from "@/components/workspace";
import { Banner, Button, Empty, Field, Panel, SelectInput, TextArea, TextInput } from "@/components/bits";
import { errorText } from "@/lib/dialer/format";

export const Route = createFileRoute("/app/contacts")({ component: ContactsPage });

function ContactsPage() {
  const onDetail = useRouterState({ select: (state) => /\/app\/contacts\/.+/.test(state.location.pathname) });
  const { membership, allow } = useWorkspace();
  const client = useQueryClient();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "new" | "working" | "qualified" | "closed">("all");
  const [dnc, setDnc] = useState<"all" | "only" | "exclude">("all");
  const [tag, setTag] = useState("");
  const [page, setPage] = useState(1);
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewContactImport>> | null>(null);
  const list = useQuery({
    queryKey: ["contacts", membership.orgId, query, status, dnc, tag, page],
    queryFn: () => listContacts({ data: { orgId: membership.orgId, query, status, dnc, tag, page, pageSize: 25 } }),
  });
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 25));
  if (onDetail) return <Outlet />;
  return (
    <>
      <PageTitle title="Contacts" lane="Work" steps={[{ label: "Find", href: "#find" }, { label: "Add", href: "#add" }, { label: "Dial", href: "/app/dial" }]} />
      <Panel id="find">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Search">
            <TextInput
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              placeholder="Name, phone, company"
            />
          </Field>
          <Field label="Status">
            <SelectInput
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as typeof status);
                setPage(1);
              }}
            >
              <option value="all">All</option>
              <option value="new">New</option>
              <option value="working">Working</option>
              <option value="qualified">Qualified</option>
              <option value="closed">Closed</option>
            </SelectInput>
          </Field>
          <Field label="Tag">
            <TextInput
              value={tag}
              placeholder="vip"
              onChange={(event) => {
                setTag(event.target.value);
                setPage(1);
              }}
            />
          </Field>
          <Field label="Do not call">
            <SelectInput value={dnc} onChange={(event) => setDnc(event.target.value as typeof dnc)}>
              <option value="all">All</option>
              <option value="exclude">Callable only</option>
              <option value="only">Suppressed</option>
            </SelectInput>
          </Field>
        </div>
      </Panel>
      <Panel title={`${total} active`}>
        {list.isError ? <Banner tone="bad">{errorText(list.error)}</Banner> : null}
        {list.data && list.data.contacts.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="data-table min-w-[640px]">
              <thead className="text-xs text-fog uppercase">
                <tr>
                  <th className="py-2">Name</th>
                  <th>Phone</th>
                  <th>Company</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.data.contacts.map((contact) => (
                  <tr key={contact.id} className="border-t border-line">
                    <td className="py-2">
                      {contact.firstName} {contact.lastName}
                      {contact.dnc ? <span className="ml-2 text-xs text-bad">DNC</span> : null}
                    </td>
                    <td className="num">{contact.phoneDisplay}</td>
                    <td>{contact.company || "—"}</td>
                    <td>{contact.status}</td>
                    <td className="text-right">
                      <Link to="/app/contacts/$contactId" params={{ contactId: contact.id }} className="underline-offset-4 hover:underline">
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No contacts match" body="Add one below or widen the filters." />
        )}
        <div className="mt-3 flex gap-2">
          <Button type="button" variant="ghost" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
            Previous
          </Button>
          <Button type="button" variant="ghost" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>
            Next
          </Button>
        </div>
      </Panel>
      {allow("manage_contacts") ? <ContactCreate orgId={membership.orgId} onDone={() => void client.invalidateQueries({ queryKey: ["contacts"] })} /> : null}
      {allow("import_contacts") ? (
        <Panel title="Import CSV">
          <p className="mb-3 text-sm text-fog">Header must include phone. A name column works, or first_name. Optional: address, last_name, email, company, timezone, tags, notes.</p>
          <TextArea value={csv} onChange={(event) => setCsv(event.target.value)} placeholder="phone,first_name,last_name" />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                void previewContactImport({ data: { orgId: membership.orgId, csv } })
                  .then(setPreview)
                  .catch((error: unknown) => toast.error(errorText(error)));
              }}
            >
              Preview
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                void importCrmContacts({ data: { orgId: membership.orgId } })
                  .then(async (result) => {
                    toast.success(`${result.sources.join(" and ")}: ${result.added} added, ${result.skipped} already here, ${result.invalid} had no usable number.`);
                    await client.invalidateQueries({ queryKey: ["contacts"] });
                  })
                  .catch((error: unknown) => toast.error(errorText(error)));
              }}
            >
              Pull from CRM
            </Button>
            <Button
              type="button"
              onClick={() => {
                void commitContactImport({ data: { orgId: membership.orgId, csv } })
                  .then(async (result) => {
                    toast.success(`${result.inserted} added, ${result.skipped} duplicates skipped`);
                    await client.invalidateQueries({ queryKey: ["contacts"] });
                  })
                  .catch((error: unknown) => toast.error(errorText(error)));
              }}
            >
              Import
            </Button>
          </div>
          {preview ? (
            <div className="mt-3 text-sm">
              <p>
                {preview.ready} ready · {preview.issueCount} issues · {preview.warningCount} warnings · {preview.alreadyOnFile} already on file {preview.truncated ? "· truncated" : ""}
              </p>
              <ul className="mt-2 text-fog">
                {preview.sample.map((row) => (
                  <li key={row.line}>
                    Line {row.line}: {row.name} {row.phone}
                  </li>
                ))}
                {preview.issues.map((issue) => (
                  <li key={`${issue.line}-${issue.message}`}>
                    Line {issue.line}: {issue.message}
                  </li>
                ))}
                {preview.warnings.map((issue) => (
                  <li key={`w-${issue.line}-${issue.message}`}>
                    Line {issue.line}: {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Panel>
      ) : null}
      {allow("export_contacts") ? (
        <Panel title="Export">
          <p className="mb-3 text-sm text-fog">Supervisors and above. Limited to 5,000 active rows. The export is written to the audit log.</p>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              void exportContacts({ data: { orgId: membership.orgId } })
                .then((result) => {
                  const blob = new Blob([result.csv], { type: "text/csv" });
                  const url = URL.createObjectURL(blob);
                  const anchor = document.createElement("a");
                  anchor.href = url;
                  anchor.download = "apexdialer-contacts.csv";
                  anchor.click();
                  URL.revokeObjectURL(url);
                  toast.success(`${result.rows} rows${result.truncated ? " (capped)" : ""}`);
                })
                .catch((error: unknown) => toast.error(errorText(error)));
            }}
          >
            Download CSV
          </Button>
        </Panel>
      ) : null}
    </>
  );
}

function ContactCreate({ orgId, onDone }: { orgId: string; onDone: () => void }) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  return (
    <Panel title="New contact" id="add">
      <form
        className="grid gap-3 md:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          void createContact({
            data: { orgId, firstName, lastName, phone, company, email, timezone: "", status: "new", notes: "", tags: [], recordingConsent: false, smsConsent: false, consentNote: "" },
          })
            .then(() => {
              toast.success("Contact saved");
              setFirstName("");
              setLastName("");
              setPhone("");
              setCompany("");
              setEmail("");
              onDone();
            })
            .catch((error: unknown) => toast.error(errorText(error)));
        }}
      >
        <Field label="First name">
          <TextInput value={firstName} onChange={(event) => setFirstName(event.target.value)} required />
        </Field>
        <Field label="Last name">
          <TextInput value={lastName} onChange={(event) => setLastName(event.target.value)} />
        </Field>
        <Field label="Phone" hint="E.164 or a 10-digit US number.">
          <TextInput value={phone} onChange={(event) => setPhone(event.target.value)} required />
        </Field>
        <Field label="Company">
          <TextInput value={company} onChange={(event) => setCompany(event.target.value)} />
        </Field>
        <Field label="Email">
          <TextInput value={email} onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <div className="flex items-end">
          <Button type="submit">Save contact</Button>
        </div>
      </form>
    </Panel>
  );
}
