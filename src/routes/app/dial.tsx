import { useEffect, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  cancelCall,
  getOpenCall,
  listCalls,
  listFollowUps,
  markConnected,
  nextLead,
  openCallBrief,
  postponeLead,
  startBrowserCall,
  startManualCall,
  startPressOneCall,
  startProviderCall,
  submitDisposition,
  transferCall,
  dropVoicemail,
  completeFollowUp,
} from "@/server/calls";
import { draftCallNotes, listTranscript, suggestReply, summarizeCall } from "@/server/assist";
import { predictiveLines } from "@/lib/dialer/pace";
import { interpretContactCsv } from "@/lib/dialer/csv";
import { CONNECTED_DISPOSITIONS } from "@/lib/dialer/dispositions";
import { lookupCrm } from "@/server/adapters";
import { listCallerIdHealth, listCampaigns, listVoicemailClips, addCampaignContacts } from "@/server/campaigns";
import { commitContactImport, createContact, getContact, lookupContact } from "@/server/contacts";
import { sendSms } from "@/server/messages";
import { SMS_TEMPLATES } from "@/lib/dialer/sms";
import { useWorkspace } from "@/components/workspace";
import { Banner, Button, Empty, Field, SelectInput, TextArea, TextInput } from "@/components/bits";
import { useSoftphone } from "@/components/softphone";
import { SmsThread } from "@/components/sms-box";
import { coachCall, reviewScriptCoverage } from "@/lib/dialer/assist";
import { replyToObjection, type TalkLine } from "@/lib/dialer/talk";
import { pressOneLine } from "@/lib/dialer/speech";
import { DISPOSITION_LABEL, STATE_LABEL } from "@/lib/dialer/labels";
import { errorText, formatWhen } from "@/lib/dialer/format";
import { isWithinCallingWindow, isValidTimeZone } from "@/lib/dialer/windows";

const PAD = [
  { key: "1", id: "no_answer" },
  { key: "2", id: "voicemail" },
  { key: "3", id: "busy" },
  { key: "4", id: "answered" },
  { key: "5", id: "interested" },
  { key: "6", id: "callback" },
  { key: "7", id: "not_interested" },
  { key: "8", id: "wrong_number" },
  { key: "9", id: "do_not_call" },
] as const;
function WindowNote({ timezone, start, end, days }: { timezone: string; start: string; end: string; days: number[] }) {
  const clock = isWithinCallingWindow({ now: new Date(), timeZone: timezone, start, end, days });
  if (clock.ok) return null;
  return <Banner tone="warn">{clock.reason} Change the days or hours in Settings if you are testing. Your own callback number can still be called.</Banner>;
}

export const Route = createFileRoute("/app/dial")({
  validateSearch: (search: Record<string, unknown>) => ({
    campaignId: typeof search.campaignId === "string" ? search.campaignId : "",
    contactId: typeof search.contactId === "string" ? search.contactId : "",
  }),
  component: DialPage,
});

function DialPage() {
  const { campaignId: initialCampaign, contactId } = Route.useSearch();
  const navigate = useNavigate();
  const { membership, telephony, allow } = useWorkspace();
  const phone = useSoftphone();
  const client = useQueryClient();
  const [campaignId, setCampaignId] = useState(initialCampaign);
  const [disposition, setDisposition] = useState("answered");
  const [clipId, setClipId] = useState("");
  const [notes, setNotes] = useState("");
  const [followUpAt, setFollowUpAt] = useState("");
  const [transferTo, setTransferTo] = useState("");
  const [pending, setPending] = useState(false);
  const [draftNote, setDraftNote] = useState("");
  const [talk, setTalk] = useState<TalkLine | null>(null);
  const [objection, setObjection] = useState("");
  const [sessionOn, setSessionOn] = useState(false);
  const [line, setLine] = useState<"browser" | "phone" | "device">("browser");
  const [lines, setLines] = useState<1 | 2 | "predictive">(1);
  const burstRef = useRef("");
  const [dialNumber, setDialNumber] = useState("");
  const [lookupNote, setLookupNote] = useState("");
  const [gaps, setGaps] = useState<string[]>([]);
  const [sessionDials, setSessionDials] = useState(0);
  const [wrapUntil, setWrapUntil] = useState(0);
  const [tick, setTick] = useState(0);
  const [addName, setAddName] = useState("");
  const [addAddress, setAddAddress] = useState("");
  const [textOpen, setTextOpen] = useState<"" | "sms" | "whatsapp">("");
  const [textBody, setTextBody] = useState<string>(SMS_TEMPLATES[0].body);
  const zone = isValidTimeZone(membership.timezone) ? membership.timezone : "UTC";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const fired = useRef("");
  const campaigns = useQuery({
    queryKey: ["campaigns", membership.orgId, "active"],
    queryFn: () => listCampaigns({ data: { orgId: membership.orgId, status: "active" } }),
  });
  const clips = useQuery({
    queryKey: ["voicemail-clips", membership.orgId],
    queryFn: () => listVoicemailClips({ data: { orgId: membership.orgId } }),
  });
  const linesHealth = useQuery({
    queryKey: ["caller-health", membership.orgId],
    queryFn: () => listCallerIdHealth({ data: { orgId: membership.orgId } }),
  });
  const open = useQuery({
    queryKey: ["open-call", membership.orgId],
    queryFn: () => getOpenCall({ data: { orgId: membership.orgId } }),
    refetchInterval: (query) => (query.state.data?.call ? 4000 : false),
  });
  const lead = useQuery({
    queryKey: ["lead", membership.orgId, campaignId],
    queryFn: () => nextLead({ data: { orgId: membership.orgId, campaignId } }),
    enabled: Boolean(campaignId) && !open.data?.call,
  });
  const direct = useQuery({
    queryKey: ["contact", membership.orgId, contactId],
    queryFn: () => getContact({ data: { orgId: membership.orgId, contactId } }),
    enabled: Boolean(contactId),
  });
  const recent = useQuery({
    queryKey: ["recent-calls", membership.orgId, today],
    queryFn: () => listCalls({ data: { orgId: membership.orgId, from: today, to: today, page: 1, pageSize: 6 } }),
  });
  const followUps = useQuery({
    queryKey: ["followups", membership.orgId],
    queryFn: () => listFollowUps({ data: { orgId: membership.orgId } }),
  });
  const onCallId = open.data?.call?.contactId ?? "";
  const onCallContact = useQuery({
    queryKey: ["contact", membership.orgId, onCallId],
    queryFn: () => getContact({ data: { orgId: membership.orgId, contactId: onCallId } }),
    enabled: Boolean(onCallId),
  });
  const openCallId = open.data?.call?.id ?? "";
  const liveBrief = useQuery({
    queryKey: ["call-brief", membership.orgId, openCallId],
    queryFn: () => openCallBrief({ data: { orgId: membership.orgId, callId: openCallId } }),
    enabled: Boolean(openCallId),
  });
  useEffect(() => {
    if (window.matchMedia("(max-width: 800px)").matches && membership.callbackPhone) setLine("phone");
  }, [membership.callbackPhone]);

  const call = open.data?.call ?? null;
  const transcript = useQuery({
    queryKey: ["transcript", membership.orgId, call?.id ?? ""],
    queryFn: () => listTranscript({ data: { orgId: membership.orgId, callId: call?.id ?? "" } }),
    enabled: Boolean(call?.id),
    refetchInterval: call && ["requested", "ringing", "in_progress"].includes(call.state) ? 3000 : false,
  });
  const queued = lead.data?.lead ?? null;
  const directContact = direct.data?.contact ?? null;
  const smsContact = call?.contactId
    ? (onCallContact.data?.contact ?? null)
    : (directContact ?? (queued
      ? { id: queued.contactId, firstName: queued.firstName, company: queued.company, smsConsent: queued.smsConsent, dnc: false }
      : null));
  const activeCampaign = (campaigns.data?.campaigns ?? []).find((item) => item.id === (call?.campaignId || campaignId));
  const talkScript = queued?.script || activeCampaign?.script || "";
  const objections = ["Not interested", "Send an email", "Too expensive", "Bad time", "Who is this", "Already have someone"];
  const facts = recent.data?.calls ?? [];
  const pace = line === "device" || lines === 1 ? 1 : lines === 2 ? 2 : predictiveLines(
    facts.filter((item) => item.state === "completed" || item.state === "failed").length,
    facts.filter((item) => CONNECTED_DISPOSITIONS.has(item.disposition)).length,
  );
  const crmPhone = directContact?.phoneE164 || queued?.phoneE164 || "";
  const crm = useQuery({
    queryKey: ["crm", membership.orgId, crmPhone],
    queryFn: () => lookupCrm({ data: { orgId: membership.orgId, phone: crmPhone } }),
    enabled: crmPhone.length > 6,
  });

  async function dial(channel: "manual" | "provider" | "browser", targetContactId: string, targetCampaign: string | null, burst = "", keepSession = false) {
    setPending(true);
    try {
      const payload = { orgId: membership.orgId, contactId: targetContactId, campaignId: targetCampaign, idempotencyKey: crypto.randomUUID(), burstId: burst, amd: Boolean(burst) };
      if (channel === "manual") {
        const result = await startManualCall({ data: payload });
        toast.success("Device dial logged. Your phone app should open the number. This is not a carrier-verified call.");
        if (result.tel) window.location.href = result.tel;
      } else if (channel === "browser") {
        if (phone.status !== "ready") {
          throw new Error(phone.detail || "Wait until the softphone lamp says Line open, then try again. Allow the microphone if the browser asks.");
        }
        phone.arm();
        await startBrowserCall({ data: payload });
        toast.success(payload.amd ? "Calling the list. Your phone rings only when a person answers. A machine is dropped." : "Your browser should ring. Answer it, allow the microphone, and the contact is dialed from your Twilio number.");
      } else {
        await startProviderCall({ data: payload });
        toast.success(payload.amd ? "Calling the list. Your phone rings only when a person answers. A machine is dropped." : "Twilio is ringing your phone first. Answer it, then the contact is dialed.");
      }
      await client.invalidateQueries({ queryKey: ["open-call", membership.orgId] });
      setSessionDials((count) => count + 1);
    } catch (error) {
      if (!keepSession) {
        fired.current = "";
        setSessionOn(false);
      }
      toast.error(errorText(error));
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    if (!sessionOn) {
      fired.current = "";
      burstRef.current = "";
      return;
    }
    if (wrapUntil > Date.now()) return;
    if (call || pending || !queued?.callable || !campaignId || directContact) return;
    if (line === "browser" && phone.status !== "ready") return;
    if (line === "phone" && !telephony.credentialsPresent) return;
    const token = `${campaignId}:${queued.contactId}`;
    if (fired.current === token) return;
    fired.current = token;
    const burst = pace > 1 && line !== "device" ? burstRef.current || (burstRef.current = crypto.randomUUID()) : "";
    void dial(line === "phone" ? "provider" : line === "device" ? "manual" : "browser", queued.contactId, campaignId, burst);
  }, [sessionOn, call, pending, queued?.contactId, queued?.callable, campaignId, line, lines, phone.status, telephony.credentialsPresent, directContact, wrapUntil, tick]);

  useEffect(() => {
    if (!sessionOn || pace < 2 || line === "device" || !campaignId || directContact || pending || !burstRef.current) return;
    if (!call || !["requested", "ringing"].includes(call.state)) return;
    if ((open.data?.ringing ?? 1) >= pace) return;
    if (!queued?.callable || queued.contactId === call.contactId) return;
    const token = `${burstRef.current}:${queued.contactId}:${open.data?.ringing ?? 0}`;
    if (fired.current === token) return;
    fired.current = token;
    void dial(line === "phone" ? "provider" : "browser", queued.contactId, campaignId, burstRef.current, true);
  }, [sessionOn, pace, line, campaignId, directContact, pending, call, queued?.contactId, queued?.callable, open.data?.ringing]);

  useEffect(() => {
    if (wrapUntil <= Date.now()) return;
    const id = window.setInterval(() => setTick((value) => value + 1), 500);
    return () => window.clearInterval(id);
  }, [wrapUntil]);

  async function saveOutcome(code: string) {
    if (!call) return;
    setDisposition(code);
    setPending(true);
    try {
      const saved = await submitDisposition({
        data: {
          orgId: membership.orgId,
          callId: call.id,
          disposition: code,
          notes,
          followUpAt: followUpAt ? new Date(followUpAt).toISOString() : null,
        },
      });
      setNotes("");
      setFollowUpAt("");
      setDraftNote("");
      phone.hangup();
      fired.current = "";
      if (sessionOn) setWrapUntil(Date.now() + 12000);
      toast.success([sessionOn ? "Saved. Next dial waits 12 seconds." : "Disposition saved", saved.followUpText].filter(Boolean).join(" "));
      await client.invalidateQueries({ queryKey: ["open-call", membership.orgId] });
      await client.invalidateQueries({ queryKey: ["lead", membership.orgId, campaignId] });
      await client.invalidateQueries({ queryKey: ["recent-calls", membership.orgId] });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!call || pending) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
      const hit = PAD.find((item) => item.key === event.key);
      if (!hit) return;
      event.preventDefault();
      void saveOutcome(hit.id);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const elapsed = useElapsed(Boolean(call && (call.state === "in_progress" || call.answeredAt)), call?.answeredAt || call?.startedAt || null);
  const shown = onCallContact.data?.contact ?? directContact;
  const person = call
    ? { name: shown ? `${shown.firstName} ${shown.lastName}`.trim() : call.contactName || "Unknown", phone: call.toDisplay, address: shown?.address || "", detail: STATE_LABEL[call.state] ?? call.state }
    : shown
      ? { name: `${shown.firstName} ${shown.lastName}`.trim(), phone: shown.phoneDisplay, address: shown.address, detail: shown.company || shown.timezone }
      : queued
        ? { name: queued.name, phone: queued.phoneDisplay, address: "", detail: `${queued.company || "No company"} · ${queued.timezone}` }
        : null;
  const opener = call ? liveBrief.data?.brief : queued?.brief;
  const script = queued?.script || activeCampaign?.script || "";
  const rank = queued?.rankReason || "";

  return (
    <div className="grid gap-3">
      <form
        className="lead-launch"
        onSubmit={(event) => {
          event.preventDefault();
          if (addName.trim().length < 1 || dialNumber.trim().length < 7) {
            toast.error("Enter a name and a phone number.");
            return;
          }
          setPending(true);
          void createContact({ data: { orgId: membership.orgId, firstName: addName.trim(), phone: dialNumber, address: addAddress.trim() } })
            .then(async (created) => {
              setAddName("");
              setDialNumber("");
              setAddAddress("");
              await navigate({ to: "/app/dial", search: { contactId: created.id, campaignId } });
              const channel = membership.callbackPhone && telephony.credentialsPresent ? "provider" : phone.status === "ready" ? "browser" : "manual";
              if (channel === "provider") setLine("phone");
              await dial(channel, created.id, campaignId || null);
            })
            .catch((error: unknown) => toast.error(errorText(error)))
            .finally(() => setPending(false));
        }}
      >
        <p className="session-kicker">New lead</p>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Name">
            <TextInput value={addName} onChange={(event) => setAddName(event.target.value)} placeholder="Jordan Blake" />
          </Field>
          <Field label="Phone">
            <TextInput value={dialNumber} onChange={(event) => setDialNumber(event.target.value)} placeholder="3125550100" />
          </Field>
          <Field label="Address">
            <TextInput value={addAddress} onChange={(event) => setAddAddress(event.target.value)} placeholder="14 King Street, Kingston" />
          </Field>
        </div>
        <div>
          <Button type="submit" disabled={pending}>Add and call</Button>
        </div>
        {allow("import_contacts") ? (
          <label className="text-sm text-fog">
            Import a list
            <input
              className="mt-1 block text-sm text-ink"
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                setPending(true);
                void file.text().then(async (csv) => {
                  const parsed = interpretContactCsv(csv);
                  if (parsed.rows.length === 0) {
                    toast.error(parsed.issues[0]?.message || "Nothing in that file can be imported.");
                    return;
                  }
                  const skipped = parsed.issues.length;
                  const ok = window.confirm(`Import ${parsed.rows.length} leads? ${skipped} row${skipped === 1 ? "" : "s"} will be skipped.`);
                  if (!ok) return;
                  const result = await commitContactImport({ data: { orgId: membership.orgId, csv } });
                    if (campaignId && result.contactIds.length > 0 && allow("manage_campaigns")) {
                      const added = await addCampaignContacts({ data: { orgId: membership.orgId, campaignId, contactIds: result.contactIds } });
                      toast.success(`${result.inserted} leads added. ${added.added} placed on this campaign. ${result.skipped} were already here.`);
                      await client.invalidateQueries({ queryKey: ["lead", membership.orgId, campaignId] });
                    } else {
                      toast.success(`${result.inserted} leads added. ${result.skipped} were already here. Choose a campaign before importing if you want them on a list.`);
                    }
                    await client.invalidateQueries({ queryKey: ["contacts"] });
                  })
                  .catch((error: unknown) => toast.error(errorText(error)))
                  .finally(() => setPending(false));
              }}
            />
            <span className="mt-1 block text-xs">Columns: name, phone, address. Up to 500 new leads can be placed on the campaign selected above.</span>
          </label>
        ) : null}
      </form>
      <div className="dialer-stats">
        <div><span>Campaign</span><strong>{activeCampaign?.name || "None"}</strong></div>
        <div><span>Left</span><strong>{activeCampaign ? activeCampaign.remaining : "—"}</strong></div>
        <div><span>Dials</span><strong>{sessionDials}</strong></div>
        <div><span>Answered today</span><strong>{facts.filter((item) => CONNECTED_DISPOSITIONS.has(item.disposition)).length}</strong></div>
      </div>
      <div id="list" className="session-card session-bar">
        <Field label="Campaign">
          <SelectInput value={campaignId} onChange={(event) => { setCampaignId(event.target.value); setSessionOn(false); fired.current = ""; }}>
            <option value="">Choose a list</option>
            {(campaigns.data?.campaigns ?? []).map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name} · {campaign.remaining} left
              </option>
            ))}
          </SelectInput>
        </Field>
        <Field label="Line">
          <SelectInput value={line} onChange={(event) => setLine(event.target.value as "browser" | "phone" | "device")}>
            <option value="browser">Browser</option>
            <option value="phone">My phone</option>
            <option value="device">This device</option>
          </SelectInput>
        </Field>
        <Field label="Mode" hint={lines === "predictive" ? "Several numbers are dialed. Your phone rings for a person. An early machine signal still rings you, so a person is not dropped. This has not been proven on a live Twilio account." : line === "phone" ? "Twilio calls your phone, then the contact." : "One call at a time, then the next."}>
          <span id="pace" />
          <SelectInput value={String(lines)} onChange={(event) => setLines(event.target.value === "predictive" ? "predictive" : event.target.value === "2" ? 2 : 1)} disabled={line === "device"}>
            <option value="1">Power</option>
            <option value="2">Parallel</option>
            <option value="predictive">Predictive</option>
          </SelectInput>
        </Field>
        <span id="dial" className="flex flex-wrap gap-2">
          <Button type="button" disabled={!campaignId || Boolean(directContact)} onClick={() => { setSessionOn((on) => !on); setWrapUntil(0); }}>
            {sessionOn ? "Pause session" : "Start session"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={pending || Boolean(call)}
            onClick={() => {
              if (!membership.callbackPhone) {
                toast.error("Add your phone number under Settings, then try again.");
                return;
              }
              const target = directContact?.id || queued?.contactId || "";
              if (!target) {
                toast.error("Pick a campaign with a lead, or look up a number first.");
                return;
              }
              setLine("phone");
              setLines(1);
              void dial("provider", target, campaignId || null);
            }}
          >
            Call from my phone
          </Button>
        </span>
        {sessionOn && wrapUntil > Date.now() ? (
          <Button type="button" variant="ghost" onClick={() => setWrapUntil(0)}>
            Dial now · {Math.max(1, Math.ceil((wrapUntil - Date.now()) / 1000))}s
          </Button>
        ) : null}
        <p className="pb-2 font-mono text-xs text-fog">{sessionDials} dials this session{sessionOn ? " · running" : " · paused"}{telephony.fromMasked ? ` · caller ID ${telephony.fromMasked}` : ""}</p>
        {linesHealth.data && linesHealth.data.lines.length > 0 ? (
          <p className="pb-2 text-xs text-fog">
            Caller ID today: {linesHealth.data.lines.map((item) => `${item.number} ${item.dials} · ${item.label}`).join(" · ")}. This is our dial count, not a carrier spam score.
          </p>
        ) : null}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setPending(true);
            void lookupContact({ data: { orgId: membership.orgId, phone: dialNumber } })
              .then((found) => {
                setLookupNote(found.reason);
                if (found.contact && !found.contact.dnc) {
                  void navigate({ to: "/app/dial", search: { contactId: found.contact.id, campaignId } });
                }
              })
              .catch((error: unknown) => setLookupNote(errorText(error)))
              .finally(() => setPending(false));
          }}
        >
          <Field label="Find a number">
            <TextInput value={dialNumber} onChange={(event) => setDialNumber(event.target.value)} placeholder="3125550100" />
          </Field>
          <Button type="submit" variant="ghost" disabled={pending || dialNumber.trim().length < 3}>
            Look up
          </Button>
        </form>
        {lookupNote ? <p className="pb-2 text-sm text-fog">{lookupNote}</p> : null}
        {lookupNote.includes("not on a list") && allow("manage_contacts") ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setPending(true);
              void createContact({ data: { orgId: membership.orgId, firstName: addName, phone: dialNumber } })
                .then((created) => navigate({ to: "/app/dial", search: { contactId: created.id, campaignId } }))
                .catch((error: unknown) => setLookupNote(errorText(error)))
                .finally(() => setPending(false));
            }}
          >
            <Field label="First name">
              <TextInput value={addName} onChange={(event) => setAddName(event.target.value)} required minLength={1} />
            </Field>
            <Button type="submit" disabled={pending || addName.trim().length < 1}>
              Add and open
            </Button>
          </form>
        ) : null}
      </div>
      {recent.data && recent.data.calls.length > 0 ? (
        <p className="font-mono text-xs text-fog">
          Today · {recent.data.calls.map((item) => `${item.contactName || item.toDisplay} ${item.disposition || item.state}`).join(" · ")}
        </p>
      ) : null}
      {phone.status === "error" ? <Banner tone="bad">{phone.detail || "The browser phone could not register."}</Banner> : null}
      {directContact && directContact.phoneE164 !== membership.callbackPhone ? (
        <WindowNote timezone={directContact.timezone || membership.timezone} start={membership.windowStart} end={membership.windowEnd} days={membership.callingDays} />
      ) : null}
      <div className="session">
        <section className="session-card lead-hero">
          <p className="session-kicker">{call ? "Live" : sessionOn ? "Next up" : "Lead"}</p>
          {person ? (
            <>
              <h2 className="lead-name">{person.name}</h2>
              {person.address ? <p className="lead-address">{person.address}</p> : <p className="lead-address">No address saved</p>}
              <p className="phone-screen">{person.phone}</p>
              <p className="mt-1 text-sm text-fog">{person.detail}</p>
              {call ? <p className="mt-3 font-mono text-4xl tabular-nums">{elapsed}</p> : null}
              {call?.failureReason ? <p className="mt-2 text-sm text-bad">{call.failureReason}</p> : null}
              {rank ? <p className="mt-3 text-sm">{rank}</p> : null}
              {crm.data && crm.data.lines.length > 0 ? <p className="mt-2 text-sm text-fog">{crm.data.lines.join(" · ")}</p> : null}
              {queued && !queued.callable ? <Banner tone="warn">{queued.windowReason}</Banner> : null}
              {directContact?.dnc ? <Banner tone="bad">Do not call. Dialing is blocked.</Banner> : null}
              {direct.data?.calls && direct.data.calls.length > 0 ? (
                <p className="mt-3 text-sm text-fog">
                  Last: {direct.data.calls.slice(0, 3).map((item) => item.disposition || item.state).join(" · ")}
                </p>
              ) : null}
            </>
          ) : (
            <Empty title={campaignId ? "Queue is clear" : "Pick a campaign"} body={campaignId ? "Nothing is due inside the calling window." : "Start a session after you choose an active campaign."} />
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            {call ? (
              <>
                {call.channel === "manual_device" && call.state === "manual_open" ? (
                  <Button type="button" disabled={pending} onClick={() => {
                    setPending(true);
                    void markConnected({ data: { orgId: membership.orgId, callId: call.id } })
                      .then(() => client.invalidateQueries({ queryKey: ["open-call", membership.orgId] }))
                      .catch((error: unknown) => toast.error(errorText(error)))
                      .finally(() => setPending(false));
                  }}>They answered</Button>
                ) : null}
                {["manual_open", "requested", "ringing"].includes(call.state) ? (
                  <Button type="button" variant="ghost" disabled={pending} onClick={() => {
                    setPending(true);
                    phone.hangup();
                    void cancelCall({ data: { orgId: membership.orgId, callId: call.id } })
                      .then(() => client.invalidateQueries({ queryKey: ["open-call", membership.orgId] }))
                      .catch((error: unknown) => toast.error(errorText(error)))
                      .finally(() => setPending(false));
                  }}>Cancel</Button>
                ) : null}
              </>
            ) : person && !sessionOn ? (
              <>
                <Button
                  type="button"
                  disabled={pending || Boolean(directContact?.dnc) || (queued ? !queued.callable : false)}
                  onClick={() => {
                    if (!membership.callbackPhone) {
                      toast.error("Add your phone number under Settings, then try again.");
                      return;
                    }
                    const target = directContact?.id || queued?.contactId || "";
                    if (!target) return;
                    setLine("phone");
                    setLines(1);
                    void dial("provider", target, campaignId || null);
                  }}
                >
                  Call from my phone
                </Button>
                <Button type="button" variant="ghost" disabled={pending || Boolean(directContact?.dnc) || (queued ? !queued.callable : false) || (line === "browser" && phone.status !== "ready")} onClick={() => void dial(line === "phone" ? "provider" : line === "device" ? "manual" : "browser", directContact?.id || queued?.contactId || "", campaignId || null)}>
                  Dial this lead
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending || Boolean(directContact?.dnc) || (queued ? !queued.callable : false)}
                  onClick={() => {
                    const target = directContact?.id || queued?.contactId || "";
                    if (!target) return;
                    setPending(true);
                    void startPressOneCall({
                      data: { orgId: membership.orgId, contactId: target, campaignId: campaignId || null, idempotencyKey: crypto.randomUUID(), burstId: "" },
                    })
                      .then(() => {
                        toast.success("They hear the line. Press 1 whispers their name to you, then connects you. Press 2 marks do-not-call.");
                        return client.invalidateQueries({ queryKey: ["open-call", membership.orgId] });
                      })
                      .catch((error: unknown) => toast.error(errorText(error)))
                      .finally(() => setPending(false));
                  }}
                >
                  Screen
                </Button>
                <p className="basis-full text-xs text-fog">Screen says: {pressOneLine(membership.orgName, script)}. If they press 1, you hear their name before you are connected.</p>
                {queued && campaignId ? (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      setPending(true);
                      fired.current = "";
                      void postponeLead({ data: { orgId: membership.orgId, campaignId, contactId: queued.contactId } })
                        .then(() => {
                          toast.success("Skipped for 30 minutes. It does not count as an attempt.");
                          return client.invalidateQueries({ queryKey: ["lead", membership.orgId, campaignId] });
                        })
                        .catch((error: unknown) => toast.error(errorText(error)))
                        .finally(() => setPending(false));
                    }}
                  >
                    Not now
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
          {smsContact ? (
            <div className="mt-3 grid gap-2">
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="ghost" disabled={pending || smsContact.dnc} onClick={() => { setTextOpen("sms"); setTextBody(SMS_TEMPLATES[0].body); }}>
                  Text
                </Button>
                <Button type="button" variant="ghost" disabled={pending || smsContact.dnc} onClick={() => { setTextOpen("whatsapp"); setTextBody(SMS_TEMPLATES[0].body); }}>
                  WhatsApp
                </Button>
              </div>
              {textOpen ? (
                <form
                  className="grid gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!smsContact.smsConsent) {
                      toast.error("Save SMS consent on this contact before texting. A call is not permission to text.");
                      return;
                    }
                    setPending(true);
                    void sendSms({ data: { orgId: membership.orgId, contactId: smsContact.id, body: textBody, channel: textOpen } })
                      .then(() => {
                        toast.success(textOpen === "whatsapp" ? "Twilio accepted the WhatsApp message." : "Twilio accepted the text. That is not a delivery receipt.");
                        setTextOpen("");
                        return client.invalidateQueries({ queryKey: ["messages", membership.orgId] });
                      })
                      .catch((error: unknown) => toast.error(errorText(error)))
                      .finally(() => setPending(false));
                  }}
                >
                  <TextArea value={textBody} maxLength={320} onChange={(event) => setTextBody(event.target.value)} />
                  <Button type="submit" disabled={pending || textBody.trim().length < 1}>
                    {textOpen === "whatsapp" ? "Send WhatsApp" : "Send text"}
                  </Button>
                </form>
              ) : null}
            </div>
          ) : null}
          {script ? <p className="mt-4 whitespace-pre-wrap rounded-md bg-paper p-3 text-sm">{script}</p> : null}
        </section>
        <section className="session-card">
          <p className="session-kicker" style={{ color: "var(--color-violet)" }}>Apex AI</p>
          {opener ? (
            <div className="mt-2">
              <p className="font-medium">{opener.headline}</p>
              <ul className="mt-1 grid gap-1 text-sm text-fog">
                {(opener.bullets ?? []).map((item) => <li key={item}>{item}</li>)}
              </ul>
              <p className="mt-2 text-sm">{opener.opener}</p>
              <p className="mt-1 text-xs text-fog">{opener.source === "model" ? "Model rewrite. Read it before you say it." : "From this contact and campaign."}</p>
            </div>
          ) : (
            <p className="mt-2 text-sm text-fog">The opener appears when a lead is loaded. Add an xAI key in Settings if you want the model to rewrite it.</p>
          )}
          <div className="mt-3">
            <p className="font-mono text-[10px] tracking-[0.16em] text-violet uppercase">Transcript</p>
            <p className="mt-1 text-xs text-fog">Lines show up only when Twilio posts them. That needs recording consent and the public https address. An empty box means nothing arrived.</p>
            {transcript.data && transcript.data.lines.length > 0 ? (
              <ul className="mt-2 grid max-h-40 gap-1 overflow-auto text-sm">
                {transcript.data.lines.map((item) => (
                  <li key={item.id}>
                    <span className="text-fog">{item.final ? item.speaker : `${item.speaker} …`}: </span>
                    {item.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-fog">No transcript lines yet.</p>
            )}
            {transcript.data?.summary ? <p className="mt-2 text-sm">{transcript.data.summary}</p> : null}
            <Button
              type="button"
              variant="ghost"
              className="mt-2"
              disabled={pending || !call}
              onClick={() => {
                if (!call) return;
                setPending(true);
                void summarizeCall({ data: { orgId: membership.orgId, callId: call.id } })
                  .then(() => client.invalidateQueries({ queryKey: ["transcript", membership.orgId, call.id] }))
                  .catch((error: unknown) => toast.error(errorText(error)))
                  .finally(() => setPending(false));
              }}
            >
              Summarize the transcript
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {objections.map((item) => (
              <Button key={item} type="button" variant="ghost" onClick={() => { setObjection(item); setTalk(replyToObjection(item)); }}>{item}</Button>
            ))}
          </div>
          {talk ? (
            <div className="mt-3 grid gap-2">
              <p className="text-sm">{talk.line}</p>
              <p className="text-xs text-fog">{talk.why}</p>
              <Button type="button" variant="ghost" disabled={pending} onClick={() => {
                setPending(true);
                void suggestReply({ data: { orgId: membership.orgId, objection, script } })
                  .then((next) => setTalk({ line: next.line, why: next.why }))
                  .catch((error: unknown) => toast.error(errorText(error)))
                  .finally(() => setPending(false));
              }}>Sharpen this line</Button>
            </div>
          ) : null}
          {call ? coachCall({ notes, disposition, durationSeconds: call.durationSeconds }).map((flag) => <p key={flag} className="mt-2 text-sm text-fog">{flag}</p>) : null}
          {draftNote ? <p className="mt-2 text-sm text-fog">{draftNote}</p> : null}
          {call ? (
            <Button className="mt-3" type="button" variant="ghost" disabled={pending} onClick={() => {
              setPending(true);
              void draftCallNotes({ data: { orgId: membership.orgId, callId: call.id, notes, disposition } })
                .then((draft) => {
                  if (draft.summary) setNotes(draft.summary);
                  setDisposition(draft.disposition);
                  setDraftNote(draft.modelError || draft.followUp || (draft.source === "model" ? "Model draft. Edit it, then save." : "Drafted from your notes. Edit it, then save."));
                })
                .catch((error: unknown) => toast.error(errorText(error)))
                .finally(() => setPending(false));
            }}>Write the note</Button>
          ) : null}
          <div className="mt-4">
            {smsContact ? (
              <SmsThread orgId={membership.orgId} contactId={smsContact.id} firstName={smsContact.firstName} company={smsContact.company} smsConsent={smsContact.smsConsent} dnc={smsContact.dnc} extraTemplates={activeCampaign?.smsTemplate ? [{ id: "campaign", name: "Campaign text", body: activeCampaign.smsTemplate }] : []} />
            ) : <p className="text-sm text-fog">Texting unlocks on the current lead.</p>}
          </div>
        </section>
        <section id="outcome" className="session-card">
          <p className="session-kicker">Outcome · keys 1–9</p>
          <div className="outcome-pad mt-2">
            {PAD.map((item) => (
              <button key={item.id} type="button" className={`outcome-key ${disposition === item.id ? "is-hot" : ""}`} disabled={!call || pending} onClick={() => void saveOutcome(item.id)}>
                <strong>{item.key}</strong>
                {DISPOSITION_LABEL[item.id]}
              </button>
            ))}
          </div>
          <Field label="Notes">
            <TextArea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={4000} />
          </Field>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              const review = reviewScriptCoverage(notes, script);
              setGaps(review.items.length === 0 ? [] : review.missing);
              setLookupNote(review.items.length === 0 ? "The campaign script has no required lines. Start a line with *, -, MUST:, or Say:." : "");
            }}
          >
            Check notes against the script
          </Button>
          {gaps.length > 0 ? (
            <ul className="mt-2 grid gap-1 text-sm text-warn">
              {gaps.map((item) => (
                <li key={item}>Not in the notes: {item}</li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1 text-xs text-fog">This reads the notes you typed. It does not hear the call.</p>
          <Field label="Callback" hint="Only if you need a reminder.">
            <TextInput type="datetime-local" value={followUpAt} onChange={(event) => setFollowUpAt(event.target.value)} />
          </Field>
          <div className="mt-2 flex flex-wrap gap-2">
            <TextInput className="max-w-40" value={transferTo} placeholder="+1…" onChange={(event) => setTransferTo(event.target.value)} />
            <Button type="button" variant="ghost" disabled={pending || !call} onClick={() => {
              if (!call) return;
              setPending(true);
              void transferCall({ data: { orgId: membership.orgId, callId: call.id, to: transferTo } })
                .then(() => toast.success("Transfer requested."))
                .catch((error: unknown) => toast.error(errorText(error)))
                .finally(() => setPending(false));
            }}>Transfer</Button>
            <SelectInput value={clipId} onChange={(event) => setClipId(event.target.value)}>
              <option value="">Campaign script</option>
              {(clips.data?.clips ?? []).map((clip) => (
                <option key={clip.id} value={clip.id}>{clip.name}</option>
              ))}
            </SelectInput>
            <Button type="button" variant="ghost" disabled={pending || !call || call.channel !== "twilio" || call.providerCallSid !== "set"} onClick={() => {
              if (!call) return;
              setPending(true);
              void dropVoicemail({ data: { orgId: membership.orgId, callId: call.id, clipId } })
                .then(() => { setDisposition("voicemail"); toast.success(clipId ? "Playing the selected clip." : "Playing the campaign voicemail."); })
                .catch((error: unknown) => toast.error(errorText(error)))
                .finally(() => setPending(false));
            }}>Drop voicemail</Button>
          </div>
          {followUps.data && followUps.data.followUps.length > 0 ? (
            <ul className="mt-3 grid gap-1 text-sm">
              {followUps.data.followUps.slice(0, 5).map((item) => {
                const due = item.dueAt ? new Date(item.dueAt).getTime() <= Date.now() : false;
                return (
                  <li key={item.id} className="flex items-center justify-between gap-2">
                    <span>
                      {due ? "Due · " : ""}
                      {item.name} · {formatWhen(item.dueAt)}
                    </span>
                    <span className="flex gap-1">
                      {item.contactId ? (
                        <Button
                          type="button"
                          variant="quiet"
                          onClick={() => {
                            setSessionOn(false);
                            void navigate({ to: "/app/dial", search: { contactId: item.contactId!, campaignId } });
                          }}
                        >
                          Open
                        </Button>
                      ) : null}
                      <Button type="button" variant="quiet" onClick={() => {
                        void completeFollowUp({ data: { orgId: membership.orgId, followUpId: item.id } })
                          .then(() => client.invalidateQueries({ queryKey: ["followups", membership.orgId] }))
                          .catch((error: unknown) => toast.error(errorText(error)));
                      }}>Done</Button>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function useElapsed(active: boolean, from: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  if (!active || !from) return "00:00";
  const seconds = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
