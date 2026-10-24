import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { formatPhone } from "@/lib/dialer/phone";
import { requireActor } from "./actor";
import { parseInput } from "./validate";

export const getFloor = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(z.object({ orgId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "view_all_calls");
    const sql = await getSql();
    const agents = await sql<{ user_id: string; name: string; status: string | null; callback_e164: string }>`
      select m.user_id, u."name" as name, p.status, m.callback_e164
      from memberships m
      join "user" u on u."id" = m.user_id
      left join agent_presence p on p.org_id = m.org_id and p.user_id = m.user_id
      where m.org_id = ${actor.orgId} and m.status = 'active'
      order by u."name" asc`;
    const live = await sql<{ id: string; agent_user_id: string; state: string; direction: string; to_number: string; name: string | null }>`
      select k.id, k.agent_user_id, k.state, k.direction, k.to_number,
             nullif(trim(concat(ct.first_name, ' ', ct.last_name)), '') as name
      from calls k
      left join contacts ct on ct.id = k.contact_id
      where k.org_id = ${actor.orgId}
        and k.state in ('manual_open', 'requested', 'ringing', 'in_progress')
      order by k.started_at desc
      limit 50`;
    const queues = await sql<{ id: string; name: string; remaining: number }>`
      select g.id, g.name,
        (select count(*)::int from campaign_contacts cc
          join contacts ct on ct.id = cc.contact_id
          where cc.campaign_id = g.id and cc.completed = false and ct.dnc = false and ct.archived_at is null
            and (cc.next_attempt_at is null or cc.next_attempt_at <= now())) as remaining
      from campaigns g
      where g.org_id = ${actor.orgId} and g.status = 'active'
      order by g.name asc`;
    return {
      agents: agents.map((agent) => ({
        userId: agent.user_id,
        name: agent.name || "Agent",
        status: agent.status || "offline",
        callback: agent.callback_e164 ? formatPhone(agent.callback_e164) : "",
      })),
      live: live.map((call) => ({
        id: call.id,
        agentUserId: call.agent_user_id,
        state: call.state,
        direction: call.direction,
        who: call.name || formatPhone(call.to_number),
      })),
      queues: queues.map((queue) => ({ id: queue.id, name: queue.name, remaining: Number(queue.remaining) })),
    };
  });
