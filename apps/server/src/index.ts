// apps/server/src/index.ts
import "./config/env.js";
import http from "http";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { healthRouter } from "./routes/health.js";
import { twilioRouter } from "./routes/twilio.js";
import { coachRouter } from "./routes/coach.js";
import { connectOpenAIRealtime } from "./services/realtimeBridge.js";
import { receptionistPrompt } from "./prompts/receptionist.js";
import { spanishCoachPrompt } from "./prompts/spanishCoach.js";
import { startCoachScheduler } from "./services/coachScheduler.js";
import { env } from "./config/env.js";
import { getCalendarAdapter } from "./services/calendar/index.js";
import {
  detectBookingIntent,
  parseDatePreference,
  parseName,
  parseReason,
  parseSlotChoice,
  parseTimePreference,
  type DatePreference,
  type ParsedTimePreference,
} from "./services/booking/bookingParser.js";
import { findAvailableSlots, type TimePreference } from "./services/booking/slotFinder.js";
import { sendSms } from "./services/twilioSms.js";
import {
  setUserInactiveById,
  updateCallLogBySid,
  updateUserLevel,
  getUserById,
} from "./services/coachDb.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const PORT = Number(process.env.PORT || 3000);

const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Optional health check
app.get("/", (_req, res) => res.status(200).send("OK"));

app.use(healthRouter);
app.use(twilioRouter);
app.use(coachRouter);

const server = http.createServer(app);

const wss = new WebSocketServer({ server });

// --- Helpers ---
function safeJsonParse(raw: WebSocket.RawData): any | null {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

function mapScoreToLevel(score: number) {
  if (score <= 25) return "A0";
  if (score <= 50) return "A1";
  if (score <= 75) return "A2";
  return "B1";
}

function computeScore(metrics: {
  spanishAnswers: number;
  spanishWithoutEnglish: number;
  simplifications: number;
}) {
  let score = 0;
  if (metrics.spanishWithoutEnglish >= 1) score += 20;
  if (metrics.spanishAnswers >= 2) score += 20;
  score -= metrics.simplifications * 10;
  return Math.max(0, Math.min(100, score));
}

function isSpanishAnswer(text: string) {
  const spanishWords = [
    "hola",
    "gracias",
    "quiero",
    "soy",
    "tengo",
    "me",
    "mi",
    "tu",
    "estoy",
    "bien",
    "sí",
    "si",
    "no",
    "por",
    "favor",
  ];
  return spanishWords.some((word) => new RegExp(`\\b${word}\\b`, "i").test(text));
}

function isEnglishAnswer(text: string) {
  const englishWords = ["the", "and", "please", "hello", "i", "you", "my", "is", "not"];
  return englishWords.some((word) => new RegExp(`\\b${word}\\b`, "i").test(text));
}

function extractTranscript(message: any): string | null {
  if (typeof message?.transcript === "string") return message.transcript;
  if (typeof message?.text === "string" && message?.type?.includes("transcription")) {
    return message.text;
  }
  if (typeof message?.type === "string" && message.type.includes("transcription")) {
    return message.transcript ?? null;
  }
  return null;
}

wss.on("connection", (twilioWs) => {
  console.log("Twilio Media Stream connected");

  let streamSid: string | null = null;
  let callSid: string | null = null;
  let userId: number | null = null;
  let callerPhone: string | null = null;
  let mode: "receptionist" | "spanish_coach" = "receptionist";
  let pendingGreeting = false;
  let openaiWs: WebSocket | null = null;
  let assistantBuffer = "";
  let optedOut = false;
  const bookingState: {
    active: boolean;
    name: string | null;
    reason: string | null;
    datePreference: DatePreference | null;
    timePreference: ParsedTimePreference | null;
    offeredSlots: Date[];
    awaitingChoice: boolean;
  } = {
    active: false,
    name: null,
    reason: null,
    datePreference: null,
    timePreference: null,
    offeredSlots: [],
    awaitingChoice: false,
  };

  const metrics = {
    simplifications: 0,
    repeats: 0,
    spanishAnswers: 0,
    spanishWithoutEnglish: 0,
  };

  const sendGreeting = () => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
      pendingGreeting = true;
      return;
    }

    pendingGreeting = false;
    const instructions =
      mode === "spanish_coach"
        ? "Start the Spanish coaching call now by saying: \"Hola {nombre}, ¿cómo estás?\" Use the learner's name if known; if you don't know it, ask and then use it. Wait for their response before asking the first simple question."
        : "Answer the phone in English with a warm greeting in one short sentence and ask how you can help.";

    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions,
        },
      })
    );
  };

  const noteAssistantText = (text: string) => {
    assistantBuffer += text;
  };

  const finalizeAssistantText = () => {
    if (mode !== "spanish_coach") {
      assistantBuffer = "";
      return;
    }

    const simplifiedPhrase = "Vamos a hacerlo más fácil.";
    const repeatPhrase = "Repito la pregunta.";
    const optOutPhrase = "No recibirás más llamadas";

    if (assistantBuffer.includes(simplifiedPhrase)) {
      metrics.simplifications += 1;
    }
    if (assistantBuffer.includes(repeatPhrase)) {
      metrics.repeats += 1;
    }
    if (assistantBuffer.includes(optOutPhrase)) {
      optedOut = true;
    }
    assistantBuffer = "";
  };

  const handleTranscript = (text: string) => {
    if (mode !== "spanish_coach") return;
    const normalized = text.trim();
    if (normalized.length < 2) return;
    if (isSpanishAnswer(normalized)) {
      metrics.spanishAnswers += 1;
      if (!isEnglishAnswer(normalized)) {
        metrics.spanishWithoutEnglish += 1;
      }
    }
  };

  const sendAssistantMessage = (message: string) => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: message,
        },
      })
    );
  };

  const formatSlot = (date: Date) => {
    const tz = env.DEFAULT_TIMEZONE ?? "America/Phoenix";
    return dayjs(date).tz(tz).format("dddd [at] h:mm A");
  };

  const resolveWindowForPreference = (preference: DatePreference | null) => {
    const tz = env.DEFAULT_TIMEZONE ?? "America/Phoenix";
    const now = dayjs().tz(tz);
    if (!preference) {
      return {
        windowStart: now.toDate(),
        windowEnd: now.add(7, "day").toDate(),
        label: "the next week",
      };
    }
    if (preference.type === "today") {
      return {
        windowStart: now.toDate(),
        windowEnd: now.endOf("day").toDate(),
        label: "today",
      };
    }
    if (preference.type === "tomorrow") {
      const target = now.add(1, "day").startOf("day");
      return {
        windowStart: target.toDate(),
        windowEnd: target.endOf("day").toDate(),
        label: "tomorrow",
      };
    }
    if (preference.type === "weekday") {
      let target = now.startOf("day");
      for (let i = 0; i < 7; i += 1) {
        const candidate = now.add(i, "day").startOf("day");
        if (candidate.day() === preference.weekday) {
          target = candidate;
          break;
        }
      }
      return {
        windowStart: target.toDate(),
        windowEnd: target.endOf("day").toDate(),
        label: target.format("dddd"),
      };
    }
    const parsed = dayjs(preference.dateISO).tz(tz);
    const target = parsed.isBefore(now, "day") ? parsed.add(1, "year") : parsed;
    return {
      windowStart: target.startOf("day").toDate(),
      windowEnd: target.endOf("day").toDate(),
      label: target.format("MMMM D"),
    };
  };

  const buildTimePreference = (pref: ParsedTimePreference | null): TimePreference => {
    if (!pref) return { type: "any" };
    if (pref.type === "morning") return { type: "morning" };
    if (pref.type === "afternoon") return { type: "afternoon" };
    if (pref.type === "specific") return { type: "specific", hour: pref.hour, minute: pref.minute };
    return { type: "any" };
  };

  const processReceptionistTranscript = async (text: string) => {
    const normalized = text.trim();
    if (!normalized) return;

    if (!bookingState.active) {
      if (!detectBookingIntent(normalized)) return;
      bookingState.active = true;
    }

    if (!bookingState.name) bookingState.name = parseName(normalized);
    if (!bookingState.reason && bookingState.name) {
      bookingState.reason = parseReason(normalized);
    }
    if (!bookingState.datePreference) {
      bookingState.datePreference = parseDatePreference(
        normalized,
        env.DEFAULT_TIMEZONE ?? "America/Phoenix"
      );
    }
    if (!bookingState.timePreference) bookingState.timePreference = parseTimePreference(normalized);

    if (bookingState.awaitingChoice) {
      const choice = parseSlotChoice(normalized);
      if (!choice || !bookingState.offeredSlots[choice - 1]) {
        sendAssistantMessage("Please say option one or option two.");
        return;
      }

      const selectedStart = bookingState.offeredSlots[choice - 1];
      const durationMinutes = env.APPT_DURATION_MINUTES ?? 30;
      const selectedEnd = new Date(selectedStart.getTime() + durationMinutes * 60 * 1000);
      const timezoneName = env.DEFAULT_TIMEZONE ?? "America/Phoenix";
      const businessName = env.BUSINESS_NAME ?? "our business";
      const summary = `Caller requested: ${bookingState.reason ?? "appointment"}.`;
      const description = [
        `Phone: ${callerPhone ?? "unknown"}`,
        `Reason: ${bookingState.reason ?? "Not provided"}`,
        `Summary: ${summary}`,
      ].join("\n");

      try {
        const adapter = getCalendarAdapter();
        await adapter.createEvent(selectedStart, selectedEnd, {
          title: `Call Booking – ${bookingState.name ?? "Caller"}`,
          description,
          location: "Phone call",
          timezone: timezoneName,
        });
      } catch (error) {
        console.log("Booking error:", error);
        sendAssistantMessage("Sorry, I ran into a scheduling issue. Let me try again later.");
        return;
      }

      if (callerPhone) {
        if (env.BOOKING_DRY_RUN) {
          console.log("BOOKING_DRY_RUN enabled. Skipping SMS send.", {
            to: callerPhone,
            time: selectedStart.toISOString(),
          });
        } else {
          try {
            const formatted = formatSlot(selectedStart);
            await sendSms(
              callerPhone,
              `You're booked with ${businessName} for ${formatted}. Reply to this text if you need to reschedule.`
            );
          } catch (error) {
            console.log("SMS send error:", error);
          }
        }
      }

      sendAssistantMessage(
        `You're booked for ${formatSlot(selectedStart)}. You'll get a confirmation text from ${businessName}.`
      );
      bookingState.active = false;
      bookingState.awaitingChoice = false;
      bookingState.offeredSlots = [];
      bookingState.name = null;
      bookingState.reason = null;
      bookingState.datePreference = null;
      bookingState.timePreference = null;
      return;
    }

    if (!bookingState.name) {
      sendAssistantMessage("Sure — may I have your name?");
      return;
    }
    if (!bookingState.reason) {
      sendAssistantMessage(`Thanks, ${bookingState.name}. What’s the reason for the appointment?`);
      return;
    }
    if (!bookingState.datePreference) {
      sendAssistantMessage("What day works best? Today, tomorrow, or another weekday?");
      return;
    }
    if (!bookingState.timePreference) {
      sendAssistantMessage("Do you prefer morning, afternoon, or a specific time?");
      return;
    }

    const { windowStart, windowEnd, label } = resolveWindowForPreference(bookingState.datePreference);
    let busyIntervals = [];
    try {
      const adapter = getCalendarAdapter();
      busyIntervals = await adapter.getAvailability(windowStart, windowEnd);
    } catch (error) {
      console.log("Availability error:", error);
      sendAssistantMessage("Sorry, I can't access the schedule right now.");
      return;
    }

    const slots = findAvailableSlots({
      busyIntervals,
      windowStart,
      windowEnd,
      durationMinutes: env.APPT_DURATION_MINUTES ?? 30,
      bufferMinutes: env.APPT_BUFFER_MINUTES ?? 10,
      timePreference: buildTimePreference(bookingState.timePreference),
      timezone: env.DEFAULT_TIMEZONE ?? "America/Phoenix",
    });

    if (slots.length < 2) {
      sendAssistantMessage(
        `I’m not seeing two openings ${label}. Would you like me to check another day?`
      );
      bookingState.timePreference = null;
      bookingState.datePreference = null;
      return;
    }

    bookingState.offeredSlots = slots;
    bookingState.awaitingChoice = true;
    sendAssistantMessage(
      `I can do ${formatSlot(slots[0])} or ${formatSlot(slots[1])}. Which works better?`
    );
  };

  // --- Twilio -> OpenAI ---
  twilioWs.on("message", (data) => {
    const msg = safeJsonParse(data);
    if (!msg) return;

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid ?? null;
      callSid = msg.start?.callSid ?? null;
      const params = msg.start?.customParameters ?? {};
      mode = params.mode === "spanish_coach" ? "spanish_coach" : "receptionist";
      userId = params.userId ? Number(params.userId) : null;
      callerPhone = typeof params.from === "string" ? params.from : null;

      console.log("Stream start", msg.start);

      if (!openaiWs) {
        let instructions = mode === "spanish_coach" ? spanishCoachPrompt : receptionistPrompt;
        if (mode === "spanish_coach" && userId) {
          const user = getUserById(userId);
          if (user?.call_instructions) {
            instructions = `${spanishCoachPrompt}\n\nUser call focus:\n${user.call_instructions}`;
          }
        }
        openaiWs = connectOpenAIRealtime({ instructions });

        openaiWs.on("open", () => {
          if (pendingGreeting) {
            sendGreeting();
          }
        });

        // --- OpenAI -> Twilio ---
        openaiWs.on("message", (openaiData) => {
          const openaiMsg = safeJsonParse(openaiData);
          if (!openaiMsg) return;

          if (
            openaiMsg.type === "session.created" ||
            openaiMsg.type === "session.updated" ||
            openaiMsg.type === "response.created" ||
            openaiMsg.type === "response.done" ||
            openaiMsg.type === "error"
          ) {
            console.log("OpenAI event:", openaiMsg.type);
            if (openaiMsg.type === "error") console.log("OpenAI error:", openaiMsg.error);
          }

          if (
            (openaiMsg.type === "response.audio.delta" ||
              openaiMsg.type === "output_audio_buffer.delta") &&
            streamSid
          ) {
            const payloadBase64 = openaiMsg.delta;

            if (twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(
                JSON.stringify({
                  event: "media",
                  streamSid,
                  media: { payload: payloadBase64 },
                })
              );
            }
          }

          if (openaiMsg.type === "response.text.delta") {
            noteAssistantText(openaiMsg.delta);
            process.stdout.write(openaiMsg.delta);
          }

          if (openaiMsg.type === "response.text.done") {
            finalizeAssistantText();
            process.stdout.write("\n");
          }

          const transcript = extractTranscript(openaiMsg);
          if (transcript) {
            if (mode === "spanish_coach") {
              handleTranscript(transcript);
            } else {
              processReceptionistTranscript(transcript).catch((error) =>
                console.log("Booking flow error:", error)
              );
            }
          }
        });

        openaiWs.on("close", () => console.log("OpenAI Realtime disconnected"));
        openaiWs.on("error", (err) => console.log("OpenAI WS error:", err));
      }

      // ✅ Force assistant to greet immediately (so caller doesn't have to speak first)
      sendGreeting();

      if (mode === "spanish_coach" && callSid) {
        updateCallLogBySid(callSid, { started_at: new Date().toISOString() });
      }

      return;
    }

    if (msg.event === "media") {
      const payloadBase64: string | undefined = msg.media?.payload;
      if (!payloadBase64 || !openaiWs) return;

      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: payloadBase64,
          })
        );
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("Stream stop", msg.stop);

      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      }

      if (mode === "spanish_coach" && callSid) {
        const score = computeScore(metrics);
        const level = mapScoreToLevel(score);
        const summary = `Spanish coach call complete. Score ${score}. Simplified ${
          metrics.simplifications
        } times.`;
        const metricsJson = JSON.stringify({
          score,
          level,
          ...metrics,
        });

        updateCallLogBySid(callSid, {
          ended_at: new Date().toISOString(),
          outcome: optedOut ? "opted_out" : "answered",
          summary,
          metrics_json: metricsJson,
        });

        if (userId) {
          updateUserLevel(userId, level);
          if (optedOut) {
            setUserInactiveById(userId);
          }
        }
      }

      try {
        openaiWs?.close();
      } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio WS closed");
    try {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    } catch {}
  });

  twilioWs.on("error", (err) => {
    console.log("Twilio WS error:", err);
    try {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    } catch {}
  });
});

startCoachScheduler();

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
