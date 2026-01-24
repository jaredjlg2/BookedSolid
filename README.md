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

Use the `render.yaml` at the repo root for a one-click deploy, or follow the manual steps below.

#### Option A: Blueprint (recommended)

1. Push this repo to GitHub/GitLab.
2. In Render, choose **New** → **Blueprint** and select the repo.
3. Render will read `render.yaml` and create the `bookedsolid-server` service.
4. Add the required environment variables in the Render dashboard (see list below).
5. Set Twilio webhooks to the Render HTTPS URL (see webhook section below).
6. Deploy; the scheduler runs in-process (every minute) and will place outbound calls.

#### Option B: Manual setup

1. In Render, create a **Web Service**.
2. Connect the repo and set the **Root Directory** to `apps/server`.
3. Use the following settings:
   - **Build command:** `npm install && npm run build`
   - **Start command:** `npm run start`
   - **Health check path:** `/health`
4. Add a **Disk** (e.g., 1 GB) mounted at `/data` for the SQLite DB.
5. Add the required environment variables (see list below).
6. Deploy and copy the service URL for Twilio webhooks.

#### Required environment variables

Core (coach):

```
OPENAI_API_KEY=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
COACH_ADMIN_KEY=
DB_PATH=/data/coach.sqlite
```

Booking (Google Calendar + SMS, if used):

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
```

> **Note:** `PUBLIC_BASE_URL` is automatically set from Render's `RENDER_EXTERNAL_URL` if you don't provide it. You can still override it explicitly if needed.

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
