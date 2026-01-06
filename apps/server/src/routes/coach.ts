import { Router } from "express";
import * as crypto from "node:crypto";
import { z } from "zod";
import { env } from "../config/env";
import {
  listUsers,
  setUserInactive,
  upsertUser,
  createCallLog,
  updateLastCalled,
  getUserByPhone,
  setUserPassword,
  updateUserPreferences,
} from "../services/coachDb";
import { runCoachCallsNow } from "../services/coachScheduler";
import { placeCoachCall } from "../services/coachTwilio";
import { buildCallInstructions } from "../services/instructionBuilder";

export const coachRouter = Router();

const phoneSchema = z.string().regex(/^\+\d{10,15}$/);
const passwordSchema = z.string().min(8);

const signupSchema = z.object({
  phone: phoneSchema,
  name: z.string().optional(),
  preferredCallTime: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string().default("America/Phoenix"),
  duolingoUnit: z.string().optional(),
  callPrompt: z.string().optional(),
  callInstructions: z.string().optional(),
  password: passwordSchema.optional(),
});

const loginSchema = z.object({
  phone: phoneSchema,
  password: passwordSchema,
});

const preferenceSchema = z.object({
  name: z.string().optional(),
  timezone: z.string().optional(),
  preferredCallHour: z.number().int().min(0).max(23).optional(),
  preferredCallMinute: z.number().int().min(0).max(59).optional(),
  levelEstimate: z.enum(["A0", "A1", "A2", "B1"]).optional(),
  duolingoUnit: z.string().nullable().optional(),
  callPrompt: z.string().nullable().optional(),
  callInstructions: z.string().nullable().optional(),
});

const HASH_ITERATIONS = 120_000;

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .pbkdf2Sync(password, salt, HASH_ITERATIONS, 32, "sha256")
    .toString("hex");
  return `pbkdf2_sha256$${HASH_ITERATIONS}$${salt}$${hash}`;
}

function verifyPassword(password: string, storedHash: string) {
  const [algorithm, iterationsRaw, salt, expectedHash] = storedHash.split("$");
  if (!algorithm || !iterationsRaw || !salt || !expectedHash) return false;
  if (algorithm !== "pbkdf2_sha256") return false;
  const iterations = Number(iterationsRaw);
  if (!Number.isFinite(iterations)) return false;
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(expectedHash, "hex"));
}

function parseBasicAuth(req: any) {
  const header = req.headers?.authorization;
  if (typeof header !== "string") return null;
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) return null;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const index = decoded.indexOf(":");
  if (index === -1) return null;
  const phone = decoded.slice(0, index);
  const password = decoded.slice(index + 1);
  return { phone, password };
}

function requireCoachAuth(req: any, res: any) {
  const auth = parseBasicAuth(req);
  if (!auth) {
    res.status(401).json({ error: "Missing authorization" });
    return null;
  }
  const user = getUserByPhone(auth.phone);
  if (!user) {
    res.status(401).json({ error: "Invalid credentials" });
    return null;
  }
  if (!user.password_hash) {
    res.status(409).json({ error: "Password not set", code: "password_not_set" });
    return null;
  }
  if (!verifyPassword(auth.password, user.password_hash)) {
    res.status(401).json({ error: "Invalid credentials" });
    return null;
  }
  return user;
}

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

  const passwordHash = parsed.data.password ? hashPassword(parsed.data.password) : undefined;
  const user = upsertUser({
    phone_e164: parsed.data.phone,
    name: parsed.data.name,
    timezone: parsed.data.timezone,
    preferred_call_hour_local: hour,
    preferred_call_minute_local: minute,
    duolingo_unit: parsed.data.duolingoUnit,
    call_prompt: parsed.data.callPrompt,
    call_instructions: parsed.data.callInstructions,
    password_hash: passwordHash,
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

  const passwordHash = parsed.data.password ? hashPassword(parsed.data.password) : undefined;
  const user = upsertUser({
    phone_e164: parsed.data.phone,
    name: parsed.data.name,
    timezone: parsed.data.timezone,
    preferred_call_hour_local: hour,
    preferred_call_minute_local: minute,
    duolingo_unit: parsed.data.duolingoUnit,
    call_prompt: parsed.data.callPrompt,
    call_instructions: parsed.data.callInstructions,
    password_hash: passwordHash,
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

coachRouter.post("/coach/login", (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }

  const user = getUserByPhone(parsed.data.phone);
  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  if (!user.password_hash) {
    return res.status(409).json({ error: "Password not set", code: "password_not_set" });
  }
  if (!verifyPassword(parsed.data.password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  return res.json({
    ok: true,
    user: {
      id: user.id,
      phone_e164: user.phone_e164,
      name: user.name,
      timezone: user.timezone,
      preferred_call_hour_local: user.preferred_call_hour_local,
      preferred_call_minute_local: user.preferred_call_minute_local,
      level_estimate: user.level_estimate,
      duolingo_unit: user.duolingo_unit,
      call_prompt: user.call_prompt,
      call_instructions: user.call_instructions,
    },
  });
});

coachRouter.post("/coach/set-password", (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const user = getUserByPhone(parsed.data.phone);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  const passwordHash = hashPassword(parsed.data.password);
  setUserPassword(parsed.data.phone, passwordHash);
  return res.json({ ok: true });
});

coachRouter.get("/coach/me", (req, res) => {
  const user = requireCoachAuth(req, res);
  if (!user) return;
  return res.json({
    id: user.id,
    phone_e164: user.phone_e164,
    name: user.name,
    timezone: user.timezone,
    preferred_call_hour_local: user.preferred_call_hour_local,
    preferred_call_minute_local: user.preferred_call_minute_local,
    level_estimate: user.level_estimate,
    duolingo_unit: user.duolingo_unit,
    call_prompt: user.call_prompt,
    call_instructions: user.call_instructions,
  });
});

coachRouter.post("/coach/preferences", (req, res) => {
  const user = requireCoachAuth(req, res);
  if (!user) return;
  const parsed = preferenceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const updates = updateUserPreferences(user.id, {
    name: parsed.data.name,
    timezone: parsed.data.timezone,
    preferred_call_hour_local: parsed.data.preferredCallHour,
    preferred_call_minute_local: parsed.data.preferredCallMinute,
    level_estimate: parsed.data.levelEstimate,
    duolingo_unit: parsed.data.duolingoUnit ?? undefined,
    call_prompt: parsed.data.callPrompt ?? undefined,
    call_instructions: parsed.data.callInstructions ?? undefined,
  });
  if (!updates) {
    return res.status(404).json({ error: "User not found" });
  }
  return res.json({
    ok: true,
    user: {
      id: updates.id,
      phone_e164: updates.phone_e164,
      name: updates.name,
      timezone: updates.timezone,
      preferred_call_hour_local: updates.preferred_call_hour_local,
      preferred_call_minute_local: updates.preferred_call_minute_local,
      level_estimate: updates.level_estimate,
      duolingo_unit: updates.duolingo_unit,
      call_prompt: updates.call_prompt,
      call_instructions: updates.call_instructions,
    },
  });
});

coachRouter.post("/coach/instructions", async (req, res) => {
  const user = requireCoachAuth(req, res);
  if (!user) return;
  const parsed = z
    .object({ prompt: z.string().min(5, "Please enter a longer prompt.") })
    .safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  try {
    const instructions = await buildCallInstructions(parsed.data.prompt);
    return res.json({ ok: true, instructions });
  } catch (error) {
    console.error("Failed to build instructions", error);
    return res.status(500).json({ error: "Failed to generate instructions" });
  }
});

coachRouter.get("/coach/portal", (_req, res) => {
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
  return res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Coach Portal</title>
    <style>
      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 32px;
        color: #111827;
        background: #f8fafc;
      }
      main {
        max-width: 640px;
        margin: 0 auto;
        background: #fff;
        border-radius: 12px;
        padding: 24px;
        box-shadow: 0 12px 24px rgba(15, 23, 42, 0.08);
      }
      h1 {
        font-size: 24px;
        margin-bottom: 8px;
      }
      h2 {
        font-size: 18px;
        margin: 24px 0 12px;
      }
      label {
        display: block;
        font-weight: 600;
        margin-bottom: 6px;
      }
      input,
      select {
        width: 100%;
        padding: 10px 12px;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        margin-bottom: 16px;
        font-size: 14px;
        background: #fff;
      }
      .row {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
        gap: 12px;
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
      .hidden {
        display: none;
      }
      textarea {
        width: 100%;
        min-height: 110px;
        padding: 10px 12px;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        margin-bottom: 16px;
        font-size: 14px;
        font-family: inherit;
        resize: vertical;
      }
      .button-row {
        display: grid;
        gap: 10px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Coach Portal</h1>
      <p class="callout">Log in with your phone and password to manage your coaching preferences.</p>

      <section id="login-section">
        <h2>Log in</h2>
        <form id="login-form">
          <label for="login-phone">Phone (E.164)</label>
          <input id="login-phone" name="phone" placeholder="+15555550123" required />

          <label for="login-password">Password</label>
          <input id="login-password" name="password" type="password" required />

          <button type="submit">Log in</button>
        </form>
      </section>

      <section id="set-password-section" class="hidden">
        <h2>Set your password</h2>
        <form id="set-password-form">
          <label for="set-phone">Phone (E.164)</label>
          <input id="set-phone" name="phone" placeholder="+15555550123" required />

          <label for="set-password">New password</label>
          <input id="set-password" name="password" type="password" required />

          <button type="submit" class="secondary">Save password</button>
        </form>
      </section>

      <section id="preferences-section" class="hidden">
        <h2>Preferences</h2>
        ${callNowNotice}
        <form id="preferences-form">
          <label for="pref-name">Name (optional)</label>
          <input id="pref-name" name="name" placeholder="Ava" />

          <div class="row">
            <div>
              <label for="pref-hour">Preferred call hour</label>
              <select id="pref-hour" name="preferredCallHour" aria-label="Preferred call hour"></select>
            </div>
            <div>
              <label for="pref-minute">Preferred call minute</label>
              <select id="pref-minute" name="preferredCallMinute" aria-label="Preferred call minute">
                <option value="0">00</option>
                <option value="15">15</option>
                <option value="30">30</option>
                <option value="45">45</option>
              </select>
            </div>
          </div>

          <label for="pref-timezone">Timezone</label>
          <select id="pref-timezone" name="timezone" aria-label="Timezone">
            <option value="America/Phoenix">America/Phoenix</option>
            <option value="America/Los_Angeles">America/Los_Angeles</option>
            <option value="America/Denver">America/Denver</option>
            <option value="America/Chicago">America/Chicago</option>
            <option value="America/New_York">America/New_York</option>
            <option value="Europe/London">Europe/London</option>
          </select>

          <label for="pref-level">Difficulty</label>
          <select id="pref-level" name="levelEstimate" aria-label="Difficulty">
            <option value="A0">A0 - brand new</option>
            <option value="A1">A1 - beginner</option>
            <option value="A2">A2 - early intermediate</option>
            <option value="B1">B1 - intermediate</option>
          </select>

          <label for="pref-prompt">Preset prompt</label>
          <select id="pref-prompt" name="duolingoUnit" aria-label="Preset prompt">
            <option value="">No specific prompt</option>
            <option value="Warm-up conversation">Warm-up conversation</option>
            <option value="Travel basics">Travel basics</option>
            <option value="Ordering food">Ordering food</option>
            <option value="Work introductions">Work introductions</option>
            <option value="Duolingo Unit 1">Duolingo Unit 1</option>
            <option value="Duolingo Unit 2">Duolingo Unit 2</option>
            <option value="Duolingo Unit 3">Duolingo Unit 3</option>
          </select>

          <label for="call-prompt">What are you looking for in the call?</label>
          <textarea
            id="call-prompt"
            name="callPrompt"
            placeholder="e.g. Help me practice ordering coffee and correcting my pronunciation."
          ></textarea>

          <label for="call-instructions">Generated call instructions</label>
          <textarea
            id="call-instructions"
            name="callInstructions"
            placeholder="Use the button below to generate instructions."
          ></textarea>

          <div class="button-row">
            <button type="button" class="secondary" id="generate-instructions">
              Generate instructions
            </button>
            <button type="submit">Save preferences</button>
            <button
              type="button"
              class="secondary"
              id="call-now"
              ${twilioConfigured ? "" : "disabled"}
            >
              Call me now
            </button>
          </div>
        </form>
      </section>

      <div id="status" class="callout hidden"></div>
    </main>

    <script>
      const statusEl = document.getElementById("status");
      const loginSection = document.getElementById("login-section");
      const setPasswordSection = document.getElementById("set-password-section");
      const preferencesSection = document.getElementById("preferences-section");
      const loginForm = document.getElementById("login-form");
      const setPasswordForm = document.getElementById("set-password-form");
      const preferencesForm = document.getElementById("preferences-form");
      const hourSelect = document.getElementById("pref-hour");
      const minuteSelect = document.getElementById("pref-minute");
      const timezoneSelect = document.getElementById("pref-timezone");
      const levelSelect = document.getElementById("pref-level");
      const promptSelect = document.getElementById("pref-prompt");
      const nameInput = document.getElementById("pref-name");
      const callPromptInput = document.getElementById("call-prompt");
      const callInstructionsInput = document.getElementById("call-instructions");
      const generateButton = document.getElementById("generate-instructions");
      const callNowButton = document.getElementById("call-now");
      let currentPhone = null;

      for (let hour = 0; hour < 24; hour += 1) {
        const option = document.createElement("option");
        option.value = String(hour);
        option.textContent = String(hour).padStart(2, "0");
        hourSelect.appendChild(option);
      }

      function setStatus(message, isError = false) {
        statusEl.textContent = message;
        statusEl.classList.remove("hidden");
        statusEl.style.background = isError ? "#fee2e2" : "#eff6ff";
        statusEl.style.color = isError ? "#991b1b" : "#1e3a8a";
      }

      function getAuthHeader() {
        return sessionStorage.getItem("coachAuth");
      }

      function setAuthHeader(phone, password) {
        const encoded = btoa(\`\${phone}:\${password}\`);
        sessionStorage.setItem("coachAuth", \`Basic \${encoded}\`);
      }

      async function loadProfile() {
        const auth = getAuthHeader();
        if (!auth) return;
        const response = await fetch("/coach/me", { headers: { Authorization: auth } });
        if (!response.ok) {
          setStatus("Please log in again to continue.", true);
          sessionStorage.removeItem("coachAuth");
          preferencesSection.classList.add("hidden");
          loginSection.classList.remove("hidden");
          return;
        }
        const user = await response.json();
        currentPhone = user.phone_e164;
        nameInput.value = user.name || "";
        hourSelect.value = String(user.preferred_call_hour_local);
        minuteSelect.value = String(user.preferred_call_minute_local);
        timezoneSelect.value = user.timezone;
        levelSelect.value = user.level_estimate;
        promptSelect.value = user.duolingo_unit || "";
        callPromptInput.value = user.call_prompt || "";
        callInstructionsInput.value = user.call_instructions || "";
        preferencesSection.classList.remove("hidden");
        loginSection.classList.add("hidden");
        setPasswordSection.classList.add("hidden");
      }

      loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const phone = document.getElementById("login-phone").value;
        const password = document.getElementById("login-password").value;
        const response = await fetch("/coach/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone, password }),
        });
        if (response.status === 409) {
          setStatus("Password missing. Set one to continue.", true);
          setPasswordSection.classList.remove("hidden");
          return;
        }
        if (!response.ok) {
          setStatus("Login failed. Check your phone and password.", true);
          return;
        }
        setAuthHeader(phone, password);
        setStatus("Logged in.");
        await loadProfile();
      });

      setPasswordForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const phone = document.getElementById("set-phone").value;
        const password = document.getElementById("set-password").value;
        const response = await fetch("/coach/set-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone, password }),
        });
        if (!response.ok) {
          setStatus("Failed to set password.", true);
          return;
        }
        setAuthHeader(phone, password);
        setStatus("Password saved. You're logged in.");
        await loadProfile();
      });

      preferencesForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const auth = getAuthHeader();
        if (!auth) {
          setStatus("Please log in to save preferences.", true);
          return;
        }
        const payload = {
          name: nameInput.value || undefined,
          timezone: timezoneSelect.value,
          preferredCallHour: Number(hourSelect.value),
          preferredCallMinute: Number(minuteSelect.value),
          levelEstimate: levelSelect.value,
          duolingoUnit: promptSelect.value || null,
          callPrompt: callPromptInput.value || null,
          callInstructions: callInstructionsInput.value || null,
        };
        const response = await fetch("/coach/preferences", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          setStatus("Failed to save preferences.", true);
          return;
        }
        setStatus("Preferences saved.");
      });

      generateButton.addEventListener("click", async () => {
        const auth = getAuthHeader();
        if (!auth) {
          setStatus("Please log in to generate instructions.", true);
          return;
        }
        if (!callPromptInput.value.trim()) {
          setStatus("Add a prompt before generating instructions.", true);
          return;
        }
        generateButton.disabled = true;
        generateButton.textContent = "Generating...";
        const response = await fetch("/coach/instructions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: auth },
          body: JSON.stringify({ prompt: callPromptInput.value }),
        });
        if (!response.ok) {
          setStatus("Failed to generate instructions.", true);
          generateButton.disabled = false;
          generateButton.textContent = "Generate instructions";
          return;
        }
        const data = await response.json();
        callInstructionsInput.value = data.instructions || "";
        setStatus("Instructions generated. Save to keep them.");
        generateButton.disabled = false;
        generateButton.textContent = "Generate instructions";
      });

      callNowButton.addEventListener("click", async () => {
        if (!currentPhone) {
          setStatus("Missing phone number. Refresh and log in again.", true);
          return;
        }
        callNowButton.disabled = true;
        callNowButton.textContent = "Calling...";
        const payload = {
          phone: currentPhone,
          name: nameInput.value || undefined,
          preferredCallTime: `${hourSelect.value.padStart(2, "0")}:${minuteSelect.value.padStart(
            2,
            "0"
          )}`,
          timezone: timezoneSelect.value,
          duolingoUnit: promptSelect.value || undefined,
          callPrompt: callPromptInput.value || undefined,
          callInstructions: callInstructionsInput.value || undefined,
        };
        const response = await fetch("/coach/call-now", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          setStatus("Failed to place call. Check Twilio settings.", true);
          callNowButton.disabled = false;
          callNowButton.textContent = "Call me now";
          return;
        }
        setStatus("Call initiated.");
        callNowButton.disabled = false;
        callNowButton.textContent = "Call me now";
      });

      const existingAuth = getAuthHeader();
      if (existingAuth) {
        loadProfile();
      }
    </script>
  </body>
</html>`);
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

        <label for="password">Set a password</label>
        <input id="password" name="password" type="password" required />

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
