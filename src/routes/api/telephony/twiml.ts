import { createFileRoute } from "@tanstack/react-router";
import { handleTwiml } from "@/server/telephony.server";

export const Route = createFileRoute("/api/telephony/twiml")({
  server: {
    handlers: {
      GET: ({ request }) => handleTwiml(request),
      POST: ({ request }) => handleTwiml(request),
    },
  },
});
