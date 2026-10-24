import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ensureDialContact, startBrowserCall, startManualCall, startPressOneCall, startProviderCall } from "@/server/calls";
import { errorText } from "@/lib/dialer/format";
import { formatPhone } from "@/lib/dialer/phone";
import { useWorkspace } from "./workspace";
import { useSoftphone } from "./softphone";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"] as const;

const LAMP: Record<string, string> = {
  off: "Line dark",
  connecting: "Registering",
  ready: "Line open",
  busy: "On the line",
  error: "Line fault",
};

function screenNumber(digits: string): string {
  if (digits.length === 10) return formatPhone(`+1${digits}`);
  if (digits.length === 11 && digits.startsWith("1")) return formatPhone(`+${digits}`);
  if (digits.length > 6) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length > 3) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return digits;
}

export function Handset() {
  const phone = useSoftphone();
  const { membership, telephony } = useWorkspace();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [scratch, setScratch] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (phone.incomingFrom || phone.status === "busy") setOpen(true);
  }, [phone.incomingFrom, phone.status]);

  function press(key: string) {
    if (phone.status === "busy") {
      phone.sendDigits(key);
      return;
    }
    if (key === "*" || key === "#") return;
    setScratch((current) => (current + key).replace(/\D/g, "").slice(0, 15));
  }

  async function place(kind: "browser" | "press" | "phone" | "device") {
    if (scratch.trim().length < 7) {
      toast.error("Type at least 7 digits, then press Call.");
      return;
    }
    if (kind === "browser" && phone.status !== "ready") {
      toast.error(phone.detail || "The browser line is not open. Use Call on this phone, or finish Twilio in Settings.");
      return;
    }
    setPending(true);
    try {
      const found = await ensureDialContact({ data: { orgId: membership.orgId, phone: scratch, campaignId: null } });
      const payload = { orgId: membership.orgId, contactId: found.contactId, campaignId: null, idempotencyKey: crypto.randomUUID(), burstId: "" };
      if (kind === "browser") {
        phone.arm();
        await startBrowserCall({ data: payload });
        toast.success("Your browser should ring. Answer it and the number you typed is dialed.");
      } else if (kind === "phone") {
        await startProviderCall({ data: payload });
        toast.success("Your phone rings first. Answer it, and the number you typed is dialed.");
      } else if (kind === "device") {
        const result = await startManualCall({ data: payload });
        toast.success("Opening the phone on this device.");
        if (result.tel) window.location.href = result.tel;
      } else {
        await startPressOneCall({ data: payload });
        toast.success("They hear the line. Press 1 and you hear their name, then you are connected. Press 2 marks do-not-call.");
      }
      await client.invalidateQueries({ queryKey: ["open-call", membership.orgId] });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setPending(false);
    }
  }

  const live = phone.status === "ready" || phone.status === "busy";
  const shown = phone.incomingFrom
    ? phone.incomingFrom.startsWith("+")
      ? formatPhone(phone.incomingFrom)
      : phone.incomingFrom
    : screenNumber(scratch);
  const canBrowser = phone.status === "ready";
  const canRing = telephony.credentialsPresent && Boolean(membership.callbackPhone);
  const primary = canBrowser ? "browser" : canRing ? "phone" : "device";
  const primaryLabel = primary === "browser" ? "Call" : primary === "phone" ? "Ring my phone" : "Call on this phone";

  return (
    <aside className={`handset ${open ? "handset-open" : ""}`} aria-label="Browser phone">
      <button type="button" className="handset-bar" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={`handset-lamp ${live ? "is-live" : ""} ${phone.status === "busy" || phone.incomingFrom ? "lamp-live" : ""}`} />
        <span className="handset-bar-copy">
          <span className="handset-kicker">Phone</span>
          <span className="handset-state">{phone.incomingFrom ? `Incoming ${phone.incomingFrom}` : LAMP[phone.status]}</span>
        </span>
        {!open && shown ? <span className="handset-mini">{shown}</span> : null}
        <span className="handset-toggle">{open ? "Close" : "Open"}</span>
      </button>
      {open ? (
        <div className="handset-body">
          <label className="handset-screen">
            <span className="handset-kicker">{phone.incomingFrom ? "Incoming" : "Number"}</span>
            <input
              className="handset-readout"
              inputMode="tel"
              autoComplete="tel"
              aria-label="Phone number"
              placeholder="Type a number"
              value={shown}
              readOnly={Boolean(phone.incomingFrom)}
              onChange={(event) => setScratch(event.target.value.replace(/\D/g, "").slice(0, 15))}
            />
          </label>
          {phone.status === "error" ? <p className="handset-detail">{phone.detail}</p> : null}
          {phone.incomingFrom ? (
            <div className="handset-row">
              <button type="button" className="handset-action is-answer" onClick={phone.acceptIncoming}>
                Answer
              </button>
              <button type="button" className="handset-action is-end" onClick={phone.declineIncoming}>
                Decline
              </button>
            </div>
          ) : (
            <>
              <div className="handset-pad">
                {KEYS.map((key) => (
                  <button key={key} type="button" className="handset-key" onClick={() => press(key)}>
                    {key}
                  </button>
                ))}
              </div>
              <button type="button" className="handset-action is-answer handset-call" disabled={pending} onClick={() => void place(primary)}>
                {primaryLabel}
              </button>
              <div className="handset-row">
                {primary !== "device" ? (
                  <button type="button" className="handset-action" disabled={pending} onClick={() => void place("device")}>
                    This phone
                  </button>
                ) : null}
                <button type="button" className="handset-action" disabled={pending || !telephony.credentialsPresent} onClick={() => void place("press")}>
                  Screen
                </button>
                {primary !== "phone" && canRing ? (
                  <button type="button" className="handset-action" disabled={pending} onClick={() => void place("phone")}>
                    Ring me
                  </button>
                ) : null}
              </div>
              <div className="handset-row">
                <button type="button" className="handset-action" disabled={phone.status !== "busy"} onClick={() => phone.setMuted(!phone.muted)}>
                  {phone.muted ? "Unmute" : "Mute"}
                </button>
                <button type="button" className="handset-action is-end" disabled={phone.status !== "busy"} onClick={phone.hangup}>
                  End
                </button>
              </div>
            </>
          )}
          <div className="handset-row">
            <button type="button" className="handset-action" onClick={() => setScratch((current) => current.slice(0, -1))}>
              Delete
            </button>
            <button type="button" className="handset-action" onClick={() => setScratch("")}>
              Clear
            </button>
            <Link to="/app/settings" className="handset-link">
              Setup
            </Link>
          </div>
        </div>
      ) : null}
    </aside>
  );
}
