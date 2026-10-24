import { createFileRoute } from "@tanstack/react-router";
import { handleInboundCall } from "@/server/telephony.server";

export const Route = createFileRoute("/api/telephony/inbound")({
  server: {
    handlers: {
      POST: ({ request }) => handleInboundCall(request),
    },
  },
});
