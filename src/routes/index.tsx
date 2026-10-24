import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const navigate = useNavigate();
  const { user, isPending } = useCurrentUserState();
  useEffect(() => {
    if (isPending) return;
    if (user) {
      void navigate({ to: "/app/dial", search: { campaignId: "", contactId: "" }, replace: true });
      return;
    }
    void navigate({ to: "/login", search: { mode: "in" }, replace: true });
  }, [isPending, navigate, user]);
  return <main className="grid min-h-screen place-items-center text-sm text-fog">Opening the desk…</main>;
}
