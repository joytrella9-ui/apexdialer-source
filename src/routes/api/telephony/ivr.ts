import { createFileRoute } from "@tanstack/react-router";
import { handleIvr } from "@/server/telephony.server";

export const Route = createFileRoute("/api/telephony/ivr")({
  server: {
    handlers: {
      POST: ({ request }) => handleIvr(request),
    },
  },
});
