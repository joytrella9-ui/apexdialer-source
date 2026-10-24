import { createFileRoute } from "@tanstack/react-router";
import { handleInboundSms } from "@/server/telephony.server";

export const Route = createFileRoute("/api/telephony/sms")({
  server: {
    handlers: {
      POST: ({ request }) => handleInboundSms(request),
    },
  },
});
