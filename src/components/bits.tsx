import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "quiet" }) {
  const look = {
    primary: "bg-teal text-paper-ink hover:bg-teal-deep",
    ghost: "border border-line bg-transparent text-ink hover:bg-paper",
    danger: "bg-bad text-paper-ink",
    quiet: "bg-transparent text-ink hover:bg-line",
  }[variant];
  return (
    <button
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${look} ${className}`}
      {...props}
    />
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint ? <span className="text-xs text-fog">{hint}</span> : null}
    </label>
  );
}

const control = "field-control";

export function TextInput({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${control} ${className}`} {...props} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${control} min-h-24 py-2`} {...props} />;
}

export function SelectInput({ className = "", ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${control} ${className}`} {...props} />;
}

export function Panel({ title, action, children, id }: { title?: string; action?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="panel" id={id}>
      {title ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{title}</h2>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat">
      <p className="text-xs font-medium tracking-wide text-fog uppercase">{label}</p>
      <p className="mt-2 font-mono text-2xl font-semibold">{value}</p>
      {note ? <p className="mt-1 text-xs text-fog">{note}</p> : null}
    </div>
  );
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-fog">{body}</p>
    </div>
  );
}

export function Banner({ tone = "info", children }: { tone?: "info" | "warn" | "bad"; children: ReactNode }) {
  const look = {
    info: "border-line bg-paper text-ink",
    warn: "border-warn/30 bg-paper text-warn",
    bad: "border-bad/30 bg-paper text-bad",
  }[tone];
  return <p className={`rounded-lg border px-3 py-2 text-sm ${look}`}>{children}</p>;
}

export function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "bad" }) {
  const look = {
    neutral: "bg-paper text-ink",
    ok: "bg-ok/10 text-ok",
    warn: "bg-warn/10 text-warn",
    bad: "bg-bad/10 text-bad",
  }[tone];
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${look}`}>{children}</span>;
}
