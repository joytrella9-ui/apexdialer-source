import { useState, type FormEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { GROK_PROVIDERS, authClient, authEnabled, signIn } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { Mark, Wordmark } from "@/components/mark";
import { Button, Field, TextInput } from "@/components/bits";
import { errorText } from "@/lib/dialer/format";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>) => ({
    mode: search.mode === "up" ? ("up" as const) : ("in" as const),
  }),
  component: Login,
});

function explainAuthError(message: string, mode: "in" | "up"): string {
  const text = message.toLowerCase();
  if (text.includes("exist") || text.includes("already")) return "That email already has an account. Use Sign in.";
  if (text.includes("invalid email")) return "Enter a real email address.";
  if (text.includes("password") && (text.includes("short") || text.includes("least") || text.includes("8"))) return "Use at least 8 characters.";
  if (mode === "in" && (text.includes("invalid") || text.includes("credential") || text.includes("incorrect") || text.includes("not found"))) {
    return "Email or password does not match. Check the spelling, or create an account.";
  }
  return message;
}

function Login() {
  const navigate = useNavigate();
  const { mode } = Route.useSearch();
  const { user } = useCurrentUserState();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [caps, setCaps] = useState(false);

  function switchMode(next: "in" | "up") {
    setMessage("");
    void navigate({ to: "/login", search: { mode: next }, replace: true });
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const cleanEmail = email.trim().toLowerCase();
    const cleanName = name.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setMessage("Enter a real email address.");
      return;
    }
    if (password.length < 8) {
      setMessage("Use at least 8 characters.");
      return;
    }
    if (mode === "up" && cleanName.length < 2) {
      setMessage("Enter the name agents will see.");
      return;
    }
    if (mode === "up" && password.toLowerCase() === cleanEmail) {
      setMessage("Do not use your email as the password.");
      return;
    }
    setPending(true);
    setMessage("");
    try {
      if (mode === "up") {
        const created = await authClient.signUp.email({ name: cleanName, email: cleanEmail, password });
        if (created.error) {
          const text = explainAuthError(created.error.message || "Could not create the account.", "up");
          setMessage(text);
          if (text.startsWith("That email already")) switchMode("in");
          return;
        }
      }
      const signed = await authClient.signIn.email({ email: cleanEmail, password });
      if (signed.error) {
        setMessage(explainAuthError(signed.error.message || "Sign-in failed.", "in"));
        return;
      }
      await navigate({ to: "/app/dial", search: { campaignId: "", contactId: "" } });
    } catch (error) {
      setMessage(explainAuthError(errorText(error), mode));
    } finally {
      setPending(false);
    }
  }

  const longEnough = password.length >= 8;
  const notEmail = password.toLowerCase() !== email.trim().toLowerCase();

  return (
    <main className="gate">
      <section className="gate-card">
        <header className="gate-head">
          <Mark size={40} />
          <div>
            <Wordmark height={22} />
            <p className="gate-kicker">Dialer</p>
          </div>
        </header>
        <div className="gate-body">
          {user && !user.isDevFallback ? (
            <div className="grid gap-2">
              <p className="gate-note">Signed in as {user.primaryEmail || user.displayName || "this account"}.</p>
              <Button type="button" variant="ghost" onClick={() => void navigate({ to: "/app/dial", search: { campaignId: "", contactId: "" } })}>
                Continue to the desk
              </Button>
            </div>
          ) : null}
          <div className="gate-tabs" role="tablist">
            <button type="button" className={`gate-tab ${mode === "in" ? "is-on" : ""}`} onClick={() => switchMode("in")}>
              Sign in
            </button>
            <button type="button" className={`gate-tab ${mode === "up" ? "is-on" : ""}`} onClick={() => switchMode("up")}>
              Create account
            </button>
          </div>
          {authEnabled ? (
            <>
              <form className="gate-form" onSubmit={onSubmit}>
                {mode === "up" ? (
                  <Field label="Name">
                    <TextInput value={name} onChange={(event) => setName(event.target.value)} required minLength={2} autoComplete="name" autoFocus />
                  </Field>
                ) : null}
                <Field label="Email">
                  <TextInput
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    autoComplete="email"
                    autoFocus={mode === "in"}
                    spellCheck={false}
                  />
                </Field>
                <Field label="Password" hint={mode === "up" ? "At least 8 characters." : undefined}>
                  <span className="gate-pass">
                    <TextInput
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      onKeyUp={(event) => setCaps(event.getModifierState("CapsLock"))}
                      required
                      minLength={8}
                      autoComplete={mode === "up" ? "new-password" : "current-password"}
                    />
                    <button type="button" className="gate-show" onClick={() => setShowPassword((value) => !value)}>
                      {showPassword ? "Hide" : "Show"}
                    </button>
                  </span>
                </Field>
                {caps ? <p className="gate-note">Caps Lock is on.</p> : null}
                {mode === "up" ? (
                  <ul className="grid gap-1 text-xs text-fog">
                    <li>{longEnough ? "Length is enough." : "Needs 8 characters."}</li>
                    <li>{password.length === 0 || notEmail ? "Not the same as the email." : "Do not reuse the email as the password."}</li>
                  </ul>
                ) : null}
                {message ? (
                  <p className="gate-alert" role="alert">
                    {message}
                  </p>
                ) : null}
                <Button type="submit" disabled={pending}>
                  {pending ? "Working…" : mode === "up" ? "Create account" : "Enter the desk"}
                </Button>
              </form>
              {GROK_PROVIDERS.length > 0 ? (
                <>
                  <p className="gate-split">or</p>
                  <div className="grid gap-2">
                    {GROK_PROVIDERS.map((provider) => (
                      <Button key={provider.providerId} variant="ghost" type="button" disabled={pending} onClick={() => signIn(provider.providerId, { callbackURL: "/app/dial", errorCallbackURL: "/login" })}>
                        Continue with {provider.label}
                      </Button>
                    ))}
                  </div>
                </>
              ) : null}
              <p className="gate-note">Password reset by email is not connected. You can change it in Settings after you are in.</p>
            </>
          ) : (
            <div className="gate-form">
              <p className="gate-note">Sign-in is turned off in this environment.</p>
              <Button type="button" onClick={() => void navigate({ to: "/app/dial", search: { campaignId: "", contactId: "" } })}>
                Open the desk
              </Button>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
