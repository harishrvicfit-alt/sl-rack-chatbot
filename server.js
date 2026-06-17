import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import { productCatalog, companyFacts, scoreProducts } from './src/slRackKnowledge.js';
import { buildSystemPrompt } from './src/systemPrompt.js';
import { getKnowledgeStatus, searchKnowledge } from './src/knowledgeSearch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3000);
const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const publicDir = path.join(__dirname, 'public');
const requestBuckets = new Map();
const MAX_MESSAGES = Number(process.env.CHAT_MAX_MESSAGES || 8);
const MAX_MESSAGE_CHARS = Number(process.env.CHAT_MAX_MESSAGE_CHARS || 1500);
const MAX_TOTAL_CHARS = Number(process.env.CHAT_MAX_TOTAL_CHARS || 5000);
const MAX_OUTPUT_TOKENS = Number(process.env.CHAT_MAX_OUTPUT_TOKENS || 900);
const RATE_WINDOW_MS = Number(process.env.CHAT_RATE_WINDOW_MS || 60_000);
const RATE_MAX_REQUESTS = Number(process.env.CHAT_RATE_MAX_REQUESTS || 12);
const DAILY_MAX_REQUESTS = Number(process.env.CHAT_DAILY_MAX_REQUESTS || 120);
const DAILY_MAX_INPUT_CHARS = Number(process.env.CHAT_DAILY_MAX_INPUT_CHARS || 120_000);
const ADMIN_PATH = process.env.ADMIN_PATH || '';
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || process.env.OPENAI_API_KEY || crypto.randomBytes(32).toString('hex');
const ADMIN_COOKIE = 'slrack_admin_session';
const analytics = {
  startedAt: new Date().toISOString(),
  events: 0,
  chats: 0,
  blocked: 0,
  errors: 0,
  attachments: 0,
  contacts: 0,
  sourceClicks: 0,
  quickActions: 0,
  topEvents: new Map(),
  lastEvents: []
};

app.use(securityHeaders);
app.use(cors({ origin: true, methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '80kb' }));
app.use(express.static(publicDir));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    aiEnabled: Boolean(client),
    model: client ? model : 'fallback-recommender',
    knowledge: getKnowledgeStatus()
  });
});

app.get('/api/catalog', (_req, res) => {
  res.json({ companyFacts, products: productCatalog });
});

if (ADMIN_PATH) {
  app.get(ADMIN_PATH, (_req, res) => {
    res.type('html').send(buildAdminPage());
  });
}

app.get('/api/admin/session', (req, res) => {
  const authenticated = isAdminRequest(req);
  res.json({ authenticated, adminPath: authenticated ? ADMIN_PATH : undefined });
});

app.post('/api/admin/login', (req, res) => {
  const username = String(req.body?.username || '');
  const password = String(req.body?.password || '');

  if (!isValidAdminLogin(username, password)) {
    recordAnalyticsEvent('admin_login_failed');
    return res.status(401).json({ error: 'invalid_login' });
  }

  setAdminSessionCookie(res);
  recordAnalyticsEvent('admin_login_success');
  res.json({ ok: true });
});

app.post('/api/admin/logout', (_req, res) => {
  clearAdminSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/admin/summary', (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(404).json({ error: 'not_found' });
  }

  res.json(buildAdminSummary());
});

app.get('/api/analytics/summary', (req, res) => {
  if (!canReadAnalytics(req)) {
    return res.status(404).json({ error: 'not_found' });
  }

  res.json(getAnalyticsSummary());
});

app.post('/api/analytics', (req, res) => {
  recordAnalyticsEvent(req.body?.type, req.body?.payload);
  res.status(204).end();
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.post('/api/recommend', (req, res) => {
  const profile = req.body?.profile || {};
  res.json({ recommendations: scoreProducts(profile).slice(0, 3) });
});

app.post('/api/chat', async (req, res) => {
  const rawMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const validation = validateChatRequest(req, rawMessages);

  if (!validation.ok) {
    recordAnalyticsEvent('chat_blocked', { error: validation.error });
    return res.status(validation.status).json({
      mode: 'blocked',
      error: validation.error,
      reply: validation.reply,
      recommendations: [],
      knowledgeResults: [],
      documentSources: []
    });
  }

  const messages = validation.messages;
  const profile = req.body?.profile || {};
  const attachment = sanitizeAttachment(req.body?.attachment);
  if (attachment) recordAnalyticsEvent('attachment_received', { kind: attachment.kind });
  const recommendations = scoreProducts(profile).slice(0, 3);
  const latestUserMessage = [...messages].reverse().find((message) => message.role !== 'assistant')?.content || '';
  const knowledgeResults = searchKnowledge(latestUserMessage, profile, 6);
  const documentSources = buildDocumentSources(knowledgeResults);

  if (!messages.length) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  if (!client) {
    return res.json({
      mode: 'fallback',
      reply: buildFallbackReply(profile, recommendations),
      recommendations,
      knowledgeResults,
      documentSources
    });
  }

  try {
    const response = await client.responses.create({
      model,
      temperature: 0.35,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      input: [
        {
          role: 'system',
          content: buildSystemPrompt({
            companyFacts,
            productCatalog,
            recommendations,
            knowledgeResults
          })
        },
        ...messages
      ]
    });

    const reply = postProcessSalesReplySafe(response.output_text, latestUserMessage);

    res.json({
      mode: 'ai',
      reply,
      recommendations,
      knowledgeResults,
      documentSources
    });
    recordAnalyticsEvent('chat_answered', { sourceCount: documentSources.length, attachment: Boolean(attachment) });
  } catch (error) {
    console.error(error);
    recordAnalyticsEvent('chat_error', { status: error?.status, code: error?.code });
    const quotaError = error?.code === 'insufficient_quota' || error?.status === 429;
    res.status(quotaError ? 200 : 500).json({
      mode: quotaError ? 'quota_fallback' : 'error_fallback',
      error: quotaError
        ? 'OpenAI API key is valid, but the account has no available API quota. Please add billing or credits in the OpenAI platform.'
        : 'AI response failed',
      reply: buildFallbackReply(profile, recommendations),
      recommendations,
      knowledgeResults,
      documentSources
    });
  }
});

if (process.env.VERCEL !== '1') {
  app.listen(port, () => {
    console.log(`SL Rack chatbot running at http://localhost:${port}`);
  });
}

export default app;

function buildAdminPage() {
  return `<!doctype html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SL Rack Admin</title>
    <link rel="icon" href="/assets/logo_sl-rack.svg" />
    <style>
      :root { color-scheme: light; --brand:#004528; --brand-2:#075d3a; --accent:#f7a600; --ink:#10231b; --muted:#65736c; --line:#dfe7e2; --surface:#eef4ef; --panel:#ffffff; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: linear-gradient(180deg, #eaf2ec 0, #f8faf8 420px); color: var(--ink); }
      .admin-shell { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; }
      header { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 24px; background: rgba(255,255,255,.92); border-bottom: 1px solid rgba(0,69,40,.12); backdrop-filter: blur(14px); }
      header img { width: 132px; height: auto; display: block; }
      .admin-pill { display: inline-flex; align-items: center; gap: 8px; border: 1px solid rgba(0,69,40,.16); border-radius: 999px; padding: 8px 12px; background: #fff; color: var(--brand); font-size: .86rem; font-weight: 900; }
      .admin-pill::before { width: 8px; height: 8px; border-radius: 999px; background: var(--accent); content: ""; }
      main { width: min(1180px, 100%); margin: 0 auto; padding: 24px; }
      .login, .panel { background: rgba(255,255,255,.96); border: 1px solid rgba(0,69,40,.12); border-radius: 8px; box-shadow: 0 24px 70px rgba(0, 69, 40, .12); }
      .login { width: min(460px, 100%); margin: 9vh auto 0; padding: 0; overflow: hidden; }
      .login-hero { padding: 24px; background: linear-gradient(135deg, rgba(0,69,40,.98), rgba(7,93,58,.88)); color: #fff; }
      .login-hero img { width: 136px; padding: 8px 10px; border-radius: 8px; background: #fff; }
      .login-body { padding: 24px; }
      h1, h2, p { margin-top: 0; }
      h1 { margin-bottom: 7px; font-size: clamp(1.35rem, 2vw, 2rem); letter-spacing: 0; }
      h2 { font-size: 1.02rem; }
      label { display: grid; gap: 7px; margin-top: 14px; font-weight: 800; color: #26362f; }
      input { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 12px 13px; font: inherit; }
      input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(247,166,0,.16); outline: none; }
      button { border: 0; border-radius: 8px; padding: 12px 16px; background: var(--accent); color: #00331e; font: inherit; font-weight: 900; cursor: pointer; transition: transform .16s ease, box-shadow .16s ease, background .16s ease; }
      button:hover { background: #ffc247; box-shadow: 0 12px 24px rgba(247,166,0,.22); transform: translateY(-1px); }
      button.secondary { background: var(--brand); color: #fff; }
      button.secondary:hover { background: #00331e; box-shadow: 0 12px 24px rgba(0,69,40,.2); }
      .toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 18px; padding: 22px; border-bottom: 1px solid rgba(0,69,40,.1); background: linear-gradient(135deg, rgba(0,69,40,.96), rgba(7,93,58,.82)); color: #fff; border-radius: 8px 8px 0 0; }
      .toolbar .muted { color: rgba(255,255,255,.78); }
      .toolbar-actions { display: flex; flex-wrap: wrap; gap: 10px; }
      .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; padding: 18px; }
      .card { position: relative; overflow: hidden; background: #fff; border: 1px solid rgba(0,69,40,.11); border-radius: 8px; padding: 16px; box-shadow: 0 14px 34px rgba(0,69,40,.06); }
      .card::before { position: absolute; inset: 0 auto 0 0; width: 4px; background: linear-gradient(180deg, var(--brand), var(--accent)); content: ""; }
      .card.ok::before { background: linear-gradient(180deg, #0a7d4f, #4fc47b); }
      .card.warn::before { background: linear-gradient(180deg, #a46a00, var(--accent)); }
      .metric { color: var(--muted); font-size: .75rem; font-weight: 900; text-transform: uppercase; }
      .value { display: block; margin-top: 9px; font-size: clamp(1.55rem, 3vw, 2.25rem); font-weight: 950; color: var(--brand); line-height: 1; }
      .wide { grid-column: 1 / -1; }
      table { width: 100%; border-collapse: collapse; font-size: .92rem; }
      th, td { border-bottom: 1px solid var(--line); padding: 11px 10px; text-align: left; vertical-align: top; }
      th { color: #26362f; font-size: .74rem; letter-spacing: .02em; text-transform: uppercase; }
      tr:hover td { background: #f8fbf9; }
      .muted { color: var(--muted); }
      .hidden { display: none !important; }
      .error { color: #a33; font-weight: 800; min-height: 1.4em; }
      @media (max-width: 900px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
      @media (max-width: 620px) { main { padding: 12px; } header { padding: 12px 14px; } header img { width: 112px; } .grid { grid-template-columns: 1fr; padding: 12px; } .toolbar { padding: 16px; } .login { margin-top: 5vh; } }
    </style>
  </head>
  <body>
    <div class="admin-shell">
      <header>
        <img src="/assets/logo_sl-rack.svg" alt="SL Rack" />
        <span class="admin-pill">Private Admin</span>
      </header>
      <main>
        <section id="loginView" class="login hidden">
          <div class="login-hero">
            <img src="/assets/logo_sl-rack.svg" alt="SL Rack" />
            <h1>Chatbot Admin</h1>
            <p>Geschuetzter Bereich fuer interne Auswertung.</p>
          </div>
          <div class="login-body">
            <form id="loginForm">
              <label>Benutzername <input id="adminUser" autocomplete="username" required /></label>
              <label>Passwort <input id="adminPass" type="password" autocomplete="current-password" required /></label>
              <p id="loginError" class="error"></p>
              <button type="submit">Anmelden</button>
            </form>
          </div>
        </section>
        <section id="panelView" class="panel hidden">
          <div class="toolbar">
            <div>
              <h1>SL Rack Chatbot Admin</h1>
              <p id="statusText" class="muted">Lade Daten...</p>
            </div>
            <div class="toolbar-actions">
              <button id="refreshButton" type="button">Aktualisieren</button>
              <button id="logoutButton" class="secondary" type="button">Abmelden</button>
            </div>
          </div>
          <div id="metrics" class="grid"></div>
        </section>
      </main>
    </div>
    <script src="/admin.js" type="module"></script>
  </body>
</html>`;
}

function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' https: data:",
      "connect-src 'self'",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'self'"
    ].join('; ')
  );
  next();
}

function sanitizeAttachment(value) {
  if (!value || typeof value !== 'object') return null;
  const name = String(value.name || '').slice(0, 160);
  const type = String(value.type || '').slice(0, 80);
  const size = Number(value.size || 0);
  const kind = value.kind === 'pdf' ? 'pdf' : value.kind === 'image' ? 'image' : 'unknown';

  if (!name || !Number.isFinite(size) || size < 0 || size > 8 * 1024 * 1024) return null;
  return { name, type, size, kind };
}

function isValidAdminLogin(username, password) {
  if (!ADMIN_USER || !ADMIN_PASSWORD_HASH) return false;
  const userOk = timingSafeEqualString(username, ADMIN_USER);
  const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
  const passwordOk = timingSafeEqualString(passwordHash, ADMIN_PASSWORD_HASH);
  return userOk && passwordOk;
}

function setAdminSessionCookie(res) {
  const issuedAt = Date.now();
  const payload = `${ADMIN_USER}.${issuedAt}`;
  const signature = signAdminPayload(payload);
  const secure = process.env.VERCEL === '1' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${ADMIN_COOKIE}=${encodeURIComponent(`${payload}.${signature}`)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure}`
  );
}

function clearAdminSessionCookie(res) {
  res.setHeader('Set-Cookie', `${ADMIN_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function isAdminRequest(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[ADMIN_COOKIE];
  if (!token) return false;

  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const [username, issuedAtText, signature] = parts;
  const issuedAt = Number(issuedAtText);
  if (!timingSafeEqualString(username, ADMIN_USER)) return false;
  if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > 8 * 60 * 60 * 1000) return false;

  return timingSafeEqualString(signature, signAdminPayload(`${username}.${issuedAtText}`));
}

function signAdminPayload(payload) {
  return crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('hex');
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName) continue;
    cookies[rawName] = decodeURIComponent(rawValue.join('=') || '');
  }
  return cookies;
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function recordAnalyticsEvent(type = 'unknown', payload = {}) {
  const eventType = String(type || 'unknown').slice(0, 80);
  analytics.events += 1;
  analytics.topEvents.set(eventType, (analytics.topEvents.get(eventType) || 0) + 1);

  if (eventType === 'chat_submitted' || eventType === 'chat_answered') analytics.chats += 1;
  if (eventType === 'chat_blocked') analytics.blocked += 1;
  if (eventType === 'chat_error' || eventType === 'chat_failed') analytics.errors += 1;
  if (eventType === 'attachment_selected' || eventType === 'attachment_received') analytics.attachments += 1;
  if (eventType === 'contact_clicked') analytics.contacts += 1;
  if (eventType === 'source_clicked') analytics.sourceClicks += 1;
  if (eventType === 'quick_action_clicked') analytics.quickActions += 1;

  analytics.lastEvents.unshift({
    type: eventType,
    at: new Date().toISOString(),
    payload: sanitizeAnalyticsPayload(payload)
  });
  analytics.lastEvents = analytics.lastEvents.slice(0, 50);
}

function sanitizeAnalyticsPayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const clean = {};
  for (const [key, value] of Object.entries(payload).slice(0, 10)) {
    if (typeof value === 'string') clean[key] = value.slice(0, 120);
    else if (typeof value === 'number' || typeof value === 'boolean') clean[key] = value;
  }
  return clean;
}

function getAnalyticsSummary() {
  return {
    startedAt: analytics.startedAt,
    events: analytics.events,
    chats: analytics.chats,
    blocked: analytics.blocked,
    errors: analytics.errors,
    attachments: analytics.attachments,
    contacts: analytics.contacts,
    sourceClicks: analytics.sourceClicks,
    quickActions: analytics.quickActions,
    topEvents: Object.fromEntries([...analytics.topEvents.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)),
    lastEvents: analytics.lastEvents
  };
}

function buildAdminSummary() {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    model: client ? model : 'fallback-recommender',
    aiEnabled: Boolean(client),
    knowledge: getKnowledgeStatus(),
    analytics: getAnalyticsSummary(),
    limits: {
      maxMessages: MAX_MESSAGES,
      maxMessageChars: MAX_MESSAGE_CHARS,
      maxTotalChars: MAX_TOTAL_CHARS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      rateWindowMs: RATE_WINDOW_MS,
      rateMaxRequests: RATE_MAX_REQUESTS,
      dailyMaxRequests: DAILY_MAX_REQUESTS,
      dailyMaxInputChars: DAILY_MAX_INPUT_CHARS
    }
  };
}

function canReadAnalytics(req) {
  const token = process.env.ANALYTICS_TOKEN;
  if (token) {
    const headerToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const queryToken = String(req.query?.token || '');
    return headerToken === token || queryToken === token;
  }

  return process.env.VERCEL !== '1' || isAdminRequest(req);
}

function buildFallbackReply(profile, recommendations) {
  const top = recommendations[0];
  const projectType = profile.projectType || top?.category || 'PV project';
  if (!top) {
    return 'Da bih preporucio pravo SL Rack rjesenje, trebaju mi tip projekta, podloga ili krov, orijentacija, velicina sistema i prioritet: brza montaza, minimalna krovna opterecenja, estetika ili maksimalan prinos.';
  }

  return [
    `Za ${projectType} bih prvo provjerio ${top.name}.`,
    top.shortPitch,
    `Zasto SL Rack: ${top.advantages.slice(0, 3).join('; ')}.`,
    'Za precizan prijedlog posaljite tip krova/povrsine, dimenzije, lokaciju, nagib, tip modula i zeljenu orijentaciju.'
  ].join(' ');
}

function buildDocumentSources(knowledgeResults = []) {
  const seen = new Map();

  for (const result of knowledgeResults) {
    if (!result?.sourceUrl || seen.has(result.sourceUrl)) continue;
    seen.set(result.sourceUrl, {
      title: result.title,
      category: result.category,
      page: result.page,
      url: result.sourceUrl
    });
  }

  return [...seen.values()].slice(0, 4);
}

function validateChatRequest(req, rawMessages) {
  if (!rawMessages.length) {
    return {
      ok: false,
      status: 400,
      error: 'messages array is required',
      reply: 'Bitte geben Sie eine konkrete Frage ein.'
    };
  }

  const rawTotalChars = rawMessages.reduce((sum, message) => sum + String(message?.content || '').length, 0);
  if (rawTotalChars > MAX_TOTAL_CHARS) {
    return {
      ok: false,
      status: 413,
      error: 'message_too_large',
      reply: 'Ihre Anfrage ist zu lang. Bitte senden Sie eine kuerzere, konkrete Projektfrage.'
    };
  }

  const messages = rawMessages
    .slice(-MAX_MESSAGES)
    .map((message) => ({
      role: message?.role === 'assistant' ? 'assistant' : 'user',
      content: String(message?.content || '').trim().slice(0, MAX_MESSAGE_CHARS)
    }))
    .filter((message) => message.content);

  const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (!messages.length || totalChars > MAX_TOTAL_CHARS) {
    return {
      ok: false,
      status: 413,
      error: 'message_too_large',
      reply: 'Ihre Anfrage ist zu lang. Bitte senden Sie eine kuerzere, konkrete Projektfrage.'
    };
  }

  const abuseText = messages.map((message) => message.content).join('\n');
  if (looksLikeAbuse(abuseText)) {
    return {
      ok: false,
      status: 400,
      error: 'unsupported_request',
      reply: 'Ich kann nur bei konkreten SL Rack Produkt-, Montage- und Planungsfragen helfen. Bitte stellen Sie eine kurze technische Frage zu Ihrem PV-Projekt.'
    };
  }

  const bucketResult = checkRateLimit(getClientIp(req), totalChars);
  if (!bucketResult.ok) {
    return {
      ok: false,
      status: 429,
      error: bucketResult.error,
      reply: bucketResult.reply
    };
  }

  return { ok: true, messages };
}

function getClientIp(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwardedFor || req.ip || req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(ip, inputChars) {
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const bucket = requestBuckets.get(ip) || { windowStart: now, requests: 0, day, dailyRequests: 0, dailyChars: 0 };

  if (now - bucket.windowStart > RATE_WINDOW_MS) {
    bucket.windowStart = now;
    bucket.requests = 0;
  }

  if (bucket.day !== day) {
    bucket.day = day;
    bucket.dailyRequests = 0;
    bucket.dailyChars = 0;
  }

  bucket.requests += 1;
  bucket.dailyRequests += 1;
  bucket.dailyChars += inputChars;
  requestBuckets.set(ip, bucket);
  pruneRequestBuckets(now);

  if (bucket.requests > RATE_MAX_REQUESTS) {
    return {
      ok: false,
      error: 'rate_limited',
      reply: 'Zu viele Anfragen in kurzer Zeit. Bitte warten Sie einen Moment und versuchen Sie es erneut.'
    };
  }

  if (bucket.dailyRequests > DAILY_MAX_REQUESTS || bucket.dailyChars > DAILY_MAX_INPUT_CHARS) {
    return {
      ok: false,
      error: 'daily_limit_reached',
      reply: 'Das Tageslimit fuer diese Verbindung wurde erreicht. Bitte versuchen Sie es spaeter erneut oder kontaktieren Sie SL Rack direkt.'
    };
  }

  return { ok: true };
}

function pruneRequestBuckets(now) {
  if (requestBuckets.size < 1000) return;

  for (const [ip, bucket] of requestBuckets.entries()) {
    if (now - bucket.windowStart > RATE_WINDOW_MS * 10) {
      requestBuckets.delete(ip);
    }
  }
}

function looksLikeAbuse(text) {
  const normalized = String(text || '').toLowerCase();

  return [
    /ignore (all )?(previous|system|developer).{0,40}instructions/,
    /ignore.{0,40}(system|developer).{0,40}(prompt|instructions)/,
    /vergiss (alle )?(vorherigen|system).*anweisungen/,
    /(drucke|zeige|print|show|reveal).{0,80}(system prompt|entwickleranweisung|api key|secret)/,
    /repeat (this|the following).{0,40}(1000|10000|forever)/,
    /(.)\1{300,}/
  ].some((pattern) => pattern.test(normalized));
}

function postProcessSalesReplySafe(reply, userMessage = '') {
  let output = String(reply || '');
  const query = String(userMessage || '').toLowerCase();
  const isTileRoofQuestion = /(ziegel|zieldach|dachhaken|erus|e58|tonziegel|betondachstein)/i.test(query);
  const asksHookQuantity = /(wie viele|wieviele|anzahl|dachhaken.*ben[o\u00f6]tig|ben[o\u00f6]tige.*dachhaken)/i.test(query);

  if (isTileRoofQuestion && (!/Alpha-Platte/i.test(output) || !/Delta-Platte/i.test(output))) {
    output += [
      '',
      'Zusatzhinweis aus der SL Rack Vertriebslogik:',
      'Bei Ziegeld\u00e4chern bitte nicht nur Dachhaken betrachten. Je nach Ziegeltyp und Projekt k\u00f6nnen auch Alpha-Platte und Delta-Platte relevante SL Rack Optionen sein. F\u00fcr eine belastbare Auswahl bitte den exakten Ziegeltyp, Tonziegel/Betondachstein, Dachneigung und Lattungsabstand pr\u00fcfen.'
    ].join('\n');
  }

  if (/dachhaken|edelstahl|sl a2/i.test(output) && /preiswert|g\u00fcnstig|guenstig|cheap|low-cost/i.test(output)) {
    output += [
      '',
      'Hinweis zur Preisbewertung:',
      'Eine pauschale Aussage wie preiswert oder g\u00fcnstig ist bei Edelstahl-Dachhaken nicht belastbar. Die wirtschaftlich passende L\u00f6sung h\u00e4ngt vom Dach, Material, Ziegeltyp, statischer Auslegung und den verf\u00fcgbaren SL Rack Alternativen ab.'
    ].join('\n');
  }

  if (asksHookQuantity && /rail 40/i.test(query) && !/1[,\\.]50|1,5|1\.5/i.test(output)) {
    output += [
      '',
      'Planungshinweis:',
      'F\u00fcr RAIL 40 ist aus dem Vertriebs-/Planungskontext eine maximale \u00dcberspannung von ca. 1,50 m als relevanter Planungswert bekannt. Die tats\u00e4chliche Anzahl der Dachhaken muss dennoch projektspezifisch mit Wind-/Schneelast, Randzonen, Modulbelegung und Statik gepr\u00fcft werden.'
    ].join('\n');
  }

  return output;
}

function postProcessSalesReply(reply, userMessage = '') {
  let output = String(reply || '');
  const query = String(userMessage || '').toLowerCase();
  const isTileRoofQuestion = /(ziegel|zieldach|dachhaken|erus|e58|tonziegel|betondachstein)/i.test(query);
  const asksHookQuantity = /(wie viele|wieviele|anzahl|dachhaken.*ben[oÃ¶]tig|ben[oÃ¶]tige.*dachhaken)/i.test(query);

  if (isTileRoofQuestion && (!/Alpha-Platte/i.test(output) || !/Delta-Platte/i.test(output))) {
    output += [
      '',
      'Zusatzhinweis aus der SL Rack Vertriebslogik:',
      'Bei ZiegeldÃ¤chern bitte nicht nur Dachhaken betrachten. Je nach Ziegeltyp und Projekt kÃ¶nnen auch Alpha-Platte und Delta-Platte relevante SL Rack Optionen sein. FÃ¼r eine belastbare Auswahl bitte den exakten Ziegeltyp, Tonziegel/Betondachstein, Dachneigung und Lattungsabstand prÃ¼fen.'
    ].join('\n');
  }

  if (/dachhaken|edelstahl|sl a2/i.test(output) && /preiswert|gÃ¼nstig|guenstig|cheap|low-cost/i.test(output)) {
    output += [
      '',
      'Hinweis zur Preisbewertung:',
      'Eine pauschale Aussage wie preiswert oder gÃ¼nstig ist bei Edelstahl-Dachhaken nicht belastbar. Die wirtschaftlich passende LÃ¶sung hÃ¤ngt vom Dach, Material, Ziegeltyp, statischer Auslegung und den verfÃ¼gbaren SL Rack Alternativen ab.'
    ].join('\n');
  }

  if (asksHookQuantity && /rail 40/i.test(query) && !/1[,\\.]50|1,5|1\.5/i.test(output)) {
    output += [
      '',
      'Planungshinweis:',
      'FÃ¼r RAIL 40 ist aus dem Vertriebs-/Planungskontext eine maximale Ãœberspannung von ca. 1,50 m als relevanter Planungswert bekannt. Die tatsÃ¤chliche Anzahl der Dachhaken muss dennoch projektspezifisch mit Wind-/Schneelast, Randzonen, Modulbelegung und Statik geprÃ¼ft werden.'
    ].join('\n');
  }

  return output;
}
