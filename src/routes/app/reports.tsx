import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getReport } from "@/server/reports";
import { listCampaigns } from "@/server/campaigns";
import { useWorkspace, PageTitle } from "@/components/workspace";
import { Banner, Field, Panel, SelectInput, Stat, TextInput } from "@/components/bits";
import { errorText, formatDuration, isoDate } from "@/lib/dialer/format";

export const Route = createFileRoute("/app/reports")({ component: ReportsPage });

function ReportsPage() {
  const { membership, allow } = useWorkspace();
  const [from, setFrom] = useState(isoDate(-13));
  const [to, setTo] = useState(isoDate(0));
  const [campaignId, setCampaignId] = useState("");
  const campaigns = useQuery({
    queryKey: ["campaigns", membership.orgId, "all"],
    queryFn: () => listCampaigns({ data: { orgId: membership.orgId, status: "all" } }),
    enabled: allow("view_reports"),
  });
  const report = useQuery({
    queryKey: ["report", membership.orgId, from, to, campaignId],
    queryFn: () => getReport({ data: { orgId: membership.orgId, from, to, campaignId } }),
    enabled: allow("view_reports"),
  });
  if (!allow("view_reports")) return <Banner tone="warn">Reports are limited to supervisors and above.</Banner>;
  const totals = report.data?.totals;
  return (
    <>
      <PageTitle title="Analytics" lane="Admin" steps={[{ label: "Today", href: "#today" }, { label: "Agents", href: "#agents" }, { label: "Campaigns", href: "#campaigns" }]} />
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="From"><TextInput type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></Field>
        <Field label="To"><TextInput type="date" value={to} onChange={(event) => setTo(event.target.value)} /></Field>
        <Field label="Campaign">
          <SelectInput value={campaignId} onChange={(event) => setCampaignId(event.target.value)}>
            <option value="">All</option>
            {(campaigns.data?.campaigns ?? []).map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
          </SelectInput>
        </Field>
      </div>
      {report.isError ? <Banner tone="bad">{errorText(report.error)}</Banner> : null}
      <div id="today" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Attempts" value={totals ? String(totals.attempts) : "—"} />
        <Stat label="Reported connect" value={totals?.reportedConnectionLabel ?? "—"} />
        <Stat label="Verified connect" value={totals?.verifiedConnectionLabel ?? "—"} />
        <Stat label="Average duration" value={totals ? formatDuration(totals.averageDurationSeconds) : "—"} />
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="No answer" value={totals ? String(totals.noAnswer) : "—"} />
        <Stat label="Voicemail" value={totals ? String(totals.voicemail) : "—"} />
        <Stat label="Busy" value={totals ? String(totals.busy) : "—"} />
        <Stat label="Failed" value={totals ? String(totals.failed) : "—"} />
      </div>
      <Panel title="By agent" id="agents">
        <SimpleTable rows={report.data?.byAgent ?? []} />
      </Panel>
      <Panel title="By campaign" id="campaigns">
        <SimpleTable rows={report.data?.byCampaign ?? []} />
      </Panel>
      {report.data ? (
        <Panel title="How the numbers are counted">
          <ul className="grid gap-2 text-sm text-fog">
            <li>{report.data.formulas.attempt}</li>
            <li>{report.data.formulas.reportedConnect}</li>
            <li>{report.data.formulas.verifiedConnect}</li>
          </ul>
        </Panel>
      ) : null}
    </>
  );
}

function SimpleTable({ rows }: { rows: { name: string; attempts: number; connects: number; rate: string; durationSeconds?: number }[] }) {
  if (rows.length === 0) return <p className="text-sm text-fog">No attempts in this range.</p>;
  return (
    <table className="data-table">
      <thead className="text-xs text-fog uppercase"><tr><th className="py-2">Name</th><th>Attempts</th><th>Connects</th><th>Rate</th></tr></thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.name} className="border-t border-line">
            <td className="py-2">{row.name}</td>
            <td className="num">{row.attempts}</td>
            <td className="num">{row.connects}</td>
            <td className="num">{row.rate}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
