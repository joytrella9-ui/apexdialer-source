import type { ErrorComponentProps } from "@tanstack/react-router";
import { Mark, Wordmark } from "@/components/mark";

const FALLBACK_MESSAGE = "An unexpected error occurred. Try reloading the page.";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return FALLBACK_MESSAGE;
}

export function AppErrorComponent({ error }: ErrorComponentProps) {
  return (
    <main className="gate">
      <section className="gate-card">
        <header className="gate-head">
          <Mark size={36} />
          <div>
            <Wordmark height={18} />
            <p className="gate-kicker">Something failed</p>
          </div>
        </header>
        <div className="gate-body">
          <p className="gate-alert">{errorMessage(error)}</p>
          <button type="button" className="gate-tab is-on" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </section>
    </main>
  );
}
