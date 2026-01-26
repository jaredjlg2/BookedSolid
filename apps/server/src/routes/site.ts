import { Router } from "express";
import { env } from "../config/env.js";

const siteRouter = Router();

function buildHomepageHtml() {
  const businessName = env.BUSINESS_NAME ?? "BookedSolid";
  const phoneNumber = env.BUSINESS_OWNER_PHONE ?? env.TWILIO_FROM_NUMBER;
  const contactLine = phoneNumber
    ? `Call or text <strong>${phoneNumber}</strong> to get started.`
    : "Call or text us to get started.";
  const contactEmail = "jaredjlg2@gmail.com";
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
        --accent: #0ea5e9;
        --soft: #e0f2fe;
        --dark: #0b1120;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        background: var(--bg);
        color: var(--text);
        scroll-behavior: smooth;
      }
      header {
        padding: 24px 20px 0;
      }
      .container {
        max-width: 960px;
        margin: 0 auto;
        padding: 0 20px 60px;
      }
      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 18px 0 8px;
      }
      .logo {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        font-weight: 700;
        font-size: 1.05rem;
        color: var(--text);
        text-decoration: none;
      }
      .logo-badge {
        display: grid;
        place-items: center;
        width: 36px;
        height: 36px;
        border-radius: 12px;
        background: var(--primary);
        color: #fff;
        font-weight: 700;
      }
      .nav {
        display: flex;
        flex-wrap: wrap;
        gap: 14px;
        font-size: 0.95rem;
      }
      .nav a {
        color: var(--muted);
        text-decoration: none;
        font-weight: 600;
      }
      .nav a:hover {
        color: var(--text);
      }
      .hero {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 24px;
        padding: 32px;
        border-radius: 24px;
        background: var(--card);
        box-shadow: var(--shadow);
      }
      .hero-content {
        display: grid;
        gap: 18px;
        align-content: center;
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
      .hero-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
        color: var(--muted);
        font-weight: 600;
      }
      .hero-actions strong {
        color: var(--text);
      }
      .hero-image {
        position: relative;
        border-radius: 20px;
        overflow: hidden;
        background: var(--soft);
        border: 1px solid #bae6fd;
      }
      .hero-image img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
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
        background: var(--soft);
        color: #0c4a6e;
        border: 1px solid #bae6fd;
      }
      .section {
        margin-top: 48px;
        scroll-margin-top: 120px;
      }
      .section h2 {
        font-size: clamp(1.6rem, 2.4vw, 2.3rem);
        margin: 0 0 12px;
      }
      .section-lead {
        color: var(--muted);
        font-size: 1.05rem;
        line-height: 1.7;
        margin: 0 0 24px;
      }
      .media-grid {
        display: grid;
        gap: 20px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      .media-card {
        background: var(--card);
        border-radius: 18px;
        border: 1px solid var(--border);
        overflow: hidden;
        box-shadow: 0 12px 25px rgba(15, 23, 42, 0.08);
      }
      .media-card img {
        width: 100%;
        display: block;
      }
      .media-card .media-body {
        padding: 18px;
        display: grid;
        gap: 8px;
      }
      .metrics {
        display: grid;
        gap: 18px;
        grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      }
      .metric {
        background: var(--card);
        border-radius: 16px;
        padding: 18px;
        border: 1px solid var(--border);
      }
      .metric span {
        display: block;
        font-size: 1.4rem;
        font-weight: 700;
      }
      .timeline {
        display: grid;
        gap: 16px;
      }
      .timeline-item {
        display: grid;
        gap: 6px;
        padding: 16px;
        border-radius: 16px;
        background: var(--card);
        border: 1px solid var(--border);
      }
      .timeline-item h4 {
        margin: 0;
      }
      .contact-card {
        display: grid;
        gap: 10px;
        padding: 20px;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: #0f172a;
        color: #e2e8f0;
      }
      .contact-card a {
        color: #7dd3fc;
        text-decoration: none;
        font-weight: 600;
      }
      .contact-card a:hover {
        color: #bae6fd;
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
        .nav {
          justify-content: flex-start;
        }
      }
    </style>
  </head>
  <body>
    <header class="container">
      <div class="topbar">
        <a class="logo" href="#top">
          <span class="logo-badge">BS</span>
          ${businessName}
        </a>
        <nav class="nav">
          <a href="#services">Services</a>
          <a href="#impact">Impact</a>
          <a href="#insights">Insights</a>
          <a href="#process">Process</a>
          <a href="#contact">Contact</a>
        </nav>
      </div>
      <div id="top" class="hero">
        <div class="hero-content">
          <span>${businessName}</span>
          <h1>Never miss a call. Build a calmer, more consistent booking experience.</h1>
          <p>
            ${businessName} combines a 24/7 AI receptionist with thoughtful customer care
            so your business is always responsive. We answer questions, schedule
            appointments, so you win more work without the admin overhead.
          </p>
          <div class="hero-actions">
            <span>Direct line: <strong>${phoneNumber ?? "Call for details"}</strong></span>
            <span>Email: <strong>${contactEmail}</strong></span>
          </div>
        </div>
        <div class="hero-image">
          <img src="/assets/hero-bookedsolid.png" alt="BookedSolid brand graphic with scheduling icons" />
        </div>
      </div>
    </header>

    <main class="container">
      <section id="services" class="section">
        <h2>Premium coverage, every day of the week.</h2>
        <p class="section-lead">
          Give your customers immediate answers and a guided path to booking. We blend
          automation with a polished, professional experience that reflects your brand.
        </p>
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
      </section>

      <section id="impact" class="section">
        <h2>Missed calls quietly erase revenue.</h2>
        <p class="section-lead">
          When prospects can’t reach you, they move on. BookedSolid ensures every inquiry
          turns into a clear next step with proactive follow-up.
        </p>
        <div class="media-grid">
          <article class="media-card">
            <img src="/assets/missed-calls.png" alt="Graphic showing missed calls causing lost revenue" />
            <div class="media-body">
              <h3>Your business is losing money</h3>
              <p class="list">
                Missed calls equal missed jobs. We capture every call, qualify the request,
                and secure the appointment before the lead goes cold.
              </p>
            </div>
          </article>
          <article class="media-card">
            <img src="/assets/competitors.png" alt="Graphic comparing missed calls versus answered calls" />
            <div class="media-body">
              <h3>Your competitors answer the calls you miss</h3>
              <p class="list">
                Stay ahead with rapid responses, courteous scripting, and seamless scheduling
                that keeps your pipeline full.
              </p>
            </div>
          </article>
        </div>
      </section>

      <section id="insights" class="section">
        <h2>Clear reporting, real visibility.</h2>
        <p class="section-lead">
          Track what’s happening across every conversation. We summarize activity and keep
          your team aligned with the details that matter.
        </p>
        <div class="metrics">
          <div class="metric">
            <span>24/7</span>
            Coverage for calls, texts, and inbound questions.
          </div>
          <div class="metric">
            <span>0</span>
            Missed opportunities thanks to instant scheduling.
          </div>
          <div class="metric">
            <span>100%</span>
            Brand-aligned scripts tailored to your business.
          </div>
        </div>
      </section>

      <section id="process" class="section">
        <h2>Launch in days, not weeks.</h2>
        <p class="section-lead">
          We tailor the receptionist experience to match your calendar, policies, and
          preferred tone. Getting started is simple.
        </p>
        <div class="timeline">
          <div class="timeline-item">
            <h4>1. Strategy call</h4>
            <p class="list">We capture your availability, service offerings, and ideal customer flow.</p>
          </div>
          <div class="timeline-item">
            <h4>2. Custom scripting</h4>
            <p class="list">We build a professional script that reflects your brand voice.</p>
          </div>
          <div class="timeline-item">
            <h4>3. Go live</h4>
            <p class="list">We connect your calendar and start answering within days.</p>
          </div>
        </div>
      </section>

      <section id="contact" class="section">
        <h2>Let’s keep your calendar full.</h2>
        <p class="section-lead">
          Reach out for a walkthrough or to see how BookedSolid fits your operations.
        </p>
        <div class="contact-card">
          <strong>Contact</strong>
          <span>${contactLine}</span>
          <span>Email: <a href="mailto:${contactEmail}">${contactEmail}</a></span>
        </div>
      </section>

      <div class="banner">
        <strong>Ready to get started?</strong>
        <p>${contactLine}</p>
      </div>

      <footer>
        <p>Questions? Reach us at ${contactEmail}.</p>
      </footer>
    </main>
  </body>
</html>`;
}

siteRouter.get("/", (_req, res) => {
  res.status(200).type("html").send(buildHomepageHtml());
});

export { siteRouter };
