import { getSql } from "@/lib/db";
import { isPlanId } from "@/lib/dialer/plans";
import { verifyStripeSignature } from "@/lib/dialer/stripe-sign";
import { newId } from "./actor";

type StripeObject = {
  metadata?: { org_id?: string; plan?: string };
  status?: string;
  mode?: string;
  payment_status?: string;
};

export async function handleStripeWebhook(request: Request): Promise<Response> {
  const orgFromUrl = new URL(request.url).searchParams.get("org");
  const { loadTelephony } = await import("./telephony.server");
  const secret = (await loadTelephony(orgFromUrl)).stripeSecret;
  if (!secret) {
    return Response.json({ error: "Billing webhooks are not configured." }, { status: 503 });
  }
  const raw = await request.text();
  const check = verifyStripeSignature(secret, raw, request.headers.get("stripe-signature"));
  if (!check.ok) return Response.json({ error: check.reason }, { status: 400 });
  let event: { type?: string; data?: { object?: StripeObject } };
  try {
    event = JSON.parse(raw) as { type?: string; data?: { object?: StripeObject } };
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const object = event.data?.object;
  const orgId = object?.metadata?.org_id ?? "";
  const plan = object?.metadata?.plan ?? "";
  if (!orgId) return Response.json({ received: true, applied: false });
  const sql = await getSql();
  const orgs = await sql<{ id: string }>`select id from organizations where id = ${orgId} limit 1`;
  if (!orgs[0]) return Response.json({ received: true, applied: false });
  let billingStatus: string | null = null;
  let nextPlan: string | null = null;
  if (event.type === "checkout.session.completed" && isPlanId(plan)) {
    const paid = object?.payment_status === "paid" || object?.payment_status === "no_payment_required";
    if (paid) {
      billingStatus = "active";
      nextPlan = plan;
    }
  } else if (event.type === "customer.subscription.updated") {
    const status = object?.status ?? "";
    if ((status === "active" || status === "trialing") && isPlanId(plan)) {
      billingStatus = "active";
      nextPlan = plan;
    } else if (status === "past_due" || status === "unpaid") {
      billingStatus = "past_due";
    } else if (status === "canceled" || status === "incomplete_expired") {
      billingStatus = "canceled";
      nextPlan = "trial";
    }
  } else if (event.type === "customer.subscription.deleted") {
    billingStatus = "canceled";
    nextPlan = "trial";
  }
  if (!billingStatus) {
    await sql`
      insert into audit_log (id, org_id, actor_user_id, action, entity_type, entity_id, metadata)
      values (${newId()}, ${orgId}, 'stripe', 'billing.ignored', 'organization', ${orgId}, ${JSON.stringify({ type: event.type ?? "" })}::jsonb)`;
    return Response.json({ received: true, applied: false });
  }
  await sql`
    update organizations
    set billing_status = ${billingStatus},
        plan = coalesce(${nextPlan}, plan),
        updated_at = now()
    where id = ${orgId}`;
  await sql`
    insert into audit_log (id, org_id, actor_user_id, action, entity_type, entity_id, metadata)
    values (${newId()}, ${orgId}, 'stripe', 'billing.updated', 'organization', ${orgId}, ${JSON.stringify({ billingStatus, plan: nextPlan })}::jsonb)`;
  return Response.json({ received: true, applied: true });
}
