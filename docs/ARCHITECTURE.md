# Architecture

ApexDialer is a multi-tenant outbound dialer. One deployment serves many organizations. Every application row is scoped by `org_id`. The signed-in user id comes from the session, never from the client.

## Stack

| Layer | Choice |
| --- | --- |
| UI | React 19, TanStack Router / Start, TanStack Query |
| Styling | Tailwind CSS v4 |
| API | TanStack Start server functions, plus a few raw HTTP routes for webhooks |
| Auth | Better Auth (email/password, Google, X). Sessions are cookies when deployed and a bearer token in the embedded preview |
| Database | Postgres via `DATABASE_URL` (Neon in production). Embedded PGLite when that variable is unset, including the live preview |
| ORM | None. Parameterized SQL through `@/lib/db` |
| Telephony | Twilio Programmable Voice, optional. Device dialing does not call Twilio |
| Billing | Stripe webhooks only. No in-app checkout |

## Request paths

1. The browser calls a server function (`createServerFn`). `authMiddleware` resolves `context.userId`.
2. `requireActor` loads the active membership. Queries include `org_id`.
3. Mutations check role (`can`) and billing status (`trial` or `active`).
4. Dial attempts also check do-not-call, campaign assignment, attempt caps, retry time, and the contact’s calling window.
5. Twilio status callbacks hit `POST /api/telephony/twilio` with a verified signature. TwiML is served at `/api/telephony/twiml` with an HMAC token, not a session cookie.

## Tenancy

`organizations` own contacts, campaigns, calls, follow-ups, notifications, and audit rows. `memberships` join users to one organization in the current product (creating a second org is rejected). Agents see their own calls. Supervisors and above see the workspace.

## What is intentionally not in this architecture

- No predictive dialer, no power dialer, no inbound queue.
- No Redis or separate worker process. Imports run inline and are capped at 2,000 rows / 1.5 MB.
- No email transport. Invites are links. Password reset mail is not sent.
- Device calls are logged by the agent. Only Twilio webhooks set `provider_verified`.
