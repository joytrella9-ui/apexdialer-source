import { createFileRoute } from "@tanstack/react-router";
import { handleAmd } from "@/server/telephony.server";

export const Route = createFileRoute("/api/telephony/amd")({
  server: {
    handlers: {
      POST: ({ request }) => handleAmd(request),
    },
  },
});
