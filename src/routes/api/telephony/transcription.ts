import { createFileRoute } from "@tanstack/react-router";
import { handleTranscription } from "@/server/telephony.server";

export const Route = createFileRoute("/api/telephony/transcription")({
  server: {
    handlers: {
      POST: ({ request }) => handleTranscription(request),
    },
  },
});
