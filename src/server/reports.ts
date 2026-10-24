import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { formatRate } from "@/lib/dialer/metrics";
import { can } from "@/lib/dialer/permissions";
import { requireActor } from "./actor";
import { parseInput } from "./validate";

const rangeSchema = z.object({
  orgId: z.string().min(8).max(80),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  campaignId: z.string().max(80).default(""),
});

type Totals = {
  attempts: number;
  connects: number;
  verified_attempts: number;
  verified_connects: number;
  no_answer: number;
  voicemail: number;
  failed: number;
  busy: number;
  duration_seconds: number;
  duration_samples: number;
};

function mapTotals(row: Totals | undefined) {
  const attempts = Number(row?.attempts ?? 0);
  const connects = Number(row?.connects ?? 0);
  const verifiedAttempts = Number(row?.verified_attempts ?? 0);
  const verifiedConnects = Number(row?.verified_connects ?? 0);
  const samples = Number(row?.duration_samples ?? 0);
  return {
    attempts,
    connects,
    verifiedAttempts,
    verifiedConnects,
    noAnswer: Number(row?.no_answer ?? 0),
    voicemail: Number(row?.voicemail ?? 0),
    failed: Number(row?.failed ?? 0),
    busy: Number(row?.busy ?? 0),
    durationSeconds: Number(row?.duration_seconds ?? 0),
    reportedConnectionRate: attempts > 0 ? connects / attempts : null,
    verifiedConnectionRate: verifiedAttempts > 0 ? verifiedConnects / verifiedAttempts : null,
    reportedConnectionLabel: formatRate(attempts > 0 ? connects / attempts : null),
    verifiedConnectionLabel: formatRate(verifiedAttempts > 0 ? verifiedConnects / verifiedAttempts : null),
    averageDurationSeconds: samples > 0 ? Math.round(Number(row?.duration_seconds ?? 0) / samples) : null,
  };
}

const TOTALS_SQL = `
  count(*) filter (where state in ('completed', 'failed'))::int as attempts,
  count(*) filter (where state in ('completed', 'failed') and disposition in ('answered', 'interested', 'not_interested', 'callback'))::int as connects,
  count(*) filter (where provider_verified and state in ('completed', 'failed'))::int as verified_attempts,
  count(*) filter (where provider_verified and state in ('completed', 'failed') and disposition in ('answered', 'interested', 'not_interested', 'callback'))::int as verified_connects,
  count(*) filter (where disposition = 'no_answer')::int as no_answer,
  count(*) filter (where disposition = 'voicemail')::int as voicemail,
  count(*) filter (where state = 'failed' or disposition = 'failed')::int as failed,
  count(*) filter (where disposition = 'busy')::int as busy,
  coalesce(sum(duration_seconds) filter (where state in ('completed', 'failed')), 0)::int as duration_seconds,
  count(*) filter (where state in ('completed', 'failed') and duration_seconds is not null)::int as duration_samples
`;

export const getOverview = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(z.object({ orgId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId);
    const sql = await getSql();
    const mine = !can(actor.role, "view_reports");
    const today = await sql.query<Totals>(
      `select ${TOTALS_SQL} from calls
       where org_id = $1
         and started_at >= (date_trunc('day', now() at time zone $2) at time zone $2)
         and started_at < ((date_trunc('day', now() at time zone $2) + interval '1 day') at time zone $2)
         and ($3::boolean = false or agent_user_id = $4)`,
      [actor.orgId, actor.timezone, mine, actor.userId],
    );
    const week = await sql.query<Totals>(
      `select ${TOTALS_SQL} from calls
       where org_id = $1 and started_at >= now() - interval '7 days'
         and ($2::boolean = false or agent_user_id = $3)`,
      [actor.orgId, mine, actor.userId],
    );
    const series = await sql.query<{ day: string; attempts: number; connects: number }>(
      `select to_char((started_at at time zone $2)::date, 'YYYY-MM-DD') as day,
              count(*) filter (where state in ('completed', 'failed'))::int as attempts,
              count(*) filter (where state in ('completed', 'failed') and disposition in ('answered', 'interested', 'not_interested', 'callback'))::int as connects
       from calls
       where org_id = $1 and started_at >= now() - interval '14 days'
         and ($3::boolean = false or agent_user_id = $4)
       group by 1
       order by 1`,
      [actor.orgId, actor.timezone, mine, actor.userId],
    );
    const recent = await sql<{
      id: string;
      state: string;
      disposition: string;
      to_number: string;
      started_at: unknown;
      provider_verified: boolean;
      name: string | null;
    }>`
      select k.id, k.state, k.disposition, k.to_number, k.started_at, k.provider_verified,
             nullif(trim(concat(ct.first_name, ' ', ct.last_name)), '') as name
      from calls k
      left join contacts ct on ct.id = k.contact_id
      where k.org_id = ${actor.orgId}
        and (${mine} = false or k.agent_user_id = ${actor.userId})
      order by k.started_at desc
      limit 8`;
    const presence = await sql<{ name: string; role: string; status: string | null }>`
      select u."name" as name, m.role, p.status
      from memberships m
      join "user" u on u."id" = m.user_id
      left join agent_presence p on p.org_id = m.org_id and p.user_id = m.user_id
      where m.org_id = ${actor.orgId} and m.status = 'active'
      order by u."name" asc`;
    const campaigns = await sql<{ active: number; paused: number }>`
      select
        count(*) filter (where status = 'active')::int as active,
        count(*) filter (where status = 'paused')::int as paused
      from campaigns where org_id = ${actor.orgId}`;
    return {
      today: mapTotals(today[0]),
      week: mapTotals(week[0]),
      series: series.map((point) => ({ day: point.day, attempts: Number(point.attempts), connects: Number(point.connects) })),
      recent: recent.map((row) => ({
        id: row.id,
        state: row.state,
        disposition: row.disposition,
        toNumber: row.to_number,
        startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
        providerVerified: Boolean(row.provider_verified),
        name: row.name ?? "Unknown contact",
      })),
      presence: presence.map((row) => ({ name: row.name, role: row.role, status: row.status ?? "offline" })),
      campaigns: { active: Number(campaigns[0]?.active ?? 0), paused: Number(campaigns[0]?.paused ?? 0) },
      scope: mine ? ("mine" as const) : ("workspace" as const),
    };
  });

export const getReport = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(rangeSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "view_reports");
    const sql = await getSql();
    const totals = await sql.query<Totals>(
      `select ${TOTALS_SQL} from calls
       where org_id = $1
         and started_at >= ($2::date::timestamp at time zone $3)
         and started_at < (($4::date + 1)::timestamp at time zone $3)
         and ($5 = '' or campaign_id = $5)`,
      [actor.orgId, data.from, actor.timezone, data.to, data.campaignId],
    );
    const byAgent = await sql.query<{ name: string; attempts: number; connects: number; duration_seconds: number }>(
      `select coalesce(u."name", 'Unknown') as name,
              count(*) filter (where k.state in ('completed', 'failed'))::int as attempts,
              count(*) filter (where k.state in ('completed', 'failed') and k.disposition in ('answered', 'interested', 'not_interested', 'callback'))::int as connects,
              coalesce(sum(k.duration_seconds) filter (where k.state in ('completed', 'failed')), 0)::int as duration_seconds
       from calls k
       left join "user" u on u."id" = k.agent_user_id
       where k.org_id = $1
         and k.started_at >= ($2::date::timestamp at time zone $3)
         and k.started_at < (($4::date + 1)::timestamp at time zone $3)
         and ($5 = '' or k.campaign_id = $5)
       group by 1
       order by attempts desc
       limit 50`,
      [actor.orgId, data.from, actor.timezone, data.to, data.campaignId],
    );
    const byCampaign = await sql.query<{ name: string; attempts: number; connects: number }>(
      `select coalesce(g.name, 'Ad hoc') as name,
              count(*) filter (where k.state in ('completed', 'failed'))::int as attempts,
              count(*) filter (where k.state in ('completed', 'failed') and k.disposition in ('answered', 'interested', 'not_interested', 'callback'))::int as connects
       from calls k
       left join campaigns g on g.id = k.campaign_id
       where k.org_id = $1
         and k.started_at >= ($2::date::timestamp at time zone $3)
         and k.started_at < (($4::date + 1)::timestamp at time zone $3)
         and ($5 = '' or k.campaign_id = $5)
       group by 1
       order by attempts desc
       limit 50`,
      [actor.orgId, data.from, actor.timezone, data.to, data.campaignId],
    );
    return {
      totals: mapTotals(totals[0]),
      byAgent: byAgent.map((row) => ({
        name: row.name,
        attempts: Number(row.attempts),
        connects: Number(row.connects),
        durationSeconds: Number(row.duration_seconds),
        rate: formatRate(Number(row.attempts) > 0 ? Number(row.connects) / Number(row.attempts) : null),
      })),
      byCampaign: byCampaign.map((row) => ({
        name: row.name,
        attempts: Number(row.attempts),
        connects: Number(row.connects),
        rate: formatRate(Number(row.attempts) > 0 ? Number(row.connects) / Number(row.attempts) : null),
      })),
      formulas: {
        attempt: "A call whose state is completed or failed. Canceled, open, and skipped device sessions are not attempts.",
        reportedConnect: "An attempt dispositioned answered, interested, not interested, or callback. Device dials are agent-reported.",
        verifiedConnect: "The same numerator and denominator, restricted to provider-verified rows. Unavailable when Twilio has not confirmed any attempt.",
      },
    };
  });
