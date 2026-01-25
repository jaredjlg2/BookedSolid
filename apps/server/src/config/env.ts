import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),

  PUBLIC_BASE_URL: z.string().optional(),
  COACH_ADMIN_KEY: z.string().optional(),
  DB_PATH: z.string().optional(),

  OPENAI_API_KEY: z.string().optional(),
  OPENAI_REALTIME_MODEL: z.string().optional(),
  OPENAI_INSTRUCTION_MODEL: z.string().optional(),

  // Booking + calendar
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  GOOGLE_CALENDAR_ID: z.string().optional(),
  BUSINESS_NAME: z.string().optional(),
  BUSINESS_OWNER_PHONE: z.string().optional(),
  DEFAULT_TIMEZONE: z.string().optional(),
  APPT_DURATION_MINUTES: z.coerce.number().optional(),
  APPT_BUFFER_MINUTES: z.coerce.number().optional(),
  BOOKING_DRY_RUN: z.coerce.boolean().optional(),

  ENABLE_POST_CALL_SMS: z.coerce.boolean().optional(),
  SEND_SUMMARY_TO_CALLER: z.coerce.boolean().optional(),
});

const rawEnv = {
  ...process.env,
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? process.env.RENDER_EXTERNAL_URL,
};

export const env = EnvSchema.parse(rawEnv);
