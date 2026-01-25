import { Router } from "express";
import { env } from "../config/env.js";

const siteRouter = Router();

function buildHomepageHtml() {
  const businessName = env.BUSINESS_NAME ?? "BookedSolid";
  const phoneNumber = env.BUSINESS_OWNER_PHONE ?? env.TWILIO_FROM_NUMBER;
  const contactLine = phoneNumber
    ? `Call or text <strong>${phoneNumber}</strong> to get started.`
    : "Call or text us to get started.";
  const publicUrl = env.PUBLIC_BASE_URL ?? "";
  const canonicalUrl = publicUrl ? `${publicUrl.replace(/\/$/, "")}/` : "/";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${businessName} | Appointment Booking & Customer Care</title>
    <meta
      name="description"
      content="Learn about ${businessName}, our services, and how to book your next appointment."
    />
    <link rel="canonical" href="${canonicalUrl}" />
    <style>
      :root {
        color-scheme: light;
        font-family: "Inter", "Segoe UI", system-ui, sans-serif;
        --bg: #f8fafc;
        --card: #ffffff;
        --primary: #1d4ed8;
        --text: #0f172a;
        --muted: #475569;
        --border: #e2e8f0;
        --shadow: 0 18px 40px rgba(15, 23, 42, 0.12);
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
      }
      header {
        padding: 32px 20px 0;
      }
      .container {
        max-width: 960px;
        margin: 0 auto;
        padding: 0 20px 60px;
      }
      .hero {
        display: grid;
        gap: 24px;
        padding: 32px;
        border-radius: 24px;
        background: var(--card);
        box-shadow: var(--shadow);
      }
      .hero h1 {
        font-size: clamp(2rem, 3vw, 3rem);
        margin: 0;
      }
      .hero p {
        color: var(--muted);
        font-size: 1.1rem;
        line-height: 1.6;
        margin: 0;
      }
      .cta {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        padding: 12px 22px;
        border-radius: 999px;
        background: var(--primary);
        color: #fff;
        text-decoration: none;
        font-weight: 600;
        width: fit-content;
      }
      .grid {
        display: grid;
        gap: 18px;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        margin-top: 28px;
      }
      .card {
        background: var(--card);
        border-radius: 18px;
        padding: 20px;
        border: 1px solid var(--border);
      }
      .card h3 {
        margin-top: 0;
      }
      .list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: grid;
        gap: 10px;
        color: var(--muted);
      }
      .banner {
        margin-top: 28px;
        padding: 20px;
        border-radius: 18px;
        background: #e0f2fe;
        color: #0c4a6e;
        border: 1px solid #bae6fd;
      }
      footer {
        margin-top: 28px;
        color: var(--muted);
        font-size: 0.9rem;
      }
      @media (max-width: 640px) {
        .hero {
          padding: 24px;
        }
      }
    </style>
  </head>
  <body>
    <header class="container">
      <div class="hero">
        <span>${businessName}</span>
        <h1>Modern appointment booking with a friendly, always-on receptionist.</h1>
        <p>
          ${businessName} helps customers connect with your business quickly. We answer
          questions, schedule appointments, and follow up automatically so you never
          miss an opportunity to serve your clients.
        </p>
        <a class="cta" href="mailto:hello@bookedsolid.com">Email us to learn more</a>
      </div>
    </header>

    <main class="container">
      <div class="grid">
        <section class="card">
          <h3>What we do</h3>
          <ul class="list">
            <li>Answer inbound calls and messages 24/7.</li>
            <li>Book, reschedule, and cancel appointments instantly.</li>
            <li>Send confirmations and reminders automatically.</li>
          </ul>
        </section>
        <section class="card">
          <h3>Who we help</h3>
          <ul class="list">
            <li>Local service businesses and professional offices.</li>
            <li>Teams who want fewer missed calls.</li>
            <li>Owners who want more time back.</li>
          </ul>
        </section>
        <section class="card">
          <h3>How it works</h3>
          <ul class="list">
            <li>Tell us your availability and booking rules.</li>
            <li>We handle inbound requests and scheduling.</li>
            <li>Get a daily summary and stay in control.</li>
          </ul>
        </section>
      </div>

      <div class="banner">
        <strong>Ready to get started?</strong>
        <p>${contactLine}</p>
      </div>

      <footer>
        <p>Questions? Reach us at hello@bookedsolid.com.</p>
      </footer>
    </main>
  </body>
</html>`;
}

siteRouter.get("/", (_req, res) => {
  res.status(200).type("html").send(buildHomepageHtml());
});

export { siteRouter };
