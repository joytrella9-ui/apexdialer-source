# ApexDialer implementation checklist

Updated after the obsidian console pass.

## Done in this pass
- Design tokens moved to obsidian surfaces, ice-cyan actions, violet for Apex AI. Existing pages pick this up through the shared tokens.
- App shell is a collapsible rail, with Search (Ctrl/Cmd+K) and an Apex AI panel.
- Apex AI answers from today's call records for the signed-in role. A saved xAI key rewrites that answer and is told to ignore instructions inside the question. No key means the record summary only.
- Session console, outcome keys, and the public home page use the same system.
- Manual lookup from the session bar. A number loads only if that contact already exists and is not on the do-not-call list.
- Script check compares notes to lines the campaign marked with *, -, MUST:, or Say:. It does not hear the call.
- The softphone stays closed until a call or an incoming ring.
- A running session waits 12 seconds after each outcome before the next dial. Dial now skips the wait.
- A missing number can be added from the session bar when the role can manage contacts.
- Today’s calls sit under the session bar. The caller ID shown is masked.
- Not now snoozes the current campaign lead for 30 minutes and does not count an attempt.
- A due callback can be opened from the session. The floor links each campaign into that session.
- Sign-in and create-account are one screen. Create an account from the front page opens signup. A saved session skips the form. Password can be changed in Settings. Reset email is still not connected.
- Live transcript lines are stored only when Twilio posts them. That requires recording consent, the recording policy, and the published https address. Summarize uses those lines, or says there were none. A model rewrite happens only when an xAI key is saved.
- Two lines can ring on a browser or phone session. When one person answers, the line that is still ringing is canceled and that lead is snoozed 30 minutes. An answered person is not dropped. This device stays one line.
- Screen speaks the first campaign line, then Press 1 and Press 2. Press 1 whispers the contact's name to the agent before connecting. Press 2 marks do-not-call. If the agent misses it, the contact is told no one is available. This needs the published https address. Twilio reads the sentence. It is not a live AI conversation.
- Settings lists Twilio setup in order, copies each webhook address, and can ring the callback phone as a test.

## Still next
- A live back-and-forth AI voice is not connected. Screen is one spoken sentence and a keypress.
- Do not cache call records in a service worker. The install manifest is the host's `/__grok/manifest.webmanifest`.

## Not claimed
- Answering-machine detection is not connected.
- A model answer is not a verified metric.

