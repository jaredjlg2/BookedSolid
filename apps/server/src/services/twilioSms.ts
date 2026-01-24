import twilio from "twilio";
import { env } from "../config/env.js";

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is missing`);
  }
  return value;
}

export async function sendSms(to: string, body: string) {
  const accountSid = requireEnv(env.TWILIO_ACCOUNT_SID, "TWILIO_ACCOUNT_SID");
  const authToken = requireEnv(env.TWILIO_AUTH_TOKEN, "TWILIO_AUTH_TOKEN");
  const fromNumber = requireEnv(
    env.TWILIO_FROM_NUMBER ?? env.TWILIO_PHONE_NUMBER,
    "TWILIO_FROM_NUMBER"
  );

  const client = twilio(accountSid, authToken);
  return client.messages.create({
    to,
    from: fromNumber,
    body,
  });
}
