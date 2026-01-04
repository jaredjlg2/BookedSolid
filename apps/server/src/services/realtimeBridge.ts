import WebSocket from "ws";
import { receptionistPrompt } from "../prompts/receptionist";

interface RealtimeOptions {
  instructions?: string;
}

export function connectOpenAIRealtime(options: RealtimeOptions = {}): WebSocket {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const model = process.env.OPENAI_REALTIME_MODEL ?? "gpt-4o-mini-realtime-preview";
  const url = `wss://api.openai.com/v1/realtime?model=${model}`;
  const instructions = options.instructions ?? receptionistPrompt;

  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  ws.on("open", () => {
    console.log("✅ OpenAI Realtime connected");

    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          instructions,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: { model: "whisper-1" },
          voice: "verse",
          turn_detection: { type: "server_vad" },
        },
      })
    );
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type) {
        console.log("OpenAI event:", msg.type);
      }

      if (msg.error) {
        console.log("OpenAI error:", msg.error);
      }
    } catch {
      console.log("OpenAI message (non-JSON):", data.toString());
    }
  });

  ws.on("close", () => {
    console.log("🛑 OpenAI Realtime disconnected");
  });

  ws.on("error", (err) => {
    console.log("OpenAI Realtime error:", err);
  });

  return ws;
}
