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

function resolveStreamUrlWithParams(
  req: Request,
  pathname: string,
  params: Record<string, string | undefined>
): string {
  const url = new URL(resolveStreamUrl(req, pathname));
  Object.entries(params).forEach(([key, value]) => {
    if (value) {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

function normalizePhoneNumber(phoneNumber: string | undefined): string {
  return phoneNumber?.replace(/\D/g, "") ?? "";
}

function maskPhoneNumber(phoneNumber: string | undefined): string {
  if (!phoneNumber) return "missing";
  if (process.env.NODE_ENV !== "production") return phoneNumber;
  const digits = phoneNumber.replace(/\D/g, "");
  if (!digits) return "unknown";
  return `***${digits.slice(-4)}`;
}

function buildStreamParameters({
  mode,
  userId,
  fromNumber,
  toNumber,
  callSid,
  businessId,
}: {
  mode: string;
  userId?: string;
  fromNumber?: string;
  toNumber?: string;
  callSid?: string;
  businessId?: string;
}) {
  const params = [
    `<Parameter name="mode" value="${mode}" />`,
    userId ? `<Parameter name="userId" value="${userId}" />` : "",
    fromNumber ? `<Parameter name="from" value="${fromNumber}" />` : "",
    toNumber ? `<Parameter name="to" value="${toNumber}" />` : "",
    callSid ? `<Parameter name="callSid" value="${callSid}" />` : "",
    businessId ? `<Parameter name="businessId" value="${businessId}" />` : "",
  ]
    .filter(Boolean)
    .join("\n    ");

  return params;
}

function buildVoiceResponse({
  streamUrl,
  mode,
  userId,
  greeting,
  fromNumber,
  toNumber,
  callSid,
  businessId,
}: {
  streamUrl: string;
  mode: string;
  userId?: string;
  greeting: string;
  fromNumber?: string;
  toNumber?: string;
  callSid?: string;
  businessId?: string;
}) {
  const params = buildStreamParameters({
    mode,
    userId,
    fromNumber,
    toNumber,
    callSid,
    businessId,
  });

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

function buildRingThenAiResponse({
  streamUrl,
  mode,
  greeting,
  ownerNumber,
  timeoutSeconds,
  fromNumber,
  toNumber,
  callSid,
  businessId,
}: {
  streamUrl: string;
  mode: string;
  greeting: string;
  ownerNumber: string;
  timeoutSeconds: number;
  fromNumber?: string;
  toNumber?: string;
  callSid?: string;
  businessId?: string;
}) {
  const params = buildStreamParameters({
    mode,
    fromNumber,
    toNumber,
    callSid,
    businessId,
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="${timeoutSeconds}" answerOnBridge="false">
    <Number>${ownerNumber}</Number>
  </Dial>
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

  const callSid = req.body?.CallSid as string | undefined;
  const fromNumber = req.body?.From as string | undefined;
  const toNumber = req.body?.To as string | undefined;
  const ownerForwardNumber = env.OWNER_FORWARD_NUMBER;
  const ringTimeoutSeconds = env.RING_TIMEOUT_SECONDS;
  const ringThenAiEnabled = env.ENABLE_RING_THEN_AI;
  const isLoop =
    normalizePhoneNumber(ownerForwardNumber) &&
    normalizePhoneNumber(ownerForwardNumber) === normalizePhoneNumber(toNumber);

  console.log("Incoming Twilio voice call", {
    callSid,
    from: fromNumber,
    to: toNumber,
  });
  console.log("Ring-then-AI config", {
    enabled: ringThenAiEnabled,
    ringTimeoutSeconds,
    ownerForwardNumber: maskPhoneNumber(ownerForwardNumber),
    loopDetected: isLoop,
  });

  const streamUrl = resolveStreamUrlWithParams(req, "/twilio/stream", {
    callSid,
    from: fromNumber,
    to: toNumber,
    businessId: toNumber,
  });

  const shouldRingOwner = Boolean(
    ringThenAiEnabled && ownerForwardNumber && !isLoop
  );

  if (shouldRingOwner) {
    console.log("Returning ring-then-AI TwiML", {
      callSid,
      timeoutSeconds: ringTimeoutSeconds,
    });
    const twiml = buildRingThenAiResponse({
      streamUrl,
      mode: "receptionist",
      greeting: "One moment.",
      ownerNumber: ownerForwardNumber,
      timeoutSeconds: ringTimeoutSeconds,
      fromNumber,
      toNumber,
      callSid,
      businessId: toNumber,
    });
    res.type("text/xml").send(twiml);
    return;
  }

  const twiml = buildVoiceResponse({
    streamUrl,
    mode: "receptionist",
    greeting: "Connecting you now.",
    fromNumber,
    toNumber,
    callSid,
    businessId: toNumber,
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
    toNumber: req.body?.To as string | undefined,
    callSid: req.body?.CallSid as string | undefined,
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
