import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { listAudit } from "@/server/team";
import { useWorkspace, PageTitle } from "@/components/workspace";
import { Banner, Button, Panel } from "@/components/bits";
import { errorText, formatWhen } from "@/lib/dialer/format";

export const Route = createFileRoute("/app/audit")({ component: AuditPage });

function AuditPage() {
  const { membership, allow } = useWorkspace();
  const [page, setPage] = useState(1);
  const audit = useQuery({
    queryKey: ["audit", membership.orgId, page],
    queryFn: () => listAudit({ data: { orgId: membership.orgId, page } }),
    enabled: allow("view_audit"),
  });
  if (!allow("view_audit")) return <Banner tone="warn">The audit log is limited to supervisors and above.</Banner>;
  return (
    <>
      <PageTitle title="Audit" lane="Admin" steps={[{ label: "Actions", href: "#actions" }]} />
      {audit.isError ? <Banner tone="bad">{errorText(audit.error)}</Banner> : null}
      <Panel title="Sensitive actions" id="actions">
        <ul className="grid gap-2 text-sm">
          {(audit.data?.entries ?? []).map((entry) => (
            <li key={entry.id} className="grid gap-1 border-b border-line py-2 sm:grid-cols-4">
              <span>{formatWhen(entry.createdAt)}</span>
              <span>{entry.actor}</span>
              <span>{entry.action}</span>
              <span className="text-fog">{entry.entityType}</span>
            </li>
          ))}
          {(audit.data?.entries.length ?? 0) === 0 ? <li className="text-fog">No audit rows on this page.</li> : null}
        </ul>
        <div className="mt-3 flex gap-2">
          <Button type="button" variant="ghost" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Previous</Button>
          <Button type="button" variant="ghost" disabled={(audit.data?.entries.length ?? 0) < 40} onClick={() => setPage((value) => value + 1)}>Next</Button>
        </div>
      </Panel>
    </>
  );
}
