alter table calls add column if not exists burst_id text not null default '';

create table if not exists call_transcripts (
  id text primary key,
  org_id text not null references organizations (id) on delete cascade,
  call_id text not null references calls (id) on delete cascade,
  speaker text not null default '',
  body text not null,
  final boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists call_transcripts_call_idx on call_transcripts (call_id, created_at);

create table if not exists call_summaries (
  call_id text primary key references calls (id) on delete cascade,
  org_id text not null references organizations (id) on delete cascade,
  summary text not null,
  points text not null default '',
  source text not null default 'rules',
  created_at timestamptz not null default now()
);
