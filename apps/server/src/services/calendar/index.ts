import type { CalendarAdapter } from "./CalendarAdapter.js";
import { GoogleCalendarAdapter } from "./GoogleCalendarAdapter.js";

export function getCalendarAdapter(): CalendarAdapter {
  return new GoogleCalendarAdapter();
}
