alter table contacts add column if not exists sms_consent boolean not null default false;

alter table campaigns add column if not exists voicemail_script text not null default '';
alter table campaigns add column if not exists sms_template text not null default '';

create table if not exists messages (
  id text primary key,
  org_id text not null references organizations (id) on delete cascade,
  contact_id text references contacts (id) on delete set null,
  agent_user_id text not null,
  direction text not null,
  body text not null,
  from_number text not null,
  to_number text not null,
  status text not null,
  provider_sid text,
  failure_reason text not null default '',
  created_at timestamptz not null default now(),
  constraint messages_direction_chk check (direction in ('outbound', 'inbound')),
  constraint messages_status_chk check (status in ('accepted', 'failed', 'received'))
);

create index if not exists messages_org_created_idx on messages (org_id, created_at desc);
create index if not exists messages_contact_idx on messages (org_id, contact_id, created_at desc);
create unique index if not exists messages_provider_sid_idx
  on messages (provider_sid)
  where provider_sid is not null and provider_sid <> '';
