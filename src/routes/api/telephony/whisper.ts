import { createFileRoute } from "@tanstack/react-router";
import { handleWhisper } from "@/server/telephony.server";

export const Route = createFileRoute("/api/telephony/whisper")({
  server: {
    handlers: {
      POST: ({ request }) => handleWhisper(request),
    },
  },
});
