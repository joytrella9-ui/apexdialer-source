import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { getOverview } from "@/server/reports";
import { listFollowUps } from "@/server/calls";
import { useWorkspace } from "@/components/workspace";
import { Banner, Empty, Panel, Stat, StatusPill } from "@/components/bits";
import { PageTitle as Title } from "@/components/workspace";
import { formatRate } from "@/lib/dialer/metrics";
import { DISPOSITION_LABEL, STATE_LABEL, presenceLabel } from "@/lib/dialer/labels";
import { formatWhen } from "@/lib/dialer/format";

export const Route = createFileRoute("/app/")({ component: OverviewPage });

function OverviewPage() {
  const { membership, usage, limits, telephony } = useWorkspace();
  const overview = useQuery({
    queryKey: ["overview", membership.orgId],
    queryFn: () => getOverview({ data: { orgId: membership.orgId } }),
  });
  const followUps = useQuery({
    queryKey: ["followups", membership.orgId],
    queryFn: () => listFollowUps({ data: { orgId: membership.orgId } }),
  });
  const data = overview.data;
  return (
    <>
      <Title title="Board" lane="Desk" steps={[{ label: "Review", href: "#review" }, { label: "Session", href: "/app/dial" }, { label: "Outcome", href: "#outcomes" }]}>
        <Link to="/app/dial" search={{ campaignId: "", contactId: "" }} className="inline-flex min-h-11 items-center rounded-lg bg-teal px-4 text-sm font-medium text-paper-ink">
          Open session
        </Link>
      </Title>
      <Banner>{telephony.detail}</Banner>
      {overview.isError ? <Banner tone="bad">Overview could not be loaded.</Banner> : null}
      <div id="review" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={data?.scope === "mine" ? "Your attempts today" : "Attempts today"} value={String(data?.today.attempts ?? "—")} note="Completed or failed calls" />
        <Stat label="Reported connect rate" value={data ? formatRate(data.today.reportedConnectionRate) : "—"} note="Needs at least one attempt" />
        <Stat
          label="Verified connect rate"
          value={data ? formatRate(data.today.verifiedConnectionRate) : "—"}
          note="Only Twilio-confirmed attempts"
        />
        <Stat
          label="Contacts"
          value={usage ? `${usage.contacts}/${limits?.maxContacts ?? "—"}` : "—"}
          note={`${usage?.campaigns ?? 0} open campaigns · ${membership.plan}`}
        />
      </div>
      <div className="grid gap-4 lg:grid-cols-5">
        <Panel title="Last 14 days">
          {data && data.series.length > 0 ? (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.series}>
                  <CartesianGrid stroke="var(--color-line)" vertical={false} />
                  <XAxis dataKey="day" tick={{ fill: "var(--color-fog)", fontSize: 11 }} />
                  <YAxis allowDecimals={false} width={32} tick={{ fill: "var(--color-fog)", fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ background: "#101722", border: "1px solid #243044", borderRadius: 8, color: "#e7eef8" }}
                    cursor={{ fill: "rgba(92, 225, 255, 0.06)" }}
                  />
                  <Bar dataKey="attempts" fill="#5ce1ff" name="Attempts" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="connects" fill="#3ddc97" name="Connects" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <Empty title="No attempts in this window" body="The chart stays empty until calls are completed or failed. Open sessions are not counted." />
          )}
        </Panel>
        <div className="grid gap-4 lg:col-span-2">
          <Panel title="People">
            {data && data.presence.length > 0 ? (
              <ul className="grid gap-2">
                {data.presence.map((person) => (
                  <li key={person.name} className="flex items-center justify-between gap-3 text-sm">
                    <span>{person.name}</span>
                    <StatusPill tone={person.status === "available" ? "ok" : person.status === "offline" ? "neutral" : "warn"}>
                      {presenceLabel(person.status)}
                    </StatusPill>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title="No members yet" body="Team status appears after someone joins." />
            )}
          </Panel>
          <Panel title="Follow-ups" id="outcomes">
            {followUps.data && followUps.data.followUps.length > 0 ? (
              <ul className="grid gap-2 text-sm">
                {followUps.data.followUps.slice(0, 5).map((item) => (
                  <li key={item.id} className="flex justify-between gap-3">
                    <span>{item.name}</span>
                    <span className="text-fog">{formatWhen(item.dueAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title="Nothing due" body="Callbacks you schedule show up here." />
            )}
          </Panel>
        </div>
      </div>
      <Panel title="Recent calls" action={<span className="text-xs text-fog">{data?.campaigns.active ?? 0} active campaigns</span>}>
        {data && data.recent.length > 0 ? (
          <ul className="divide-y divide-line text-sm">
            {data.recent.map((call) => (
              <li key={call.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{call.name}</span>
                <span className="text-fog">{STATE_LABEL[call.state] ?? call.state}</span>
                <span>{DISPOSITION_LABEL[call.disposition] ?? (call.disposition || "No disposition")}</span>
                <span className="text-fog">{call.providerVerified ? "Provider verified" : "Not provider verified"}</span>
                <span className="text-fog">{formatWhen(call.startedAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="No calls yet" body={data?.scope === "mine" ? "Your calls will appear here." : "Workspace calls will appear here."} />
        )}
      </Panel>
    </>
  );
}
