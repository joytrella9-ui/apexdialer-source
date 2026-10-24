-- Optional model key for call briefs and note drafts. Never returned to the browser.
alter table org_integrations add column if not exists xai_api_key text not null default '';
