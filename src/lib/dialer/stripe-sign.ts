import { createHmac, timingSafeEqual } from "node:crypto";

export type StripeCheck =
  | { ok: true; timestamp: number }
  | { ok: false; reason: string };

/** Stripe-Signature: t=unix,v1=hex[,v1=hex] over `${t}.${rawBody}`. Tolerance 5 minutes. */
export function verifyStripeSignature(
  secret: string,
  rawBody: string,
  header: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): StripeCheck {
  if (!secret) return { ok: false, reason: "Billing webhook secret is not configured." };
  if (!header) return { ok: false, reason: "Missing Stripe-Signature header." };
  const parts = Object.fromEntries(
    header.split(",").map((piece) => {
      const eq = piece.indexOf("=");
      return [piece.slice(0, eq), piece.slice(eq + 1)];
    }),
  );
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: "Signature timestamp is invalid." };
  if (Math.abs(nowSeconds - timestamp) > 300) return { ok: false, reason: "Signature timestamp is outside the tolerance window." };
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  const signatures = header
    .split(",")
    .filter((piece) => piece.startsWith("v1="))
    .map((piece) => piece.slice(3));
  const expBuf = Buffer.from(expected);
  const match = signatures.some((sig) => {
    const got = Buffer.from(sig);
    return got.length === expBuf.length && timingSafeEqual(expBuf, got);
  });
  if (!match) return { ok: false, reason: "Signature does not match." };
  return { ok: true, timestamp };
}
