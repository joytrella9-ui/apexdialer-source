import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { listMessages, sendSms } from "@/server/messages";
import { getAdapters } from "@/server/adapters";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { fillSmsTemplate, SMS_TEMPLATES } from "@/lib/dialer/sms";
import { errorText, formatWhen } from "@/lib/dialer/format";
import { Banner, Button, TextArea } from "./bits";

const STATUS: Record<string, string> = {
  accepted: "Accepted by Twilio",
  failed: "Not sent",
  received: "Reply",
};

export function SmsThread({
  orgId,
  contactId = "",
  firstName = "",
  company = "",
  smsConsent = false,
  dnc = false,
  showContact = false,
  extraTemplates = [],
}: {
  orgId: string;
  contactId?: string;
  firstName?: string;
  company?: string;
  smsConsent?: boolean;
  dnc?: boolean;
  showContact?: boolean;
  extraTemplates?: { id: string; name: string; body: string }[];
}) {
  const client = useQueryClient();
  const { user } = useCurrentUserState();
  const agentName = user?.displayName ?? "";
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const adapters = useQuery({
    queryKey: ["adapters", orgId],
    queryFn: () => getAdapters({ data: { orgId } }),
  });
  const thread = useQuery({
    queryKey: ["messages", orgId, contactId],
    queryFn: () => listMessages({ data: { orgId, contactId } }),
  });
  const preview = body.trim()
    ? fillSmsTemplate(body, { firstName, company, agent: agentName })
    : "";
  const blocked = Boolean(contactId) && (!smsConsent || dnc);
  return (
    <div className="grid gap-3">
      {contactId && !smsConsent ? (
        <Banner>Texting stays off until SMS consent is saved on this contact. A phone call is not permission to text.</Banner>
      ) : null}
      {contactId && dnc ? <Banner tone="bad">Do-not-call blocks texts as well as calls.</Banner> : null}
      {contactId ? (
        <form
          id="reply"
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!body.trim() || blocked) return;
            setPending(true);
            void sendSms({ data: { orgId, contactId, body } })
              .then(() => {
                toast.success("Twilio accepted the text. That is not a delivery receipt.");
                setBody("");
              })
              .catch((error: unknown) => toast.error(errorText(error)))
              .finally(() => {
                setPending(false);
                void client.invalidateQueries({ queryKey: ["messages", orgId] });
              });
          }}
        >
          <div className="flex flex-wrap gap-2">
            {extraTemplates.map((template) => (
              <Button key={template.id} type="button" variant="ghost" onClick={() => setBody(template.body)}>
                {template.name}
              </Button>
            ))}
            {SMS_TEMPLATES.map((template) => (
              <Button key={template.id} type="button" variant="ghost" onClick={() => setBody(template.body)}>
                {template.name}
              </Button>
            ))}
          </div>
          <TextArea value={body} maxLength={320} placeholder="Hi {{first_name}}…" onChange={(event) => setBody(event.target.value)} />
          {preview && preview !== body.trim() ? <p className="text-sm text-fog">Sends as: {preview}</p> : null}
          <Button type="submit" disabled={pending || !body.trim() || blocked}>
            Send text
          </Button>
          {adapters.data?.whatsapp ? (
            <Button
              type="button"
              variant="ghost"
              disabled={pending || !body.trim() || blocked}
              onClick={() => {
                if (!body.trim() || blocked) return;
                setPending(true);
                void sendSms({ data: { orgId, contactId, body, channel: "whatsapp" } })
                  .then(() => {
                    toast.success("Twilio accepted the WhatsApp message.");
                    setBody("");
                  })
                  .catch((error: unknown) => toast.error(errorText(error)))
                  .finally(() => {
                    setPending(false);
                    void client.invalidateQueries({ queryKey: ["messages", orgId] });
                  });
              }}
            >
              Send on WhatsApp
            </Button>
          ) : null}
        </form>
      ) : (
        <p className="text-sm text-fog">Open a contact to send a text.</p>
      )}
      {thread.isError ? <Banner tone="bad">{errorText(thread.error)}</Banner> : null}
      <ul className="grid gap-2 text-sm">
        {(thread.data?.messages ?? []).map((message) => (
          <li key={message.id} className="rounded-lg border border-line px-3 py-2">
            <p className="flex flex-wrap justify-between gap-2 text-xs text-fog">
              <span>
                {message.direction === "inbound" ? "In" : "Out"}
                {showContact && message.contactId ? (
                  <>
                    {" · "}
                    <Link to="/app/contacts/$contactId" params={{ contactId: message.contactId }} className="underline">
                      {message.contactName || message.fromDisplay}
                    </Link>
                  </>
                ) : null}
              </span>
              <span>{STATUS[message.status] ?? message.status} · {formatWhen(message.createdAt)}</span>
            </p>
            <p className="mt-1">{message.body}</p>
            {message.failureReason ? <p className="mt-1 text-xs text-bad">{message.failureReason}</p> : null}
          </li>
        ))}
        {thread.data && thread.data.messages.length === 0 ? <li className="text-fog">No texts yet.</li> : null}
      </ul>
    </div>
  );
}
