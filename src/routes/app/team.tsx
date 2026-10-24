import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { inviteMember, listTeam, removeMember, revokeInvite, setMemberRole, setMemberPassword } from "@/server/team";
import { useWorkspace, PageTitle } from "@/components/workspace";
import { Banner, Button, Field, Panel, SelectInput, TextInput } from "@/components/bits";
import { ROLE_LABEL, presenceLabel } from "@/lib/dialer/labels";
import { errorText, formatWhen } from "@/lib/dialer/format";
import { useCurrentUser } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/app/team")({ component: TeamPage });

function TeamPage() {
  const { membership, allow, limits, usage } = useWorkspace();
  const me = useCurrentUser();
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "supervisor" | "agent">("agent");
  const [link, setLink] = useState("");
  const team = useQuery({
    queryKey: ["team", membership.orgId],
    queryFn: () => listTeam({ data: { orgId: membership.orgId } }),
    enabled: allow("manage_team"),
  });
  if (!allow("manage_team")) return <Banner tone="warn">Team management is limited to admins and owners.</Banner>;
  return (
    <>
      <PageTitle title="Team" lane="Admin" steps={[{ label: "Seats", href: "#seats" }, { label: "Invite", href: "#invite" }, { label: "Role", href: "#seats" }]} />
      <p className="text-sm text-fog">
        {usage?.agents ?? 0} of {limits?.maxAgents ?? "—"} seats on the {membership.plan} plan, including you. Invites are links, not emails.
      </p>
      <Panel title="Members" id="seats">
        <ul className="grid gap-3">
          {(team.data?.members ?? []).map((member) => (
            <li key={member.userId} className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3 text-sm">
              <div>
                <p className="font-medium">{member.name}</p>
                <p className="text-fog">{member.email} · {presenceLabel(member.presence)}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <SelectInput
                  aria-label={`Role for ${member.name}`}
                  value={member.role}
                  disabled={(member.userId === me?.id && member.role === "owner") || (membership.role !== "owner" && (member.role === "owner" || member.role === "admin"))}
                  onChange={(event) => {
                    void setMemberRole({ data: { orgId: membership.orgId, userId: member.userId, role: event.target.value as "owner" | "admin" | "supervisor" | "agent" } })
                      .then(() => client.invalidateQueries({ queryKey: ["team", membership.orgId] }))
                      .catch((error: unknown) => toast.error(errorText(error)));
                  }}
                >
                  {(() => {
                    const grantable = membership.role === "owner" ? (["owner", "admin", "supervisor", "agent"] as const) : (["supervisor", "agent"] as const);
                    const options = (grantable as readonly string[]).includes(member.role) ? grantable : [member.role, ...grantable];
                    return options.map((item) => (
                      <option key={item} value={item}>{ROLE_LABEL[item as keyof typeof ROLE_LABEL] ?? item}</option>
                    ));
                  })()}
                </SelectInput>
                {member.userId !== me?.id ? (
                  <>
                    <PasswordSet orgId={membership.orgId} userId={member.userId} name={member.name} />
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        if (!window.confirm(`Remove ${member.name} from this workspace?`)) return;
                        void removeMember({ data: { orgId: membership.orgId, userId: member.userId } })
                          .then(() => client.invalidateQueries({ queryKey: ["team", membership.orgId] }))
                          .catch((error: unknown) => toast.error(errorText(error)));
                      }}
                    >
                      Remove
                    </Button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Invite" id="invite">
        <form
          className="grid gap-3 md:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            void inviteMember({ data: { orgId: membership.orgId, email, role } })
              .then((result) => {
                setLink(`${window.location.origin}${result.path}`);
                setEmail("");
                void client.invalidateQueries({ queryKey: ["team", membership.orgId] });
              })
              .catch((error: unknown) => toast.error(errorText(error)));
          }}
        >
          <Field label="Email"><TextInput type="email" value={email} required onChange={(event) => setEmail(event.target.value)} /></Field>
          <Field label="Role">
            <SelectInput value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
              <option value="agent">Agent</option>
              <option value="supervisor">Supervisor</option>
              {membership.role === "owner" ? <option value="admin">Admin</option> : null}
            </SelectInput>
          </Field>
          <div className="flex items-end"><Button type="submit">Create invite link</Button></div>
        </form>
        {link ? <p className="mt-3 break-all font-mono text-sm">{link}</p> : null}
        <ul className="mt-4 grid gap-2 text-sm">
          {(team.data?.invites ?? []).map((invite) => (
            <li key={invite.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>{invite.email} · {invite.role} · expires {formatWhen(invite.expiresAt)}</span>
              <Button type="button" variant="quiet" onClick={() => void revokeInvite({ data: { orgId: membership.orgId, inviteId: invite.id } }).then(() => client.invalidateQueries({ queryKey: ["team"] }))}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

function PasswordSet({ orgId, userId, name }: { orgId: string; userId: string; name: string }) {
  const [password, setPassword] = useState("");
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button type="button" variant="ghost" onClick={() => setOpen(true)}>
        Set password
      </Button>
    );
  }
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (password.length < 8) {
          toast.error("Use at least 8 characters.");
          return;
        }
        void setMemberPassword({ data: { orgId, userId, password } })
          .then(() => {
            toast.success(`${name} can sign in with the new password. Their other sessions are signed out.`);
            setPassword("");
            setOpen(false);
          })
          .catch((error: unknown) => toast.error(errorText(error)));
      }}
    >
      <TextInput type="password" value={password} minLength={8} placeholder="New password" onChange={(event) => setPassword(event.target.value)} />
      <Button type="submit">Save</Button>
    </form>
  );
}
