# Booking (Google Calendar + Twilio SMS)

This server can book phone appointments directly into Google Calendar and text confirmations via Twilio.

## Required env vars

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
GOOGLE_REFRESH_TOKEN=
GOOGLE_CALENDAR_ID=primary
BUSINESS_NAME=
DEFAULT_TIMEZONE=America/Phoenix
APPT_DURATION_MINUTES=30
APPT_BUFFER_MINUTES=10
BOOKING_DRY_RUN=false
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
```

## Generate a Google refresh token (one time)

1. Create OAuth credentials in Google Cloud Console and set the redirect URI.
2. Export the env vars above locally.
3. Run:

```
node scripts/google_oauth_token.ts
```

Follow the prompt, then store the printed refresh token in `GOOGLE_REFRESH_TOKEN`.

## How booking works

- The receptionist collects name, reason, day, and time preference.
- The server queries Google Calendar free/busy for the requested day or next 7 days.
- It offers two concrete options and books the chosen one.
- A confirmation SMS is sent via Twilio.

## Local testing with ngrok + Twilio

1. Run the server:

```
cd apps/server
npm install
npm run dev
```

2. Expose it with ngrok:

```
ngrok http 3000
```

3. Set `PUBLIC_BASE_URL` to the HTTPS ngrok URL.
4. Configure Twilio voice webhook to `POST /twilio/voice`.

## Example call flow

1. Caller: “I’d like to book an appointment.”
2. Assistant: asks for name → reason → day → time preference.
3. Assistant: offers two time slots.
4. Caller picks one → calendar event created + SMS sent.
