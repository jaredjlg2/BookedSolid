import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { env } from "../config/env";
import {
  CoachUser,
  createCallLog,
  listActiveUsers,
  updateLastCalled,
} from "./coachDb";
import { placeCoachCall } from "./coachTwilio";

dayjs.extend(utc);
dayjs.extend(timezone);

const MIN_HOURS_BETWEEN_CALLS = 20;
const MATCH_WINDOW_MINUTES = 1;

function isUserDue(user: CoachUser, nowUtc: dayjs.Dayjs): boolean {
  const localNow = nowUtc.tz(user.timezone);
  const hourMatches = localNow.hour() === user.preferred_call_hour_local;
  const minuteDiff = Math.abs(localNow.minute() - user.preferred_call_minute_local);
  const minuteMatches = minuteDiff <= MATCH_WINDOW_MINUTES;

  if (!hourMatches || !minuteMatches) {
    return false;
  }

  if (user.last_called_at) {
    const lastCall = dayjs(user.last_called_at);
    if (nowUtc.diff(lastCall, "hour") < MIN_HOURS_BETWEEN_CALLS) {
      return false;
    }
  }

  return true;
}

async function processDueUsers(): Promise<void> {
  const users = listActiveUsers();
  const nowUtc = dayjs.utc();

  for (const user of users) {
    if (!isUserDue(user, nowUtc)) {
      continue;
    }

    try {
      const call = await placeCoachCall(user);
      createCallLog({ user_id: user.id, call_sid: call.sid, outcome: "initiated" });
      updateLastCalled(user.id);
      console.log(`📞 Placed coach call for ${user.phone_e164}`);
    } catch (error) {
      console.error("Failed to place coach call", error);
    }
  }
}

let isRunning = false;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;

export function startCoachScheduler(): void {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.PUBLIC_BASE_URL) {
    console.log("Coach scheduler disabled: missing Twilio or PUBLIC_BASE_URL env vars.");
    return;
  }

  try {
    listActiveUsers();
  } catch (error) {
    console.log(
      "Coach scheduler disabled: SQLite driver unavailable. Install better-sqlite3 or upgrade to Node 22+."
    );
    console.error(error);
    return;
  }

  if (schedulerTimer) return;

  const run = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      await processDueUsers();
    } finally {
      isRunning = false;
    }
  };

  run();
  schedulerTimer = setInterval(run, 60 * 1000);

  console.log("⏰ Coach scheduler running (every minute)");
}

export async function runCoachCallsNow(limit = 10): Promise<number> {
  const users = listActiveUsers().slice(0, limit);
  let placed = 0;
  for (const user of users) {
    try {
      const call = await placeCoachCall(user);
      createCallLog({ user_id: user.id, call_sid: call.sid, outcome: "initiated" });
      updateLastCalled(user.id);
      placed += 1;
    } catch (error) {
      console.error("Manual coach call failed", error);
    }
  }
  return placed;
}
