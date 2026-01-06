// apps/server/src/index.ts
import "./config/env";
import http from "http";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import { healthRouter } from "./routes/health";
import { twilioRouter } from "./routes/twilio";
import { coachRouter } from "./routes/coach";
import { connectOpenAIRealtime } from "./services/realtimeBridge";
import { receptionistPrompt } from "./prompts/receptionist";
import { spanishCoachPrompt } from "./prompts/spanishCoach";
import { startCoachScheduler } from "./services/coachScheduler";
import {
  setUserInactiveById,
  updateCallLogBySid,
  updateUserLevel,
  getUserById,
} from "./services/coachDb";

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
        ? "Start the Spanish coaching call now with a brief Spanish greeting, then ask one very simple question."
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
            handleTranscript(transcript);
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
