import { getSql, type Sql } from "@/lib/db";
import { billingAllowsMutation } from "@/lib/dialer/plans";
import { can, isRole, type Action, type Role } from "@/lib/dialer/permissions";

export function newId(): string {
  return crypto.randomUUID();
}

export function asIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function asDays(value: unknown): number[] {
  const raw = Array.isArray(value)
    ? value.map(Number)
    : typeof value === "string"
      ? value.replace(/[{}]/g, "").split(",").filter(Boolean).map(Number)
      : [];
  const days = raw.filter((day) => day >= 0 && day <= 6);
  return days.length ? days : [1, 2, 3, 4, 5];
}

export function asTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return [];
}

export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type Actor = {
  userId: string;
  orgId: string;
  orgName: string;
  role: Role;
  timezone: string;
  plan: string;
  billingStatus: string;
  windowStart: string;
  windowEnd: string;
  callingDays: number[];
  recordingPolicy: string;
  retentionDays: number;
  callbackPhone: string;
};

type MembershipRow = {
  org_id: string;
  org_name: string;
  role: string;
  timezone: string;
  plan: string;
  billing_status: string;
  window_start: string;
  window_end: string;
  calling_days: unknown;
  recording_policy: string;
  retention_days: number;
  callback_e164: string;
};

function mapActor(userId: string, row: MembershipRow): Actor {
  if (!isRole(row.role)) throw new HttpError("Membership role is invalid.", 500);
  return {
    userId,
    orgId: row.org_id,
    orgName: row.org_name,
    role: row.role,
    timezone: row.timezone,
    plan: row.plan,
    billingStatus: row.billing_status,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    callingDays: asDays(row.calling_days),
    recordingPolicy: row.recording_policy,
    retentionDays: Number(row.retention_days),
    callbackPhone: row.callback_e164 ?? "",
  };
}

const MEMBERSHIP_SELECT = `
  select o.id as org_id, o.name as org_name, m.role, o.timezone, o.plan, o.billing_status,
         o.window_start, o.window_end, o.calling_days, o.recording_policy, o.retention_days,
         m.callback_e164
  from memberships m
  join organizations o on o.id = m.org_id
`;

export async function findActor(userId: string, orgId?: string | null): Promise<Actor | null> {
  const sql = await getSql();
  const rows = orgId
    ? await sql.query<MembershipRow>(
        `${MEMBERSHIP_SELECT} where m.user_id = $1 and m.status = 'active' and o.id = $2 limit 1`,
        [userId, orgId],
      )
    : await sql.query<MembershipRow>(
        `${MEMBERSHIP_SELECT} where m.user_id = $1 and m.status = 'active' order by m.created_at asc limit 1`,
        [userId],
      );
  const row = rows[0];
  return row ? mapActor(userId, row) : null;
}

export async function requireActor(userId: string, orgId: string | null | undefined, action?: Action): Promise<Actor> {
  const actor = await findActor(userId, orgId);
  if (!actor || (orgId && actor.orgId !== orgId)) throw new HttpError("You do not belong to this workspace.", 403);
  if (action && !can(actor.role, action)) throw new HttpError("You do not have permission for that action.", 403);
  return actor;
}

export function assertMutable(actor: Actor) {
  if (!billingAllowsMutation(actor.billingStatus)) {
    throw new HttpError("This workspace is read-only until billing is active again.", 402);
  }
}

export async function writeAudit(
  sql: Sql,
  actor: { orgId: string; userId: string },
  action: string,
  entityType: string,
  entityId: string,
  metadata: Record<string, string | number | boolean | null>,
) {
  await sql`
    insert into audit_log (id, org_id, actor_user_id, action, entity_type, entity_id, metadata)
    values (
      ${newId()},
      ${actor.orgId},
      ${actor.userId},
      ${action},
      ${entityType},
      ${entityId},
      ${JSON.stringify(metadata)}::jsonb
    )`;
}

export async function notifyUser(sql: Sql, orgId: string, userId: string, title: string, body: string) {
  await sql`
    insert into notifications (id, org_id, user_id, title, body)
    values (${newId()}, ${orgId}, ${userId}, ${title}, ${body})`;
}

export async function countActiveContacts(sql: Sql, orgId: string): Promise<number> {
  const rows = await sql<{ n: number }>`
    select count(*)::int as n from contacts where org_id = ${orgId} and archived_at is null`;
  return Number(rows[0]?.n ?? 0);
}

export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, "\\$&")}%`;
}

export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && String(error.code) === "23505") return true;
  const message = error instanceof Error ? error.message : "";
  return message.includes("23505") || /duplicate key value/i.test(message);
}
