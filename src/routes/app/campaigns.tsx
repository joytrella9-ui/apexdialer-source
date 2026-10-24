import { useState } from "react";
import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createCampaign, listCampaigns, listVoicemailClips, saveVoicemailClip } from "@/server/campaigns";
import { useWorkspace, PageTitle } from "@/components/workspace";
import { Button, Empty, Field, Panel, SelectInput, TextArea, TextInput } from "@/components/bits";
import { DAY_OPTIONS, errorText } from "@/lib/dialer/format";

export const Route = createFileRoute("/app/campaigns")({ component: CampaignsPage });

function CampaignsPage() {
  const onDetail = useRouterState({ select: (state) => /\/app\/campaigns\/.+/.test(state.location.pathname) });
  const { membership, allow } = useWorkspace();
  const client = useQueryClient();
  const [status, setStatus] = useState<"all" | "draft" | "active" | "paused" | "archived">("all");
  const list = useQuery({
    queryKey: ["campaigns", membership.orgId, status],
    queryFn: () => listCampaigns({ data: { orgId: membership.orgId, status } }),
  });
  if (onDetail) return <Outlet />;
  return (
    <>
      <PageTitle title="Campaigns" lane="Work" steps={[{ label: "List", href: "#list" }, { label: "Script", href: "#new" }, { label: "Dial", href: "/app/dial" }]} />
      <Field label="Status">
        <SelectInput className="max-w-xs" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
          <option value="all">All you can see</option>
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="archived">Archived</option>
        </SelectInput>
      </Field>
      {list.data && list.data.campaigns.length > 0 ? (
        <ul id="list" className="grid gap-3">
          {list.data.campaigns.map((campaign) => (
            <li key={campaign.id}>
              <Link to="/app/campaigns/$campaignId" params={{ campaignId: campaign.id }} className="block rounded-xl border border-line bg-card p-4 hover:border-teal">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="font-semibold">{campaign.name}</h2>
                  <span className="text-xs text-fog uppercase">{campaign.status}</span>
                </div>
                <p className="mt-1 text-sm text-fog">
                  {campaign.dialMode === "provider" ? "Twilio" : "Device"} · {campaign.windowStart}–{campaign.windowEnd} {campaign.timezone} · {campaign.remaining} of {campaign.totalContacts} remaining
                </p>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Empty title="No campaigns" body={allow("manage_campaigns") ? "Create a draft below. It cannot go live without callable contacts." : "You only see campaigns you are assigned to."} />
      )}
      {allow("manage_campaigns") ? <CampaignCreate orgTimezone={membership.timezone} orgId={membership.orgId} onDone={() => void client.invalidateQueries({ queryKey: ["campaigns"] })} /> : null}
      {allow("manage_campaigns") ? <ClipLibrary orgId={membership.orgId} /> : null}
    </>
  );
}

function CampaignCreate({ orgId, orgTimezone, onDone }: { orgId: string; orgTimezone: string; onDone: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [dialMode, setDialMode] = useState<"manual" | "provider">("manual");
  const [timezone, setTimezone] = useState(orgTimezone);
  const [windowStart, setWindowStart] = useState("09:00");
  const [windowEnd, setWindowEnd] = useState("17:00");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [retryMinutes, setRetryMinutes] = useState(120);
  const [callerId, setCallerId] = useState("");
  const [localPresence, setLocalPresence] = useState(false);
  const [script, setScript] = useState("");
  const [voicemailScript, setVoicemailScript] = useState("");
  const [smsTemplate, setSmsTemplate] = useState("");
  const [missSms, setMissSms] = useState(false);
  return (
    <Panel title="New campaign" id="new">
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void createCampaign({
            data: { orgId, name, description, dialMode, timezone, windowStart, windowEnd, callingDays: days, maxAttempts, retryMinutes, callerId, localPresence, script, voicemailScript, smsTemplate, missSms },
          })
            .then(() => {
              toast.success("Draft created");
              setName("");
              onDone();
            })
            .catch((error: unknown) => toast.error(errorText(error)));
        }}
      >
        <Field label="Name">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} required />
        </Field>
        <Field label="Description">
          <TextArea value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Dial mode">
            <SelectInput value={dialMode} onChange={(event) => setDialMode(event.target.value as typeof dialMode)}>
              <option value="manual">Device dial — agent phone, logged outcome</option>
              <option value="provider">Twilio — only if the server is configured</option>
            </SelectInput>
          </Field>
          <Field label="Timezone">
            <TextInput value={timezone} onChange={(event) => setTimezone(event.target.value)} required />
          </Field>
          <Field label="Window start">
            <TextInput value={windowStart} onChange={(event) => setWindowStart(event.target.value)} required />
          </Field>
          <Field label="Window end">
            <TextInput value={windowEnd} onChange={(event) => setWindowEnd(event.target.value)} required />
          </Field>
          <Field label="Max attempts" hint="1 to 6.">
            <TextInput type="number" min={1} max={6} value={maxAttempts} onChange={(event) => setMaxAttempts(Number(event.target.value))} />
          </Field>
          <Field label="Retry minutes" hint="At least 30.">
            <TextInput type="number" min={30} value={retryMinutes} onChange={(event) => setRetryMinutes(Number(event.target.value))} />
          </Field>
        </div>
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">Calling days</legend>
          <div className="flex flex-wrap gap-2">
            {DAY_OPTIONS.map((day) => (
              <label key={day.id} className="flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-sm">
                <input
                  type="checkbox"
                  checked={days.includes(day.id)}
                  onChange={(event) => setDays(event.target.checked ? [...days, day.id] : days.filter((value) => value !== day.id))}
                />
                {day.label}
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Caller ID" hint="Required for Twilio unless local presence is on. Must be an allow-listed E.164 number.">
          <TextInput value={callerId} onChange={(event) => setCallerId(event.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={localPresence} onChange={(event) => setLocalPresence(event.target.checked)} />
          Match the caller ID to the contact's area code when one is allow-listed
        </label>
        <Field label="Script">
          <TextArea value={script} onChange={(event) => setScript(event.target.value)} />
        </Field>
        <Field label="Voicemail drop" hint="Spoken on a live Twilio call when the agent presses Drop voicemail.">
          <TextArea value={voicemailScript} maxLength={500} onChange={(event) => setVoicemailScript(event.target.value)} />
        </Field>
        <Field label="Text template" hint="Optional. {{first_name}} is filled in when the text is sent.">
          <TextArea value={smsTemplate} maxLength={320} onChange={(event) => setSmsTemplate(event.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={missSms} onChange={(event) => setMissSms(event.target.checked)} />
          After a miss, text this template once if the contact already consented
        </label>
        <Button type="submit">Create draft</Button>
      </form>
    </Panel>
  );
}

function ClipLibrary({ orgId }: { orgId: string }) {
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [script, setScript] = useState("");
  const clips = useQuery({
    queryKey: ["voicemail-clips", orgId],
    queryFn: () => listVoicemailClips({ data: { orgId } }),
  });
  return (
    <Panel title="Voicemail clips">
      <p className="mb-3 text-sm text-fog">An https address is played as audio. If you leave it blank, Twilio speaks the script. The session can drop either one on a live call.</p>
      <ul className="mb-3 grid gap-1 text-sm">
        {(clips.data?.clips ?? []).map((clip) => (
          <li key={clip.id}>{clip.name} · {clip.audioUrl ? "audio" : "spoken"}</li>
        ))}
        {(clips.data?.clips.length ?? 0) === 0 ? <li className="text-fog">No clips yet.</li> : null}
      </ul>
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void saveVoicemailClip({ data: { orgId, name, audioUrl, script } })
            .then(() => {
              setName("");
              setAudioUrl("");
              setScript("");
              toast.success("Clip saved");
              void client.invalidateQueries({ queryKey: ["voicemail-clips", orgId] });
            })
            .catch((error: unknown) => toast.error(errorText(error)));
        }}
      >
        <Field label="Name">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} required />
        </Field>
        <Field label="Audio URL" hint="Optional. Must start with https.">
          <TextInput value={audioUrl} onChange={(event) => setAudioUrl(event.target.value)} placeholder="https://…" />
        </Field>
        <Field label="Spoken fallback">
          <TextArea value={script} maxLength={500} onChange={(event) => setScript(event.target.value)} />
        </Field>
        <Button type="submit">Save clip</Button>
      </form>
    </Panel>
  );
}
