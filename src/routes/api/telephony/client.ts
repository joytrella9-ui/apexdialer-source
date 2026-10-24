import { createFileRoute } from "@tanstack/react-router";
import { handleClientVoice } from "@/server/telephony.server";

export const Route = createFileRoute("/api/telephony/client")({
  server: {
    handlers: {
      POST: ({ request }) => handleClientVoice(request),
    },
  },
});
