# Production readiness

**Not ready for unsupervised live calling.** Ready to configure Twilio on a published `https` site and place a controlled test call to your own phone.

## Evidence from this pass

- `npx tsc --noEmit` passed after the safety changes.
- `npm test` passed: 197 script tests, 35 domain tests, 59 app tests, 0 failed. The older “13 failed / Hello World” result is no longer current.
- No live Twilio call was placed. Machine detection, inbound IVR, SMS, and CRM logging are implemented and unproven against a carrier.
- `GET /api/health` reports `database` as `pglite` or `neon` and `telephony` as `configured` or `not_configured`. It does not prove a call works.

## What is enforced on the server

- Sign-in is required. Workspace ids from the browser are checked against the session.
- Do-not-call, calling windows, attempt caps, and consent are checked before a dial.
- A user cannot start more than 24 dials in a minute.
- A workspace cannot start more than `APEX_DAILY_DIAL_CAP` dials in a rolling day (default 500).
- `APEX_DIALING_DISABLED=true` refuses new dials.
- Twilio webhooks reject a bad signature.
- Predictive mode does not hang up on Twilio’s early `machine_start` result. Only `machine_end_beep`, `machine_end_silence`, `machine_end_other`, and `fax` skip the agent. This has not been proven on a live account.

## Launch blockers

- Twilio credentials, a public `https` address, and a controlled test call are still required.
- Production should set `DATABASE_URL` to persistent Postgres. With it unset, the app uses embedded PGLite, which is the preview database and is not a backup.
- Stripe checkout is not implemented. A signed webhook can change the plan. Nobody can pay inside the app.
- No email transport. Invites are links. Password reset email is not implemented.
- No legal review of outbound calling.

## Not claimed

No load test. No claim that a disposition from device dial was verified by a carrier. No claim that HubSpot, Salesforce, WhatsApp, or answering-machine detection succeeded against a live account.
