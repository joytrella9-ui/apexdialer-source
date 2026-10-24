-- ApexDialer application schema. Identity lives in 0001_auth.sql.
-- App rows are tenant-scoped by org_id. Every server function must resolve
-- membership from the authenticated user id before reading or writing.

create table if not exists organizations (
  id text primary key,
  name text not null,
  timezone text not null default 'America/Chicago',
  plan text not null default 'trial',
  billing_status text not null default 'trial',
  window_start text not null default '09:00',
  window_end text not null default '20:00',
  calling_days smallint[] not null default '{1,2,3,4,5}',
  recording_policy text not null default 'disabled',
  retention_days integer not null default 365,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_plan_chk check (plan in ('trial', 'starter', 'growth')),
  constraint organizations_billing_chk check (billing_status in ('trial', 'active', 'past_due', 'canceled')),
  constraint organizations_recording_chk check (recording_policy in ('disabled', 'provider_if_consented'))
);

create table if not exists memberships (
  id text primary key,
  org_id text not null references organizations (id) on delete cascade,
  user_id text not null references "user" ("id") on delete cascade,
  role text not null,
  status text not null default 'active',
  callback_e164 text not null default '',
  created_at timestamptz not null default now(),
  unique (org_id, user_id),
  constraint memberships_role_chk check (role in ('owner', 'admin', 'supervisor', 'agent')),
  constraint memberships_status_chk check (status in ('active', 'removed'))
);

create index if not exists memberships_user_idx on memberships (user_id, status);

create table if not exists invitations (
  id text primary key,
  org_id text not null references organizations (id) on delete cascade,
  email text not null,
  role text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint invitations_role_chk check (role in ('admin', 'supervisor', 'agent'))
);

create index if not exists invitations_org_idx on invitations (org_id, accepted_at);

create table if not exists contacts (
  id text primary key,
  org_id text not null references organizations (id) on delete cascade,
  first_name text not null,
  last_name text not null default '',
  phone_e164 text not null,
  email text not null default '',
  company text not null default '',
  timezone text not null default '',
  status text not null default 'new',
  dnc boolean not null default false,
  dnc_reason text not null default '',
  recording_consent boolean not null default false,
  consent_note text not null default '',
  tags text[] not null default '{}',
  custom_fields jsonb not null default '{}'::jsonb,
  notes text not null default '',
  created_by text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contacts_status_chk check (status in ('new', 'working', 'qualified', 'closed'))
);

create unique index if not exists contacts_org_phone_active_idx
  on contacts (org_id, phone_e164)
  where archived_at is null;

create index if not exists contacts_org_created_idx
  on contacts (org_id, created_at desc)
  where archived_at is null;

create table if not exists campaigns (
  id text primary key,
  org_id text not null references organizations (id) on delete cascade,
  name text not null,
  description text not null default '',
  status text not null default 'draft',
  dial_mode text not null default 'manual',
  timezone text not null,
  window_start text not null,
  window_end text not null,
  calling_days smallint[] not null,
  max_attempts integer not null default 3,
  retry_minutes integer not null default 120,
  caller_id text not null default '',
  script text not null default '',
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaigns_status_chk check (status in ('draft', 'active', 'paused', 'archived')),
  constraint campaigns_mode_chk check (dial_mode in ('manual', 'provider'))
);

create index if not exists campaigns_org_status_idx on campaigns (org_id, status);

create table if not exists campaign_contacts (
  campaign_id text not null references campaigns (id) on delete cascade,
  contact_id text not null references contacts (id) on delete cascade,
  attempts integer not null default 0,
  last_disposition text not null default '',
  next_attempt_at timestamptz,
  completed boolean not null default false,
  primary key (campaign_id, contact_id)
);

create index if not exists campaign_contacts_queue_idx
  on campaign_contacts (campaign_id, completed, attempts);

create table if not exists campaign_agents (
  campaign_id text not null references campaigns (id) on delete cascade,
  user_id text not null,
  primary key (campaign_id, user_id)
);

create table if not exists calls (
  id text primary key,
  org_id text not null references organizations (id) on delete cascade,
  campaign_id text references campaigns (id) on delete set null,
  contact_id text references contacts (id) on delete set null,
  agent_user_id text not null,
  direction text not null default 'outbound',
  channel text not null,
  state text not null,
  disposition text not null default '',
  notes text not null default '',
  from_number text not null default '',
  to_number text not null,
  provider_call_sid text,
  provider_status text not null default '',
  provider_verified boolean not null default false,
  failure_reason text not null default '',
  idempotency_key text not null,
  started_at timestamptz not null default now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  recording_url text,
  created_at timestamptz not null default now(),
  unique (org_id, idempotency_key),
  constraint calls_channel_chk check (channel in ('manual_device', 'twilio')),
  constraint calls_direction_chk check (direction in ('outbound'))
);

create unique index if not exists calls_provider_sid_idx
  on calls (provider_call_sid)
  where provider_call_sid is not null;

create index if not exists calls_org_started_idx on calls (org_id, started_at desc);
create index if not exists calls_agent_started_idx on calls (org_id, agent_user_id, started_at desc);
create index if not exists calls_open_idx on calls (org_id, agent_user_id, state);

create table if not exists follow_ups (
  id text primary key,
  org_id text not null references organizations (id) on delete cascade,
  contact_id text references contacts (id) on delete cascade,
  call_id text references calls (id) on delete set null,
  assigned_user_id text not null,
  due_at timestamptz not null,
  note text not null default '',
  done_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now()
);

create index if not exists follow_ups_assignee_idx
  on follow_ups (org_id, assigned_user_id, due_at)
  where done_at is null;

create table if not exists agent_presence (
  org_id text not null references organizations (id) on delete cascade,
  user_id text not null,
  status text not null default 'offline',
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id),
  constraint agent_presence_status_chk check (status in ('available', 'on_call', 'wrap_up', 'break', 'offline'))
);

create table if not exists notifications (
  id text primary key,
  org_id text not null references organizations (id) on delete cascade,
  user_id text not null,
  title text not null,
  body text not null default '',
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_idx
  on notifications (org_id, user_id, created_at desc);

create table if not exists audit_log (
  id text primary key,
  org_id text not null references organizations (id) on delete cascade,
  actor_user_id text not null,
  action text not null,
  entity_type text not null,
  entity_id text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_log_org_created_idx on audit_log (org_id, created_at desc);
