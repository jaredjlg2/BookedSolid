export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface CalendarEventDetails {
  title: string;
  description: string;
  location?: string;
  timezone: string;
  idempotencySource?: string;
  toolCallId?: string;
}

export interface CalendarEventRecord {
  id: string;
  summary?: string;
  description?: string;
  startISO: string;
  endISO: string;
  timezone?: string;
}

export interface CalendarEventUpdate {
  start: Date;
  end: Date;
  summary?: string;
  description?: string;
  timezone: string;
}

export interface CalendarAdapter {
  getAvailability(windowStart: Date, windowEnd: Date): Promise<BusyInterval[]>;
  createEvent(
    start: Date,
    end: Date,
    details: CalendarEventDetails
  ): Promise<{ eventId?: string; htmlLink?: string } | null>;
  listEvents(windowStart: Date, windowEnd: Date): Promise<CalendarEventRecord[]>;
  updateEvent(
    eventId: string,
    updates: CalendarEventUpdate
  ): Promise<{ eventId?: string; htmlLink?: string } | null>;
  cancelEvent(eventId: string): Promise<{ eventId?: string } | null>;
}
