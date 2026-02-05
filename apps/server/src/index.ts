// apps/server/src/index.ts
import "./config/env.js";
import http from "http";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket, { WebSocketServer } from "ws";
import { healthRouter } from "./routes/health.js";
import { twilioRouter } from "./routes/twilio.js";
import { coachRouter } from "./routes/coach.js";
import { siteRouter } from "./routes/site.js";
import { connectOpenAIRealtime } from "./services/realtimeBridge.js";
import { env } from "./config/env.js";
import { receptionistPrompt } from "./prompts/receptionist.js";
import { spanishCoachPrompt } from "./prompts/spanishCoach.js";
import { startCoachScheduler } from "./services/coachScheduler.js";
import {
  BookingToolError,
  cancelAppointment,
  checkAvailability,
  createAppointment,
  findAppointment,
  type BookingCheckAvailabilityInput,
  type BookingCancelAppointmentInput,
  type BookingCreateAppointmentInput,
  type BookingCreateAppointmentOutput,
  type BookingFindAppointmentInput,
  type BookingUpdateAppointmentInput,
  updateAppointment,
} from "./services/booking/bookingTools.js";
import {
  setUserInactiveById,
  updateCallLogBySid,
  updateUserLevel,
  getUserById,
} from "./services/coachDb.js";
import { sendSms } from "./services/twilioSms.js";

const PORT = Number(process.env.PORT || 3000);

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const assetsDir = path.join(__dirname, "../assets");

app.set("trust proxy", true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use("/assets", express.static(assetsDir));

// Optional health check
app.use(siteRouter);
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

function formatDurationMs(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function formatCallDateTime(iso: string | null) {
  if (!iso) return "Unknown time";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function normalizeReason(reason: string | null) {
  const trimmed = reason?.trim();
  if (!trimmed) return "General inquiry.";
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
}

function isDialableNumber(phone: string | null) {
  if (!phone) return false;
  const normalized = phone.trim();
  if (!normalized || normalized.toLowerCase() === "anonymous") return false;
  return /^\+?[1-9]\d{6,}$/.test(normalized);
}

const sentPostCallSummaries = new Set<string>();

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

function isBookingCreateAppointmentInput(
  value: unknown
): value is BookingCreateAppointmentInput {
  if (!value || typeof value !== "object") {
    return false;
  }

  const input = value as {
    startISO?: unknown;
    endISO?: unknown;
    name?: unknown;
    reason?: unknown;
    phone?: unknown;
    timezone?: unknown;
  };

  return (
    typeof input.startISO === "string" &&
    typeof input.endISO === "string" &&
    typeof input.name === "string" &&
    typeof input.reason === "string" &&
    (input.phone === undefined || typeof input.phone === "string") &&
    (input.timezone === undefined || typeof input.timezone === "string")
  );
}

function isBookingFindAppointmentInput(
  value: unknown
): value is BookingFindAppointmentInput {
  if (!value || typeof value !== "object") {
    return false;
  }
  const input = value as {
    startISO?: unknown;
    timezone?: unknown;
    name?: unknown;
    daysAhead?: unknown;
  };
  return (
    (input.startISO === undefined || typeof input.startISO === "string") &&
    (input.timezone === undefined || typeof input.timezone === "string") &&
    (input.name === undefined || typeof input.name === "string") &&
    (input.daysAhead === undefined || typeof input.daysAhead === "number")
  );
}

function isBookingUpdateAppointmentInput(
  value: unknown
): value is BookingUpdateAppointmentInput {
  if (!value || typeof value !== "object") {
    return false;
  }
  const input = value as {
    eventId?: unknown;
    startISO?: unknown;
    endISO?: unknown;
    summary?: unknown;
    description?: unknown;
    timezone?: unknown;
  };
  return (
    typeof input.eventId === "string" &&
    typeof input.startISO === "string" &&
    typeof input.endISO === "string" &&
    (input.summary === undefined || typeof input.summary === "string") &&
    (input.description === undefined || typeof input.description === "string") &&
    (input.timezone === undefined || typeof input.timezone === "string")
  );
}

function isBookingCancelAppointmentInput(
  value: unknown
): value is BookingCancelAppointmentInput {
  if (!value || typeof value !== "object") {
    return false;
  }
  const input = value as { eventId?: unknown };
  return typeof input.eventId === "string";
}

wss.on("connection", (twilioWs) => {
  console.log("Twilio Media Stream connected");

  let streamSid: string | null = null;
  let callSid: string | null = null;
  let conversationId: string | null = null;
  let userId: number | null = null;
  let callerPhone: string | null = null;
  let mode: "receptionist" | "spanish_coach" = "receptionist";
  let pendingGreeting = false;
  let openaiWs: WebSocket | null = null;
  let assistantBuffer = "";
  let optedOut = false;
  const processedToolCalls = new Map<string, unknown>();
  const inflightToolCalls = new Set<string>();
  const recentAppointments = new Map<
    string,
    { timestamp: number; result: BookingCreateAppointmentOutput }
  >();
  const appointmentDedupeWindowMs = 2 * 60 * 1000;
  const bookingClaimRegex = /\b(appointment\s+)?(booked|scheduled|confirmed|set up|locked in)\b/i;
  let lastBookingCreateResult: BookingCreateAppointmentOutput | null = null;
  let lastBookingCreateCallId: string | null = null;
  let bookingCorrectionSent = false;

  const metrics = {
    simplifications: 0,
    repeats: 0,
    spanishAnswers: 0,
    spanishWithoutEnglish: 0,
  };

  const callSummaryState = {
    callSid: null as string | null,
    callerPhone: null as string | null,
    businessPhone: null as string | null,
    startTimeMs: null as number | null,
    endTimeMs: null as number | null,
    callerName: null as string | null,
    primaryReason: null as string | null,
    appointmentStartISO: null as string | null,
    appointmentBooked: null as boolean | null,
    appointmentRequested: false,
    followUpNote: null as string | null,
  };

  const captureReason = (reason: string | null) => {
    if (reason) {
      callSummaryState.primaryReason = reason;
    }
  };

  const captureCallerName = (name: string | null) => {
    if (name && !callSummaryState.callerName) {
      callSummaryState.callerName = name;
    }
  };

  const markFollowUp = (note: string) => {
    if (!callSummaryState.followUpNote) {
      callSummaryState.followUpNote = note;
    }
  };

  const buildOwnerSummaryBody = () => {
    const callerName = callSummaryState.callerName?.trim() || "Unknown caller";
    const callerNumber = callSummaryState.callerPhone ?? "Unknown number";
    const reason = normalizeReason(callSummaryState.primaryReason);
    const outcome = callSummaryState.appointmentBooked
      ? `Outcome: Appointment booked: ${formatCallDateTime(
          callSummaryState.appointmentStartISO
        )}`
      : "Outcome: No appointment booked";
    const followUp =
      callSummaryState.followUpNote ||
      (callSummaryState.appointmentRequested && !callSummaryState.appointmentBooked
        ? "Confirm next steps with the caller."
        : null);
    const duration =
      callSummaryState.startTimeMs && callSummaryState.endTimeMs
        ? formatDurationMs(callSummaryState.endTimeMs - callSummaryState.startTimeMs)
        : "Unknown duration";

    const lines = [
      "Call summary",
      `Caller: ${callerName} (${callerNumber})`,
      `Reason: ${reason}`,
      outcome,
      followUp ? `Follow-up: ${followUp}` : null,
      `Duration: ${duration}`,
    ].filter(Boolean);

    return lines.join("\n");
  };

  const buildCallerSummaryBody = () => {
    const businessName = env.BUSINESS_NAME ?? "our office";
    const reason = normalizeReason(callSummaryState.primaryReason);
    const outcome = callSummaryState.appointmentBooked
      ? `Outcome: Appointment booked: ${formatCallDateTime(
          callSummaryState.appointmentStartISO
        )}`
      : "Outcome: No appointment booked";
    const followUp =
      callSummaryState.followUpNote ||
      (callSummaryState.appointmentRequested && !callSummaryState.appointmentBooked
        ? "Please contact us if you'd like to schedule."
        : null);
    const duration =
      callSummaryState.startTimeMs && callSummaryState.endTimeMs
        ? formatDurationMs(callSummaryState.endTimeMs - callSummaryState.startTimeMs)
        : "Unknown duration";

    const lines = [
      `Thanks for calling ${businessName}.`,
      `We noted: ${reason}`,
      outcome,
      followUp ? `Next steps: ${followUp}` : null,
      `Call duration: ${duration}`,
    ].filter(Boolean);

    return lines.join("\n");
  };

  const sendPostCallSmsSummaries = async () => {
    if (!env.ENABLE_POST_CALL_SMS) {
      console.log("Post-call SMS skipped: ENABLE_POST_CALL_SMS is disabled");
      return;
    }
    if (mode !== "receptionist") {
      console.log("Post-call SMS skipped: not in receptionist mode");
      return;
    }
    if (!callSummaryState.callSid) {
      console.log("Post-call SMS skipped: missing callSid");
      return;
    }
    if (sentPostCallSummaries.has(callSummaryState.callSid)) {
      console.log("Post-call SMS skipped: already sent for callSid", callSummaryState.callSid);
      return;
    }

    const ownerPhone = env.BUSINESS_OWNER_PHONE;
    const ownerBody = buildOwnerSummaryBody();
    const callerBody = buildCallerSummaryBody();
    console.log("Post-call SMS body (owner):", ownerBody);
    console.log("Post-call SMS body (caller):", callerBody);

    let attemptedSend = false;

    if (!ownerPhone) {
      console.log("Post-call SMS skipped: missing BUSINESS_OWNER_PHONE");
    } else {
      attemptedSend = true;
      try {
        const ownerMessage = await sendSms(ownerPhone, ownerBody);
        console.log("SMS summary sent (owner)", { sid: ownerMessage.sid });
      } catch (error) {
        console.log("SMS summary failed (owner)", error);
      }
    }

    const sendSummaryToCaller = env.SEND_SUMMARY_TO_CALLER ?? false;
    if (sendSummaryToCaller && isDialableNumber(callSummaryState.callerPhone)) {
      attemptedSend = true;
      try {
        const callerMessage = await sendSms(callSummaryState.callerPhone!, callerBody);
        console.log("SMS summary sent (caller)", { sid: callerMessage.sid });
      } catch (error) {
        console.log("SMS summary failed (caller)", error);
      }
    } else if (sendSummaryToCaller) {
      console.log("Post-call SMS skipped: invalid caller phone", callSummaryState.callerPhone);
    } else {
      console.log("Post-call SMS skipped: SEND_SUMMARY_TO_CALLER is disabled");
    }

    if (attemptedSend) {
      sentPostCallSummaries.add(callSummaryState.callSid);
    }
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
      const assistantText = assistantBuffer.trim();
      if (assistantText.length > 0) {
        console.log("🗣️ assistant response", { text: assistantText });
        const bookingClaimed = bookingClaimRegex.test(assistantText);
        const bookingConfirmed = lastBookingCreateResult?.created === true;
        if (bookingClaimed && !bookingConfirmed) {
          console.log("⚠️ booking claim without confirmed appointment", {
            assistantText,
            lastBookingCreateCallId,
            lastBookingCreateResult,
          });
          const reason = lastBookingCreateResult?.dryRun
            ? "Just to clarify, I'm in test mode and couldn't finalize that booking. Would you like to leave a message or have someone follow up?"
            : "Just to clarify, that appointment is not booked yet. Would you like to leave a message or have someone follow up?";
          sendBookingCorrection(reason);
        }
      }
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

  const sendToolOutput = (toolCallId: string, output: unknown) => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    openaiWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: toolCallId,
          output: JSON.stringify(output),
        },
      })
    );
  };

  const sendToolOutputCached = (toolCallId: string, output: unknown) => {
    processedToolCalls.set(toolCallId, output);
    inflightToolCalls.delete(toolCallId);
    sendToolOutput(toolCallId, output);
  };

  const sendCalendarFiller = (toolName: string, toolCallId: string) => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    const fillerSentence = "One moment while I check the calendar.";
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: `Say exactly this one short sentence to the caller: "${fillerSentence}"`,
        },
      })
    );
    console.log("🗣️ calendar filler emitted before tool call", { toolName, toolCallId });
  };

  const sendBookingFailureResponse = (options: { reason: string }) => {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    const instructions = `Tell the caller: "${options.reason}" Keep it short and offer to take a message or have someone follow up.`;
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

  const sendBookingFailureNotice = (result: BookingCreateAppointmentOutput) => {
    if (result.created) return;
    const message = result.dryRun
      ? "I'm in test mode, so I can't finalize that booking. Would you like to leave a message or have someone follow up?"
      : "I wasn't able to book that appointment right now. Would you like to leave a message or have someone follow up?";
    sendBookingFailureResponse({ reason: message });
  };

  const sendBookingCorrection = (reason: string) => {
    if (bookingCorrectionSent) return;
    bookingCorrectionSent = true;
    console.log("⚠️ booking clarification sent", { reason });
    sendBookingFailureResponse({ reason });
  };

  const logBookingCreateResult = (
    result: BookingCreateAppointmentOutput,
    context: { toolCallId: string; dedupeKey?: string | null }
  ) => {
    console.log("📅 booking_create_appointment result", {
      toolCallId: context.toolCallId,
      dedupeKey: context.dedupeKey ?? null,
      created: result.created,
      dryRun: result.dryRun,
      startISO: result.startISO,
      endISO: result.endISO,
      eventId: result.eventId ?? null,
    });
    if (!result.created) {
      console.log("⚠️ booking_create_appointment not created", {
        toolCallId: context.toolCallId,
        dryRun: result.dryRun,
        hint: result.dryRun
          ? "BOOKING_DRY_RUN is true; calendar events are not created."
          : "Calendar adapter did not confirm event creation. Check calendar credentials/logs.",
      });
    }
  };

  const buildAppointmentDedupeKey = (startISO: string, endISO: string) => {
    const sessionId = callSid ?? streamSid ?? "unknown-session";
    return `${sessionId}:${startISO}:${endISO}`;
  };

  const buildIdempotencySource = () => {
    return callSid ?? streamSid ?? conversationId ?? "unknown-session";
  };

  const handleToolCall = async (toolCall: {
    name: string;
    callId: string;
    arguments: unknown;
  }) => {
    const cachedOutput = processedToolCalls.get(toolCall.callId);
    if (cachedOutput) {
      console.log("🔁 tool_call_id dedupe hit", {
        toolCallId: toolCall.callId,
        toolName: toolCall.name,
        cachedOutput,
      });
      sendToolOutput(toolCall.callId, cachedOutput);
      return;
    }
    if (inflightToolCalls.has(toolCall.callId)) {
      console.log("⏳ tool_call_id inflight; skipping duplicate", {
        toolCallId: toolCall.callId,
        toolName: toolCall.name,
      });
      return;
    }
    inflightToolCalls.add(toolCall.callId);

    if (
      toolCall.name === "booking_check_availability" ||
      toolCall.name === "booking_create_appointment" ||
      toolCall.name === "find_event" ||
      toolCall.name === "update_event" ||
      toolCall.name === "cancel_event"
    ) {
      sendCalendarFiller(toolCall.name, toolCall.callId);
    }

    console.log("🧰 tool call received", {
      toolName: toolCall.name,
      toolCallId: toolCall.callId,
      rawArguments: toolCall.arguments,
    });
    let parsedArgs: Record<string, unknown> = {};
    if (typeof toolCall.arguments === "string" && toolCall.arguments.trim().length > 0) {
      try {
        parsedArgs = JSON.parse(toolCall.arguments);
      } catch (error) {
        sendToolOutputCached(toolCall.callId, {
          error: { code: "invalid_arguments", message: "Could not parse tool arguments." },
        });
        console.log("Tool arguments parse error:", error);
        return;
      }
    } else if (typeof toolCall.arguments === "object" && toolCall.arguments !== null) {
      parsedArgs = toolCall.arguments as Record<string, unknown>;
    }
    console.log("🧰 tool call parsed", {
      toolName: toolCall.name,
      toolCallId: toolCall.callId,
      parsedArgs,
    });

    try {
      if (toolCall.name === "booking_check_availability") {
        const result = await checkAvailability(parsedArgs as BookingCheckAvailabilityInput);
        sendToolOutputCached(toolCall.callId, result);
        return;
      }
      if (toolCall.name === "booking_create_appointment") {
        if (!isBookingCreateAppointmentInput(parsedArgs)) {
          sendToolOutputCached(toolCall.callId, {
            error: {
              code: "invalid_arguments",
              message:
                "Missing required appointment fields: startISO, endISO, name, reason.",
            },
          });
          return;
        }
        const typedArgs = parsedArgs as BookingCreateAppointmentInput;
        callSummaryState.appointmentRequested = true;
        captureCallerName(typedArgs.name);
        captureReason(typedArgs.reason);
        const idempotencySource = buildIdempotencySource();
        const dedupeKey = buildAppointmentDedupeKey(typedArgs.startISO, typedArgs.endISO);
        const existing = recentAppointments.get(dedupeKey);
        const now = Date.now();
        if (existing && now - existing.timestamp < appointmentDedupeWindowMs) {
          console.log("📅 appointment dedupe hit; skipping calendar insert", {
            dedupeKey,
            toolCallId: toolCall.callId,
          });
          lastBookingCreateResult = existing.result;
          lastBookingCreateCallId = toolCall.callId;
          bookingCorrectionSent = false;
          logBookingCreateResult(existing.result, {
            toolCallId: toolCall.callId,
            dedupeKey,
          });
          sendToolOutputCached(toolCall.callId, existing.result);
          return;
        }

        recentAppointments.delete(dedupeKey);
        const result = await createAppointment({
          ...typedArgs,
          idempotencySource,
          toolCallId: toolCall.callId,
        });
        recentAppointments.set(dedupeKey, { timestamp: now, result });
        console.log("📅 appointment recorded for dedupe window", {
          dedupeKey,
          toolCallId: toolCall.callId,
        });
        lastBookingCreateResult = result;
        lastBookingCreateCallId = toolCall.callId;
        bookingCorrectionSent = false;
        logBookingCreateResult(result, { toolCallId: toolCall.callId, dedupeKey });
        callSummaryState.appointmentBooked = result.created;
        callSummaryState.appointmentStartISO = result.startISO;
        sendToolOutputCached(toolCall.callId, result);
        sendBookingFailureNotice(result);
        return;
      }
      if (toolCall.name === "find_event") {
        if (!isBookingFindAppointmentInput(parsedArgs)) {
          sendToolOutputCached(toolCall.callId, {
            error: {
              code: "invalid_arguments",
              message: "Invalid appointment lookup request.",
            },
          });
          return;
        }
        callSummaryState.appointmentRequested = true;
        captureReason("Locate an existing appointment.");
        const result = await findAppointment(parsedArgs as BookingFindAppointmentInput);
        if (!result.matches.length) {
          markFollowUp("No matching appointment found.");
        }
        sendToolOutputCached(toolCall.callId, result);
        return;
      }
      if (toolCall.name === "update_event") {
        if (!isBookingUpdateAppointmentInput(parsedArgs)) {
          sendToolOutputCached(toolCall.callId, {
            error: {
              code: "invalid_arguments",
              message: "Missing required update fields: eventId, startISO, endISO.",
            },
          });
          return;
        }
        callSummaryState.appointmentRequested = true;
        captureReason("Reschedule an existing appointment.");
        const result = await updateAppointment(parsedArgs as BookingUpdateAppointmentInput);
        callSummaryState.appointmentBooked = result.updated;
        callSummaryState.appointmentStartISO = result.startISO;
        sendToolOutputCached(toolCall.callId, result);
        return;
      }
      if (toolCall.name === "cancel_event") {
        if (!isBookingCancelAppointmentInput(parsedArgs)) {
          sendToolOutputCached(toolCall.callId, {
            error: {
              code: "invalid_arguments",
              message: "Missing required cancel fields: eventId.",
            },
          });
          return;
        }
        callSummaryState.appointmentRequested = true;
        captureReason("Cancel an existing appointment.");
        const result = await cancelAppointment(parsedArgs as BookingCancelAppointmentInput);
        if (!result.cancelled) {
          markFollowUp("Cancellation not confirmed.");
        } else {
          callSummaryState.appointmentBooked = false;
        }
        sendToolOutputCached(toolCall.callId, result);
        return;
      }

      sendToolOutputCached(toolCall.callId, {
        error: { code: "unknown_tool", message: `Unknown tool: ${toolCall.name}` },
      });
    } catch (error) {
      if (error instanceof BookingToolError) {
        sendToolOutputCached(toolCall.callId, {
          error: { code: error.code, message: error.message },
        });
        if (toolCall.name === "booking_create_appointment") {
          sendBookingFailureResponse({
            reason:
              "I couldn't book that appointment right now. Would you like to leave a message or have someone follow up?",
          });
        }
        return;
      }
      sendToolOutputCached(toolCall.callId, {
        error: { code: "booking_error", message: "Booking tool failed." },
      });
      console.log("Tool execution error:", error);
    }
  };

  const extractToolCall = (message: any) => {
    if (message?.type === "response.function_call_arguments.done") {
      return {
        name: message.name as string,
        callId: message.call_id as string,
        arguments: message.arguments as string,
      };
    }

    if (
      message?.type === "response.output_item.done" &&
      (message?.item?.type === "function_call" || message?.item?.type === "tool_call")
    ) {
      return {
        name: message.item.name as string,
        callId: (message.item.call_id ?? message.item.tool_call_id) as string,
        arguments: message.item.arguments as string,
      };
    }

    return null;
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
      const businessPhone = typeof params.to === "string" ? params.to : null;

      callSummaryState.callSid = callSid;
      callSummaryState.callerPhone = callerPhone;
      callSummaryState.businessPhone = businessPhone;
      callSummaryState.startTimeMs = Date.now();
      callSummaryState.endTimeMs = null;
      lastBookingCreateResult = null;
      lastBookingCreateCallId = null;
      bookingCorrectionSent = false;

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

          if (!conversationId) {
            conversationId =
              (typeof openaiMsg.conversation_id === "string"
                ? openaiMsg.conversation_id
                : typeof openaiMsg.conversationId === "string"
                  ? openaiMsg.conversationId
                  : null) ?? conversationId;
          }

          const toolCall = extractToolCall(openaiMsg);
          if (toolCall) {
            handleToolCall(toolCall).catch((error) => console.log("Tool handler error:", error));
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
      if (!callSid && typeof msg.stop?.callSid === "string") {
        callSid = msg.stop.callSid;
        callSummaryState.callSid = callSid;
      }
      callSummaryState.endTimeMs = Date.now();

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

      sendPostCallSmsSummaries().catch((error) =>
        console.log("Post-call SMS summary error", error)
      );
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
