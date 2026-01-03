import { Router } from "express";

export const twilioRouter = Router();

twilioRouter.post("/twilio/voice", (req, res) => {
  const streamUrl = "wss://tracie-unsmuggled-vena.ngrok-free.dev/twilio/stream";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Connecting you now.</Say>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});
