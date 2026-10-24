import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listNotifications, markNotificationsRead } from "@/server/team";
import { useWorkspace, PageTitle } from "@/components/workspace";
import { Button, Empty, Panel } from "@/components/bits";
import { formatWhen } from "@/lib/dialer/format";

export const Route = createFileRoute("/app/notifications")({ component: NotificationsPage });

function NotificationsPage() {
  const { membership, reload } = useWorkspace();
  const client = useQueryClient();
  const notes = useQuery({
    queryKey: ["notifications", membership.orgId],
    queryFn: () => listNotifications({ data: { orgId: membership.orgId } }),
  });
  return (
    <>
      <PageTitle title="Alerts" lane="Desk">
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            void markNotificationsRead({ data: { orgId: membership.orgId } }).then(async () => {
              await client.invalidateQueries({ queryKey: ["notifications", membership.orgId] });
              reload();
            });
          }}
        >
          Mark read
        </Button>
      </PageTitle>
      {notes.data && notes.data.notifications.length > 0 ? (
        <Panel>
          <ul className="grid gap-3">
            {notes.data.notifications.map((item) => (
              <li key={item.id} className="border-b border-line pb-3">
                <p className="font-medium">{item.title}</p>
                <p className="text-sm text-fog">{item.body}</p>
                <p className="text-xs text-fog">{formatWhen(item.createdAt)}{item.readAt ? " · read" : " · unread"}</p>
              </li>
            ))}
          </ul>
        </Panel>
      ) : (
        <Empty title="No alerts" body="Campaign assignments and system notices land here. Email delivery is not connected." />
      )}
    </>
  );
}
