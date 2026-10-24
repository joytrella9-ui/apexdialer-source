# Setup

1. Install dependencies with `npm install`.
2. Apply schema. With `DATABASE_URL` set, `npm run db:migrate` runs `migrations/0001_auth.sql` and `migrations/0002_apex.sql`. Without it, the app applies those files to PGLite on startup.
3. Start the app with `npm run dev`. It listens on port 8080.
4. Open the site, create an account, and create one workspace.
5. Add a contact, put them on a manual campaign, and start the campaign during the calling window.

Live Twilio calls also need the variables in `ENVIRONMENT_VARIABLES.md`. Until Test connection succeeds, use device dialing. The app will not pretend a carrier call was placed.
