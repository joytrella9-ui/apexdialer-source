import { createFileRoute, Link } from "@tanstack/react-router";
import { useWorkspace, PageTitle } from "@/components/workspace";
import { Panel } from "@/components/bits";
import { SmsThread } from "@/components/sms-box";

export const Route = createFileRoute("/app/inbox")({ component: InboxPage });

function InboxPage() {
  const { membership } = useWorkspace();
  return (
    <>
      <PageTitle title="Inbox" lane="Work" steps={[{ label: "Thread", href: "#thread" }, { label: "Reply", href: "#reply" }]}>
        <Link to="/app/calls" className="console-chip">Call log</Link>
      </PageTitle>
      <Panel title="Workspace texts" id="thread">
        <p className="mb-3 text-sm text-fog">
          Outbound texts go through the Twilio number saved in Settings. Replies show up after you point the number’s message webhook at the address on that page. Accepted means Twilio took the message, not that the phone received it.
        </p>
        <SmsThread orgId={membership.orgId} showContact />
      </Panel>
    </>
  );
}
