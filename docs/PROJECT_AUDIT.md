# Project audit

Audited 2026-10-17 against the workspace as it existed before the product shell was added.

## What was already here

- Postgres schema in `migrations/0002_apex.sql`: organizations, memberships, invitations, contacts, campaigns, campaign membership, calls, follow-ups, presence, notifications, audit log.
- Server functions for workspace, contacts, campaigns, calls, reports, team, billing webhooks, and Twilio.
- Domain rules for phones, CSV, calling windows, dispositions, metrics, plans, and webhook signatures, with `src/lib/dialer/domain.test.ts`.
- Auth and database helpers under `src/lib`. Email/password was already enabled. `VITE_AUTH_ENABLED` was not forced off.

## What was missing

- No router, root document, styles, or pages. The product could not be opened.
- No HTTP routes for `/api/auth`, `/api/health`, Twilio, or Stripe. The server functions that handle those webhooks were unreachable.
- `acceptInvite` did not parse (`). [0]`), so joining a workspace could not run.
- `xmlEscape` replaced characters with themselves, so TwiML was not actually escaped.

## What was wrong

- Overview metrics included every agent’s calls for agents who should only see their own.
- A repeated Twilio terminal webhook could advance a campaign queue twice.
- Retention cleared call notes as well as recording URLs.
- Updating a campaign did not re-check the Twilio caller-ID allow list.
- Updating a contact did not translate a duplicate-phone error.
- Contact and campaign detail routes were nested under parents that did not render an outlet, so those URLs showed the list.

## What this pass changed

The shell, pages, and webhook routes were added on top of the existing server functions. The defects above were fixed. Device dialing, windows, and empty metrics were exercised in the browser. Twilio was not called, because no credentials are configured.

## What was left alone

- Auth library files under `src/lib/auth`, except none of them were edited.
- The schema. No new migration was required.
- Predictive dialing, inbound, conferencing, and in-app card checkout. Those are not in the current provider model and were not faked.

## Second pass

Reviewed again after the shell was in place. Findings and fixes are in the security audit’s second-pass table. Domain tests cover the parent-leg versus contact-leg status split, role grant rules, spreadsheet-formula export, recording URL allow-listing, and supervisor queue corrections.

Not retested against a live Twilio account or a live Stripe account. Those still need credentials.
