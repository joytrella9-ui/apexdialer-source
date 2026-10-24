import { createFileRoute } from "@tanstack/react-router";
import { handleScreenDone } from "@/server/telephony.server";

export const Route = createFileRoute("/api/telephony/screen")({
  server: {
    handlers: {
      POST: ({ request }) => handleScreenDone(request),
    },
  },
});
