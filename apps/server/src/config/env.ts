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

  // Add these later when you wire scheduling
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  CALENDAR_ID: z.string().optional(),
});

export const env = EnvSchema.parse(process.env);
