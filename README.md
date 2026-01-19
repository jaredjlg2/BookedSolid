# BookedSolid Voice Agent

This repo hosts the Express + Twilio + OpenAI Realtime server for inbound receptionist calls, plus a Spanish Daily Coach outbound calling mode.

## Booking (Google Calendar + SMS)

See [apps/server/BOOKING.md](apps/server/BOOKING.md) for setup instructions and required env vars.

## Spanish Daily Coach (Outbound Calling MVP)

### Required env vars

```
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
PUBLIC_BASE_URL=
OPENAI_API_KEY=
COACH_ADMIN_KEY=
DB_PATH=./data/coach.sqlite
```

Notes:
- `PUBLIC_BASE_URL` must be the public HTTPS URL (Render service URL) for Twilio webhooks.
- `TWILIO_FROM_NUMBER` should be your Twilio voice-enabled number in E.164 format.

### Running locally

```
cd apps/server
npm install
npm run dev
```

### Render deploy notes

- Deploy the `apps/server` service.
- Set the env vars above in Render.
- Ensure the service is reachable via HTTPS and set `PUBLIC_BASE_URL` to that URL.
- The scheduler runs in-process (every minute) and will place outbound calls.

### Coach API endpoints

- `POST /coach/signup` — create/update user and opt in.
- `POST /coach/optout` — opt out user.
- `GET /coach/users` — list users (requires `x-coach-admin-key`).
- `POST /coach/run` — manual call trigger (requires `x-coach-admin-key`).

### Twilio webhooks

Configure Twilio voice webhooks to the server:

- Inbound voice: `POST /twilio/voice`
- Outbound coach voice: server calls `POST /twilio/coach/voice` internally.
- Status callback: server calls `POST /twilio/coach/status` internally.
