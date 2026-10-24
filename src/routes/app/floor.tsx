import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getFloor } from "@/server/floor";
import { useWorkspace, PageTitle } from "@/components/workspace";
import { Banner, Empty, Panel } from "@/components/bits";
import { STATE_LABEL } from "@/lib/dialer/labels";
import { presenceLabel } from "@/lib/dialer/labels";
import { errorText } from "@/lib/dialer/format";

export const Route = createFileRoute("/app/floor")({ component: FloorPage });

function FloorPage() {
  const { membership, allow } = useWorkspace();
  const floor = useQuery({
    queryKey: ["floor", membership.orgId],
    queryFn: () => getFloor({ data: { orgId: membership.orgId } }),
    enabled: allow("view_all_calls"),
    refetchInterval: 5000,
  });
  if (!allow("view_all_calls")) return <Banner>The floor is for supervisors.</Banner>;
  return (
    <>
      <PageTitle title="Floor" lane="Desk" steps={[{ label: "Agents", href: "#agents" }, { label: "Queue", href: "#queue" }]} />
      <p className="text-sm text-fog">Who is on a call right now, and what is still due. This refreshes every few seconds. It is not a recording.</p>
      {floor.isError ? <Banner tone="bad">{errorText(floor.error)}</Banner> : null}
      <Panel title="Agents" id="agents">
        {floor.data && floor.data.agents.length > 0 ? (
          <ul className="grid gap-2 text-sm">
            {floor.data.agents.map((agent) => {
              const current = floor.data?.live.find((call) => call.agentUserId === agent.userId);
              return (
                <li key={agent.userId} className="flex flex-wrap justify-between gap-2 border-b border-line py-2">
                  <span className="font-medium">{agent.name}</span>
                  <span className="text-fog">
                    {current ? `${STATE_LABEL[current.state] ?? current.state} · ${current.direction} · ${current.who}` : presenceLabel(agent.status)}
                    {agent.callback ? ` · ${agent.callback}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty title="No agents" body="Invite the team before the floor can show anyone." />
        )}
      </Panel>
      <Panel title="Due now" id="queue">
        {floor.data && floor.data.queues.length > 0 ? (
          <ul className="grid gap-1 text-sm">
            {floor.data.queues.map((queue) => (
              <li key={queue.id} className="flex justify-between gap-2">
                <Link to="/app/dial" search={{ campaignId: queue.id, contactId: "" }} className="underline-offset-4 hover:underline">
                  {queue.name}
                </Link>
                <span className="text-fog">{queue.remaining} ready</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="No active campaigns" body="Start a campaign to see the queue." />
        )}
      </Panel>
    </>
  );
}
