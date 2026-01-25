import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import {
  cancelAppointment,
  createAppointment,
  updateAppointment,
} from "../src/services/booking/bookingTools.js";

dayjs.extend(utc);
dayjs.extend(timezone);

async function run() {
  const timezoneName = process.env.DEFAULT_TIMEZONE ?? "America/Phoenix";
  const start = dayjs().tz(timezoneName).add(1, "hour").minute(0).second(0).millisecond(0);
  const end = start.add(30, "minute");
  const idempotencySource = `manual-crud-${Date.now()}`;

  console.log("Creating appointment...");
  const createInput = {
    startISO: start.toISOString(),
    endISO: end.toISOString(),
    name: "Test Caller",
    reason: "Booking CRUD test",
    phone: "555-0100",
    timezone: timezoneName,
    idempotencySource,
    toolCallId: "manual-create-1",
  };

  const created = await createAppointment(createInput);
  const createdDuplicate = await createAppointment({
    ...createInput,
    toolCallId: "manual-create-2",
  });

  console.log("Create results:", { created, createdDuplicate });

  const eventId = created.eventId ?? createdDuplicate.eventId;
  if (!eventId) {
    throw new Error("No eventId returned from create.");
  }

  const updatedStart = start.add(1, "hour");
  const updatedEnd = updatedStart.add(30, "minute");
  console.log("Updating appointment...");
  const updated = await updateAppointment({
    eventId,
    startISO: updatedStart.toISOString(),
    endISO: updatedEnd.toISOString(),
    summary: "Call Booking – Test Caller (Updated)",
    description: "Updated via booking_crud_test script.",
    timezone: timezoneName,
  });

  console.log("Update result:", updated);

  console.log("Cancelling appointment...");
  const cancelled = await cancelAppointment({ eventId });
  console.log("Cancel result:", cancelled);
}

run().catch((error) => {
  console.error("Booking CRUD test failed:", error);
  process.exit(1);
});
