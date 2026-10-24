import { createFileRoute } from "@tanstack/react-router";
import { handleStripeWebhook } from "@/server/billing.server";

export const Route = createFileRoute("/api/billing/stripe")({
  server: {
    handlers: {
      POST: ({ request }) => handleStripeWebhook(request),
    },
  },
});
