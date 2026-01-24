export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface CalendarEventDetails {
  title: string;
  description: string;
  location?: string;
  timezone: string;
}

export interface CalendarAdapter {
  getAvailability(windowStart: Date, windowEnd: Date): Promise<BusyInterval[]>;
  createEvent(
    start: Date,
    end: Date,
    details: CalendarEventDetails
  ): Promise<{ eventId?: string; htmlLink?: string } | null>;
}
