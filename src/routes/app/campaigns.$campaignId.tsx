import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { addCampaignContacts, getCampaign, setCampaignAgents, setCampaignStatus, updateCampaign } from "@/server/campaigns";
import { listContacts } from "@/server/contacts";
import { listTeam } from "@/server/team";
import { useWorkspace, PageTitle } from "@/components/workspace";
import { Banner, Button, Field, Panel, SelectInput, TextArea, TextInput } from "@/components/bits";
import { DAY_OPTIONS, errorText } from "@/lib/dialer/format";

export const Route = createFileRoute("/app/campaigns/$campaignId")({ component: CampaignPage });

function CampaignPage() {
  const { campaignId } = Route.useParams();
  const { membership, allow } = useWorkspace();
  const client = useQueryClient();
  const detail = useQuery({
    queryKey: ["campaign", membership.orgId, campaignId],
    queryFn: () => getCampaign({ data: { orgId: membership.orgId, campaignId } }),
  });
  const team = useQuery({
    queryKey: ["team", membership.orgId],
    queryFn: () => listTeam({ data: { orgId: membership.orgId } }),
    enabled: allow("manage_campaigns"),
  });
  const contacts = useQuery({
    queryKey: ["contacts", membership.orgId, "picker"],
    queryFn: () => listContacts({ data: { orgId: membership.orgId, query: "", dnc: "exclude", status: "all", page: 1, pageSize: 50 } }),
    enabled: allow("manage_campaigns"),
  });
  const campaign = detail.data?.campaign;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [script, setScript] = useState("");
  const [voicemailScript, setVoicemailScript] = useState("");
  const [smsTemplate, setSmsTemplate] = useState("");
  const [missSms, setMissSms] = useState(false);
  const [localPresence, setLocalPresence] = useState(false);
  const [agents, setAgents] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    if (!campaign || !detail.data) return;
    setName(campaign.name);
    setDescription(campaign.description);
    setScript(campaign.script);
    setVoicemailScript(campaign.voicemailScript);
    setSmsTemplate(campaign.smsTemplate);
    setMissSms(campaign.missSms);
    setLocalPresence(campaign.localPresence);
    setAgents(detail.data.agents.map((agent) => agent.userId));
  }, [campaign, detail.data]);
  if (detail.isError) return <Banner tone="bad">{errorText(detail.error)}</Banner>;
  if (!campaign) return <p className="text-sm text-fog">Loading campaign…</p>;
  const nextStatus =
    campaign.status === "draft" ? "active" : campaign.status === "active" ? "paused" : campaign.status === "paused" ? "active" : "draft";
  return (
    <>
      <PageTitle title={campaign.name} lane="Work" steps={[{ label: "Script", href: "#script" }, { label: "Agents", href: "#agents" }, { label: "Queue", href: "#queue" }, { label: "Dial", href: `/app/dial?campaignId=${campaign.id}` }]}>
        <Link to="/app/dial" search={{ campaignId, contactId: "" }} className="inline-flex min-h-11 items-center rounded-lg bg-teal px-4 text-sm font-medium text-paper-ink">
          Dial this campaign
        </Link>
      </PageTitle>
      <p className="text-sm text-fog">
        {campaign.status} · {campaign.dialMode} · {campaign.remaining} callable of {campaign.totalContacts} · {campaign.windowStart}–{campaign.windowEnd}
      </p>
      {allow("manage_campaigns") ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              void setCampaignStatus({ data: { orgId: membership.orgId, campaignId, status: nextStatus } })
                .then(() => {
                  toast.success(`Moved to ${nextStatus}`);
                  void client.invalidateQueries({ queryKey: ["campaign", membership.orgId, campaignId] });
                })
                .catch((error: unknown) => toast.error(errorText(error)));
            }}
          >
            {campaign.status === "active" ? "Pause" : campaign.status === "archived" ? "Reopen as draft" : "Start"}
          </Button>
          {campaign.status !== "archived" ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                if (!window.confirm("Archive this campaign? It leaves the live queue.")) return;
                void setCampaignStatus({ data: { orgId: membership.orgId, campaignId, status: "archived" } })
                  .then(() => client.invalidateQueries({ queryKey: ["campaign", membership.orgId, campaignId] }))
                  .catch((error: unknown) => toast.error(errorText(error)));
              }}
            >
              Archive
            </Button>
          ) : null}
        </div>
      ) : null}
      <Panel title="Configuration" id="script">
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void updateCampaign({
              data: {
                orgId: membership.orgId,
                campaignId,
                name,
                description,
                script,
                voicemailScript,
                smsTemplate,
                missSms,
                dialMode: campaign.dialMode as "manual" | "provider",
                timezone: campaign.timezone,
                windowStart: campaign.windowStart,
                windowEnd: campaign.windowEnd,
                callingDays: campaign.callingDays,
                maxAttempts: campaign.maxAttempts,
                retryMinutes: campaign.retryMinutes,
                callerId: campaign.callerId,
                localPresence,
              },
            })
              .then(() => toast.success("Campaign updated"))
              .catch((error: unknown) => toast.error(errorText(error)));
          }}
        >
          <Field label="Name">
            <TextInput value={name} disabled={!allow("manage_campaigns")} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Description">
            <TextArea value={description} disabled={!allow("manage_campaigns")} onChange={(event) => setDescription(event.target.value)} />
          </Field>
          <Field label="Script" hint="Shown to the agent before the dial. The first ordinary line is also what a screened call speaks, followed by Press 1 and Press 2. Start a required line with *, -, MUST:, or Say: so the notes check can see it.">
            <TextArea value={script} disabled={!allow("manage_campaigns")} onChange={(event) => setScript(event.target.value)} />
          </Field>
          <Field label="Voicemail drop" hint="Spoken by Twilio when an agent presses Drop voicemail on a live call. Keep it under a few sentences.">
            <TextArea value={voicemailScript} maxLength={500} disabled={!allow("manage_campaigns")} onChange={(event) => setVoicemailScript(event.target.value)} />
          </Field>
          <Field label="Text template" hint="Optional. Agents can still pick the built-in texts. Use {{first_name}}.">
            <TextArea value={smsTemplate} maxLength={320} disabled={!allow("manage_campaigns")} onChange={(event) => setSmsTemplate(event.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={missSms} disabled={!allow("manage_campaigns")} onChange={(event) => setMissSms(event.target.checked)} />
            After no answer, busy, or voicemail, send this text once if the contact consented
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={localPresence} disabled={!allow("manage_campaigns")} onChange={(event) => setLocalPresence(event.target.checked)} />
            Use a caller ID with the contact's area code when one is allow-listed
          </label>
          <p className="text-xs text-fog">
            Days: {campaign.callingDays.map((day) => DAY_OPTIONS.find((option) => option.id === day)?.label).join(", ")}. Max attempts {campaign.maxAttempts}. Retry {campaign.retryMinutes} minutes.
            {campaign.callerId ? ` Caller ID ${campaign.callerId}.` : ""}
          </p>
          {allow("manage_campaigns") ? <Button type="submit">Save copy</Button> : null}
        </form>
      </Panel>
      <Panel title="Agents" id="agents">
        <ul className="mb-3 text-sm">
          {detail.data?.agents.map((agent) => (
            <li key={agent.userId}>
              {agent.name} · {agent.email}
            </li>
          ))}
        </ul>
        {allow("manage_campaigns") && team.data ? (
          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void setCampaignAgents({ data: { orgId: membership.orgId, campaignId, userIds: agents } })
                .then(() => {
                  toast.success("Assignments saved");
                  void client.invalidateQueries({ queryKey: ["campaign", membership.orgId, campaignId] });
                })
                .catch((error: unknown) => toast.error(errorText(error)));
            }}
          >
            {team.data.members.map((member) => (
              <label key={member.userId} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={agents.includes(member.userId)}
                  onChange={(event) => setAgents(event.target.checked ? [...agents, member.userId] : agents.filter((id) => id !== member.userId))}
                />
                {member.name} · {member.role}
              </label>
            ))}
            <Button type="submit">Save assignments</Button>
          </form>
        ) : null}
      </Panel>
      {allow("manage_campaigns") ? (
        <Panel title="Add contacts" id="queue">
          <form
            className="grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (picked.length === 0) return;
              void addCampaignContacts({ data: { orgId: membership.orgId, campaignId, contactIds: picked } })
                .then((result) => {
                  toast.success(`${result.added} added`);
                  setPicked([]);
                  void client.invalidateQueries({ queryKey: ["campaign", membership.orgId, campaignId] });
                })
                .catch((error: unknown) => toast.error(errorText(error)));
            }}
          >
            {(contacts.data?.contacts ?? []).map((contact) => (
              <label key={contact.id} className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={picked.includes(contact.id)}
                  onChange={(event) => setPicked(event.target.checked ? [...picked, contact.id] : picked.filter((id) => id !== contact.id))}
                />
                {contact.firstName} {contact.lastName} · {contact.phoneDisplay}
              </label>
            ))}
            <Button type="submit" disabled={picked.length === 0}>
              Add selected
            </Button>
          </form>
        </Panel>
      ) : null}
    </>
  );
}
