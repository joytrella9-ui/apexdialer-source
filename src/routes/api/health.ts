import { createFileRoute } from "@tanstack/react-router";
import { healthPayload } from "@/server/workspace";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: async () => {
        try {
          return Response.json(await healthPayload());
        } catch {
          return Response.json({ status: "error", database: "unavailable" }, { status: 503 });
        }
      },
    },
  },
});
