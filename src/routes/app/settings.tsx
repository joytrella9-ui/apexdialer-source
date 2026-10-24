import { useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { clearAssistKey, clearTelephonyConnection, getTelephonyConnection, provisionBrowserPhone, ringMyPhone, runRetention, runTwilioSetup, saveAssistKey, saveIvrMenu, saveTelephonyConnection, testTelephony, updateOrgSettings } from "@/server/workspace";
import { getAdapters, saveAdapters, testAdapter } from "@/server/adapters";
import { setCallbackPhone } from "@/server/team";
import { useWorkspace, PageTitle } from "@/components/workspace";
import { Banner, Button, Field, Panel, SelectInput, TextArea, TextInput } from "@/components/bits";
import { parseIvrOptions, type IvrOption } from "@/lib/dialer/ivr";
import { DAY_OPTIONS, errorText } from "@/lib/dialer/format";
import { authClient } from "@/lib/auth/client";

export const Route = createFileRoute("/app/settings")({ component: SettingsPage });

function SettingsPage() {
  const { membership, telephony, usage, limits, allow, reload } = useWorkspace();
  const [phone, setPhone] = useState(membership.callbackPhone);
  const [name, setName] = useState(membership.orgName);
  const [timezone, setTimezone] = useState(membership.timezone);
  const [windowStart, setWindowStart] = useState(membership.windowStart);
  const [windowEnd, setWindowEnd] = useState(membership.windowEnd);
  const [days, setDays] = useState<number[]>(membership.callingDays);
  const [recordingPolicy, setRecordingPolicy] = useState(membership.recordingPolicy as "disabled" | "provider_if_consented");
  const [retentionDays, setRetentionDays] = useState(membership.retentionDays);
  const [testResult, setTestResult] = useState("");
  const [setupLines, setSetupLines] = useState<string[]>([]);
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [fromNumber, setFromNumber] = useState("");
  const [callerIds, setCallerIds] = useState("");
  const [publicUrl, setPublicUrl] = useState("");
  const [apiKeySid, setApiKeySid] = useState("");
  const [apiKeySecret, setApiKeySecret] = useState("");
  const [twimlAppSid, setTwimlAppSid] = useState("");
  const [stripeSecret, setStripeSecret] = useState("");
  const [aiKey, setAiKey] = useState("");
  const blankMenu = (): IvrOption[] => [
    { digit: "1", label: "", action: "agent", message: "" },
    { digit: "2", label: "", action: "message", message: "" },
    { digit: "3", label: "", action: "agent", message: "" },
  ];
  const [ivrGreeting, setIvrGreeting] = useState("");
  const [ivrRows, setIvrRows] = useState<IvrOption[]>(blankMenu);
  const connection = useQuery({
    queryKey: ["telephony-connection", membership.orgId],
    queryFn: () => getTelephonyConnection({ data: { orgId: membership.orgId } }),
    enabled: allow("manage_settings"),
  });
  const browserOrigin = typeof window === "undefined" ? "" : window.location.origin;
  const previewHost = /localhost|127\.0\.0\.1|grok-sandbox|grok\.me|app-builder-testing/.test(browserOrigin);
  useEffect(() => {
    const saved = connection.data;
    if (!saved) return;
    setAccountSid(saved.accountSid);
    setFromNumber(saved.fromNumber);
    setCallerIds(saved.callerIds);
    setPublicUrl(saved.publicUrl || (browserOrigin.startsWith("https://") && !previewHost ? browserOrigin : ""));
    setApiKeySid(saved.apiKeySid);
    setTwimlAppSid(saved.twimlAppSid);
    setAuthToken("");
    setApiKeySecret("");
    setStripeSecret("");
    const savedMenu = parseIvrOptions(saved.ivrOptions);
    setIvrGreeting(saved.ivrGreeting);
    setIvrRows(savedMenu.length > 0 ? savedMenu : blankMenu());
  }, [connection.data]);
  return (
    <>
      <PageTitle
        title="Settings"
        lane="Admin"
        steps={[
          { label: "Account", href: "#account" },
          { label: "Line", href: "#line" },
          { label: "Hours", href: "#hours" },
          { label: "Menu", href: "#menu" },
          { label: "Connections", href: "#connections" },
        ]}
      />
      <InstallApp />
      <Panel title="More">
        <p className="mb-3 text-sm text-fog">These stay out of the sidebar so the desk stays to six tabs.</p>
        <div className="flex flex-wrap gap-2">
          <Link to="/app" className="console-chip">Board</Link>
          <Link to="/app/calls" className="console-chip">Call log</Link>
          {allow("view_all_calls") ? <Link to="/app/floor" className="console-chip">Floor</Link> : null}
          {allow("manage_team") ? <Link to="/app/team" className="console-chip">Team</Link> : null}
          {allow("view_audit") ? <Link to="/app/audit" className="console-chip">Audit</Link> : null}
        </div>
      </Panel>
      <PasswordPanel />
      <Panel title="Your callback number">
        <p className="mb-3 text-sm text-fog">Twilio calls this number first, then bridges the contact. Device dialing does not use it.</p>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void setCallbackPhone({ data: { orgId: membership.orgId, phone } })
              .then(() => {
                toast.success("Callback number saved");
                reload();
              })
              .catch((error: unknown) => toast.error(errorText(error)));
          }}
        >
          <TextInput className="max-w-xs" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+13125550100" />
          <Button type="submit">Save</Button>
        </form>
      </Panel>
      <Panel title="Plan">
        <p className="text-sm">
          {membership.plan} · billing {membership.billingStatus}. Contacts {usage?.contacts ?? 0}/{limits?.maxContacts}. Campaigns {usage?.campaigns ?? 0}/{limits?.maxCampaigns}. Seats {usage?.agents ?? 0}/{limits?.maxAgents}. Calls this month {usage?.callsThisMonth ?? 0}.
        </p>
        <p className="mt-2 text-sm text-fog">There is no card form. If you use Stripe, point a webhook at the billing address shown under Telephony and include metadata org_id and plan. Nothing on this page charges a card.</p>
      </Panel>
      <Panel title="Telephony" id="line">
        <ol className="mb-4 grid list-decimal gap-3 pl-5 text-sm">
          <li>
            <span className="font-medium">Open Twilio.</span> Create an account at console.twilio.com. A trial account can only call numbers you have verified inside Twilio. Add credit before you call customers.
          </li>
          <li>
            <span className="font-medium">Buy one voice number.</span> Copy the Account SID (AC) and the Auth Token from the Twilio home page. Paste them below with the number in international form, then press Save connection.
          </li>
          <li>
            <span className="font-medium">Save your own mobile</span> as the callback number at the top of this page. Press Test Twilio account, then Ring my phone. Your phone should say ApexDialer can reach it. That is the first real call.
          </li>
          <li>
            <span className="font-medium">Publish this app</span> from the builder. Copy the public https address with no path on the end, paste it in Public https address, and save again. A private preview cannot receive inbound calls, texts, recordings, or screened connects.
          </li>
          <li>
            <span className="font-medium">Create the browser phone</span> with the button below. Allow the microphone. The lamp must say Line open. Then type your own number on the softphone and press Call.
          </li>
          <li>
            <span className="font-medium">Point the Twilio number at this app.</span> On that number, set “A call comes in” to Webhook, POST, and the inbound voice address below. Set “A message comes in” to the inbound text address. Copy them from here so a character is not missed.
          </li>
          <li>
            <span className="font-medium">Screened connect.</span> On a lead, Screen calls them and speaks the first line of the campaign script, then “Press 1” and “Press 2.” Press 1 rings you and whispers their name before you are connected. Press 2 marks do-not-call. This needs the published address. It is not a conversation with an AI. The voice is Twilio reading that sentence.
          </li>
        </ol>
        <Banner>{telephony.detail}</Banner>
        <p className="mt-2 text-sm text-fog">Allow-listed caller IDs: {telephony.callerIds.length ? telephony.callerIds.join(", ") : "none yet"}.</p>
        {allow("manage_settings") ? (
          <form
            className="mt-4 grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void saveTelephonyConnection({
                data: {
                  orgId: membership.orgId,
                  accountSid,
                  authToken,
                  fromNumber,
                  callerIds,
                  publicUrl,
                  stripeWebhookSecret: stripeSecret,
                  apiKeySid,
                  apiKeySecret,
                  twimlAppSid,
                },
              })
                .then(() => {
                  toast.success("Connection saved");
                  setAuthToken("");
                  setApiKeySecret("");
                  setStripeSecret("");
                  reload();
                  void connection.refetch();
                })
                .catch((error: unknown) => toast.error(errorText(error)));
            }}
          >
            <Field label="Twilio Account SID" hint="Starts with AC. Found on the Twilio console home page.">
              <TextInput value={accountSid} autoComplete="off" onChange={(event) => setAccountSid(event.target.value)} placeholder="AC…" />
            </Field>
            <Field label="Auth token" hint={connection.data?.authTokenSet ? "A token is already saved. Leave this blank to keep it." : "Shown once by Twilio. It is not displayed again after you save."}>
              <TextInput type="password" value={authToken} autoComplete="new-password" onChange={(event) => setAuthToken(event.target.value)} placeholder={connection.data?.authTokenSet ? "Saved" : "Auth token"} />
            </Field>
            <Field label="From number" hint="The Twilio number that people see. E.164.">
              <TextInput value={fromNumber} onChange={(event) => setFromNumber(event.target.value)} placeholder="+13125550100" />
            </Field>
            <Field label="Other caller IDs" hint="Optional. Comma-separated E.164 numbers on the same Twilio account.">
              <TextInput value={callerIds} onChange={(event) => setCallerIds(event.target.value)} placeholder="+13125550199" />
            </Field>
            <Field label="Public https address" hint="Twilio calls this address to connect the other person. No path on the end. A private preview cannot receive it.">
              <TextInput value={publicUrl} onChange={(event) => setPublicUrl(event.target.value)} placeholder="https://dial.example.com" />
            </Field>
            {browserOrigin.startsWith("https://") && !previewHost ? (
              <Button type="button" variant="ghost" onClick={() => setPublicUrl(browserOrigin)}>Use this site’s address</Button>
            ) : (
              <p className="text-sm text-fog">This preview cannot receive Twilio’s callbacks. After you publish, paste the public https address here.</p>
            )}
            <div className="border border-brass bg-paper p-3">
              <p className="font-display text-xl">Browser phone</p>
              <p className="mt-1 text-sm text-fog">
                Save the account above, then create the key and voice app on your Twilio account. Or paste an API key (SK) and a TwiML app (AP) you already made. The secret is stored once and is not shown again.
              </p>
              <div className="mt-3 grid gap-3">
                <Field label="API key SID" hint="Starts with SK. Leave blank to keep the saved key.">
                  <TextInput value={apiKeySid} autoComplete="off" onChange={(event) => setApiKeySid(event.target.value)} placeholder="SK…" />
                </Field>
                <Field label="API key secret" hint={connection.data?.apiKeySet ? "A secret is saved. Leave blank to keep it." : "Shown once by Twilio."}>
                  <TextInput type="password" value={apiKeySecret} autoComplete="new-password" onChange={(event) => setApiKeySecret(event.target.value)} placeholder={connection.data?.apiKeySet ? "Saved" : "API key secret"} />
                </Field>
                <Field label="TwiML app SID" hint="Starts with AP. The voice URL is pointed at this site when you create it here.">
                  <TextInput value={twimlAppSid} autoComplete="off" onChange={(event) => setTwimlAppSid(event.target.value)} placeholder="AP…" />
                </Field>
              </div>
            </div>
            <Field label="Stripe webhook secret" hint={connection.data?.stripeSecretSet ? "A secret is saved. Leave blank to keep it. Optional." : "Optional. From Stripe’s webhook endpoint, starts with whsec_."}>
              <TextInput type="password" value={stripeSecret} autoComplete="new-password" onChange={(event) => setStripeSecret(event.target.value)} placeholder={connection.data?.stripeSecretSet ? "Saved" : "whsec_…"} />
            </Field>
            {connection.data?.inboundUrl ? <CopyLine label="Inbound voice, paste as A call comes in, POST" value={connection.data.inboundUrl} /> : null}
            {connection.data?.smsUrl ? <CopyLine label="Inbound text, paste as A message comes in, POST" value={connection.data.smsUrl} /> : null}
            {connection.data?.clientVoiceUrl ? <CopyLine label="Browser voice address, set on the TwiML app" value={connection.data.clientVoiceUrl} /> : null}
            {connection.data?.statusUrl ? <CopyLine label="Status address, set on each outbound call" value={connection.data.statusUrl} /> : null}
            {connection.data?.stripeUrl ? <CopyLine label="Stripe webhook address" value={connection.data.stripeUrl} /> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="submit">Save connection</Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  if (!window.confirm("Remove the saved Twilio token and Stripe secret for this workspace?")) return;
                  void clearTelephonyConnection({ data: { orgId: membership.orgId } })
                    .then(() => {
                      toast.success("Disconnected");
                      setAccountSid("");
                      setAuthToken("");
                      setFromNumber("");
                      setCallerIds("");
                      setPublicUrl("");
                      setApiKeySid("");
                      setApiKeySecret("");
                      setTwimlAppSid("");
                      setStripeSecret("");
                      reload();
                      void connection.refetch();
                    })
                    .catch((error: unknown) => toast.error(errorText(error)));
                }}
              >
                Disconnect
              </Button>
            </div>
          </form>
        ) : null}
        {allow("manage_settings") ? (
          <Button
            className="mt-3"
            type="button"
            onClick={() => {
              setSetupLines([]);
              void provisionBrowserPhone({ data: { orgId: membership.orgId } })
                .then((result) => {
                  toast.success(result.createdKey ? "Browser phone created on your Twilio account." : "Browser phone pointed at this site.");
                  setSetupLines([`API key ${result.apiKeySid}`, `Voice app ${result.twimlAppSid}`, result.voiceUrl]);
                  reload();
                  void connection.refetch();
                })
                .catch((error: unknown) => {
                  toast.error(errorText(error));
                  setSetupLines([errorText(error)]);
                });
            }}
          >
            Create the browser phone on Twilio
          </Button>
        ) : null}
        {allow("test_telephony") ? (
          <Button
            className="mt-3 ml-2"
            type="button"
            variant="ghost"
            onClick={() => {
              setTestResult("");
              void testTelephony({ data: { orgId: membership.orgId } })
                .then((result) => setTestResult(`Twilio answered as ${result.friendlyName}. That confirms the account lookup, not a placed call.`))
                .catch((error: unknown) => setTestResult(errorText(error)));
            }}
          >
            Test Twilio account
          </Button>
        ) : null}
        {allow("test_telephony") ? (
          <Button
            className="mt-3 ml-2"
            type="button"
            variant="ghost"
            onClick={() => {
              setTestResult("");
              void ringMyPhone({ data: { orgId: membership.orgId } })
                .then(() => setTestResult("Twilio is calling your callback number. You should hear that ApexDialer can reach this phone."))
                .catch((error: unknown) => setTestResult(errorText(error)));
            }}
          >
            Ring my phone
          </Button>
        ) : null}
        {allow("test_telephony") ? (
          <Button
            className="mt-3 ml-2"
            type="button"
            variant="ghost"
            onClick={() => {
              setSetupLines([]);
              void runTwilioSetup({ data: { orgId: membership.orgId } })
                .then((result) => {
                  setSetupLines([
                    result.ready ? "Ready for a live call." : "Not ready for a live call.",
                    result.live.detail,
                    ...result.checks.map((check) => `${check.ok ? "Pass" : "Fail"} — ${check.label}: ${check.detail}`),
                  ]);
                })
                .catch((error: unknown) => setSetupLines([errorText(error)]));
            }}
          >
            Run Twilio setup check
          </Button>
        ) : null}
        {setupLines.map((line) => (
          <p key={line} className="mt-2 text-sm">{line}</p>
        ))}
        {testResult ? <p className="mt-2 text-sm">{testResult}</p> : null}
      </Panel>
      {allow("manage_settings") ? <Connections orgId={membership.orgId} /> : null}
      {allow("manage_settings") ? (
        <Panel title="Inbound menu" id="menu">
          <p className="mb-3 text-sm text-fog">
            When someone calls your Twilio number, they hear this menu before anyone’s phone rings. Leave every label blank and inbound calls still go straight to an available agent. A message option speaks the text and hangs up. An agent option rings a free callback phone or softphone. This needs the published https address.
          </p>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void saveIvrMenu({ data: { orgId: membership.orgId, greeting: ivrGreeting, options: ivrRows } })
                .then((saved) => {
                  toast.success(saved.options.length ? "Menu saved. Callers hear it on the next inbound call." : "Menu cleared. Inbound calls ring an agent directly.");
                  setIvrRows(saved.options.length > 0 ? saved.options : blankMenu());
                  void connection.refetch();
                })
                .catch((error: unknown) => toast.error(errorText(error)));
            }}
          >
            <Field label="Greeting" hint="Spoken first. The keys are added after it.">
              <TextArea value={ivrGreeting} maxLength={180} onChange={(event) => setIvrGreeting(event.target.value)} placeholder="Thanks for calling Northline." />
            </Field>
            {ivrRows.map((row, index) => (
              <div key={row.digit + index} className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-[4rem_1fr_8rem]">
                <Field label="Key">
                  <TextInput value={row.digit} maxLength={1} onChange={(event) => {
                    const digit = event.target.value.replace(/\D/g, "").slice(0, 1);
                    setIvrRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, digit } : item));
                  }} />
                </Field>
                <Field label="What they hear">
                  <TextInput value={row.label} maxLength={40} placeholder="Sales" onChange={(event) => {
                    const label = event.target.value;
                    setIvrRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, label } : item));
                  }} />
                </Field>
                <Field label="Then">
                  <SelectInput value={row.action} onChange={(event) => {
                    const action = event.target.value === "message" ? "message" : "agent";
                    setIvrRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, action } : item));
                  }}>
                    <option value="agent">Ring an agent</option>
                    <option value="message">Play a message</option>
                  </SelectInput>
                </Field>
                {row.action === "message" ? (
                  <Field label="Message">
                    <TextInput value={row.message} maxLength={240} placeholder="Our hours are nine to five." onChange={(event) => {
                      const message = event.target.value;
                      setIvrRows((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, message } : item));
                    }} />
                  </Field>
                ) : null}
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button type="submit">Save menu</Button>
              <Button type="button" variant="ghost" onClick={() => setIvrRows((current) => current.length >= 6 ? current : [...current, { digit: String(current.length + 1), label: "", action: "agent", message: "" }])}>
                Add a key
              </Button>
            </div>
          </form>
        </Panel>
      ) : null}
      {allow("manage_settings") ? (
        <Panel title="Call assist">
          <p className="mb-3 text-sm text-fog">
            Briefs, the next-lead order, and note drafts work without a key, using the contact and call history. A key lets Grok rewrite the opener and the note. It cannot dial, and it cannot save a disposition.
          </p>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void saveAssistKey({ data: { orgId: membership.orgId, apiKey: aiKey } })
                .then(() => {
                  toast.success("Assist key saved");
                  setAiKey("");
                  void connection.refetch();
                })
                .catch((error: unknown) => toast.error(errorText(error)));
            }}
          >
            <TextInput
              className="max-w-md"
              type="password"
              autoComplete="new-password"
              value={aiKey}
              placeholder={connection.data?.aiKeySet ? "Key saved" : "xAI API key"}
              onChange={(event) => setAiKey(event.target.value)}
            />
            <Button type="submit">Save key</Button>
            {connection.data?.aiKeySet ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  void clearAssistKey({ data: { orgId: membership.orgId } })
                    .then(() => {
                      toast.success("Assist key removed");
                      void connection.refetch();
                    })
                    .catch((error: unknown) => toast.error(errorText(error)));
                }}
              >
                Remove key
              </Button>
            ) : null}
          </form>
        </Panel>
      ) : null}
      {allow("manage_settings") ? (
        <Panel title="Workspace rules" id="hours">
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void updateOrgSettings({
                data: { orgId: membership.orgId, name, timezone, windowStart, windowEnd, callingDays: days, recordingPolicy, retentionDays },
              })
                .then(() => {
                  toast.success("Settings saved");
                  reload();
                })
                .catch((error: unknown) => toast.error(errorText(error)));
            }}
          >
            <Field label="Name"><TextInput value={name} onChange={(event) => setName(event.target.value)} /></Field>
            <Field label="Timezone"><TextInput value={timezone} onChange={(event) => setTimezone(event.target.value)} /></Field>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Default window start"><TextInput value={windowStart} onChange={(event) => setWindowStart(event.target.value)} /></Field>
              <Field label="Default window end"><TextInput value={windowEnd} onChange={(event) => setWindowEnd(event.target.value)} /></Field>
            </div>
            <div className="flex flex-wrap gap-2">
              {DAY_OPTIONS.map((day) => (
                <label key={day.id} className="flex min-h-11 items-center gap-2 rounded-lg border border-line px-3 text-sm">
                  <input type="checkbox" checked={days.includes(day.id)} onChange={(event) => setDays(event.target.checked ? [...days, day.id] : days.filter((value) => value !== day.id))} />
                  {day.label}
                </label>
              ))}
            </div>
            <Field label="Recording" hint="When this is on and the contact allowed it, Twilio may record and send a live transcript to the published address. No transcript is invented if nothing arrives.">
              <SelectInput value={recordingPolicy} onChange={(event) => setRecordingPolicy(event.target.value as typeof recordingPolicy)}>
                <option value="disabled">Do not record</option>
                <option value="provider_if_consented">Record on Twilio only when the contact has consent</option>
              </SelectInput>
            </Field>
            <Field label="Recording URL retention (days)" hint="Clears stored recording URLs older than this. Call notes are kept.">
              <TextInput type="number" min={30} max={2555} value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))} />
            </Field>
            <Button type="submit">Save rules</Button>
          </form>
          <Button
            className="mt-3"
            type="button"
            variant="ghost"
            onClick={() => {
              if (!window.confirm("Clear recording URLs older than the retention window?")) return;
              void runRetention({ data: { orgId: membership.orgId } })
                .then((result) => toast.success(`${result.scrubbed} recording URLs cleared`))
                .catch((error: unknown) => toast.error(errorText(error)));
            }}
          >
            Run retention now
          </Button>
        </Panel>
      ) : (
        <Banner>Organization rules are visible to admins. Your role can still set a callback number.</Banner>
      )}
    </>
  );
}

function CopyLine({ label, value }: { label: string; value: string }) {
  return (
    <p className="break-all text-sm text-fog">
      {label}: {value}{" "}
      <button
        type="button"
        className="underline"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(
            () => toast.success("Copied"),
            () => toast.error("Could not copy. Select the address instead."),
          );
        }}
      >
        Copy
      </button>
    </p>
  );
}

function InstallApp() {
  const [install, setInstall] = useState<(() => Promise<void>) | null>(null);
  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault();
      const deferred = event as Event & { prompt: () => Promise<void> };
      setInstall(() => () => deferred.prompt());
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);
  return (
    <Panel title="Install">
      <p className="mb-3 text-sm text-fog">
        This installs Apex on a phone or computer from the browser. It is not an App Store or Play Store listing. Live calls still need the published address in Telephony.
      </p>
      {install ? (
        <Button type="button" onClick={() => void install().finally(() => setInstall(null))}>
          Install Apex
        </Button>
      ) : (
        <p className="text-sm text-fog">If the button is not here, open the browser menu and choose Install app, or Add to Home Screen. That appears after the site is published on https.</p>
      )}
    </Panel>
  );
}

function PasswordPanel() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <Panel title="Password" id="account">
      <p className="mb-3 text-sm text-fog">Change it here. An owner can set a new password for someone else from Team. There is no reset email.</p>
      <form
        className="grid max-w-md gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (next.length < 8) {
            toast.error("Use at least 8 characters.");
            return;
          }
          if (next === current) {
            toast.error("Choose a different password.");
            return;
          }
          setPending(true);
          void authClient
            .changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true })
            .then((result) => {
              if (result.error) {
                toast.error(result.error.message || "Could not change the password.");
                return;
              }
              setCurrent("");
              setNext("");
              toast.success("Password updated.");
            })
            .catch((error: unknown) => toast.error(errorText(error)))
            .finally(() => setPending(false));
        }}
      >
        <Field label="Current password">
          <TextInput type="password" value={current} autoComplete="current-password" onChange={(event) => setCurrent(event.target.value)} required />
        </Field>
        <Field label="New password" hint="At least 8 characters.">
          <TextInput type="password" value={next} autoComplete="new-password" minLength={8} onChange={(event) => setNext(event.target.value)} required />
        </Field>
        <Button type="submit" disabled={pending}>
          {pending ? "Updating…" : "Update password"}
        </Button>
      </form>
    </Panel>
  );
}

function Connections({ orgId }: { orgId: string }) {
  const client = useQueryClient();
  const status = useQuery({ queryKey: ["adapters", orgId], queryFn: () => getAdapters({ data: { orgId } }) });
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [hubspotToken, setHubspotToken] = useState("");
  const [salesforceUrl, setSalesforceUrl] = useState("");
  const [salesforceToken, setSalesforceToken] = useState("");
  const [whatsappFrom, setWhatsappFrom] = useState("");
  const [note, setNote] = useState("");
  function save(clear: Array<"webhook" | "hubspot" | "salesforce" | "whatsapp"> = []) {
    setNote("");
    void saveAdapters({ data: { orgId, webhookUrl, webhookSecret, hubspotToken, salesforceUrl, salesforceToken, whatsappFrom, clear } })
      .then(() => {
        setWebhookSecret("");
        setHubspotToken("");
        setSalesforceToken("");
        setNote("Saved. Empty secret fields were left as they were.");
        void client.invalidateQueries({ queryKey: ["adapters", orgId] });
      })
      .catch((error: unknown) => setNote(errorText(error)));
  }
  function ping(which: "webhook" | "hubspot" | "salesforce" | "whatsapp") {
    setNote("");
    void testAdapter({ data: { orgId, which } })
      .then((result) => setNote(result.detail))
      .catch((error: unknown) => setNote(errorText(error)));
  }
  const on = status.data;
  return (
    <Panel title="Connections" id="connections">
      <p className="mb-3 text-sm text-fog">
        These stay off until you save them. A disposition then logs the call. A failure is shown on the session and does not undo the disposition. Tokens are not shown again after you save them.
      </p>
      <div className="grid gap-4">
        <div className="grid gap-2">
          <p className="text-sm font-medium">Webhook {on?.webhook ? "· on" : "· off"}</p>
          <Field label="https address" hint="Zapier, Make, or your own server. We POST the call and sign the body with X-Apex-Signature when a secret is set.">
            <TextInput value={webhookUrl} placeholder="https://" onChange={(event) => setWebhookUrl(event.target.value)} />
          </Field>
          <Field label="Signing secret">
            <TextInput type="password" value={webhookSecret} autoComplete="new-password" onChange={(event) => setWebhookSecret(event.target.value)} />
          </Field>
          <span className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => ping("webhook")}>Test</Button>
            <Button type="button" variant="ghost" onClick={() => save(["webhook"])}>Disconnect</Button>
          </span>
        </div>
        <div className="grid gap-2">
          <p className="text-sm font-medium">HubSpot {on?.hubspot ? "· on" : "· off"}</p>
          <Field label="Private app token" hint="Creates a call and attaches it when a HubSpot contact has the same phone number. It does not import the list.">
            <TextInput type="password" value={hubspotToken} autoComplete="new-password" onChange={(event) => setHubspotToken(event.target.value)} />
          </Field>
          <span className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => ping("hubspot")}>Test</Button>
            <Button type="button" variant="ghost" onClick={() => save(["hubspot"])}>Disconnect</Button>
          </span>
        </div>
        <div className="grid gap-2">
          <p className="text-sm font-medium">Salesforce {on?.salesforce ? "· on" : "· off"}</p>
          <Field label="Instance URL" hint="https://your-domain.my.salesforce.com. The token expires on Salesforce’s schedule. Paste a new one when Test fails.">
            <TextInput value={salesforceUrl} placeholder="https://….my.salesforce.com" onChange={(event) => setSalesforceUrl(event.target.value)} />
          </Field>
          <Field label="Access token">
            <TextInput type="password" value={salesforceToken} autoComplete="new-password" onChange={(event) => setSalesforceToken(event.target.value)} />
          </Field>
          <span className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => ping("salesforce")}>Test</Button>
            <Button type="button" variant="ghost" onClick={() => save(["salesforce"])}>Disconnect</Button>
          </span>
        </div>
        <div className="grid gap-2">
          <p className="text-sm font-medium">WhatsApp {on?.whatsapp ? "· on" : "· off"}</p>
          <Field label="Twilio WhatsApp sender" hint="The number Twilio approved for WhatsApp, in E.164. Messages still require SMS consent.">
            <TextInput value={whatsappFrom} placeholder="+14155550100" onChange={(event) => setWhatsappFrom(event.target.value)} />
          </Field>
          <span className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => ping("whatsapp")}>Test</Button>
            <Button type="button" variant="ghost" onClick={() => save(["whatsapp"])}>Disconnect</Button>
          </span>
        </div>
        <Button type="button" onClick={() => save()}>Save connections</Button>
        {note ? <p className="text-sm">{note}</p> : null}
      </div>
    </Panel>
  );
}
