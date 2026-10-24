# Operations runbook

## Health

`GET /api/health` checks the database with `select 1` and reports whether Twilio credentials and `APEX_PUBLIC_URL` are both present. It does not place a call.

## A dial will not start

- Billing status is `past_due` or `canceled`. New dials return a billing error.
- The contact is do-not-call, archived, over the attempt cap, or not yet due.
- The local time is outside the campaign window or on a disallowed day. The dialer shows the reason.
- The agent already has an open call or an undispositioned call.
- Provider mode is selected but Twilio is not ready, the caller ID is not allow-listed, or the agent has no callback number.
- The agent has made 12 attempts in the last minute.

## Twilio shows requested and never moves

- `APEX_PUBLIC_URL` must be the public https origin, not a preview hostname Twilio cannot reach.
- The status callback is `POST /api/telephony/twilio`. A 403 means the signature did not match. Check the auth token and that the URL has no extra path or slash.
- A 200 body of `ignored` means the call SID was not stored yet. A later callback for the stored SID still applies.

## Retention

Settings → Run retention now nulls `recording_url` on calls older than the org’s `retention_days`. Notes stay. The action is audited.

## Invite did not arrive by email

It will not. Copy the link the team page shows. It expires in 7 days and only works for that email address.

## Restore

1. Restore the Postgres backup into a new database.
2. Point `DATABASE_URL` at it.
3. Deploy the same build that produced the data. Do not run a newer destructive migration first.
