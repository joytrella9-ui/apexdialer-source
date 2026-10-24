# Security audit

This is an engineering review, not a legal opinion and not a penetration test.

## Fixed in the first pass

| Issue | Severity | Fix |
| --- | --- | --- |
| TwiML `xmlEscape` was a no-op | High if a number or prompt ever contained markup | Real entity encoding. Covered by a unit test |
| Invite acceptance did not compile | High for team join | Syntax repaired |
| Agents could see other agents’ recent calls on the overview | Medium | Overview totals, series, and recent rows are scoped unless the role can view reports |
| Duplicate Twilio terminal events could double-count attempts | Medium | Disposition is claimed with `disposition = ''` before the queue moves |
| Retention job erased notes | Medium | Only `recording_url` is cleared |
| Campaign update skipped caller-ID allow-list checks | Medium | Same provider checks as create |

## Fixed in the second pass

| Issue | Severity | Fix |
| --- | --- | --- |
| A missed agent leg (no-answer, busy, failed) was stored as the contact’s outcome and burned a campaign attempt | High | Parent-call status only tracks the agent leg. Contact outcomes come from the Dial action. An agent miss is canceled and does not move the queue |
| TwiML still bridged a canceled, finished, archived, or do-not-call contact | High | The bridge is refused and the open row is canceled |
| An admin could invite another admin, and could demote a peer admin | Medium | Only an owner can grant admin or edit a member at admin rank. Covered by unit tests |
| Creating a contact reported every database error as a duplicate phone | Medium | Only unique violations are translated |
| Reusing a provider dial idempotency key returned another contact’s call | Medium | The existing row must be the same contact |
| Contact history showed every agent’s calls to agents | Medium | Agents see their own rows unless they can view all calls |
| Pending invite emails were readable by anyone who could load the team list | Medium | The roster requires campaign management. Invites require team management |
| CSV export could be a spreadsheet formula | Medium | Cells that start with `=`, `+`, `-`, `@`, or a tab are prefixed |
| “Today” on the overview used the database date, not the workspace timezone | Medium | The window is the workspace’s local calendar day |
| Supervisor correction did not reopen or close the campaign queue, and could not undo a disposition do-not-call | Medium | The queue completed flag follows the corrected outcome. A disposition do-not-call can be cleared; a manual do-not-call is left in place |
| Checkout webhook activated a plan before payment | Medium | `checkout.session.completed` applies only when `payment_status` is `paid` or `no_payment_required` |
| Recording URLs from Twilio were stored without checking the host | Low | Only `https` URLs on a `twilio.com` host are kept |
| A past-due workspace could not run retention | Low | Retention no longer requires an active subscription |
| Two accepts of one invite could race | Low | The invite row is claimed before the membership is inserted |

## Controls that were already in place

- Server functions use `authMiddleware` and `requireActor`. Client-supplied user ids are not trusted.
- Queries filter by `org_id`. Campaign reads for agents also require assignment unless the role can manage campaigns.
- Do-not-call, attempt caps, retry times, and calling windows are enforced before a call row is inserted for a new dial.
- Dial attempts are capped at 12 per agent per minute.
- Idempotency keys stop a repeated dial click from inserting a second call.
- Twilio webhooks check `X-Twilio-Signature` against `APEX_PUBLIC_URL`. TwiML requires an HMAC bound to the call id.
- Stripe webhooks check `Stripe-Signature` with a 5-minute tolerance. Missing secret returns 503.
- Contact export and do-not-call changes require supervisor or admin rank and write an audit row.
- Billing status `past_due` and `canceled` block new mutations with HTTP 402.

## Remaining risks

- No multi-factor authentication.
- No password-reset email. A lost password needs an operator.
- Invite tokens are shown once to the admin. There is no email channel and no rate limit beyond the plan seat cap. Two people accepting different invites at the same moment can still pass the seat count.
- CSV import runs in the request. A 1.5 MB cap limits abuse but does not isolate a slow import from the web process.
- Recording URLs, if Twilio sends them, are stored and not shown in the UI. Anyone with database access can read them. Playback is not implemented.
- Legal calling rules (TCPA, consent, state telemarketing laws) are not fully encoded. The product enforces an 08:00–21:00 window, DNC, and attempt caps. That is not a compliance certification.
- A live Twilio account can still be used for toll fraud up to 12 attempts per agent per minute. There is no daily spend cap.
- Stripe subscription events still trust `metadata.plan` and `metadata.org_id`. Checkout inside the app does not exist yet, so those events only arrive if this deployment’s Stripe account sends them.
- The contact book (names, numbers, notes) is visible to every member of the workspace. Call rows are not.
- The 13 failing tests in `npm test` are template checks that expect a blank app with auth forced off and a placeholder title. They are not authorization tests. Product tests in `src/lib/dialer/domain.test.ts` pass.
