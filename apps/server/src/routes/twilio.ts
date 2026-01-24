import type { Request } from "express";
import { Router } from "express";
import { buildStreamUrl } from "../services/coachTwilio.js";
import { env } from "../config/env.js";
import { setUserInactiveById, updateCallLogBySid } from "../services/coachDb.js";

export const twilioRouter = Router();

function resolveStreamUrl(req: Request, pathname: string): string {
  try {
    return buildStreamUrl(pathname);
  } catch {
    const host = req.get("host");
    const forwardedProto = req.get("x-forwarded-proto");
    const protocol = forwardedProto?.split(",")[0]?.trim() || req.protocol;
    const wsProtocol = protocol === "https" ? "wss" : "ws";
    return `${wsProtocol}://${host}${pathname}`;
  }
}

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

function buildUnavailableResponse(message: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${message}</Say>
  <Hangup />
</Response>`;
}

twilioRouter.post("/twilio/voice", (req, res) => {
  if (!env.OPENAI_API_KEY) {
    res
      .type("text/xml")
      .status(503)
      .send(
        buildUnavailableResponse(
          "This service is not configured yet. Please try again later."
        )
      );
    return;
  }

  const streamUrl = resolveStreamUrl(req, "/twilio/stream");

  const twiml = buildVoiceResponse({
    streamUrl,
    mode: "receptionist",
    greeting: "Connecting you now.",
    fromNumber: req.body?.From as string | undefined,
  });

  res.type("text/xml").send(twiml);
});

twilioRouter.post("/twilio/coach/voice", (req, res) => {
  if (!env.OPENAI_API_KEY) {
    res
      .type("text/xml")
      .status(503)
      .send(
        buildUnavailableResponse(
          "This service is not configured yet. Please try again later."
        )
      );
    return;
  }

  const streamUrl = resolveStreamUrl(req, "/twilio/stream/coach");
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
