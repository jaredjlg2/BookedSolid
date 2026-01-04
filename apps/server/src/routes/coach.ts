import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env";
import {
  listUsers,
  setUserInactive,
  upsertUser,
} from "../services/coachDb";
import { runCoachCallsNow } from "../services/coachScheduler";

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
