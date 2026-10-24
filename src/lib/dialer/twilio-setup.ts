export type SetupCheck = { id: string; ok: boolean; label: string; detail: string };

export function twilioSetupChecks(input: {
  accountSid: string;
  authTokenPresent: boolean;
  from: string;
  callerIds: string[];
  publicUrl: string;
  callbackPhone: string;
}): SetupCheck[] {
  const sidOk = /^AC[0-9a-f]{32}$/i.test(input.accountSid);
  const fromOk = input.callerIds.includes(input.from) && /^\+[1-9]\d{7,14}$/.test(input.from);
  const urlOk = input.publicUrl.startsWith("https://") && !input.publicUrl.includes("localhost");
  const callbackOk = /^\+[1-9]\d{7,14}$/.test(input.callbackPhone);
  return [
    {
      id: "sid",
      ok: sidOk,
      label: "Account SID",
      detail: sidOk ? "SID format is valid." : "Save an Account SID that starts with AC and has 32 hex characters.",
    },
    {
      id: "token",
      ok: input.authTokenPresent,
      label: "Auth token",
      detail: input.authTokenPresent ? "A token is stored on the server." : "Save the auth token in Settings. It is not shown again.",
    },
    {
      id: "from",
      ok: fromOk,
      label: "Caller ID",
      detail: fromOk ? `${input.from} is on the allow list.` : "Save the Twilio number in E.164. It must be on the allow list.",
    },
    {
      id: "url",
      ok: urlOk,
      label: "Public https address",
      detail: urlOk
        ? input.publicUrl
        : "Needed for inbound calls and recordings. Outbound calls still place without it.",
    },
    {
      id: "callback",
      ok: callbackOk,
      label: "Your callback number",
      detail: callbackOk ? "Twilio can ring you first." : "Save the phone Twilio should ring before it dials the contact.",
    },
  ];
}
