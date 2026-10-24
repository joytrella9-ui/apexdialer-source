import { createFileRoute } from "@tanstack/react-router";
import { handlePressOne } from "@/server/telephony.server";

export const Route = createFileRoute("/api/telephony/press")({
  server: {
    handlers: {
      POST: ({ request }) => handlePressOne(request),
    },
  },
});
