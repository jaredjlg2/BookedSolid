import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { env } from "./config/env";
import { healthRouter } from "./routes/health";
import { twilioRouter } from "./routes/twilio";

const app = express();

// Twilio sends x-www-form-urlencoded by default.
// This lets req.body parse correctly later when you need it.
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use(healthRouter);
app.use(twilioRouter);

const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/twilio/stream" });

wss.on("connection", (ws) => {
  // eslint-disable-next-line no-console
  console.log("Twilio Media Stream connected");

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.event === "start") {
        // eslint-disable-next-line no-console
        console.log("Stream start", msg.start);
      }
      if (msg.event === "stop") {
        // eslint-disable-next-line no-console
        console.log("Stream stop", msg.stop);
      }
    } catch {
      // ignore
    }
  });

  ws.on("close", () => {
    // eslint-disable-next-line no-console
    console.log("Twilio Media Stream disconnected");
  });
});

server.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${env.PORT}`);
});
