# Feature inventory

Status key: **Verified** (exercised in this workspace), **Implemented** (code reviewed, not live against a carrier), **Partial**, **Missing**, **Blocked**, **Broken** (fixed items are listed in the audit).

| Feature | Status | Notes |
| --- | --- | --- |
| Email/password sign-up and sign-in | Verified | Account created and session opened in the preview |
| Google and X sign-in | Implemented | Broker buttons are wired. Not exercised here |
| Password reset email | Missing | No mail transport. The login screen says so |
| MFA | Missing | Not supported by the current auth package configuration |
| Workspace create | Verified | Owner membership and presence row |
| Role permissions | Implemented | Enforced in server functions. Unit-tested in `permissions.ts` |
| Invite link, accept, revoke | Implemented | Link is returned to the admin. No email is sent. Accept requires the invited email |
| Contacts CRUD, search, archive | Verified | Create and list confirmed in the browser |
| CSV preview and import | Implemented | Parser unit-tested. Commit path is server-side with duplicate skip |
| CSV export | Implemented | Supervisors and above, 5,000 row cap, audited |
| Do-not-call | Implemented | Admin action and `do_not_call` disposition. Dial is rejected server-side |
| Campaign draft, start, pause, archive | Verified | Start refused until a callable contact exists; start succeeded after one was added |
| Calling windows and timezone | Verified | Dial button disabled at 23:28 America/Chicago against a 09:00–17:00 window |
| Attempt caps and retry delay | Implemented | `nextQueueState` unit-tested. Max attempts 1–6, retry at least 30 minutes |
| Device click-to-call | Implemented | Opens `tel:`. Does not claim a carrier connection |
| Twilio agent-first bridge | Implemented | The call to the agent is not a contact attempt. Contact results come from the Dial action. Blocked until Twilio credentials and a public https origin are set |
| Hold, mute, transfer, conference | Missing | Not offered. The provider path is a single Dial |
| Inbound voice and IVR | Implemented | `POST /api/telephony/inbound` and `/api/telephony/ivr`. Signature checked. Menu is in Settings. Not proven on a live call |
| Predictive and parallel dialing | Implemented | Dials more than one number. A finished machine or fax does not ring the agent. An early machine signal still rings the agent. Not proven on a live Twilio account |
| SMS | Implemented | Consent and STOP are enforced. Delivery needs the published message webhook |
| Dispositions, notes, follow-ups | Implemented | UI is on the dial screen. Not completed in-browser because the window blocked the dial |
| Call history and supervisor correction | Implemented | Agents are scoped to their own rows, including on a contact. A correction updates the queue without adding an attempt |
| Reports | Implemented | Attempt, reported connect, verified connect. Empty denominators stay “Unavailable” |
| Overview dashboard | Verified | Zeros and Unavailable, not invented rates |
| Team management | Implemented | Seat limits by plan |
| Audit log | Implemented | Sensitive mutations write a row |
| In-app alerts | Implemented | No email or push |
| Org settings, retention of recording URLs | Implemented | Notes are not wiped |
| Stripe subscription webhook | Implemented | Signature-checked. No checkout UI and no card is charged |
| Health endpoint | Verified | `GET /api/health` returned database and telephony status |
| Live listen / barge / recording playback UI | Missing | Recording URLs are stored, not rendered |
| Background job queue | Missing | Imports are synchronous and capped |
