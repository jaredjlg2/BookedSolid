import { Router } from "express";

export const twilioRouter = Router();

// Twilio will POST here when a call comes in.
// For now, we just return simple TwiML so you can prove end-to-end wiring.
twilioRouter.post("/twilio/voice", (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thanks for calling. Our automated receptionist is coming online.</Say>
  <Pause length="1"/>
  <Say voice="alice">Please call back soon.</Say>
</Response>`;

  res.type("text/xml").send(twiml);
});
