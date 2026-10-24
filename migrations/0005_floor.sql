alter table campaigns add column if not exists local_presence boolean not null default false;

alter table calls drop constraint if exists calls_direction_chk;
alter table calls add constraint calls_direction_chk check (direction in ('outbound', 'inbound'));
