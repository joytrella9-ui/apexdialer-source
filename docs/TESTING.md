# Testing

```bash
npx tsc --noEmit
npm test
npm run build
```

`npm test` runs the workspace script tests and `src/lib/dialer/domain.test.ts`. Domain coverage includes phone normalization, calling windows, queue math, metric nulls, CSV issues, role gates, billing gates, Twilio and Stripe signatures, and TwiML escaping.

As of this pass, `tsc --noEmit` succeeds and `npm test` passes with 0 failures: 197 script tests, 35 domain tests, and 59 app tests. An older note about 13 failures expected a blank template titled “Hello World” with sign-in forced off. That is no longer the result.

Browser checks that were run: sign-up, workspace create, contact create, campaign start, and an after-hours dial refusal. Dev and production-preview smoke both rendered the landing page with an empty console.
