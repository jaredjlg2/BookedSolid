import WebSocket from "ws";

export function connectOpenAIRealtime(): WebSocket {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const url = "wss://api.openai.com/v1/realtime?model=gpt-realtime";

  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      // Optional, but harmless if included:
      // "OpenAI-Beta": "realtime=v1",
    },
  });

  ws.on("open", () => {
    console.log("✅ OpenAI Realtime connected");

    // REQUIRED: session.type must be set
    ws.send(
  JSON.stringify({
    type: "session.update",
    session: {
      type: "realtime",
      model: "gpt-realtime",
      instructions:
        "You are a professional phone receptionist. Be brief, friendly, and ask how you can help.",
      output_modalities: ["audio", "text"],
      // Try to match Twilio:
      input_audio_format: "g711_ulaw",
      output_audio_format: "g711_ulaw",
      voice: "alloy",
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
