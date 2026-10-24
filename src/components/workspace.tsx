import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";
import { getBootstrap, createOrganization } from "@/server/workspace";
import { RedirectToSignIn, UserButton } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { can, type Action, type Role } from "@/lib/dialer/permissions";
import { ROLE_LABEL, presenceLabel } from "@/lib/dialer/labels";
import { setPresence } from "@/server/calls";
import { askApex } from "@/server/assist";
import { errorText } from "@/lib/dialer/format";
import { Button, Field, TextInput } from "./bits";
import { Mark, Wordmark } from "./mark";
import { Handset } from "./handset";
import { SoftphoneProvider, useSoftphone } from "./softphone";

type Bootstrap = Awaited<ReturnType<typeof getBootstrap>>;

type WorkspaceValue = {
  boot: Bootstrap;
  reload: () => void;
  allow: (action: Action) => boolean;
};

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value?.boot.membership) throw new Error("Workspace is not ready.");
  return { ...value, membership: value.boot.membership, usage: value.boot.usage, limits: value.boot.limits, telephony: value.boot.telephony };
}

export function AppFrame() {
  const { user, isPending } = useCurrentUserState();
  const boot = useQuery({
    queryKey: ["bootstrap"],
    queryFn: () => getBootstrap({ data: {} }),
    enabled: typeof window !== "undefined" && Boolean(user),
  });
  const client = useQueryClient();
  if (isPending || (user && boot.isLoading)) {
    return <p className="grid min-h-screen place-items-center text-sm text-fog">Checking your session…</p>;
  }
  if (!user) return <RedirectToSignIn />;
  if (boot.isError) {
    return <p className="grid min-h-screen place-items-center px-6 text-sm text-bad">{errorText(boot.error)}</p>;
  }
  if (!boot.data?.membership) {
    return <CreateWorkspace onCreated={() => void client.invalidateQueries({ queryKey: ["bootstrap"] })} />;
  }
  const value: WorkspaceValue = {
    boot: boot.data,
    reload: () => void client.invalidateQueries({ queryKey: ["bootstrap"] }),
    allow: (action) => can(boot.data.membership!.role as Role, action),
  };
  return (
    <WorkspaceContext.Provider value={value}>
      <Shell />
    </WorkspaceContext.Provider>
  );
}

const NAV = [
  { to: "/app/dial", label: "Dialer", search: { campaignId: "", contactId: "" } as const },
  { to: "/app/contacts", label: "Contacts" },
  { to: "/app/campaigns", label: "Campaigns" },
  { to: "/app/inbox", label: "Inbox" },
  { to: "/app/reports", label: "Analytics", action: "view_reports" as const },
  { to: "/app/settings", label: "Settings" },
] as const;

const MORE = [
  { to: "/app", label: "Board", exact: true as const },
  { to: "/app/calls", label: "Call log" },
  { to: "/app/floor", label: "Floor", action: "view_all_calls" as const },
  { to: "/app/team", label: "Team", action: "manage_team" as const },
  { to: "/app/audit", label: "Audit", action: "view_audit" as const },
] as const;

function Shell() {
  const { membership, telephony } = useWorkspace();
  return (
    <SoftphoneProvider orgId={membership.orgId} enabled={telephony.softphoneReady}>
      <ShellFrame />
    </SoftphoneProvider>
  );
}

function ShellFrame() {
  const { membership, usage, allow, reload } = useWorkspace();
  const phone = useSoftphone();
  const path = useRouterState({ select: (state) => state.location.pathname }).replace(/\/$/, "") || "/";
  const [collapsed, setCollapsed] = useState(false);
  const [palette, setPalette] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const line =
    phone.status === "ready" ? "Line open" : phone.status === "busy" ? "On a call" : phone.status === "connecting" ? "Registering" : phone.status === "error" ? "Line fault" : "Line off";
  useEffect(() => {
    if (localStorage.getItem("apex-nav") === "collapsed") setCollapsed(true);
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((open) => !open);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className={`console ${collapsed ? "is-collapsed" : ""}`}>
      <aside className="console-nav">
        <div className="flex items-center justify-between gap-2 px-2 py-1">
          <div className="min-w-0">
            <div className="brand-lockup">
              <Mark />
              <Wordmark height={16} className="console-label" />
            </div>
            <p className="console-label mt-1 truncate text-xs text-fog">{membership.orgName}</p>
          </div>
          <button
            type="button"
            className="console-chip"
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            onClick={() => {
              setCollapsed((value) => {
                localStorage.setItem("apex-nav", value ? "open" : "collapsed");
                return !value;
              });
            }}
          >
            {collapsed ? ">" : "<"}
          </button>
        </div>
        <nav className="mt-4 grid content-start gap-1">
          {NAV.filter((item) => !("action" in item) || !item.action || allow(item.action)).map((item) => {
            const target = item.to.replace(/\/$/, "") || "/";
            const active = "exact" in item && item.exact ? path === target : path === target || path.startsWith(`${target}/`);
            return (
              <Link
                key={item.to}
                to={item.to}
                search={"search" in item ? item.search : undefined}
                className={`nav-link ${active ? "is-active" : ""}`}
              >
                <span className="nav-full">{item.label}</span>
                <span className="nav-mark">{item.label.slice(0, 1)}</span>
              </Link>
            );
          })}
        </nav>
        <div className="console-meta mt-auto grid gap-2 px-1 pt-4">
          <PresenceControl orgId={membership.orgId} onChanged={reload} />
          <p className="text-xs text-fog">{ROLE_LABEL[membership.role] ?? membership.role}</p>
          <UserButton />
        </div>
      </aside>
      <div className="console-main">
        <header className="console-top">
          <span className="console-status">
            <span className={`inline-block h-2 w-2 rounded-full ${phone.status === "ready" || phone.status === "busy" ? "bg-filament" : "bg-fog"} ${phone.status === "busy" ? "lamp-live" : ""}`} />
            {line}
          </span>
          {phone.status === "busy" ? (
            <span className="flex gap-2">
              <button type="button" className="console-chip" onClick={() => phone.setMuted(!phone.muted)}>
                {phone.muted ? "Unmute" : "Mute"}
              </button>
              <button type="button" className="console-chip is-end" onClick={() => phone.hangup()}>
                End
              </button>
            </span>
          ) : (
            <span className="truncate text-xs text-fog">{phone.status === "error" ? phone.detail : membership.orgName}</span>
          )}
          <span className="ml-auto flex items-center gap-2">
            <button type="button" className="console-chip" onClick={() => setPalette(true)}>
              Search
            </button>
            <button type="button" className="console-chip" onClick={() => setAiOpen((open) => !open)}>
              Apex AI
            </button>
            <Link to="/app/notifications" className="console-chip">
              Alerts{usage && usage.unread > 0 ? ` ${usage.unread}` : ""}
            </Link>
          </span>
        </header>
        {phone.incomingFrom ? (
          <div className="incoming-strip">
            <p className="font-mono text-sm">Incoming {phone.incomingFrom}</p>
            <span className="flex gap-2">
              <Button type="button" onClick={phone.acceptIncoming}>Answer</Button>
              <Button type="button" variant="ghost" onClick={phone.declineIncoming}>Decline</Button>
            </span>
          </div>
        ) : null}
        {membership.billingStatus !== "trial" && membership.billingStatus !== "active" ? (
          <p className="mx-3 mt-3 rounded-lg border border-warn/40 bg-card px-3 py-2 text-sm text-warn">
            Billing status is {membership.billingStatus}. New contacts, campaigns, and dials are paused until it is active again.
          </p>
        ) : null}
        <main className="console-body">
          <Outlet />
        </main>
        {palette ? <CommandPalette items={[...NAV, ...MORE].filter((item) => !("action" in item) || !item.action || allow(item.action))} onClose={() => setPalette(false)} /> : null}
        {aiOpen ? <ApexPanel orgId={membership.orgId} onClose={() => setAiOpen(false)} /> : null}
        <Handset />
      </div>
    </div>
  );
}

function CommandPalette({
  items,
  onClose,
}: {
  items: ReadonlyArray<{ to: string; label: string; search?: { campaignId: string; contactId: string } }>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const matches = items.filter((item) => item.label.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="fixed inset-0 z-40 grid content-start justify-center bg-black/60 px-4 pt-24" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-line bg-card p-3" onClick={(event) => event.stopPropagation()}>
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Jump to…"
          className="min-h-11 w-full rounded-lg border border-line bg-paper px-3 text-sm"
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
          }}
        />
        <ul className="mt-2 grid">
          {matches.map((item) => (
            <li key={item.to}>
              <Link to={item.to} search={item.search} className="block rounded-md px-2 py-2 text-sm hover:bg-paper" onClick={onClose}>
                {item.label}
              </Link>
            </li>
          ))}
          {matches.length === 0 ? <li className="px-2 py-2 text-sm text-fog">No matching page.</li> : null}
        </ul>
      </div>
    </div>
  );
}

function ApexPanel({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [source, setSource] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <aside className="fixed top-14 right-3 z-40 w-[min(24rem,calc(100vw-1.5rem))] rounded-xl border border-line bg-card p-4 shadow-2xl">
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-[10px] tracking-[0.18em] text-violet uppercase">Apex AI</p>
        <button type="button" className="text-sm text-fog" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="mt-2 text-sm text-fog">Asks about today’s calls in this workspace. It will not invent a number that is not in the records.</p>
      <form
        className="mt-3 grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setPending(true);
          void askApex({ data: { orgId, question } })
            .then((result) => {
              setAnswer(result.answer);
              setSource(result.source === "model" ? "Model, limited to your records." : "From your records. No model key is saved.");
            })
            .catch((error: unknown) => setAnswer(errorText(error)))
            .finally(() => setPending(false));
        }}
      >
        <TextInput value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="How many connects today?" minLength={2} />
        <Button type="submit" disabled={pending || question.trim().length < 2}>
          {pending ? "Looking…" : "Ask"}
        </Button>
      </form>
      {answer ? <p className="mt-3 text-sm">{answer}</p> : null}
      {source ? <p className="mt-1 text-xs text-fog">{source}</p> : null}
    </aside>
  );
}

function PresenceControl({ orgId, onChanged }: { orgId: string; onChanged: () => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-fog">Status</span>
      <select
        className="min-h-11 rounded-lg border border-brass bg-card px-2 text-ink"
        defaultValue="available"
        aria-label="Agent status"
        onChange={(event) => {
          const status = event.target.value as "available" | "wrap_up" | "break" | "offline";
          void setPresence({ data: { orgId, status } })
            .then(() => {
              toast.success(presenceLabel(status));
              onChanged();
            })
            .catch((error: unknown) => toast.error(errorText(error)));
        }}
      >
        <option value="available">Available</option>
        <option value="wrap_up">Wrap-up</option>
        <option value="break">Break</option>
        <option value="offline">Offline</option>
      </select>
    </label>
  );
}

function CreateWorkspace({ onCreated }: { onCreated: () => void }) {
  return (
    <main className="mx-auto grid min-h-screen max-w-lg content-center gap-4 px-4">
      <div>
        <div className="brand-lockup">
          <Mark size={36} />
          <Wordmark height={20} />
        </div>
        <h1 className="mt-1 text-2xl font-semibold">Create your workspace</h1>
        <p className="mt-2 text-sm text-fog">One workspace per account. Calling hours default to weekdays, 09:00–20:00, and can be tightened in settings.</p>
      </div>
      <WorkspaceForm onCreated={onCreated} />
    </main>
  );
}

function WorkspaceForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Chicago");
  const [pending, setPending] = useState(false);
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      await createOrganization({ data: { name, timezone } });
      toast.success("Workspace created");
      onCreated();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="grid gap-3 rounded-xl border border-line bg-card p-4" onSubmit={onSubmit}>
      <Field label="Workspace name">
        <TextInput value={name} onChange={(event) => setName(event.target.value)} required minLength={2} maxLength={80} />
      </Field>
      <Field label="Timezone" hint="IANA zone, for example America/Chicago.">
        <TextInput value={timezone} onChange={(event) => setTimezone(event.target.value)} required />
      </Field>
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create workspace"}
      </Button>
    </form>
  );
}

export function PageTitle({
  title,
  children,
}: {
  title: string;
  lane?: string;
  steps?: ReadonlyArray<{ label: string; state?: "now" | "done"; href?: string }>;
  children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <h1>{title}</h1>
      {children}
    </div>
  );
}
