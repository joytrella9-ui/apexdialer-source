alter table org_integrations add column if not exists adapter_config text not null default '{}';
