alter table org_integrations add column if not exists ivr_greeting text not null default '';
alter table org_integrations add column if not exists ivr_options text not null default '[]';
