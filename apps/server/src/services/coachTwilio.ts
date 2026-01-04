import twilio from "twilio";
import { env } from "../config/env";
import type { CoachUser } from "./coachDb";

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is missing`);
  }
  return value;
}

function buildPublicUrl(pathname: string, params?: Record<string, string>): string {
  const base = requireEnv(env.PUBLIC_BASE_URL, "PUBLIC_BASE_URL");
  const url = new URL(base.replace(/\/$/, ""));
  url.pathname = pathname;
  if (params) {
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  }
  return url.toString();
}

export async function placeCoachCall(user: CoachUser) {
  const accountSid = requireEnv(env.TWILIO_ACCOUNT_SID, "TWILIO_ACCOUNT_SID");
  const authToken = requireEnv(env.TWILIO_AUTH_TOKEN, "TWILIO_AUTH_TOKEN");
  const fromNumber = requireEnv(
    env.TWILIO_FROM_NUMBER ?? env.TWILIO_PHONE_NUMBER,
    "TWILIO_FROM_NUMBER"
  );

  const client = twilio(accountSid, authToken);
  const url = buildPublicUrl("/twilio/coach/voice", { userId: String(user.id) });
  const statusCallback = buildPublicUrl("/twilio/coach/status", { userId: String(user.id) });

  return client.calls.create({
    to: user.phone_e164,
    from: fromNumber,
    url,
    statusCallback,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
  });
}

export function buildStreamUrl(pathname: string): string {
  const base = requireEnv(env.PUBLIC_BASE_URL, "PUBLIC_BASE_URL");
  const url = new URL(base.replace(/\/$/, ""));
  url.pathname = pathname;
  if (url.protocol === "https:") {
    url.protocol = "wss:";
  } else if (url.protocol === "http:") {
    url.protocol = "ws:";
  }
  return url.toString();
}
