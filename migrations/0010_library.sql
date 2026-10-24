create table if not exists voicemail_clips (
  id text primary key,
  org_id text not null references organizations (id) on delete cascade,
  name text not null,
  audio_url text not null default '',
  script text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists voicemail_clips_org_idx on voicemail_clips (org_id, created_at desc);

alter table campaigns add column if not exists miss_sms boolean not null default false;

alter table messages add column if not exists call_id text not null default '';

create unique index if not exists messages_one_followup_idx
  on messages (org_id, call_id)
  where call_id <> '' and direction = 'outbound';
