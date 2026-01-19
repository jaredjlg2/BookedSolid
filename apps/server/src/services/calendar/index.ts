import type { CalendarAdapter } from "./CalendarAdapter";
import { GoogleCalendarAdapter } from "./GoogleCalendarAdapter";

export function getCalendarAdapter(): CalendarAdapter {
  return new GoogleCalendarAdapter();
}
