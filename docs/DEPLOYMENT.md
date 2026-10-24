# Deployment

The app builds to a Vercel/Nitro output with `npm run build`.

## Safe sequence

1. Set `DATABASE_URL` to a new or migrated Postgres database. Do not point a first deploy at a database you cannot restore.
2. Run `npm run db:migrate` against that database. The migration files are additive (`create table if not exists`). They do not drop data.
3. Set the Twilio and Stripe variables only when those accounts exist. Leave them unset to ship device dialing only.
4. Set `APEX_PUBLIC_URL` to the exact public origin Twilio will call.
5. Deploy the build. Confirm `GET /api/health` returns `status: ok` and `telephony` is either `configured` or `not_configured`, matching what you intended.
6. Sign in, create a workspace, and place a device-dial test during the window. Do not start a provider campaign until Settings → Test Twilio account returns the account name.

## Connect Twilio

1. In Twilio, create an account, buy a voice-capable number, and copy the Account SID and auth token from the console home page.
2. Publish this app to a public `https` address. Twilio must be able to reach `/api/telephony/twilio` and `/api/telephony/twiml` on that origin. A private preview cannot receive those callbacks.
3. In ApexDialer Settings, save the Account SID, auth token, the Twilio number in E.164, and that public address with no path.
4. Save your own callback number. Twilio calls that phone first, then the contact.
5. On the campaign, choose provider dialing and the same caller ID. Start the campaign only after Test Twilio account returns the account name.
6. A trial Twilio account can only call verified numbers. Enable the countries you will dial. Recording plays in Calls only when the contact has recording consent and the workspace recording policy allows it.

Stripe billing is a webhook, not a checkout form. After the public address is saved, give Stripe the billing address shown in Settings, and save the webhook secret there. The event needs metadata `org_id` and `plan`.

Call assist works without an xAI key. To let Grok rewrite openers and notes, create a key at the xAI console and save it under Settings → Call assist. Set `XAI_MODEL` only if you do not want the default fast model.

## Rollback

Redeploy the previous build. Schema changes in this repo have not dropped columns. If a future migration is destructive, restore the database backup taken before it ran. There is no automated backup in this repository. Take one in the database host before the first production migration.

## PGLite note

`npm run build` copies `pglite.data`, `pglite.wasm`, and `initdb.wasm` into the server bundle so a preview without `DATABASE_URL` can boot. Production should still use `DATABASE_URL`. PGLite is not a multi-instance database.
