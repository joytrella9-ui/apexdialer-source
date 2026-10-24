alter table org_integrations add column if not exists twilio_api_key_sid text not null default '';
alter table org_integrations add column if not exists twilio_api_key_secret text not null default '';
alter table org_integrations add column if not exists twilio_twiml_app_sid text not null default '';

alter table agent_presence add column if not exists softphone_until timestamptz;
