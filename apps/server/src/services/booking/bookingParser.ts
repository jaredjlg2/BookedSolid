import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import customParseFormat from "dayjs/plugin/customParseFormat";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export type DatePreference =
  | { type: "today" }
  | { type: "tomorrow" }
  | { type: "weekday"; weekday: number }
  | { type: "date"; dateISO: string };

export type ParsedTimePreference =
  | { type: "morning" }
  | { type: "afternoon" }
  | { type: "specific"; hour: number; minute: number }
  | { type: "any" };

export function detectBookingIntent(text: string): boolean {
  return /\b(book|booking|schedule|appointment|reserve)\b/i.test(text);
}

export function parseName(text: string): string | null {
  const match = text.match(/(?:my name is|this is|i am|it's)\s+([a-zA-Z][a-zA-Z\s'-]{1,40})/i);
  if (match?.[1]) {
    return normalizeName(match[1]);
  }
  if (/^[a-zA-Z][a-zA-Z\s'-]{1,30}$/.test(text.trim()) && text.trim().split(" ").length <= 3) {
    return normalizeName(text.trim());
  }
  return null;
}

export function parseReason(text: string): string | null {
  const match = text.match(/(?:for|about|regarding)\s+(.+)/i);
  if (match?.[1]) {
    return match[1].trim();
  }
  if (text.trim().length >= 4) {
    return text.trim();
  }
  return null;
}

export function parseDatePreference(text: string, timeZone: string): DatePreference | null {
  const lower = text.toLowerCase();
  if (/\btoday\b/.test(lower)) return { type: "today" };
  if (/\btomorrow\b/.test(lower)) return { type: "tomorrow" };

  const weekdays = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const weekdayIndex = weekdays.findIndex((day) => lower.includes(day));
  if (weekdayIndex >= 0) {
    return { type: "weekday", weekday: weekdayIndex };
  }

  const dateMatch = text.match(/\b(\d{1,2}[/-]\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (dateMatch) {
    const format = dateMatch[2] ? "M/D/YYYY" : "M/D";
    const value = dateMatch[2] ? dateMatch[0] : `${dateMatch[0]}/${dayjs().year()}`;
    const parsed = dayjs.tz(value, format, timeZone);
    if (parsed.isValid()) {
      return { type: "date", dateISO: parsed.toISOString() };
    }
  }

  const monthMatch = text.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\b/i
  );
  if (monthMatch) {
    const value = `${monthMatch[1]} ${monthMatch[2]} ${dayjs().year()}`;
    const parsed = dayjs.tz(value, ["MMM D YYYY", "MMMM D YYYY"], timeZone);
    if (parsed.isValid()) {
      return { type: "date", dateISO: parsed.toISOString() };
    }
  }

  return null;
}

export function parseTimePreference(text: string): ParsedTimePreference | null {
  const lower = text.toLowerCase();
  if (/\bmorning\b/.test(lower)) return { type: "morning" };
  if (/\bafternoon\b/.test(lower) || /\bevening\b/.test(lower)) return { type: "afternoon" };

  const timeMatch = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (timeMatch) {
    let hour = Number(timeMatch[1]);
    const minute = timeMatch[2] ? Number(timeMatch[2]) : 0;
    const meridian = timeMatch[3]?.toLowerCase();
    if (meridian) {
      if (meridian === "pm" && hour < 12) hour += 12;
      if (meridian === "am" && hour === 12) hour = 0;
    }
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { type: "specific", hour, minute };
    }
  }

  if (/\bany time\b/.test(lower) || /\bno preference\b/.test(lower)) {
    return { type: "any" };
  }
  return null;
}

export function parseSlotChoice(text: string): 1 | 2 | null {
  const lower = text.toLowerCase();
  if (/\b(1|one|first)\b/.test(lower)) return 1;
  if (/\b(2|two|second)\b/.test(lower)) return 2;
  return null;
}

function normalizeName(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}
