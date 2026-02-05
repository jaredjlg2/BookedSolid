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
  startISO?: string;
  endISO?: string;
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
  idempotencySource?: string;
  toolCallId?: string;
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

export interface BookingFindAppointmentInput {
  startISO?: string;
  timezone?: string;
  name?: string;
  daysAhead?: number;
}

export interface BookingEventMatch {
  eventId: string;
  summary?: string;
  description?: string;
  startISO: string;
  endISO: string;
}

export interface BookingFindAppointmentOutput {
  matches: BookingEventMatch[];
  timezone: string;
}

export interface BookingUpdateAppointmentInput {
  eventId: string;
  startISO: string;
  endISO: string;
  summary?: string;
  description?: string;
  timezone?: string;
}

export interface BookingUpdateAppointmentOutput {
  updated: boolean;
  eventId: string;
  htmlLink?: string;
  startISO: string;
  endISO: string;
  timezone: string;
}

export interface BookingCancelAppointmentInput {
  eventId: string;
}

export interface BookingCancelAppointmentOutput {
  cancelled: boolean;
  eventId: string;
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
  const dryRun = (process.env.BOOKING_DRY_RUN ?? "").toLowerCase() === "true";
  const timezoneName = resolveTimezone(input.timezone);
  const durationMinutes = input.durationMinutes ?? env.APPT_DURATION_MINUTES ?? 30;
  const bufferMinutes = env.APPT_BUFFER_MINUTES ?? 10;

  console.log("📅 availability request", {
    dayISO: input.dayISO,
    timezone: timezoneName,
    window: input.window,
    startISO: input.startISO,
    endISO: input.endISO,
    durationMinutes,
  });

  try {
    if (input.startISO) {
      const start = dayjs.tz(input.startISO, timezoneName);
      const end = input.endISO
        ? dayjs.tz(input.endISO, timezoneName)
        : start.add(durationMinutes, "minute");
      const windowStart = start.toDate();
      const windowEnd = end.toDate();
      if (dryRun) {
        console.log("📅 BOOKING_DRY_RUN enabled. Skipping calendar availability check.", {
          startISO: windowStart.toISOString(),
          endISO: windowEnd.toISOString(),
        });
        return {
          slots: [
            {
              startISO: windowStart.toISOString(),
              endISO: windowEnd.toISOString(),
            },
          ],
          timezone: timezoneName,
          notes: "Booking dry run enabled; availability not checked against calendar.",
        };
      }

      const adapter = getCalendarAdapter();
      const queryStart = start.subtract(bufferMinutes, "minute").toDate();
      const queryEnd = end.add(bufferMinutes, "minute").toDate();
      const busyIntervals = await adapter.getAvailability(queryStart, queryEnd);
      const slotFree = !isSlotBusy(windowStart, windowEnd, busyIntervals, bufferMinutes);
      const slots = slotFree
        ? [
            {
              startISO: windowStart.toISOString(),
              endISO: windowEnd.toISOString(),
            },
          ]
        : [];

      console.log("📅 exact-time availability", {
        startISO: windowStart.toISOString(),
        endISO: windowEnd.toISOString(),
        available: slotFree,
      });

      return {
        slots,
        timezone: timezoneName,
      };
    }

    const { windowStart, windowEnd } = resolveWindow(input.dayISO, timezoneName);
    const busyIntervals = dryRun
      ? []
      : await getCalendarAdapter().getAvailability(windowStart, windowEnd);
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
      notes: dryRun
        ? "Booking dry run enabled; availability not checked against calendar."
        : undefined,
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

function isSlotBusy(
  start: Date,
  end: Date,
  busyIntervals: { start: Date; end: Date }[],
  bufferMinutes: number
) {
  const bufferMs = bufferMinutes * 60 * 1000;
  const slotStart = start.getTime();
  const slotEnd = end.getTime();
  return busyIntervals.some((interval) => {
    const busyStart = interval.start.getTime() - bufferMs;
    const busyEnd = interval.end.getTime() + bufferMs;
    return slotStart < busyEnd && slotEnd > busyStart;
  });
}

export async function createAppointment(
  input: BookingCreateAppointmentInput
): Promise<BookingCreateAppointmentOutput> {
  const dryRun = (process.env.BOOKING_DRY_RUN ?? "").toLowerCase() === "true";
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

  console.log(`📅 create event (dryRun=${dryRun})`, {
    startISO: start.toISOString(),
    endISO: end.toISOString(),
  });

  if (dryRun) {
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
      idempotencySource: input.idempotencySource,
      toolCallId: input.toolCallId,
    });

    const created = Boolean(result?.eventId);
    if (!created) {
      console.log("📅 event creation unconfirmed; missing event id", {
        startISO: start.toISOString(),
        endISO: end.toISOString(),
      });
      throw new BookingToolError(
        "booking_error",
        "Unable to confirm appointment booking."
      );
    }

    console.log("📅 event created", { eventId: result?.eventId });

    return {
      dryRun: false,
      created,
      eventId: result?.eventId,
      htmlLink: result?.htmlLink,
      summary,
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      timezone: timezoneName,
    };
  } catch (error) {
    if (error instanceof BookingToolError) {
      throw error;
    }
    if (isBookingConfigError(error)) {
      throw new BookingToolError(
        "booking_not_configured",
        "Google Calendar authentication failed."
      );
    }
    throw new BookingToolError("booking_error", "Unable to create appointment.");
  }
}

export async function findAppointment(
  input: BookingFindAppointmentInput
): Promise<BookingFindAppointmentOutput> {
  const timezoneName = resolveTimezone(input.timezone);
  const windowStart = dayjs().tz(timezoneName).toDate();
  const windowEnd = dayjs().tz(timezoneName).add(input.daysAhead ?? 30, "day").toDate();

  try {
    const adapter = getCalendarAdapter();
    const events = await adapter.listEvents(windowStart, windowEnd);

    let matches = events;
    if (input.startISO) {
      const target = dayjs.tz(input.startISO, timezoneName);
      matches = matches.filter((event) => {
        const eventStart = dayjs.tz(event.startISO, timezoneName);
        return eventStart.isSame(target, "minute");
      });
    }

    if (input.name) {
      const needle = input.name.toLowerCase();
      matches = matches.filter((event) => {
        const summary = event.summary?.toLowerCase() ?? "";
        const description = event.description?.toLowerCase() ?? "";
        return summary.includes(needle) || description.includes(needle);
      });
    }

    return {
      matches: matches.map((event) => ({
        eventId: event.id,
        summary: event.summary,
        description: event.description,
        startISO: event.startISO,
        endISO: event.endISO,
      })),
      timezone: timezoneName,
    };
  } catch (error) {
    if (isBookingConfigError(error)) {
      throw new BookingToolError(
        "booking_not_configured",
        "Google Calendar authentication failed."
      );
    }
    throw new BookingToolError("booking_error", "Unable to find appointments.");
  }
}

export async function updateAppointment(
  input: BookingUpdateAppointmentInput
): Promise<BookingUpdateAppointmentOutput> {
  const timezoneName = resolveTimezone(input.timezone);
  const start = new Date(input.startISO);
  const end = new Date(input.endISO);

  try {
    const adapter = getCalendarAdapter();
    const result = await adapter.updateEvent(input.eventId, {
      start,
      end,
      summary: input.summary,
      description: input.description,
      timezone: timezoneName,
    });

    return {
      updated: true,
      eventId: result?.eventId ?? input.eventId,
      htmlLink: result?.htmlLink,
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
    throw new BookingToolError("booking_error", "Unable to update appointment.");
  }
}

export async function cancelAppointment(
  input: BookingCancelAppointmentInput
): Promise<BookingCancelAppointmentOutput> {
  try {
    const adapter = getCalendarAdapter();
    await adapter.cancelEvent(input.eventId);
    return {
      cancelled: true,
      eventId: input.eventId,
    };
  } catch (error) {
    if (isBookingConfigError(error)) {
      throw new BookingToolError(
        "booking_not_configured",
        "Google Calendar authentication failed."
      );
    }
    throw new BookingToolError("booking_error", "Unable to cancel appointment.");
  }
}
