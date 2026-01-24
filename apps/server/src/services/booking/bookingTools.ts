import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { env } from "../../config/env.js";
import { getCalendarAdapter } from "../calendar/index.js";
import { findAvailableSlots } from "./slotFinder.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export interface AvailabilityWindow {
  startHour?: number;
  endHour?: number;
}

export interface BookingCheckAvailabilityInput {
  dayISO?: string;
  timezone?: string;
  window?: AvailabilityWindow;
  durationMinutes?: number;
}

export interface BookingSlot {
  startISO: string;
  endISO: string;
}

export interface BookingCheckAvailabilityOutput {
  slots: BookingSlot[];
  timezone: string;
  notes?: string;
}

export interface BookingCreateAppointmentInput {
  startISO: string;
  endISO: string;
  name: string;
  reason: string;
  phone?: string;
  timezone?: string;
}

export interface BookingCreateAppointmentOutput {
  dryRun: boolean;
  created: boolean;
  eventId?: string;
  htmlLink?: string;
  summary?: string;
  startISO: string;
  endISO: string;
  timezone: string;
}

export class BookingToolError extends Error {
  constructor(
    public code: "booking_not_configured" | "booking_error",
    message: string
  ) {
    super(message);
  }
}

function isBookingConfigError(error: unknown) {
  if (!error) return false;
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : JSON.stringify(error);
  return (
    message.includes("invalid_grant") ||
    message.includes("invalid_client") ||
    message.includes("missing")
  );
}

function resolveTimezone(inputTimezone?: string) {
  return inputTimezone ?? env.DEFAULT_TIMEZONE ?? "America/Phoenix";
}

function resolveWindow(dayISO: string | undefined, tz: string) {
  if (dayISO) {
    const day = dayjs.tz(dayISO, tz);
    return {
      windowStart: day.startOf("day").toDate(),
      windowEnd: day.endOf("day").toDate(),
    };
  }
  const now = dayjs().tz(tz);
  return {
    windowStart: now.toDate(),
    windowEnd: now.add(7, "day").toDate(),
  };
}

export async function checkAvailability(
  input: BookingCheckAvailabilityInput
): Promise<BookingCheckAvailabilityOutput> {
  const timezoneName = resolveTimezone(input.timezone);
  const { windowStart, windowEnd } = resolveWindow(input.dayISO, timezoneName);
  const durationMinutes = input.durationMinutes ?? env.APPT_DURATION_MINUTES ?? 30;
  const bufferMinutes = env.APPT_BUFFER_MINUTES ?? 10;

  console.log("📅 availability request", {
    dayISO: input.dayISO,
    timezone: timezoneName,
    window: input.window,
    durationMinutes,
  });

  try {
    const adapter = getCalendarAdapter();
    const busyIntervals = await adapter.getAvailability(windowStart, windowEnd);
    const slots = findAvailableSlots({
      busyIntervals,
      windowStart,
      windowEnd,
      durationMinutes,
      bufferMinutes,
      timePreference: { type: "any" },
      timezone: timezoneName,
      businessStartHour: input.window?.startHour,
      businessEndHour: input.window?.endHour,
    });

    const outputSlots = slots.map((start) => {
      const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
      return {
        startISO: start.toISOString(),
        endISO: end.toISOString(),
      };
    });

    console.log("📅 returning", outputSlots.length, "slots");

    return {
      slots: outputSlots,
      timezone: timezoneName,
    };
  } catch (error) {
    if (isBookingConfigError(error)) {
      throw new BookingToolError(
        "booking_not_configured",
        "Google Calendar authentication failed."
      );
    }
    throw new BookingToolError("booking_error", "Unable to check availability.");
  }
}

export async function createAppointment(
  input: BookingCreateAppointmentInput
): Promise<BookingCreateAppointmentOutput> {
  const timezoneName = resolveTimezone(input.timezone);
  const start = new Date(input.startISO);
  const end = new Date(input.endISO);
  const title = `Call Booking – ${input.name}`;
  const summary = `Caller requested: ${input.reason}.`;
  const description = [
    `Name: ${input.name}`,
    `Phone: ${input.phone ?? "unknown"}`,
    `Reason: ${input.reason}`,
    `Summary: ${summary}`,
  ].join("\n");

  console.log(`📅 create event (dryRun=${env.BOOKING_DRY_RUN ?? false})`, {
    startISO: start.toISOString(),
    endISO: end.toISOString(),
  });

  if (env.BOOKING_DRY_RUN) {
    return {
      dryRun: true,
      created: false,
      summary,
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      timezone: timezoneName,
    };
  }

  try {
    const adapter = getCalendarAdapter();
    const result = await adapter.createEvent(start, end, {
      title,
      description,
      location: "Phone call",
      timezone: timezoneName,
    });

    if (result?.eventId) {
      console.log("📅 event created", { eventId: result.eventId });
    }

    return {
      dryRun: false,
      created: true,
      eventId: result?.eventId,
      htmlLink: result?.htmlLink,
      summary,
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      timezone: timezoneName,
    };
  } catch (error) {
    if (isBookingConfigError(error)) {
      throw new BookingToolError(
        "booking_not_configured",
        "Google Calendar authentication failed."
      );
    }
    throw new BookingToolError("booking_error", "Unable to create appointment.");
  }
}
