# ApexDialer — continue here

Last updated: 21 October 2026. This is the handoff. Edit this file as you go.

## What this is

ApexDialer is a web dialer: leads, campaigns, a phone pad, call from your own phone, texts, WhatsApp, an inbound menu, and reports. It is built. It is not launched.

Score for personal use after you publish and connect Twilio: good enough to call yourself.
Score as a product you can sell: not yet. No live Twilio call has been proven.

## How to open it

There is no public link yet.

- Right now, the app is the preview in this chat.
- To keep it, press **Publish** in this chat.
- Copy the `https://` address the builder shows. Bookmark that. Use that site, not the preview.
- Sign in there. If it asks for a workspace, create one. The preview and the published site do not share data.

Paste the published address here when you have it:

```
Published URL:
```

## Make Twilio stay and work

Do this on the **published** site. Settings saved only in the preview can disappear.

1. In Twilio (console.twilio.com), copy the Account SID (starts with `AC`) and the Auth Token. Buy one voice number. A trial can only call numbers you verify inside Twilio.
2. In Apex, open **Settings**.
3. Save your mobile as the callback number.
4. Under **Telephony**, paste the Account SID, auth token, and Twilio number like `+1876…`.
5. Paste the published address into **Public https address**. No path after the domain.
6. Press **Save connection**. Later saves can leave the token blank. It stays stored and is not shown again.
7. Press **Test Twilio account**. It should name your Twilio account. Then press **Ring my phone**.
8. Copy the inbound voice address and the inbound text address from Settings. In Twilio, on that number, set **A call comes in** to Webhook, POST, and the voice address. Set **A message comes in** to the text address.
9. On **Dialer**, enter your own name and your other phone. Press **Add and call**. Answer your callback phone, then the other phone.

## What already works in the app

- Sign in, sign out, workspace, team.
- Add a lead with name, phone, and address. The lead card shows the name and address.
- Import a CSV with columns `name`, `phone`, `address`. Choose a campaign first if those leads should go on that list.
- Phone pad at the bottom right. Type a number, then **Call**. If the browser line is closed, the button is **Call on this phone** and opens your device.
- **Call from my phone** rings your callback number first, then the lead. Needs Twilio.
- **Text** and **WhatsApp** on the lead card. Texting needs SMS consent on that contact. WhatsApp also needs a Twilio WhatsApp sender under **Settings → Connections**.
- IVR under **Settings → Inbound menu**. Blank labels mean inbound calls skip the menu and ring a free agent.
- Power dial, parallel, and predictive. Predictive is not proven on a live line. An early "machine" signal still rings you so a person is not dropped.
- Contacts, campaigns, inbox, reports, do-not-call, calling hours, daily dial cap (default 500).

## What is not connected

| Piece | State |
| --- | --- |
| Twilio account, number, token | Not connected on the server |
| Published https address | Not set |
| Browser phone | Needs Twilio, then **Create the browser phone** in Settings |
| SMS replies, IVR, recordings | Need the published address and the Twilio webhooks |
| WhatsApp | Off until a sender is saved |
| HubSpot, Salesforce, webhook | Off until saved under Connections |
| Stripe checkout | Not built. A signed webhook can change a plan, but nobody can pay in the app |
| Password-reset email | Not built. Change the password in Settings while signed in |
| Production database | Preview uses a temporary database. Publishing gives the lasting one. Use the published site |

A call-assist key is present on the server. Briefs work without it. The key only rewrites the opener and the note. It cannot dial.

## Everyday use, once the test call works

1. Open the published site and sign in.
2. **Dialer**: name, phone, address, **Add and call**. Or import a list.
3. To work a list: create a campaign, set it active, inside its calling hours, import while that campaign is selected, then start the session.
4. Leave Predictive off until you have tried it on numbers you own.

## If you continue building

Useful files:

- `src/routes/app/dial.tsx` — the dialer, add-and-call, text, WhatsApp
- `src/components/handset.tsx` — the phone pad
- `src/server/calls.ts` — placing calls, rate limits
- `src/server/telephony.server.ts` — Twilio, IVR, inbound
- `src/server/messages.ts` — SMS and WhatsApp
- `src/routes/app/settings.tsx` — Twilio, IVR, connections
- `src/styles.css` — look
- `docs/DEPLOYMENT.md` — deploy notes
- `docs/ENVIRONMENT_VARIABLES.md` — variable names, not values

Checks that were passing on 21 October 2026:

- `npx tsc --noEmit`
- `npm test` — 291 passed, 0 failed
- `npm run build`
- TanStack Start 1.168.60

Do not claim a live call worked unless you heard the phone ring.

## Still worth doing later

1. Publish, connect Twilio, and complete the test call to your own phone.
2. Password-reset email, if other people will use it.
3. Prove predictive on your own numbers before selling it.
4. Two-way CRM only if a buyer needs the contact list kept in sync. Today HubSpot and Salesforce only log a call when the phone number matches.
5. A legal review before calling anyone but yourself.

## Edit log

- 21 Oct 2026 — Created this handoff. Phone pad call button works without Twilio by opening the device. Text and WhatsApp buttons are on the lead card.
