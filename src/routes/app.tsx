import { createFileRoute } from "@tanstack/react-router";
import { AppFrame } from "@/components/workspace";

export const Route = createFileRoute("/app")({ component: AppFrame });
