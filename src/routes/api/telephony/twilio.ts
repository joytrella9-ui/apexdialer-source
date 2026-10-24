import { createFileRoute } from "@tanstack/react-router";
import { handleTwilioWebhook } from "@/server/telephony.server";

export const Route = createFileRoute("/api/telephony/twilio")({
  server: {
    handlers: {
      POST: ({ request }) => handleTwilioWebhook(request),
    },
  },
});
