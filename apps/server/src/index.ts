import express from "express";
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

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${env.PORT}`);
});
