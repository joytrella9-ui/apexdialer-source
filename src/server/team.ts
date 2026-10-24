import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getSql } from "@/lib/db";
import { authMiddleware } from "@/lib/auth/middleware";
import { isE164, normalizePhone } from "@/lib/dialer/phone";
import { planLimits } from "@/lib/dialer/plans";
import { can, canEditMember, canGrantRole, isRole, type Role } from "@/lib/dialer/permissions";
import { asIso, newId, requireActor, writeAudit } from "./actor";
import { parseInput } from "./validate";

const orgSchema = z.object({ orgId: z.string().min(8).max(80) });

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const setMemberPassword = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    parseInput(orgSchema.extend({ userId: z.string().min(8).max(80), password: z.string().min(8).max(80) }), input),
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_team");
    if (data.userId === actor.userId) throw new Error("Change your own password in Settings.");
    const sql = await getSql();
    const members = await sql<{ role: string }>`
      select role from memberships where org_id = ${actor.orgId} and user_id = ${data.userId} and status = 'active' limit 1`;
    const role = members[0]?.role;
    if (!role || !isRole(role)) throw new Error("That person is not on this workspace.");
    if (!canEditMember(actor.role, role)) throw new Error("You cannot set a password for this role.");
    const { hashPassword } = await import("better-auth/crypto");
    const hashed = await hashPassword(data.password);
    const updated = await sql<{ id: string }>`
      update "account"
      set "password" = ${hashed}, "updatedAt" = now()
      where "userId" = ${data.userId} and "providerId" = 'credential'
      returning "id"`;
    if (!updated[0]) {
      await sql`
        insert into "account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
        values (${newId()}, ${data.userId}, 'credential', ${data.userId}, ${hashed}, now(), now())`;
    }
    await sql`delete from "session" where "userId" = ${data.userId}`;
    await writeAudit(sql, actor, "team.password", "user", data.userId, {});
    return { ok: true as const };
  });

export const listTeam = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_campaigns");
    const sql = await getSql();
    const members = await sql<{ user_id: string; name: string; email: string; role: string; presence: string | null }>`
      select m.user_id, u."name" as name, u."email" as email, m.role, p.status as presence
      from memberships m
      join "user" u on u."id" = m.user_id
      left join agent_presence p on p.org_id = m.org_id and p.user_id = m.user_id
      where m.org_id = ${actor.orgId} and m.status = 'active'
      order by m.created_at asc`;
    const invites = can(actor.role, "manage_team")
      ? await sql<{ id: string; email: string; role: string; expires_at: unknown }>`
          select id, email, role, expires_at from invitations
          where org_id = ${actor.orgId} and accepted_at is null and expires_at > now()
          order by created_at desc`
      : [];
    return {
      members: members.map((member) => ({
        userId: member.user_id,
        name: member.name,
        email: member.email,
        role: member.role,
        presence: member.presence ?? "offline",
      })),
      invites: invites.map((invite) => ({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        expiresAt: asIso(invite.expires_at),
      })),
    };
  });

export const inviteMember = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    parseInput(orgSchema.extend({ email: z.string().trim().email().max(160), role: z.enum(["admin", "supervisor", "agent"]) }), input),
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_team");
    if (!isRole(data.role) || !canGrantRole(actor.role, data.role)) throw new Error("You cannot invite that role.");
    const sql = await getSql();
    const counts = await sql<{ members: number; pending: number }>`
      select
        (select count(*)::int from memberships where org_id = ${actor.orgId} and status = 'active') as members,
        (select count(*)::int from invitations where org_id = ${actor.orgId} and accepted_at is null and expires_at > now()) as pending`;
    const limits = planLimits(actor.plan);
    if (Number(counts[0]?.members ?? 0) + Number(counts[0]?.pending ?? 0) >= limits.maxAgents) {
      throw new Error(`The ${actor.plan} plan allows ${limits.maxAgents} members, including open invites.`);
    }
    const raw = randomToken();
    const hash = await sha256Hex(raw);
    await sql`
      insert into invitations (id, org_id, email, role, token_hash, expires_at, created_by)
      values (${newId()}, ${actor.orgId}, ${data.email.toLowerCase()}, ${data.role}, ${hash}, now() + interval '7 days', ${actor.userId})`;
    await writeAudit(sql, actor, "member.invite", "invitation", hash.slice(0, 12), { role: data.role });
    return { path: `/invite/${raw}` };
  });

export const revokeInvite = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ inviteId: z.string().min(8).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_team");
    const sql = await getSql();
    await sql`delete from invitations where id = ${data.inviteId} and org_id = ${actor.orgId} and accepted_at is null`;
    await writeAudit(sql, actor, "member.invite_revoke", "invitation", data.inviteId, {});
    return { ok: true as const };
  });

export const acceptInvite = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(z.object({ token: z.string().min(20).max(200) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const hash = await sha256Hex(data.token);
    const invites = await sql<{ id: string; org_id: string; email: string; role: string }>`
      select id, org_id, email, role from invitations
      where token_hash = ${hash} and accepted_at is null and expires_at > now()
      limit 1`;
    const invite = invites[0];
    if (!invite) throw new Error("This invite is invalid or expired.");
    const users = await sql<{ email: string }>`select "email" as email from "user" where "id" = ${context.userId} limit 1`;
    const email = users[0]?.email?.toLowerCase() ?? "";
    if (!email || email !== invite.email.toLowerCase()) {
      throw new Error("Sign in with the email address this invite was sent to.");
    }
    const orgRows = await sql<{ plan: string }>`select plan from organizations where id = ${invite.org_id} limit 1`;
    const limits = planLimits(orgRows[0]?.plan ?? "trial");
    const members = await sql<{ n: number }>`
      select count(*)::int as n from memberships where org_id = ${invite.org_id} and status = 'active' and user_id <> ${context.userId}`;
    if (Number(members[0]?.n ?? 0) >= limits.maxAgents) throw new Error("This workspace has no open seats.");
    const claimed = await sql<{ id: string }>`
      update invitations set accepted_at = now()
      where id = ${invite.id} and accepted_at is null and expires_at > now()
      returning id`;
    if (!claimed[0]) throw new Error("This invite is invalid or expired.");
    const existing = await sql<{ role: string; status: string }>`
      select role, status from memberships where org_id = ${invite.org_id} and user_id = ${context.userId} limit 1`;
    if (!existing[0]) {
      await sql`
        insert into memberships (id, org_id, user_id, role)
        values (${newId()}, ${invite.org_id}, ${context.userId}, ${invite.role})`;
    } else if (existing[0].role !== "owner") {
      await sql`
        update memberships set status = 'active', role = ${invite.role}
        where org_id = ${invite.org_id} and user_id = ${context.userId}`;
    } else {
      await sql`
        update memberships set status = 'active'
        where org_id = ${invite.org_id} and user_id = ${context.userId}`;
    }
    await sql`
      insert into agent_presence (org_id, user_id, status)
      values (${invite.org_id}, ${context.userId}, 'offline')
      on conflict (org_id, user_id) do nothing`;
    await writeAudit(sql, { orgId: invite.org_id, userId: context.userId }, "member.join", "membership", context.userId, {
      role: invite.role,
    });
    return { orgId: invite.org_id };
  });

export const setMemberRole = createServerFn({ method: "POST" })
  .validator((input: unknown) =>
    parseInput(orgSchema.extend({ userId: z.string().min(1).max(80), role: z.enum(["admin", "supervisor", "agent", "owner"]) }), input),
  )
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_team");
    if (!isRole(data.role) || !canGrantRole(actor.role, data.role)) throw new Error("You cannot grant that role.");
    const sql = await getSql();
    const target = await sql<{ role: string }>`
      select role from memberships where org_id = ${actor.orgId} and user_id = ${data.userId} and status = 'active' limit 1`;
    if (!target[0] || !isRole(target[0].role)) throw new Error("Member not found.");
    if (!canEditMember(actor.role, target[0].role)) throw new Error("You cannot change a member at your rank.");
    if (target[0].role === "owner" && data.role !== "owner") {
      const owners = await sql<{ n: number }>`
        select count(*)::int as n from memberships where org_id = ${actor.orgId} and role = 'owner' and status = 'active'`;
      if (Number(owners[0]?.n ?? 0) < 2) throw new Error("Add another owner before changing this role.");
    }
    await sql`update memberships set role = ${data.role} where org_id = ${actor.orgId} and user_id = ${data.userId}`;
    await writeAudit(sql, actor, "member.role", "membership", data.userId, { role: data.role as Role });
    return { ok: true as const };
  });

export const removeMember = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ userId: z.string().min(1).max(80) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "manage_team");
    if (data.userId === actor.userId) throw new Error("You cannot remove yourself.");
    const sql = await getSql();
    const target = await sql<{ role: string }>`
      select role from memberships where org_id = ${actor.orgId} and user_id = ${data.userId} and status = 'active' limit 1`;
    if (!target[0] || !isRole(target[0].role)) throw new Error("Member not found.");
    if (target[0].role === "owner") throw new Error("Transfer ownership before removing an owner.");
    if (!canEditMember(actor.role, target[0].role)) throw new Error("You cannot remove a member at your rank.");
    await sql`
      update memberships set status = 'removed'
      where org_id = ${actor.orgId} and user_id = ${data.userId}`;
    await sql`delete from campaign_agents where user_id = ${data.userId} and campaign_id in (select id from campaigns where org_id = ${actor.orgId})`;
    await writeAudit(sql, actor, "member.remove", "membership", data.userId, {});
    return { ok: true as const };
  });

export const setCallbackPhone = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ phone: z.string().max(32) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId);
    const phone = data.phone.trim() ? normalizePhone(data.phone) : "";
    if (data.phone.trim() && !phone) throw new Error("Enter a valid callback number or leave it blank.");
    if (phone && !isE164(phone)) throw new Error("Callback number must be E.164.");
    const sql = await getSql();
    await sql`
      update memberships set callback_e164 = ${phone ?? ""}
      where org_id = ${actor.orgId} and user_id = ${actor.userId} and status = 'active'`;
    return { phone: phone ?? "" };
  });

export const listNotifications = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId);
    const sql = await getSql();
    const rows = await sql<{ id: string; title: string; body: string; read_at: unknown; created_at: unknown }>`
      select id, title, body, read_at, created_at from notifications
      where org_id = ${actor.orgId} and user_id = ${actor.userId}
      order by created_at desc
      limit 30`;
    return {
      notifications: rows.map((row) => ({
        id: row.id,
        title: row.title,
        body: row.body,
        readAt: asIso(row.read_at),
        createdAt: asIso(row.created_at),
      })),
    };
  });

export const markNotificationsRead = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema, input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId);
    const sql = await getSql();
    await sql`
      update notifications set read_at = now()
      where org_id = ${actor.orgId} and user_id = ${actor.userId} and read_at is null`;
    return { ok: true as const };
  });

export const listAudit = createServerFn({ method: "POST" })
  .validator((input: unknown) => parseInput(orgSchema.extend({ page: z.number().int().min(1).default(1) }), input))
  .middleware([authMiddleware])
  .handler(async ({ context, data }) => {
    const actor = await requireActor(context.userId, data.orgId, "view_audit");
    const sql = await getSql();
    const offset = (data.page - 1) * 40;
    const rows = await sql<{
      id: string;
      actor_user_id: string;
      action: string;
      entity_type: string;
      entity_id: string;
      created_at: unknown;
      name: string | null;
    }>`
      select a.id, a.actor_user_id, a.action, a.entity_type, a.entity_id, a.created_at, u."name" as name
      from audit_log a
      left join "user" u on u."id" = a.actor_user_id
      where a.org_id = ${actor.orgId}
      order by a.created_at desc
      limit 40 offset ${offset}`;
    return {
      entries: rows.map((row) => ({
        id: row.id,
        actor: row.name || (row.actor_user_id === "twilio" || row.actor_user_id === "stripe" ? row.actor_user_id : "Member"),
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        createdAt: asIso(row.created_at),
      })),
    };
  });
