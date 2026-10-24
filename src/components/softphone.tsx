import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { pulseSoftphone, voiceToken } from "@/server/calls";
import { errorText } from "@/lib/dialer/format";

type SoftphoneValue = {
  status: "off" | "connecting" | "ready" | "busy" | "error";
  detail: string;
  incomingFrom: string;
  acceptIncoming: () => void;
  declineIncoming: () => void;
  connect: (callId: string) => Promise<void>;
  arm: () => void;
  hangup: () => void;
  sendDigits: (digits: string) => void;
  muted: boolean;
  setMuted: (muted: boolean) => void;
};

const SoftphoneContext = createContext<SoftphoneValue | null>(null);

export function useSoftphone(): SoftphoneValue {
  const value = useContext(SoftphoneContext);
  if (!value) {
    return {
      status: "off",
      detail: "",
      incomingFrom: "",
      acceptIncoming: () => undefined,
      declineIncoming: () => undefined,
      connect: async () => undefined,
      arm: () => undefined,
      hangup: () => undefined,
      sendDigits: () => undefined,
      muted: false,
      setMuted: () => undefined,
    };
  }
  return value;
}

type LiveCall = {
  disconnect: () => void;
  mute: (muted: boolean) => void;
  accept: () => void;
  reject: () => void;
  sendDigits: (digits: string) => void;
  parameters: Record<string, string>;
  on: (event: string, handler: () => void) => void;
};

type LiveDevice = {
  connect: (options: { params: Record<string, string> }) => Promise<LiveCall>;
  register: () => Promise<void>;
  updateToken: (token: string) => void;
  disconnectAll: () => void;
  destroy: () => void;
  on: (event: string, handler: (...args: never[]) => void) => void;
};

export function SoftphoneProvider({ orgId, enabled, children }: { orgId: string; enabled: boolean; children: ReactNode }) {
  const [status, setStatus] = useState<SoftphoneValue["status"]>(enabled ? "connecting" : "off");
  const [detail, setDetail] = useState("");
  const [incomingFrom, setIncomingFrom] = useState("");
  const [muted, setMutedState] = useState(false);
  const deviceRef = useRef<LiveDevice | null>(null);
  const callRef = useRef<LiveCall | null>(null);
  const incomingRef = useRef<LiveCall | null>(null);
  const armUntil = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setStatus("off");
      return;
    }
    let cancelled = false;
    let timer = 0;
    const deviceBox: { current: LiveDevice | null } = { current: null };
    async function boot() {
      try {
        const issued = await voiceToken({ data: { orgId } });
        if (cancelled) return;
        const sdk = (await import("@twilio/voice-sdk")) as unknown as { Device: new (token: string) => LiveDevice };
        const device = new sdk.Device(issued.token);
        deviceBox.current = device;
        deviceRef.current = device;
        device.on("registered", () => {
          setStatus("ready");
          setDetail("Browser phone is registered.");
        });
        device.on("error", ((error: { message?: string }) => {
          const message = error?.message || "";
          const blocked = /permission|notallowed|getusermedia|microphone|media/i.test(message);
          setStatus("error");
          setDetail(blocked ? "The microphone is blocked. Allow it for this site. A preview frame sometimes cannot use the mic, and the published app can." : message || "The browser phone hit an error.");
        }) as never);
        device.on("incoming", ((call: LiveCall) => {
          const take = Date.now() < armUntil.current;
          if (take) {
            armUntil.current = 0;
            call.accept();
            callRef.current = call;
            setStatus("busy");
            setDetail("You are on the browser line. The contact is being dialed.");
            call.on("disconnect", () => {
              callRef.current = null;
              setMutedState(false);
              setStatus("ready");
              setDetail("Browser phone is registered.");
            });
            return;
          }
          incomingRef.current = call;
          setIncomingFrom(call.parameters.From || "Unknown caller");
          call.on("cancel", () => {
            incomingRef.current = null;
            setIncomingFrom("");
          });
          call.on("disconnect", () => {
            incomingRef.current = null;
            setIncomingFrom("");
            setStatus("ready");
          });
        }) as never);
        device.on("tokenWillExpire", (async () => {
          const next = await voiceToken({ data: { orgId } });
          device.updateToken(next.token);
        }) as never);
        await device.register();
        await pulseSoftphone({ data: { orgId } });
        timer = window.setInterval(() => {
          void pulseSoftphone({ data: { orgId } }).catch(() => undefined);
        }, 20000);
      } catch (error) {
        if (!cancelled) {
          setStatus("error");
          setDetail(errorText(error));
        }
      }
    }
    void boot();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      deviceBox.current?.destroy();
      deviceRef.current = null;
      callRef.current = null;
    };
  }, [enabled, orgId]);

  const value: SoftphoneValue = {
    status,
    detail,
    incomingFrom,
    acceptIncoming: () => {
      const call = incomingRef.current;
      if (!call) return;
      call.accept();
      callRef.current = call;
      incomingRef.current = null;
      setIncomingFrom("");
      setStatus("busy");
    },
    declineIncoming: () => {
      incomingRef.current?.reject();
      incomingRef.current = null;
      setIncomingFrom("");
    },
    connect: async (callId: string) => {
      const device = deviceRef.current;
      if (!device || status === "off" || status === "error") throw new Error(detail || "The browser phone is not registered.");
      const call = await device.connect({ params: { ApexCallId: callId } });
      callRef.current = call;
      setStatus("busy");
      call.on("disconnect", () => {
        callRef.current = null;
        setMutedState(false);
        setStatus("ready");
      });
    },
    arm: () => {
      armUntil.current = Date.now() + 25000;
    },
    hangup: () => {
      callRef.current?.disconnect();
      deviceRef.current?.disconnectAll();
      callRef.current = null;
      setMutedState(false);
      if (status !== "off" && status !== "error") setStatus("ready");
    },
    sendDigits: (digits: string) => {
      if (!/^[\d*#w]+$/i.test(digits)) return;
      callRef.current?.sendDigits(digits);
    },
    muted,
    setMuted: (next) => {
      callRef.current?.mute(next);
      setMutedState(next);
    },
  };

  return <SoftphoneContext.Provider value={value}>{children}</SoftphoneContext.Provider>;
}
