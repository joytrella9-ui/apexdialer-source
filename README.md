# ApexDialer

Outbound calling operations for a single workspace: contacts, campaigns, device dialing, optional Twilio bridging, dispositions, and reports that do not invent a connection rate.

Device dialing opens the number on the agent’s phone and stores the outcome they enter. It is not a carrier-verified call. Live Twilio calls stay off until server credentials and a public URL are set and the account test succeeds.

## Local

```bash
npm install
npm run dev
```

The dev server listens on port 8080. Create an account, then one workspace.

```bash
npx tsc --noEmit
npm test
npm run build
```

See `docs/SETUP.md`, `docs/ENVIRONMENT_VARIABLES.md`, `docs/TESTING.md`, `docs/DEPLOYMENT.md`, and `docs/PRODUCTION_READINESS.md`.

## Calling rules encoded in the product

- Windows must sit inside 08:00–21:00 local, be at least 60 minutes, and must not cross midnight.
- Each dial uses the contact timezone when it is set, otherwise the campaign timezone.
- Do-not-call numbers are rejected before a call row is created.
- Max attempts are 1–6. A skip does not consume an attempt.
- Reported connection rate and provider-verified rate are separate. A zero denominator is “Unavailable”, not 0%.
