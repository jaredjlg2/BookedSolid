// apps/server/src/index.ts
import "./config/env.js";
import http from "http";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import { healthRouter } from "./routes/health.js";
import { twilioRouter } from "./routes/twilio.js";
import { coachRouter } from "./routes/coach.js";
import { connectOpenAIRealtime } from "./services/realtimeBridge.js";
import { receptionistPrompt } from "./prompts/receptionist.js";
import { spanishCoachPrompt } from "./prompts/spanishCoach.js";
import { startCoachScheduler } from "./services/coachScheduler.js";
import {
  BookingToolError,
  checkAvailability,
  createAppointment,
  type BookingCheckAvailabilityInput,
  type BookingCreateAppointmentInput,
} from "./services/booking/bookingTools.js";
import {
  setUserInactiveById,
  updateCallLogBySid,
  updateUserLevel,
  getUserById,
} from "./services/coachDb.js";

const PORT = Number(process.env.PORT || 3000);

const app = express();

app.set("trust proxy", true);
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

  const handleToolCall = async (toolCall: {
    name: string;
    callId: string;
    arguments: unknown;
  }) => {
    let parsedArgs: Record<string, unknown> = {};
    if (typeof toolCall.arguments === "string" && toolCall.arguments.trim().length > 0) {
      try {
        parsedArgs = JSON.parse(toolCall.arguments);
      } catch (error) {
        sendToolOutput(toolCall.callId, {
          error: { code: "invalid_arguments", message: "Could not parse tool arguments." },
        });
        console.log("Tool arguments parse error:", error);
        return;
      }
    } else if (typeof toolCall.arguments === "object" && toolCall.arguments !== null) {
      parsedArgs = toolCall.arguments as Record<string, unknown>;
    }

    try {
      if (toolCall.name === "booking_check_availability") {
        const result = await checkAvailability(parsedArgs as BookingCheckAvailabilityInput);
        sendToolOutput(toolCall.callId, result);
        return;
      }
      if (toolCall.name === "booking_create_appointment") {
        if (!isBookingCreateAppointmentInput(parsedArgs)) {
          sendToolOutput(toolCall.callId, {
            error: {
              code: "invalid_arguments",
              message:
                "Missing required appointment fields: startISO, endISO, name, reason.",
            },
          });
          return;
        }
        const result = await createAppointment(parsedArgs);
        sendToolOutput(toolCall.callId, result);
        return;
      }

      sendToolOutput(toolCall.callId, {
        error: { code: "unknown_tool", message: `Unknown tool: ${toolCall.name}` },
      });
    } catch (error) {
      if (error instanceof BookingToolError) {
        sendToolOutput(toolCall.callId, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      sendToolOutput(toolCall.callId, {
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
