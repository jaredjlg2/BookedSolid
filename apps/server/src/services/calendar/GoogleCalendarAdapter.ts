import { google } from "googleapis";
import { env } from "../../config/env.js";
import type {
  BusyInterval,
  CalendarAdapter,
  CalendarEventDetails,
  CalendarEventRecord,
  CalendarEventUpdate,
} from "./CalendarAdapter.js";

const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const idempotencyCache = new Map<
  string,
  { status: "inflight" | "done"; eventId?: string; htmlLink?: string; createdAt: number }
>();
const inflightPromises = new Map<
  string,
  Promise<{ eventId?: string; htmlLink?: string } | null>
>();
const RATE_LIMIT_RETRY_DELAYS_MS = [500, 1500, 3000];

function pruneIdempotencyCache(now = Date.now()) {
  for (const [key, entry] of idempotencyCache.entries()) {
    if (now - entry.createdAt > IDEMPOTENCY_TTL_MS) {
      idempotencyCache.delete(key);
      inflightPromises.delete(key);
    }
  }
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is missing`);
  }
  return value;
}

function isRateLimitError(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const response = (error as { response?: { status?: number; data?: any } }).response;
  const status = response?.status;
  if (status !== 403 && status !== 429) return false;
  const reasons: string[] =
    response?.data?.error?.errors?.map((item: { reason?: string }) => item.reason) ?? [];
  return (
    status === 429 ||
    reasons.some((reason) =>
      ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason ?? "")
    )
  );
}

async function withCalendarRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= RATE_LIMIT_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      if (attempt > 0) {
        console.log("📅 retrying calendar operation", { operation, attempt });
      }
      return await fn();
    } catch (error) {
      if (!isRateLimitError(error) || attempt === RATE_LIMIT_RETRY_DELAYS_MS.length) {
        throw error;
      }
      const delayMs = RATE_LIMIT_RETRY_DELAYS_MS[attempt] ?? 0;
      console.log("📅 rate limit hit; backing off", { operation, delayMs });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`Calendar operation failed after retries: ${operation}`);
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

  async createEvent(
    start: Date,
    end: Date,
    details: CalendarEventDetails
  ): Promise<{ eventId?: string; htmlLink?: string } | null> {
    const dryRun = (process.env.BOOKING_DRY_RUN ?? "").toLowerCase() === "true";
    if (dryRun) {
      console.log("BOOKING_DRY_RUN enabled. Skipping calendar create.", {
        start: start.toISOString(),
        end: end.toISOString(),
      });
      return null;
    }

    const startISO = start.toISOString();
    const endISO = end.toISOString();
    const idempotencySource = details.idempotencySource ?? "unknown-session";
    const idempotencyKey = `${idempotencySource}:${this.calendarId}:${startISO}:${endISO}`;
    const toolCallId = details.toolCallId;

    pruneIdempotencyCache();
    const cached = idempotencyCache.get(idempotencyKey);
    if (cached) {
      console.log("📅 INSERT skipped (duplicate)", {
        idempotencyKey,
        toolCallId,
        status: cached.status,
        eventId: cached.eventId,
      });
      if (cached.status === "inflight") {
        const inflight = inflightPromises.get(idempotencyKey);
        if (inflight) {
          return await inflight;
        }
      }
      return {
        eventId: cached.eventId,
        htmlLink: cached.htmlLink,
      };
    }

    idempotencyCache.set(idempotencyKey, {
      status: "inflight",
      createdAt: Date.now(),
    });

    const auth = buildOAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    console.log("📅 INSERT start", { idempotencyKey, toolCallId });

    const insertPromise = withCalendarRetry("insert", () =>
      calendar.events.insert({
        calendarId: this.calendarId,
        requestBody: {
          summary: details.title,
          description: details.description,
          location: details.location,
          start: { dateTime: startISO, timeZone: details.timezone },
          end: { dateTime: endISO, timeZone: details.timezone },
        },
      })
    )
      .then((response) => {
        idempotencyCache.set(idempotencyKey, {
          status: "done",
          eventId: response.data.id ?? undefined,
          htmlLink: response.data.htmlLink ?? undefined,
          createdAt: Date.now(),
        });
        return {
          eventId: response.data.id ?? undefined,
          htmlLink: response.data.htmlLink ?? undefined,
        };
      })
      .catch((error) => {
        idempotencyCache.delete(idempotencyKey);
        const response = (error as { response?: { status?: number; data?: unknown } })
          .response;
        console.log("📅 INSERT failed", {
          idempotencyKey,
          toolCallId,
          status: response?.status,
          response: response?.data,
        });
        throw error;
      })
      .finally(() => {
        inflightPromises.delete(idempotencyKey);
      });

    inflightPromises.set(idempotencyKey, insertPromise);
    return await insertPromise;
  }

  async listEvents(windowStart: Date, windowEnd: Date): Promise<CalendarEventRecord[]> {
    const auth = buildOAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    const response = await calendar.events.list({
      calendarId: this.calendarId,
      timeMin: windowStart.toISOString(),
      timeMax: windowEnd.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 50,
    });

    const items = response.data.items ?? [];
    return items
      .filter((item) => Boolean(item.id && item.start && item.end))
      .map((item) => {
        const startISO = item.start?.dateTime ?? item.start?.date ?? "";
        const endISO = item.end?.dateTime ?? item.end?.date ?? "";
        return {
          id: item.id ?? "",
          summary: item.summary ?? undefined,
          description: item.description ?? undefined,
          startISO,
          endISO,
          timezone: item.start?.timeZone ?? item.end?.timeZone ?? undefined,
        };
      })
      .filter((item) => item.id && item.startISO && item.endISO);
  }

  async updateEvent(
    eventId: string,
    updates: CalendarEventUpdate
  ): Promise<{ eventId?: string; htmlLink?: string } | null> {
    const auth = buildOAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    try {
      const response = await withCalendarRetry("update", () =>
        calendar.events.patch({
          calendarId: this.calendarId,
          eventId,
          requestBody: {
            summary: updates.summary,
            description: updates.description,
            start: { dateTime: updates.start.toISOString(), timeZone: updates.timezone },
            end: { dateTime: updates.end.toISOString(), timeZone: updates.timezone },
          },
        })
      );

      console.log("📅 UPDATE success", {
        eventId,
        status: response.status,
        response: response.data,
      });

      return {
        eventId: response.data.id ?? eventId,
        htmlLink: response.data.htmlLink ?? undefined,
      };
    } catch (error) {
      const response = (error as { response?: { status?: number; data?: unknown } }).response;
      console.log("📅 UPDATE failed", {
        eventId,
        status: response?.status,
        response: response?.data,
      });
      throw error;
    }
  }

  async cancelEvent(eventId: string): Promise<{ eventId?: string } | null> {
    const auth = buildOAuthClient();
    const calendar = google.calendar({ version: "v3", auth });

    try {
      const response = await withCalendarRetry("delete", () =>
        calendar.events.delete({
          calendarId: this.calendarId,
          eventId,
        })
      );

      console.log("📅 DELETE success", {
        eventId,
        status: response.status,
        response: response.data,
      });

      return { eventId };
    } catch (error) {
      const response = (error as { response?: { status?: number; data?: unknown } }).response;
      console.log("📅 DELETE failed", {
        eventId,
        status: response?.status,
        response: response?.data,
      });
      throw error;
    }
  }
}
