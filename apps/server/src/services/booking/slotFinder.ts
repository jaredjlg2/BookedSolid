import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import type { BusyInterval } from "../calendar/CalendarAdapter.js";

dayjs.extend(utc);
dayjs.extend(timezone);

export type TimePreference =
  | { type: "morning" }
  | { type: "afternoon" }
  | { type: "specific"; hour: number; minute: number }
  | { type: "any" };

export interface SlotFinderInput {
  busyIntervals: BusyInterval[];
  windowStart: Date;
  windowEnd: Date;
  durationMinutes: number;
  bufferMinutes: number;
  timePreference: TimePreference;
  timezone: string;
  businessStartHour?: number;
  businessEndHour?: number;
}

export function findAvailableSlots(input: SlotFinderInput): Date[] {
  const businessStartHour = input.businessStartHour ?? 9;
  const businessEndHour = input.businessEndHour ?? 17;
  const durationMs = input.durationMinutes * 60 * 1000;
  const bufferMs = input.bufferMinutes * 60 * 1000;

  const expandedBusy = input.busyIntervals.map((interval) => ({
    start: interval.start.getTime() - bufferMs,
    end: interval.end.getTime() + bufferMs,
  }));

  const slots: Date[] = [];
  const startDay = dayjs(input.windowStart).tz(input.timezone).startOf("day");
  const endDay = dayjs(input.windowEnd).tz(input.timezone).startOf("day");

  for (let day = startDay; day.isBefore(endDay) || day.isSame(endDay, "day"); day = day.add(1, "day")) {
    let dayStart = day.hour(businessStartHour).minute(0).second(0).millisecond(0);
    let dayEnd = day.hour(businessEndHour).minute(0).second(0).millisecond(0);

    if (input.timePreference.type === "morning") {
      dayEnd = day.hour(12).minute(0).second(0).millisecond(0);
    }
    if (input.timePreference.type === "afternoon") {
      dayStart = day.hour(12).minute(0).second(0).millisecond(0);
    }

    const windowStart = dayjs(input.windowStart).tz(input.timezone);
    const windowEnd = dayjs(input.windowEnd).tz(input.timezone);
    if (dayStart.isBefore(windowStart) && day.isSame(windowStart, "day")) {
      dayStart = windowStart;
    }
    if (dayEnd.isAfter(windowEnd) && day.isSame(windowEnd, "day")) {
      dayEnd = windowEnd;
    }

    if (dayEnd.diff(dayStart, "minute") < input.durationMinutes) {
      continue;
    }

    if (input.timePreference.type === "specific") {
      const specificStart = day
        .hour(input.timePreference.hour)
        .minute(input.timePreference.minute)
        .second(0)
        .millisecond(0);
      if (specificStart.isBefore(dayStart) || specificStart.add(durationMs, "millisecond").isAfter(dayEnd)) {
        continue;
      }
      if (!isSlotBusy(specificStart.toDate(), durationMs, expandedBusy)) {
        slots.push(specificStart.toDate());
      }
      return slots;
    }

    for (let cursor = dayStart; cursor.valueOf() + durationMs <= dayEnd.valueOf(); cursor = cursor.add(15, "minute")) {
      if (!isSlotBusy(cursor.toDate(), durationMs, expandedBusy)) {
        slots.push(cursor.toDate());
        if (slots.length >= 2) {
          return slots;
        }
      }
    }
  }

  return slots;
}

function isSlotBusy(start: Date, durationMs: number, expandedBusy: { start: number; end: number }[]) {
  const slotStart = start.getTime();
  const slotEnd = slotStart + durationMs;
  return expandedBusy.some((interval) => slotStart < interval.end && slotEnd > interval.start);
}
