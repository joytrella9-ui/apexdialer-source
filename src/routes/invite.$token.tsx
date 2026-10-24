import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { acceptInvite } from "@/server/team";
import { RedirectToSignIn } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Button } from "@/components/bits";
import { errorText } from "@/lib/dialer/format";

export const Route = createFileRoute("/invite/$token")({ component: InvitePage });

function InvitePage() {
  const { token } = Route.useParams();
  const { user, isPending } = useCurrentUserState();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  if (isPending) return <p className="grid min-h-screen place-items-center text-sm text-fog">Checking your session…</p>;
  if (!user) return <RedirectToSignIn />;
  return (
    <main className="mx-auto grid min-h-screen max-w-md content-center gap-4 px-4">
      <h1 className="text-2xl font-semibold">Join a workspace</h1>
      <p className="text-sm text-fog">This invite only works for the email address it was created for. ApexDialer does not email the link — the admin has to share it.</p>
      {message ? <p className="text-sm text-bad">{message}</p> : null}
      <Button
        type="button"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void acceptInvite({ data: { token } })
            .then(async () => {
              await client.invalidateQueries({ queryKey: ["bootstrap"] });
              toast.success("Joined workspace");
              await navigate({ to: "/app/dial", search: { campaignId: "", contactId: "" } });
            })
            .catch((error: unknown) => setMessage(errorText(error)))
            .finally(() => setPending(false));
        }}
      >
        {pending ? "Joining…" : "Accept invite"}
      </Button>
      <Link to="/app" className="text-sm text-fog underline-offset-4 hover:underline">
        Back to workspace
      </Link>
    </main>
  );
}
