-- Per-workspace telephony and billing secrets. The auth token and Stripe secret
-- are never returned to the browser. Environment variables still override when
-- a workspace has not saved its own values.

create table if not exists org_integrations (
  org_id text primary key references organizations (id) on delete cascade,
  twilio_account_sid text not null default '',
  twilio_auth_token text not null default '',
  twilio_from_e164 text not null default '',
  twilio_caller_ids text not null default '',
  public_url text not null default '',
  stripe_webhook_secret text not null default '',
  updated_at timestamptz not null default now()
);
