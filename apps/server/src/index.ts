// apps/server/src/index.ts
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

// If you already have TwiML routes elsewhere, keep them.
// This file focuses on the Media Stream websocket bridge.
app.use(healthRouter);
app.use(twilioRouter);

const server = http.createServer(app);

// Twilio connects to *your* websocket (the one you put in TwiML: <Stream url="wss://...">)
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

  // Connect to OpenAI Realtime for THIS call
  const openaiWs = connectOpenAIRealtime();

  // --- OpenAI -> Twilio (send audio back onto the phone call) ---
  openaiWs.on("message", (data) => {
    const msg = safeJsonParse(data);
    if (!msg) return;

    // Debug logging (keep light; you can expand if needed)
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

    // Audio chunks from OpenAI (base64)
    // Most common types you’ll see:
    // - "response.audio.delta"
    // - sometimes "output_audio_buffer.delta" depending on SDK/version
    if ((msg.type === "response.audio.delta" || msg.type === "output_audio_buffer.delta") && streamSid) {
      const payloadBase64 = msg.delta; // base64 audio chunk

      // Forward it to Twilio
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

    // Optional: see text in terminal while it speaks
    if (msg.type === "response.text.delta") {
      process.stdout.write(msg.delta);
    }
    if (msg.type === "response.text.done") {
      process.stdout.write("\n");
    }
  });

  openaiWs.on("close", () => {
    console.log("OpenAI Realtime disconnected");
    if (twilioWs.readyState === WebSocket.OPEN) {
      // Twilio can remain open, but usually you want to end cleanly if OpenAI dies.
      // You can also choose to do nothing here.
    }
  });

  openaiWs.on("error", (err) => {
    console.log("OpenAI WS error:", err);
  });

  // --- Twilio -> OpenAI (send caller audio into OpenAI) ---
  twilioWs.on("message", (data) => {
    const msg = safeJsonParse(data);
    if (!msg) return;

    // Twilio Media Streams events: connected, start, media, mark, stop
    if (msg.event === "start") {
      streamSid = msg.start?.streamSid ?? null;
      console.log("Stream start", msg.start);
      return;
    }

    if (msg.event === "media") {
      // msg.media.payload is base64 G.711 μ-law @ 8kHz
      const payloadBase64: string | undefined = msg.media?.payload;
      if (!payloadBase64) return;

      if (openaiWs.readyState === WebSocket.OPEN) {
        // Push audio into OpenAI’s input buffer
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
        // Commit any remaining audio (optional but nice)
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

        // If you're NOT using server_vad, you'd typically trigger a response here:
        // openaiWs.send(JSON.stringify({ type: "response.create" }));
        //
        // If you ARE using server_vad, OpenAI should auto-respond when it detects end of speech.
        // Still, creating a response on stop is fine if you want a final “goodbye” behavior.
      }

      // Close OpenAI connection for this call
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
