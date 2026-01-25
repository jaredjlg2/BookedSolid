import WebSocket from "ws";
import { receptionistPrompt } from "../prompts/receptionist.js";

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
          tools: [
            {
              type: "function",
              name: "booking_check_availability",
              description: "Check calendar availability and return up to two open slots.",
              parameters: {
                type: "object",
                properties: {
                  dayISO: {
                    type: "string",
                    description: "Optional day in ISO format (YYYY-MM-DD) to check.",
                  },
                  startISO: {
                    type: "string",
                    description:
                      "Optional exact start time in ISO format. Use for specific-time availability checks.",
                  },
                  endISO: {
                    type: "string",
                    description:
                      "Optional exact end time in ISO format. Defaults to startISO + duration.",
                  },
                  timezone: {
                    type: "string",
                    description: "IANA timezone name (e.g., America/Phoenix).",
                  },
                  window: {
                    type: "object",
                    properties: {
                      startHour: { type: "number" },
                      endHour: { type: "number" },
                    },
                    description: "Optional business hours window.",
                  },
                  durationMinutes: { type: "number" },
                },
                required: [],
              },
            },
            {
              type: "function",
              name: "booking_create_appointment",
              description: "Create a calendar appointment for a confirmed slot.",
              parameters: {
                type: "object",
                properties: {
                  startISO: { type: "string" },
                  endISO: { type: "string" },
                  name: { type: "string" },
                  reason: { type: "string" },
                  phone: { type: "string" },
                  timezone: { type: "string" },
                },
                required: ["startISO", "endISO", "name", "reason"],
              },
            },
            {
              type: "function",
              name: "find_event",
              description: "Find a calendar event matching a requested appointment time.",
              parameters: {
                type: "object",
                properties: {
                  startISO: {
                    type: "string",
                    description: "Target appointment start time in ISO format.",
                  },
                  timezone: {
                    type: "string",
                    description: "IANA timezone name (e.g., America/Phoenix).",
                  },
                  name: {
                    type: "string",
                    description: "Optional caller name to match against event summary.",
                  },
                  daysAhead: {
                    type: "number",
                    description: "Optional number of days ahead to search (default 30).",
                  },
                },
                required: [],
              },
            },
            {
              type: "function",
              name: "update_event",
              description: "Update an existing calendar event time/details.",
              parameters: {
                type: "object",
                properties: {
                  eventId: { type: "string" },
                  startISO: { type: "string" },
                  endISO: { type: "string" },
                  summary: { type: "string" },
                  description: { type: "string" },
                  timezone: { type: "string" },
                },
                required: ["eventId", "startISO", "endISO"],
              },
            },
            {
              type: "function",
              name: "cancel_event",
              description: "Cancel an existing calendar event.",
              parameters: {
                type: "object",
                properties: {
                  eventId: { type: "string" },
                },
                required: ["eventId"],
              },
            },
          ],
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
