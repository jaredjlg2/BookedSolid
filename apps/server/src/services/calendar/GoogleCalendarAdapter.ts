import { google } from "googleapis";
import { env } from "../../config/env";
import type { BusyInterval, CalendarAdapter, CalendarEventDetails } from "./CalendarAdapter";

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is missing`);
  }
  return value;
}

function buildOAuthClient() {
  const clientId = requireEnv(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID");
  const clientSecret = requireEnv(env.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET");
  const redirectUri = requireEnv(env.GOOGLE_REDIRECT_URI, "GOOGLE_REDIRECT_URI");
  const refreshToken = requireEnv(env.GOOGLE_REFRESH_TOKEN, "GOOGLE_REFRESH_TOKEN");

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return oauth2Client;
}

export class GoogleCalendarAdapter implements CalendarAdapter {
  private calendarId: string;
  private timezone: string;

  constructor() {
    this.calendarId = requireEnv(env.GOOGLE_CALENDAR_ID, "GOOGLE_CALENDAR_ID");
    this.timezone = env.DEFAULT_TIMEZONE ?? "America/Phoenix";
  }

  async getAvailability(windowStart: Date, windowEnd: Date): Promise<BusyInterval[]> {
    const auth = buildOAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin: windowStart.toISOString(),
        timeMax: windowEnd.toISOString(),
        timeZone: this.timezone,
        items: [{ id: this.calendarId }],
      },
    });

    const busy = response.data.calendars?.[this.calendarId]?.busy ?? [];
    return busy
      .filter((item): item is { start: string; end: string } => Boolean(item?.start && item?.end))
      .map((item) => ({
        start: new Date(item.start),
        end: new Date(item.end),
      }));
  }

  async createEvent(start: Date, end: Date, details: CalendarEventDetails): Promise<void> {
    if (env.BOOKING_DRY_RUN) {
      console.log("BOOKING_DRY_RUN enabled. Skipping calendar create.", {
        start: start.toISOString(),
        end: end.toISOString(),
        details,
      });
      return;
    }

    const auth = buildOAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    await calendar.events.insert({
      calendarId: this.calendarId,
      requestBody: {
        summary: details.title,
        description: details.description,
        location: details.location,
        start: { dateTime: start.toISOString(), timeZone: details.timezone },
        end: { dateTime: end.toISOString(), timeZone: details.timezone },
      },
    });
  }
}
