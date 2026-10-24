# Environment variables

Do not commit real values. The preview injects nothing for telephony. Production should set these in the host, not in a file in the repo.

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Production | Postgres connection string. When unset, the app uses embedded PGLite |
| `VITE_AUTH_ENABLED` | No | Omit it, or set anything other than `false`, to require sign-in |
| `TWILIO_ACCOUNT_SID` | For live calls | Starts with `AC` |
| `TWILIO_AUTH_TOKEN` | For live calls | Used for the API and for webhook signatures. Never sent to the browser |
| `TWILIO_FROM_NUMBER` | For live calls | E.164 caller ID |
| `TWILIO_CALLER_IDS` | No | Extra comma-separated E.164 numbers allowed as caller ID |
| `APEX_PUBLIC_URL` | For live calls | Public `https` origin Twilio can reach. No trailing path |
| `STRIPE_WEBHOOK_SECRET` | For billing updates | Verifies `Stripe-Signature`. Without it the webhook returns 503 |
| `XAI_API_KEY` | No | Optional. Same effect as the assist key saved in Settings. Never sent to the browser |
| `APEX_DAILY_DIAL_CAP` | No | Workspace dial cap per rolling day. Default 500. Maximum 10000. This is a safety stop, not a bill |
| `APEX_DIALING_DISABLED` | No | Set to `true` to refuse every new dial until you remove it |
| `XAI_MODEL` | No | Defaults to `grok-4-1-fast-non-reasoning` |

An admin can also save the Twilio account, caller ID, public https address, and Stripe webhook secret under Settings. Those values stay on the server for that workspace and are never sent back to the browser. Environment variables still apply when the workspace has not saved its own account. `GET /api/health` only reports the environment variables, not a workspace’s saved connection.
