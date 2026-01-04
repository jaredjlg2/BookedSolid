// apps/server/src/index.ts
import "./config/env";
import http from "http";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import { healthRouter } from "./routes/health";
import { twilioRouter } from "./routes/twilio";
import { connectOpenAIRealtime } from "./services/realtimeBridge";

const PORT = Number(process.env.PORT || 3000);

const app = express();

app.use(express.urlencoded({ extended: false }));

// Optional health check
app.get("/", (_req, res) => res.status(200).send("OK"));

app.use(healthRouter);
app.use(twilioRouter);

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

wss.on("connection", (twilioWs) => {
  console.log("Twilio Media Stream connected");

  let streamSid: string | null = null;

  const openaiWs = connectOpenAIRealtime();

  // --- OpenAI -> Twilio ---
  openaiWs.on("message", (data) => {
    const msg = safeJsonParse(data);
    if (!msg) return;

    if (
      msg.type === "session.created" ||
      msg.type === "session.updated" ||
      msg.type === "response.created" ||
      msg.type === "response.done" ||
      msg.type === "error"
    ) {
      console.log("OpenAI event:", msg.type);
      if (msg.type === "error") console.log("OpenAI error:", msg.error);
    }

    if (
      (msg.type === "response.audio.delta" ||
        msg.type === "output_audio_buffer.delta") &&
      streamSid
    ) {
      const payloadBase64 = msg.delta;

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

    if (msg.type === "response.text.delta") process.stdout.write(msg.delta);
    if (msg.type === "response.text.done") process.stdout.write("\n");
  });

  openaiWs.on("close", () => console.log("OpenAI Realtime disconnected"));
  openaiWs.on("error", (err) => console.log("OpenAI WS error:", err));

  // --- Twilio -> OpenAI ---
  twilioWs.on("message", (data) => {
    const msg = safeJsonParse(data);
    if (!msg) return;

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid ?? null;
      console.log("Stream start", msg.start);

      // ✅ Force assistant to greet immediately (so caller doesn't have to speak first)
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(
          JSON.stringify({
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              instructions:
                "Answer the phone with a warm greeting in one short sentence and ask how you can help.",
            },
          })
        );
      }

      return;
    }

    if (msg.event === "media") {
      const payloadBase64: string | undefined = msg.media?.payload;
      if (!payloadBase64) return;

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

      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      }

      try {
        openaiWs.close();
      } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio WS closed");
    try {
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    } catch {}
  });

  twilioWs.on("error", (err) => {
    console.log("Twilio WS error:", err);
    try {
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
