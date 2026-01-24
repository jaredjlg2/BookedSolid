import { Router } from "express";
import { buildStreamUrl } from "../services/coachTwilio.js";
import { setUserInactiveById, updateCallLogBySid } from "../services/coachDb.js";

export const twilioRouter = Router();

function buildVoiceResponse({
  streamUrl,
  mode,
  userId,
  greeting,
  fromNumber,
}: {
  streamUrl: string;
  mode: string;
  userId?: string;
  greeting: string;
  fromNumber?: string;
}) {
  const params = [
    `<Parameter name="mode" value="${mode}" />`,
    userId ? `<Parameter name="userId" value="${userId}" />` : "",
    fromNumber ? `<Parameter name="from" value="${fromNumber}" />` : "",
  ]
    .filter(Boolean)
    .join("\n    ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${greeting}</Say>
  <Connect>
    <Stream url="${streamUrl}">
    ${params}
    </Stream>
  </Connect>
</Response>`;
}

twilioRouter.post("/twilio/voice", (req, res) => {
  const streamUrl = buildStreamUrl("/twilio/stream");

  const twiml = buildVoiceResponse({
    streamUrl,
    mode: "receptionist",
    greeting: "Connecting you now.",
    fromNumber: req.body?.From as string | undefined,
  });

  res.type("text/xml").send(twiml);
});

twilioRouter.post("/twilio/coach/voice", (req, res) => {
  const streamUrl = buildStreamUrl("/twilio/stream/coach");
  const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;

  const twiml = buildVoiceResponse({
    streamUrl,
    mode: "spanish_coach",
    userId,
    greeting: "Conectando con tu coach de español.",
  });

  res.type("text/xml").send(twiml);
});

twilioRouter.post("/twilio/coach/status", (req, res) => {
  const callSid = req.body?.CallSid as string | undefined;
  const callStatus = req.body?.CallStatus as string | undefined;
  const userId = req.query.userId ? Number(req.query.userId) : undefined;

  if (callSid && callStatus) {
    if (callStatus === "answered") {
      updateCallLogBySid(callSid, {
        outcome: "answered",
        started_at: new Date().toISOString(),
      });
    }

    if (["busy", "no-answer"].includes(callStatus)) {
      updateCallLogBySid(callSid, {
        outcome: "no_answer",
        ended_at: new Date().toISOString(),
      });
    }

    if (["failed", "canceled"].includes(callStatus)) {
      updateCallLogBySid(callSid, {
        outcome: "failed",
        ended_at: new Date().toISOString(),
      });
    }

    if (callStatus === "completed") {
      updateCallLogBySid(callSid, {
        ended_at: new Date().toISOString(),
      });
    }
  }

  if (callStatus === "blocked" && userId) {
    setUserInactiveById(userId);
  }

  res.json({ ok: true });
});
