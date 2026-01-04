import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import {
  listUsers,
  setUserInactive,
  upsertUser,
  createCallLog,
  updateLastCalled,
} from "../services/coachDb";
import { runCoachCallsNow } from "../services/coachScheduler";
import { placeCoachCall } from "../services/coachTwilio";

export const coachRouter = Router();

const phoneSchema = z.string().regex(/^\+\d{10,15}$/);

const signupSchema = z.object({
  phone: phoneSchema,
  name: z.string().optional(),
  preferredCallTime: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().default("America/Phoenix"),
  duolingoUnit: z.string().optional(),
});

function requireAdminKey(req: any, res: any, next: any) {
  if (!env.COACH_ADMIN_KEY) {
    return res.status(500).json({ error: "COACH_ADMIN_KEY is not set" });
  }

  const key = req.headers["x-coach-admin-key"] ?? req.query.adminKey;
  if (typeof key !== "string" || key !== env.COACH_ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}

coachRouter.post("/coach/signup", (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }

  const [hour, minute] = parsed.data.preferredCallTime.split(":").map(Number);

  if (Number.isNaN(hour) || Number.isNaN(minute) || hour > 23 || minute > 59) {
    return res.status(400).json({ error: "Invalid preferredCallTime" });
  }

  const user = upsertUser({
    phone_e164: parsed.data.phone,
    name: parsed.data.name,
    timezone: parsed.data.timezone,
    preferred_call_hour_local: hour,
    preferred_call_minute_local: minute,
    duolingo_unit: parsed.data.duolingoUnit,
  });

  return res.json(user);
});

coachRouter.post("/coach/call-now", async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }

  const twilioConfigured = Boolean(
    env.TWILIO_ACCOUNT_SID &&
      env.TWILIO_AUTH_TOKEN &&
      env.PUBLIC_BASE_URL &&
      (env.TWILIO_FROM_NUMBER ?? env.TWILIO_PHONE_NUMBER)
  );

  if (!twilioConfigured) {
    return res.status(503).json({
      error: "Twilio is not configured",
      missing: {
        TWILIO_ACCOUNT_SID: !env.TWILIO_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN: !env.TWILIO_AUTH_TOKEN,
        PUBLIC_BASE_URL: !env.PUBLIC_BASE_URL,
        TWILIO_FROM_NUMBER: !(env.TWILIO_FROM_NUMBER ?? env.TWILIO_PHONE_NUMBER),
      },
    });
  }

  const [hour, minute] = parsed.data.preferredCallTime.split(":").map(Number);

  if (Number.isNaN(hour) || Number.isNaN(minute) || hour > 23 || minute > 59) {
    return res.status(400).json({ error: "Invalid preferredCallTime" });
  }

  const user = upsertUser({
    phone_e164: parsed.data.phone,
    name: parsed.data.name,
    timezone: parsed.data.timezone,
    preferred_call_hour_local: hour,
    preferred_call_minute_local: minute,
    duolingo_unit: parsed.data.duolingoUnit,
  });

  try {
    const call = await placeCoachCall(user);
    createCallLog({ user_id: user.id, call_sid: call.sid, outcome: "initiated" });
    updateLastCalled(user.id);
    return res.json({ ok: true, callSid: call.sid });
  } catch (error) {
    console.error("Failed to place call now", error);
    return res.status(500).json({ error: "Failed to place call" });
  }
});

coachRouter.get("/coach/signup", (_req, res) => {
  const twilioConfigured = Boolean(
    env.TWILIO_ACCOUNT_SID &&
      env.TWILIO_AUTH_TOKEN &&
      env.PUBLIC_BASE_URL &&
      (env.TWILIO_FROM_NUMBER ?? env.TWILIO_PHONE_NUMBER)
  );
  const callNowNotice = twilioConfigured
    ? ""
    : `<div class="callout warning">
        “Call me now” is disabled until Twilio is configured. Set
        <code>TWILIO_ACCOUNT_SID</code>, <code>TWILIO_AUTH_TOKEN</code>,
        <code>TWILIO_FROM_NUMBER</code>, and <code>PUBLIC_BASE_URL</code>.
      </div>`;
  return res
    .type("html")
    .send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Spanish Coach Signup</title>
    <style>
      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 32px;
        color: #111827;
        background: #f9fafb;
      }
      main {
        max-width: 520px;
        margin: 0 auto;
        background: #fff;
        border-radius: 12px;
        padding: 24px;
        box-shadow: 0 10px 20px rgba(15, 23, 42, 0.08);
      }
      h1 {
        font-size: 24px;
        margin-bottom: 8px;
      }
      p {
        color: #4b5563;
        margin-bottom: 24px;
      }
      label {
        display: block;
        font-weight: 600;
        margin-bottom: 6px;
      }
      input {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        margin-bottom: 16px;
        font-size: 14px;
      }
      button {
        width: 100%;
        border: none;
        border-radius: 8px;
        padding: 12px;
        background: #2563eb;
        color: white;
        font-weight: 600;
        cursor: pointer;
      }
      button.secondary {
        background: #111827;
      }
      button:hover {
        background: #1d4ed8;
      }
      button.secondary:hover {
        background: #0f172a;
      }
      small {
        display: block;
        margin-top: 8px;
        color: #6b7280;
      }
      .callout {
        background: #eff6ff;
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 16px;
        color: #1e3a8a;
        font-size: 14px;
      }
      .callout.warning {
        background: #fef3c7;
        color: #92400e;
      }
      .button-row {
        display: grid;
        gap: 10px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Spanish Coach Signup</h1>
      <p>Fill this out to opt into the daily coach call. Times are local to your timezone.</p>
      <div class="callout">
        Incoming calls to the main Twilio number go to the receptionist. To reach the Spanish coach,
        use “Call me now” (the coach will call you) or point a second Twilio number at
        <code>/twilio/coach/voice</code>.
      </div>
      ${callNowNotice}
      <form method="post" action="/coach/signup">
        <label for="phone">Phone (E.164)</label>
        <input id="phone" name="phone" placeholder="+15555550123" required />

        <label for="name">Name (optional)</label>
        <input id="name" name="name" placeholder="Ava" />

        <label for="preferredCallTime">Preferred call time (HH:MM)</label>
        <input id="preferredCallTime" name="preferredCallTime" placeholder="08:30" required />

        <label for="timezone">Timezone</label>
        <input id="timezone" name="timezone" value="America/Phoenix" required />

        <label for="duolingoUnit">Duolingo unit (optional)</label>
        <input id="duolingoUnit" name="duolingoUnit" placeholder="Unit 4" />

        <div class="button-row">
          <button type="submit">Sign up</button>
          <button type="submit" class="secondary" formaction="/coach/call-now"${
            twilioConfigured ? "" : " disabled"
          }>Call me now</button>
        </div>
        <small>These post to the JSON APIs at <code>/coach/signup</code> and <code>/coach/call-now</code>.</small>
      </form>
    </main>
  </body>
</html>`);
});

coachRouter.post("/coach/optout", (req, res) => {
  const parsed = z.object({ phone: phoneSchema }).safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid phone" });
  }

  setUserInactive(parsed.data.phone);
  return res.json({ ok: true });
});

coachRouter.get("/coach/users", requireAdminKey, (_req, res) => {
  const users = listUsers();
  return res.json({ users });
});

coachRouter.post("/coach/run", requireAdminKey, async (_req, res) => {
  const placed = await runCoachCallsNow();
  return res.json({ ok: true, placed });
});
