# Implementation plan

## Done

- [x] Audit the existing server, schema, and domain rules
- [x] Fix invite parsing, TwiML escaping, agent-scoped overview, webhook claim, retention, and campaign caller-ID checks
- [x] Add auth, health, Twilio, and Stripe HTTP routes
- [x] Add the signed-in shell: overview, dialer, contacts, campaigns, calls, reports, team, settings, audit, alerts
- [x] Verify sign-up, workspace create, contact create, campaign start, and a blocked after-hours dial in the browser
- [x] Typecheck, production build, and browser smoke on dev and on the built output
- [x] Run domain tests as part of `npm test`
- [x] Second audit pass: agent-leg outcomes, TwiML refusal, role grants, export, overview day boundary, correction queue, checkout payment status

## Not done, and why

- [ ] Live Twilio call. Needs `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, and `APEX_PUBLIC_URL`.
- [ ] Stripe checkout. Webhooks are ready. There is no Checkout session creator and no card form, on purpose.
- [ ] Password reset and invite email. No mail provider is configured.
- [ ] MFA. Not available in the wired auth methods.
- [ ] Inbound, hold, mute, transfer, conference, predictive pacing. Not supported by the current call model. Buttons were not added.
- [ ] Recording playback. URLs are retained and then deleted by the retention job. They are not rendered.
- [ ] A second-user permission test in the browser. Role checks are unit-tested and enforced on the server.

## Next tasks if work resumes

1. Point `APEX_PUBLIC_URL` at the public https origin and run Settings → Test Twilio account.
2. Place one consented test call and confirm the status webhook moves the row to a provider-verified state.
3. Add an email transport before inviting people who are not in the room with the admin.
4. Have counsel review the calling-window and consent copy before a real campaign.
