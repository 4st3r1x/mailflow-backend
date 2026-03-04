require("dotenv").config();
const express = require("express");
const sgMail = require("@sendgrid/mail");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(cors());
app.use(express.json());

// ── In-memory store (replace with a DB for production) ──
const store = {
  campaigns: [],
  events: [],          // open / click / bounce / unsubscribe
  suppressions: new Set(), // hard bounces + unsubscribes
};

// ── Helpers ──
function injectTracking(html, campaignId, recipientEmail) {
  const encoded = encodeURIComponent(recipientEmail);
  const base = process.env.BASE_URL || "http://localhost:3001";

  // Wrap every <a href> for click tracking
  const clickTracked = html.replace(
    /<a\s+([^>]*?)href="([^"]+)"([^>]*?)>/gi,
    (match, pre, url, post) => {
      if (url.startsWith("{{unsubscribe")) return match;
      const trackUrl = `${base}/track/click?cid=${campaignId}&email=${encoded}&url=${encodeURIComponent(url)}`;
      return `<a ${pre}href="${trackUrl}"${post}>`;
    }
  );

  // Inject 1x1 open pixel before </body>
  const pixel = `<img src="${base}/track/open?cid=${campaignId}&email=${encoded}" width="1" height="1" style="display:none" />`;
  const unsubLink = `<p style="font-size:11px;color:#999;text-align:center;margin-top:32px">
    <a href="${base}/track/unsubscribe?cid=${campaignId}&email=${encoded}" style="color:#999">Unsubscribe</a>
  </p>`;

  return clickTracked.replace("</body>", `${pixel}${unsubLink}</body>`) + (clickTracked.includes("</body>") ? "" : pixel + unsubLink);
}

// ── Routes ──

// POST /send  — send a campaign
app.post("/send", async (req, res) => {
  const { apiKey, fromName, fromEmail, subject, body, recipients } = req.body;

  if (!apiKey || !fromEmail || !subject || !body || !recipients?.length) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  sgMail.setApiKey(apiKey);

  const campaignId = uuidv4();
  const campaign = {
    id: campaignId,
    name: req.body.name || subject,
    subject,
    fromName,
    fromEmail,
    status: "sending",
    total: recipients.length,
    sent: 0,
    failed: 0,
    createdAt: new Date().toISOString(),
  };
  store.campaigns.push(campaign);

  // Send emails (batched to respect rate limits)
  const results = { sent: 0, failed: 0, skipped: 0 };

  for (const email of recipients) {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || store.suppressions.has(trimmed)) {
      results.skipped++;
      continue;
    }

    const trackedHtml = injectTracking(body, campaignId, trimmed);

    try {
      await sgMail.send({
        to: trimmed,
        from: { name: fromName, email: fromEmail },
        subject,
        html: trackedHtml,
      });
      results.sent++;
    } catch (err) {
      results.failed++;
      console.error(`Failed to send to ${trimmed}:`, err.message);
      // Mark as bounce if SendGrid says invalid
      if (err.code === 550 || err.message?.includes("invalid")) {
        store.suppressions.add(trimmed);
        store.events.push({ type: "bounce", subtype: "hard", email: trimmed, campaignId, time: new Date().toISOString() });
      }
    }
  }

  // Update campaign record
  campaign.sent = results.sent;
  campaign.failed = results.failed;
  campaign.skipped = results.skipped;
  campaign.status = "sent";
  campaign.sentAt = new Date().toISOString();

  res.json({ success: true, campaignId, ...results });
});

// GET /track/open — pixel hit
app.get("/track/open", (req, res) => {
  const { cid, email } = req.query;
  if (cid && email) {
    store.events.push({ type: "open", email: decodeURIComponent(email), campaignId: cid, time: new Date().toISOString() });
  }
  // Return 1x1 transparent GIF
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  res.set("Content-Type", "image/gif").send(gif);
});

// GET /track/click — redirect + log
app.get("/track/click", (req, res) => {
  const { cid, email, url } = req.query;
  if (cid && email && url) {
    store.events.push({ type: "click", email: decodeURIComponent(email), campaignId: cid, url: decodeURIComponent(url), time: new Date().toISOString() });
  }
  res.redirect(decodeURIComponent(url || "/"));
});

// GET /track/unsubscribe
app.get("/track/unsubscribe", (req, res) => {
  const { cid, email } = req.query;
  const decoded = decodeURIComponent(email || "");
  if (decoded) {
    store.suppressions.add(decoded.toLowerCase());
    store.events.push({ type: "unsubscribe", email: decoded, campaignId: cid, time: new Date().toISOString() });
  }
  res.send("<html><body style='font-family:sans-serif;text-align:center;padding:60px'><h2>You've been unsubscribed ✓</h2><p>You won't receive further emails.</p></body></html>");
});

// POST /webhooks/sendgrid — bounce/spam webhooks from SendGrid
app.post("/webhooks/sendgrid", (req, res) => {
  const events = Array.isArray(req.body) ? req.body : [req.body];
  for (const ev of events) {
    const email = (ev.email || "").toLowerCase();
    if (!email) continue;

    if (ev.event === "bounce" || ev.event === "dropped") {
      store.suppressions.add(email);
      store.events.push({ type: "bounce", subtype: ev.type || "hard", email, campaignId: ev.campaign_id, time: new Date().toISOString() });
    } else if (ev.event === "spamreport" || ev.event === "unsubscribe") {
      store.suppressions.add(email);
      store.events.push({ type: ev.event === "spamreport" ? "spam" : "unsubscribe", email, campaignId: ev.campaign_id, time: new Date().toISOString() });
    } else if (ev.event === "open") {
      store.events.push({ type: "open", email, campaignId: ev.campaign_id, time: new Date().toISOString() });
    } else if (ev.event === "click") {
      store.events.push({ type: "click", email, url: ev.url, campaignId: ev.campaign_id, time: new Date().toISOString() });
    }
  }
  res.sendStatus(200);
});

// GET /campaigns — list all campaigns
app.get("/campaigns", (req, res) => res.json(store.campaigns));

// GET /campaigns/:id/stats — stats for one campaign
app.get("/campaigns/:id/stats", (req, res) => {
  const { id } = req.params;
  const campaign = store.campaigns.find(c => c.id === id);
  if (!campaign) return res.status(404).json({ error: "Not found" });

  const evts = store.events.filter(e => e.campaignId === id);
  const unique = (type) => new Set(evts.filter(e => e.type === type).map(e => e.email)).size;

  res.json({
    ...campaign,
    opens: unique("open"),
    clicks: unique("click"),
    bounces: evts.filter(e => e.type === "bounce").length,
    unsubscribes: unique("unsubscribe"),
    spamReports: unique("spam"),
  });
});

// GET /events — recent events (live feed)
app.get("/events", (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(store.events.slice(-limit).reverse());
});

// GET /suppressions — suppressed emails
app.get("/suppressions", (req, res) => res.json([...store.suppressions]));

// DELETE /suppressions/:email — remove from suppression
app.delete("/suppressions/:email", (req, res) => {
  store.suppressions.delete(decodeURIComponent(req.params.email).toLowerCase());
  res.json({ success: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`✅ MailFlow backend running on http://localhost:${PORT}`));
