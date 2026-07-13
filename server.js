import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import OpenAI from 'openai';
import { BlobPreconditionFailedError, get as getBlob, put as putBlob } from '@vercel/blob';
import { waitUntil as vercelWaitUntil } from '@vercel/functions';
import { productCatalog, companyFacts, scoreProducts } from './src/slRackKnowledge.js';
import { buildSystemPrompt } from './src/systemPrompt.js';
import { getKnowledgeStatus, searchKnowledge } from './src/knowledgeSearch.js';
import {
  hasAnalyticsDatabase,
  insertAnalyticsEvents,
  loadAnalyticsDatabaseSnapshot
} from './src/analyticsDatabase.js';
import { enforceRateLimit, hasDistributedRateLimit, hashRateLimitIdentifier } from './src/rateLimit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.disable('x-powered-by');
const port = Number(process.env.PORT || 3000);
const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const publicDir = path.join(__dirname, 'public');
const MAX_MESSAGES = Number(process.env.CHAT_MAX_MESSAGES || 8);
const MAX_MESSAGE_CHARS = Number(process.env.CHAT_MAX_MESSAGE_CHARS || 1500);
const MAX_TOTAL_CHARS = Number(process.env.CHAT_MAX_TOTAL_CHARS || 5000);
const MAX_OUTPUT_TOKENS = Number(process.env.CHAT_MAX_OUTPUT_TOKENS || 900);
const RATE_WINDOW_MS = Number(process.env.CHAT_RATE_WINDOW_MS || 60_000);
const RATE_MAX_REQUESTS = Number(process.env.CHAT_RATE_MAX_REQUESTS || 12);
const DAILY_MAX_REQUESTS = Number(process.env.CHAT_DAILY_MAX_REQUESTS || 120);
const DAILY_MAX_INPUT_CHARS = Number(process.env.CHAT_DAILY_MAX_INPUT_CHARS || 120_000);
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 55_000);
const ADMIN_LOGIN_MAX_ATTEMPTS = Number(process.env.ADMIN_LOGIN_MAX_ATTEMPTS || 5);
const ADMIN_LOGIN_WINDOW_MS = Number(process.env.ADMIN_LOGIN_WINDOW_MS || 15 * 60 * 1000);
const CLIENT_EVENT_MAX_REQUESTS = Number(process.env.CLIENT_EVENT_MAX_REQUESTS || 60);
const ADMIN_PATH = process.env.ADMIN_PATH || '';
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const ADMIN_PASSWORD_SCRYPT = process.env.ADMIN_PASSWORD_SCRYPT || '';
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || process.env.OPENAI_API_KEY || crypto.randomBytes(32).toString('hex');
const ADMIN_COOKIE = 'slrack_admin_session';
const CHAT_SESSION_COOKIE = 'slrack_chat_session';
const ACTIVE_SESSION_MS = Number(process.env.ACTIVE_SESSION_MS || 30 * 60 * 1000);
const ADMIN_EVENT_WINDOW_MS = 5 * 60 * 60 * 1000;
const ADMIN_EVENT_PREVIEW_LIMIT = 10;
const ANALYTICS_WRITE_RETRIES = 8;
const ANALYTICS_BLOB_MIGRATION_VERSION = 2;
const ANALYTICS_TIME_ZONE = 'Europe/Berlin';
const CLIENT_ANALYTICS_EVENTS = new Set([
  'session_started',
  'quick_action_clicked',
  'source_clicked',
  'contact_offered',
  'contact_clicked',
  'client_error'
]);
const ANALYTICS_BLOB_PATH = process.env.ANALYTICS_BLOB_PATH || 'analytics/live.json';
const HAS_BLOB_STORAGE = Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
let analyticsLoaded = false;
let analyticsSaveQueue = Promise.resolve();
let pendingAnalyticsEvents = [];
let lastAiSuccessAt = null;
let lastAiErrorAt = null;
let lastAiErrorCode = null;
let analyticsBlobMigrationComplete = false;
const analytics = {
  schemaVersion: 2,
  legacyTotals: { questions: 0, sessions: 0 },
  startedAt: new Date().toISOString(),
  events: 0,
  chats: 0,
  totalQuestions: 0,
  totalSubmitted: 0,
  rejectedQuestions: 0,
  totalSessions: 0,
  blocked: 0,
  errors: 0,
  attachments: 0,
  contacts: 0,
  contactOffers: 0,
  sourceClicks: 0,
  quickActions: 0,
  clientErrors: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  averageLatencyMs: 0,
  topEvents: new Map(),
  topQuestions: new Map(),
  topProducts: new Map(),
  topTopics: new Map(),
  sessions: new Map(),
  eventLog: [],
  lastEvents: []
};

const productAnalyticsTerms = buildProductAnalyticsTerms();
const topicAnalyticsTerms = buildTopicAnalyticsTerms();

app.use(securityHeaders);
app.use(blockCrossOriginApiRequests);
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});
app.use(express.json({ limit: '80kb' }));
app.use(express.static(publicDir));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    aiConfigured: Boolean(client),
    analyticsStorage: hasAnalyticsDatabase() ? 'database' : HAS_BLOB_STORAGE ? 'blob' : 'memory',
    distributedRateLimit: hasDistributedRateLimit()
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

app.post('/api/admin/login', async (req, res) => {
  await ensureAnalyticsLoaded();
  const loginIdentifier = buildRateLimitIdentifier(req, 'admin-login');
  const loginLimit = await enforceRateLimit({
    scope: 'admin-login',
    identifier: loginIdentifier,
    limit: ADMIN_LOGIN_MAX_ATTEMPTS,
    windowMs: ADMIN_LOGIN_WINDOW_MS
  });
  setRateLimitHeaders(res, loginLimit);
  if (!loginLimit.ok) {
    recordAnalyticsEvent('admin_login_rate_limited');
    await persistAnalytics();
    return res.status(429).json({ error: 'too_many_attempts' });
  }

  const username = String(req.body?.username || '');
  const password = String(req.body?.password || '');

  if (!isValidAdminLogin(username, password)) {
    recordAnalyticsEvent('admin_login_failed');
    await persistAnalytics();
    return res.status(401).json({ error: 'invalid_login' });
  }

  setAdminSessionCookie(res);
  recordAnalyticsEvent('admin_login_success');
  await persistAnalytics();
  res.json({ ok: true });
});

app.post('/api/admin/logout', (_req, res) => {
  clearAdminSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/admin/summary', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(404).json({ error: 'not_found' });
  }

  await refreshAnalyticsFromStorage();
  res.json(buildAdminSummary());
});

app.get('/api/admin/events.csv', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(404).json({ error: 'not_found' });
  }

  await refreshAnalyticsFromStorage();
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sl-rack-chatbot-event-log-${date}.csv"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(`\uFEFF${buildEventLogCsv(analytics.eventLog)}`);
});

app.get('/api/admin/questions.csv', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(404).json({ error: 'not_found' });
  }

  await refreshAnalyticsFromStorage();
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sl-rack-chatbot-all-questions-${date}.csv"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(`\uFEFF${buildQuestionsCsv(analytics.eventLog)}`);
});

app.get('/api/admin/topics.csv', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(404).json({ error: 'not_found' });
  }

  await refreshAnalyticsFromStorage();
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sl-rack-chatbot-top-themen-${date}.csv"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(`\uFEFF${buildTopicsCsv(analytics.eventLog)}`);
});

app.get('/api/admin/unresolved-questions.csv', async (req, res) => {
  if (!isAdminRequest(req)) {
    return res.status(404).json({ error: 'not_found' });
  }

  await refreshAnalyticsFromStorage();
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sl-rack-chatbot-upiti-bez-dobrog-odgovora-${date}.csv"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(`\uFEFF${buildUnresolvedQuestionsCsv(analytics.eventLog)}`);
});

app.get('/api/analytics/summary', async (req, res) => {
  if (!canReadAnalytics(req)) {
    return res.status(404).json({ error: 'not_found' });
  }

  await refreshAnalyticsFromStorage();
  res.json(getAnalyticsSummary());
});

app.post('/api/analytics', async (req, res) => {
  await ensureAnalyticsLoaded();
  const eventLimit = await enforceRateLimit({
    scope: 'client-events',
    identifier: buildRateLimitIdentifier(req, 'client-events'),
    limit: CLIENT_EVENT_MAX_REQUESTS,
    windowMs: 60_000
  });
  setRateLimitHeaders(res, eventLimit);
  if (!eventLimit.ok) return res.status(429).json({ error: 'rate_limited' });

  const eventType = String(req.body?.type || '');
  if (!CLIENT_ANALYTICS_EVENTS.has(eventType)) return res.status(204).end();
  const sessionId = getOrCreateChatSession(req, res);
  if (eventType === 'session_started' && hasSessionEvent(sessionId, eventType)) return res.status(204).end();
  recordAnalyticsEvent(eventType, req.body?.payload, sessionId);
  await persistAnalytics();
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
  await ensureAnalyticsLoaded();
  const sessionId = getOrCreateChatSession(req, res);
  const rawMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const rawLatestUserMessage = [...rawMessages]
    .reverse()
    .find((message) => message?.role !== 'assistant')?.content || '';
  const requestId = normalizeRequestId(req.body?.requestId) || crypto.randomUUID();
  const validation = await validateChatRequest(req, rawMessages);

  if (!validation.ok) {
    if (String(rawLatestUserMessage).trim()) {
      recordAnalyticsEvent(
        'question_rejected',
        {
          question: String(rawLatestUserMessage),
          requestId,
          source: 'chat_api',
          reason: validation.error
        },
        sessionId
      );
    }
    recordAnalyticsEvent('chat_blocked', { error: validation.error, requestId }, sessionId);
    await persistAnalytics();
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
  const requestStartedAt = Date.now();
  const profile = req.body?.profile || {};
  const recommendations = scoreProducts(profile).slice(0, 3);
  const latestUserMessage = [...messages].reverse().find((message) => message.role !== 'assistant')?.content || '';
  recordAnalyticsEvent('chat_submitted', { messageLength: latestUserMessage.length, requestId, source: 'chat_api' }, sessionId);
  recordAnalyticsEvent('question_asked', { question: latestUserMessage, requestId, source: 'chat_api' }, sessionId);
  const knowledgeResults = buildKnowledgeContext(latestUserMessage, profile, 4);
  const publicCompanySources = buildPublicCompanySources(latestUserMessage);
  const documentSources = publicCompanySources.length
    ? publicCompanySources
    : buildDocumentSources(knowledgeResults);

  if (!messages.length) {
    recordAnalyticsEvent('chat_blocked', { error: 'empty_messages' }, sessionId);
    await persistAnalytics();
    return res.status(400).json({ error: 'messages array is required' });
  }

  if (isRevenueQuestion(latestUserMessage)) {
    const reply = buildPublicRevenueReply(latestUserMessage);
    const quality = analyzeReplyQuality(reply, 'public_company_info');
    recordAnalyticsEvent('chat_answered', { sourceCount: documentSources.length, mode: 'public_company_info', requestId, durationMs: Date.now() - requestStartedAt, ...quality }, sessionId);
    scheduleAnalyticsPersistence();
    return res.json({
      mode: 'public_company_info',
      reply,
      recommendations,
      knowledgeResults,
      documentSources
    });
  }

  if (!client) {
    const reply = postProcessSalesReplySafe(buildFallbackReply(profile, recommendations), latestUserMessage);
    const quality = analyzeReplyQuality(reply, 'fallback');
    recordAnalyticsEvent('chat_answered', { sourceCount: documentSources.length, mode: 'fallback', requestId, durationMs: Date.now() - requestStartedAt, ...quality }, sessionId);
    scheduleAnalyticsPersistence();
    return res.json({
      mode: 'fallback',
      reply,
      recommendations,
      knowledgeResults,
      documentSources
    });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
    let response;
    try {
      response = await client.responses.create(
        {
          model,
          temperature: 0.35,
          max_output_tokens: MAX_OUTPUT_TOKENS,
          input: [
            {
              role: 'system',
              content: buildSystemPrompt({
                companyFacts,
                recommendations,
                knowledgeResults
              })
            },
            ...messages
          ]
        },
        { signal: controller.signal }
      );
    } finally {
      clearTimeout(timeout);
    }

    const reply = postProcessSalesReplySafe(response.output_text, latestUserMessage);
    const quality = analyzeReplyQuality(reply, 'ai');
    const usage = normalizeOpenAiUsage(response.usage);
    lastAiSuccessAt = new Date().toISOString();
    lastAiErrorAt = null;
    lastAiErrorCode = null;

    recordAnalyticsEvent('chat_answered', { sourceCount: documentSources.length, mode: 'ai', requestId, durationMs: Date.now() - requestStartedAt, ...usage, ...quality }, sessionId);
    scheduleAnalyticsPersistence();
    res.json({
      mode: 'ai',
      reply,
      recommendations,
      knowledgeResults,
      documentSources
    });
  } catch (error) {
    console.error(error);
    lastAiErrorAt = new Date().toISOString();
    lastAiErrorCode = String(error?.code || error?.name || error?.status || 'unknown').slice(0, 80);
    recordAnalyticsEvent('chat_error', { status: error?.status, code: error?.code, requestId, durationMs: Date.now() - requestStartedAt }, sessionId);
    const quotaError = error?.code === 'insufficient_quota';
    const rateLimitError = error?.status === 429 && !quotaError;
    const timeoutError = error?.name === 'AbortError';
    scheduleAnalyticsPersistence();
    res.status(quotaError || rateLimitError || timeoutError ? 200 : 500).json({
      mode: quotaError ? 'quota_fallback' : rateLimitError ? 'rate_limit_fallback' : timeoutError ? 'timeout_fallback' : 'error_fallback',
      error: quotaError
        ? 'OpenAI API key is valid, but the account has no available API quota. Please add billing or credits in the OpenAI platform.'
        : rateLimitError
          ? 'OpenAI is temporarily rate limited. Please try again shortly.'
          : timeoutError
            ? 'AI response timed out.'
            : 'AI response failed',
      reply: postProcessSalesReplySafe(buildFallbackReply(profile, recommendations), latestUserMessage),
      recommendations,
      knowledgeResults,
      documentSources
    });
  }
});

app.use((error, req, res, _next) => {
  console.error('Unhandled request error:', error?.message || error);
  if (res.headersSent) return res.end();
  const invalidJson = error instanceof SyntaxError && 'body' in error;
  res.status(invalidJson ? 400 : 500).json({
    error: invalidJson ? 'invalid_json' : 'internal_error',
    reply: invalidJson
      ? 'Die Anfrage konnte nicht gelesen werden. Bitte versuchen Sie es erneut.'
      : 'Der Dienst ist voruebergehend nicht verfuegbar.'
  });
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
      :root { color-scheme: light; --brand:#004528; --brand-2:#075d3a; --brand-3:#0c2f22; --accent:#f7a600; --accent-2:#ffd36b; --ink:#10231b; --muted:#65736c; --line:#dfe7e2; --surface:#eef4ef; --panel:#ffffff; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: linear-gradient(180deg, #e8f1eb 0, #f7faf8 430px, #eef4ef 100%); color: var(--ink); }
      .admin-shell { min-height: 100vh; display: grid; grid-template-rows: auto 1fr; }
      header { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 26px; background: rgba(255,255,255,.82); border-bottom: 1px solid rgba(0,69,40,.12); box-shadow: 0 12px 36px rgba(0,69,40,.08); backdrop-filter: blur(18px); }
      header img { width: 132px; height: auto; display: block; }
      .admin-pill { display: inline-flex; align-items: center; gap: 9px; border: 1px solid rgba(0,69,40,.14); border-radius: 999px; padding: 9px 14px; background: rgba(255,255,255,.9); box-shadow: 0 10px 26px rgba(0,69,40,.08); color: var(--brand); font-size: .86rem; font-weight: 950; }
      .admin-pill::before { width: 9px; height: 9px; border-radius: 999px; background: var(--accent); box-shadow: 0 0 0 5px rgba(247,166,0,.16); content: ""; }
      main { width: min(1220px, 100%); margin: 0 auto; padding: 26px; }
      .login, .panel { background: rgba(255,255,255,.9); border: 1px solid rgba(0,69,40,.11); border-radius: 8px; box-shadow: 0 28px 90px rgba(0, 48, 29, .14); backdrop-filter: blur(10px); }
      .login { width: min(460px, 100%); margin: 9vh auto 0; padding: 0; overflow: hidden; }
      .login-hero { padding: 26px; background: linear-gradient(135deg, #06351f, #0b5c39 62%, #174833); color: #fff; }
      .login-hero img { width: 138px; padding: 9px 11px; border-radius: 8px; background: #fff; box-shadow: 0 18px 40px rgba(0,0,0,.18); }
      .login-body { padding: 26px; }
      h1, h2, p { margin-top: 0; }
      h1 { margin-bottom: 7px; font-size: clamp(1.45rem, 2.2vw, 2.2rem); letter-spacing: 0; }
      h2 { font-size: 1.04rem; }
      label { display: grid; gap: 7px; margin-top: 14px; font-weight: 800; color: #26362f; }
      input { width: 100%; border: 1px solid var(--line); border-radius: 8px; padding: 12px 13px; font: inherit; }
      input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(247,166,0,.16); outline: none; }
      button { border: 0; border-radius: 8px; padding: 12px 17px; background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #00331e; font: inherit; font-weight: 950; cursor: pointer; transition: transform .16s ease, box-shadow .16s ease, background .16s ease; }
      button:hover { background: #ffc247; box-shadow: 0 12px 24px rgba(247,166,0,.22); transform: translateY(-1px); }
      button.secondary { background: linear-gradient(135deg, var(--brand), var(--brand-2)); color: #fff; }
      button.secondary:hover { background: #00331e; box-shadow: 0 12px 24px rgba(0,69,40,.2); }
      .toolbar { position: relative; overflow: hidden; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; padding: 26px; border-bottom: 1px solid rgba(255,255,255,.12); background: linear-gradient(135deg, #062d1d 0, #075d3a 58%, #184232 100%); color: #fff; border-radius: 8px 8px 0 0; }
      .toolbar .muted { color: rgba(255,255,255,.78); }
      .toolbar-actions { display: flex; flex-wrap: wrap; gap: 10px; }
      .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; padding: 20px; }
      .card { position: relative; overflow: hidden; background: linear-gradient(180deg, rgba(255,255,255,.98), rgba(252,254,253,.95)); border: 1px solid rgba(0,69,40,.1); border-radius: 8px; padding: 18px; box-shadow: 0 18px 46px rgba(0,69,40,.07); transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease; }
      .card::before { position: absolute; inset: 0 auto 0 0; width: 4px; background: linear-gradient(180deg, var(--brand), var(--accent)); content: ""; opacity: .94; }
      .card:hover { transform: translateY(-2px); border-color: rgba(247,166,0,.28); box-shadow: 0 24px 58px rgba(0,69,40,.1); }
      .card.ok::before { background: linear-gradient(180deg, #0a7d4f, #4fc47b); }
      .card.warn::before { background: linear-gradient(180deg, #a46a00, var(--accent)); }
      .card[data-tooltip] { cursor: help; }
      .card[data-tooltip]::after { position: absolute; left: 16px; right: 16px; bottom: calc(100% - 8px); z-index: 20; display: block; width: max-content; max-width: min(360px, calc(100vw - 48px)); padding: 10px 12px; border: 1px solid rgba(0,69,40,.14); border-radius: 8px; background: #0f2f22; box-shadow: 0 18px 38px rgba(0,69,40,.2); color: #fff; content: attr(data-tooltip); font-size: .78rem; font-weight: 750; line-height: 1.35; opacity: 0; pointer-events: none; transform: translateY(6px); transition: opacity .15s ease, transform .15s ease; white-space: normal; }
      .card[data-tooltip]:hover { overflow: visible; z-index: 30; border-color: rgba(247,166,0,.45); }
      .card[data-tooltip]:hover::after { opacity: 1; transform: translateY(0); }
      .metric { color: #53665d; font-size: .72rem; font-weight: 950; text-transform: uppercase; }
      .value { display: block; margin-top: 11px; font-size: clamp(1.65rem, 3vw, 2.38rem); font-weight: 950; color: var(--brand); line-height: 1; }
      .wide { grid-column: 1 / -1; }
      .card-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 12px; }
      .card-heading h2 { margin: 0; }
      .card-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 10px; }
      .download-link { display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; padding: 10px 13px; background: linear-gradient(135deg, var(--brand), var(--brand-2)); color: #fff; font-size: .82rem; font-weight: 950; text-decoration: none; box-shadow: 0 12px 28px rgba(0,69,40,.14); transition: transform .16s ease, box-shadow .16s ease; }
      .download-link::after { margin-left: 8px; color: var(--accent-2); content: "CSV"; font-size: .68rem; font-weight: 950; }
      .download-link:hover { transform: translateY(-1px); box-shadow: 0 16px 32px rgba(0,69,40,.2); }
      .chart-summary { display: flex; flex-wrap: wrap; gap: 8px; }
      .chart-summary span { display: inline-flex; align-items: baseline; gap: 6px; border: 1px solid rgba(0,69,40,.12); border-radius: 999px; padding: 8px 11px; background: #f7fbf8; color: #53665d; font-size: .78rem; font-weight: 850; }
      .chart-summary strong { color: var(--brand); font-size: 1rem; }
      .product-chart { display: grid; gap: 11px; margin: 16px 0 18px; padding: 16px; border: 1px solid rgba(0,69,40,.1); border-radius: 8px; background: linear-gradient(180deg, #f7fbf8, #fff); box-shadow: inset 0 1px 0 rgba(255,255,255,.8); }
      .bar-row { display: grid; grid-template-columns: 32px minmax(160px, 1fr) minmax(190px, 2.25fr) 50px; align-items: center; gap: 11px; min-width: 0; padding: 7px 8px; border-radius: 8px; transition: background .16s ease; }
      .bar-row:hover { background: rgba(0,69,40,.04); }
      .bar-row.top { background: linear-gradient(90deg, rgba(247,166,0,.1), rgba(255,255,255,0)); }
      .bar-rank { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 1px solid rgba(247,166,0,.22); border-radius: 999px; background: linear-gradient(180deg, #fff8e8, #fde7aa); color: #7a5200; font-size: .78rem; font-weight: 950; box-shadow: 0 8px 18px rgba(247,166,0,.1); }
      .bar-label { min-width: 0; color: #1f342b; font-size: .92rem; font-weight: 900; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bar-track { position: relative; height: 16px; overflow: hidden; border-radius: 999px; background: linear-gradient(180deg, #e8f0eb, #edf5f0); box-shadow: inset 0 0 0 1px rgba(0,69,40,.08); }
      .bar-fill { display: block; width: var(--bar-width); height: 100%; min-width: 6px; border-radius: inherit; background: linear-gradient(90deg, #004528 0, #0b6a43 58%, #f7a600 100%); box-shadow: 0 10px 18px rgba(0,69,40,.2); }
      .bar-count { color: var(--brand); font-weight: 950; text-align: right; }
      table { width: 100%; border-collapse: separate; border-spacing: 0; table-layout: fixed; font-size: .92rem; }
      th, td { border-bottom: 1px solid var(--line); padding: 12px 10px; text-align: left; vertical-align: top; }
      th { background: #f7fbf8; color: #26362f; font-size: .74rem; letter-spacing: .02em; text-transform: uppercase; }
      th:first-child { border-radius: 8px 0 0 0; }
      th:last-child { border-radius: 0 8px 0 0; }
      td { min-width: 0; overflow-wrap: anywhere; word-break: break-word; }
      tr:hover td { background: #f8fbf9; }
      .muted { color: var(--muted); }
      .hidden { display: none !important; }
      .error { color: #a33; font-weight: 800; min-height: 1.4em; }
      @media (max-width: 900px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
      @media (max-width: 620px) {
        body { overflow-x: hidden; }
        main { min-width: 0; padding: 12px; }
        header { padding: 12px 14px; }
        header img { width: 112px; }
        .admin-pill { padding: 7px 10px; font-size: .78rem; }
        .grid { grid-template-columns: minmax(0, 1fr); padding: 12px; }
        .toolbar { padding: 16px; }
        .login { margin-top: 5vh; }
        .card, .wide { min-width: 0; max-width: 100%; }
        .card-heading { align-items: stretch; }
        .card-heading > * { min-width: 0; }
        .card-actions { justify-content: stretch; }
        .card-actions > * { width: 100%; }
        .download-link { width: 100%; }
        .product-chart { padding: 12px; }
        .bar-row { grid-template-columns: 28px minmax(0, 1fr) 42px; gap: 8px; }
        .bar-track { grid-column: 2 / 4; }
        .bar-label { white-space: normal; overflow: visible; text-overflow: clip; }
        table, tbody, tr, td { display: block; width: 100%; }
        table { table-layout: auto; }
        thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
        tbody tr { padding: 9px 0; border-bottom: 1px solid var(--line); }
        tbody tr:last-child { border-bottom: 0; }
        td { display: grid; grid-template-columns: 82px minmax(0, 1fr); gap: 10px; border: 0; padding: 6px 4px; overflow-wrap: anywhere; word-break: break-word; }
        td::before { color: var(--muted); content: attr(data-label); font-size: .7rem; font-weight: 900; letter-spacing: .02em; text-transform: uppercase; }
        tr:hover td { background: transparent; }
      }
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
              <p class="muted">Persistente Statistik der aktuellen Produktionsinstanz.</p>
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

async function ensureAnalyticsLoaded() {
  if (analyticsLoaded) return;
  if (!HAS_BLOB_STORAGE && !hasAnalyticsDatabase()) {
    analyticsLoaded = true;
    return;
  }

  analyticsLoaded = true;
  if (hasAnalyticsDatabase()) {
    try {
      const databaseSnapshot = await loadAnalyticsDatabaseSnapshot();
      if (Number(databaseSnapshot?.blobMigrationVersion || 0) >= ANALYTICS_BLOB_MIGRATION_VERSION) {
        analyticsBlobMigrationComplete = true;
        hydrateAnalytics(databaseSnapshot);
        return;
      }

      const blobSnapshot = await readStoredAnalyticsSnapshot();
      if (blobSnapshot?.snapshot) {
        hydrateAnalytics(mergeAnalyticsSnapshots(databaseSnapshot, blobSnapshot.snapshot));
        await insertAnalyticsEvents(analytics.eventLog, {
          ...buildAnalyticsMetaSnapshot(),
          blobMigrationVersion: ANALYTICS_BLOB_MIGRATION_VERSION,
          blobMigratedAt: new Date().toISOString()
        });
        analyticsBlobMigrationComplete = true;
        return;
      }

      if (databaseSnapshot?.eventLog?.length) hydrateAnalytics(databaseSnapshot);
      analyticsBlobMigrationComplete = true;
      return;
    } catch (error) {
      console.warn('Analytics database load failed, using Blob fallback:', error?.message || error);
    }
  }

  try {
    const result = await getBlob(ANALYTICS_BLOB_PATH, { access: 'private', useCache: false });
    if (!result?.stream) return;
    const text = await new Response(result.stream).text();
    const stored = JSON.parse(text);
    hydrateAnalytics(stored);
  } catch (error) {
    if (error?.name !== 'BlobNotFoundError') {
      console.warn('Analytics blob load failed:', error?.message || error);
    }
  }
}

async function persistAnalytics() {
  if (!HAS_BLOB_STORAGE && !hasAnalyticsDatabase()) return;

  analyticsSaveQueue = analyticsSaveQueue
    .then(async () => {
      const pending = [...pendingAnalyticsEvents];
      if (!pending.length) return;

      if (hasAnalyticsDatabase()) {
        try {
          const saved = await insertAnalyticsEvents(pending, buildAnalyticsMetaSnapshot());
          if (saved) {
            const savedIds = new Set(pending.map((event) => event.id));
            pendingAnalyticsEvents = pendingAnalyticsEvents.filter((event) => !savedIds.has(event.id));
            return;
          }
        } catch (error) {
          console.warn('Analytics database save failed, using Blob fallback:', error?.message || error);
        }
      }

      if (!HAS_BLOB_STORAGE) throw new Error('No analytics persistence backend is available');

      for (let attempt = 0; attempt < ANALYTICS_WRITE_RETRIES; attempt += 1) {
        const current = serializeAnalytics();
        const storedResult = await readStoredAnalyticsSnapshot();
        const merged = mergeAnalyticsSnapshots(storedResult?.snapshot, current);

        try {
          await putBlob(ANALYTICS_BLOB_PATH, JSON.stringify(merged), {
            access: 'private',
            allowOverwrite: true,
            contentType: 'application/json',
            cacheControlMaxAge: 60,
            ...(storedResult?.etag ? { ifMatch: storedResult.etag } : {})
          });

          // Preserve events accepted by this instance while the Blob write was in flight.
          hydrateAnalytics(mergeAnalyticsSnapshots(merged, serializeAnalytics()));
          const savedIds = new Set(pending.map((event) => event.id));
          pendingAnalyticsEvents = pendingAnalyticsEvents.filter((event) => !savedIds.has(event.id));
          return;
        } catch (error) {
          if (!(error instanceof BlobPreconditionFailedError) && error?.name !== 'BlobPreconditionFailedError') {
            throw error;
          }
          await wait(20 + Math.floor(Math.random() * 40) + attempt * 25);
        }
      }

      throw new Error('Analytics write conflict retry limit reached');
    })
    .catch((error) => {
      console.warn('Analytics blob save failed:', error?.message || error);
    });

  await analyticsSaveQueue;
}

async function readStoredAnalyticsSnapshot() {
  try {
    const result = await getBlob(ANALYTICS_BLOB_PATH, { access: 'private', useCache: false });
    if (!result?.stream) return null;
    const text = await new Response(result.stream).text();
    return { snapshot: JSON.parse(text), etag: result.etag };
  } catch (error) {
    if (error?.name !== 'BlobNotFoundError') {
      console.warn('Analytics blob merge load failed:', error?.message || error);
    }
    return null;
  }
}

async function refreshAnalyticsFromStorage() {
  await ensureAnalyticsLoaded();
  if (hasAnalyticsDatabase()) {
    try {
      await analyticsSaveQueue;
      const storedSnapshot = await loadAnalyticsDatabaseSnapshot();
      if (storedSnapshot) hydrateAnalytics(mergeAnalyticsSnapshots(storedSnapshot, serializeAnalytics()));
      return;
    } catch (error) {
      console.warn('Analytics database refresh failed, using Blob fallback:', error?.message || error);
    }
  }

  if (!HAS_BLOB_STORAGE) return;
  await analyticsSaveQueue;
  const firstRead = await readStoredAnalyticsSnapshot();
  await wait(80);
  const secondRead = await readStoredAnalyticsSnapshot();
  const storedSnapshot = mergeAnalyticsSnapshots(firstRead?.snapshot, secondRead?.snapshot || firstRead?.snapshot);
  if (storedSnapshot) {
    hydrateAnalytics(mergeAnalyticsSnapshots(storedSnapshot, serializeAnalytics()));
  }
}

function serializeAnalytics() {
  return {
    ...analytics,
    topEvents: [...analytics.topEvents.entries()],
    topQuestions: [...analytics.topQuestions.entries()],
    topProducts: [...analytics.topProducts.entries()],
    topTopics: [...analytics.topTopics.entries()],
    sessions: [...analytics.sessions.entries()],
    savedAt: new Date().toISOString(),
    ...(analyticsBlobMigrationComplete ? { blobMigrationVersion: ANALYTICS_BLOB_MIGRATION_VERSION } : {})
  };
}
function scheduleAnalyticsPersistence() {
  const task = persistAnalytics();
  if (process.env.VERCEL === '1') vercelWaitUntil(task);
  return task;
}

function buildAnalyticsMetaSnapshot() {
  return {
    schemaVersion: analytics.schemaVersion,
    legacyTotals: analytics.legacyTotals,
    startedAt: analytics.startedAt,
    savedAt: new Date().toISOString(),
    ...(analyticsBlobMigrationComplete ? { blobMigrationVersion: ANALYTICS_BLOB_MIGRATION_VERSION } : {})
  };
}

function mergeAnalyticsSnapshots(stored, incoming) {
  if (!stored || typeof stored !== 'object') {
    return deriveAnalyticsSnapshot({ ...incoming, savedAt: new Date().toISOString() });
  }

  const merged = {
    ...stored,
    ...incoming,
    startedAt: stored.startedAt || incoming.startedAt,
    savedAt: new Date().toISOString()
  };

  merged.schemaVersion = 2;
  merged.legacyTotals = mergeLegacyTotals(stored.legacyTotals, incoming.legacyTotals);
  merged.sessions = mergeSessionEntries(stored.sessions, incoming.sessions);
  merged.eventLog = mergeEventLogs(
    stored.eventLog || stored.lastEvents,
    incoming.eventLog || incoming.lastEvents
  );
  return deriveAnalyticsSnapshot(merged);
}

function deriveAnalyticsSnapshot(snapshot) {
  const events = mergeEventLogs(snapshot?.eventLog || snapshot?.lastEvents, []);
  const topEvents = new Map();
  const topQuestions = new Map();
  const topProducts = new Map();
  const topTopics = new Map();
  const sessions = new Map(mergeSessionEntries(snapshot?.sessions, []));
  const seenQuestions = new Set();
  const seenAcceptedRequests = new Set();
  const seenRejectedRequests = new Set();
  const seenAnswers = new Set();
  const counters = {
    chats: 0,
    totalQuestions: 0,
    rejectedQuestions: 0,
    blocked: 0,
    errors: 0,
    attachments: 0,
    contacts: 0,
    contactOffers: 0,
    sourceClicks: 0,
    quickActions: 0,
    clientErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalLatencyMs: 0,
    latencySamples: 0
  };

  for (const event of events) {
    const type = String(event?.type || 'unknown');
    topEvents.set(type, (topEvents.get(type) || 0) + 1);

    const timestamp = Date.parse(event?.at || '');
    if (event?.sessionId && Number.isFinite(timestamp)) {
      const previous = sessions.get(event.sessionId) || 0;
      sessions.set(event.sessionId, Math.max(previous, timestamp));
    }

    if (type === 'question_asked') {
      const questionKey = buildRequestEventKey(event);
      if (questionKey) seenAcceptedRequests.add(questionKey);
      if (!seenQuestions.has(questionKey)) {
        seenQuestions.add(questionKey);
        const question = normalizeQuestion(event?.payload?.question);
        if (question) {
          topQuestions.set(question, (topQuestions.get(question) || 0) + 1);
          for (const label of getProductInterestLabels(question)) {
            topProducts.set(label, (topProducts.get(label) || 0) + 1);
          }
          for (const topic of getTopicLabels(question)) {
            topTopics.set(topic, (topTopics.get(topic) || 0) + 1);
          }
        }
      }
    }

    if (type === 'question_rejected') {
      const questionKey = buildRequestEventKey(event);
      if (!seenRejectedRequests.has(questionKey)) {
        seenRejectedRequests.add(questionKey);
        counters.rejectedQuestions += 1;
      }
    }

    if (type === 'chat_submitted') {
      const submissionKey = buildRequestEventKey(event);
      if (submissionKey) seenAcceptedRequests.add(submissionKey);
    }

    if (type === 'chat_answered') {
      const answerKey = buildRequestEventKey(event);
      if (answerKey) seenAcceptedRequests.add(answerKey);
      if (!seenAnswers.has(answerKey)) {
        seenAnswers.add(answerKey);
        counters.chats += 1;
        counters.inputTokens += Math.max(0, Number(event?.payload?.inputTokens || 0));
        counters.outputTokens += Math.max(0, Number(event?.payload?.outputTokens || 0));
        counters.totalTokens += Math.max(0, Number(event?.payload?.totalTokens || 0));
        const durationMs = Number(event?.payload?.durationMs || 0);
        if (durationMs > 0) {
          counters.totalLatencyMs += durationMs;
          counters.latencySamples += 1;
        }
      }
    }
    if (type === 'chat_blocked') counters.blocked += 1;
    if (type === 'chat_error' || type === 'chat_failed') counters.errors += 1;
    if (type === 'attachment_selected' || type === 'attachment_received') counters.attachments += 1;
    if (type === 'contact_clicked') counters.contacts += 1;
    if (type === 'contact_offered') counters.contactOffers += 1;
    if (type === 'source_clicked') counters.sourceClicks += 1;
    if (type === 'quick_action_clicked') counters.quickActions += 1;
    if (type === 'client_error') counters.clientErrors += 1;
  }

  counters.totalQuestions = seenAcceptedRequests.size;

  const migratedLegacyTotals = snapshot?.schemaVersion === 2 || snapshot?.legacyTotals
    ? normalizeLegacyTotals(snapshot?.legacyTotals)
    : {
        questions: Math.max(0, Number(snapshot?.totalQuestions || 0) - counters.totalQuestions),
        sessions: Math.max(0, Number(snapshot?.totalSessions || 0) - sessions.size)
      };

  return {
    ...snapshot,
    ...counters,
    schemaVersion: 2,
    legacyTotals: migratedLegacyTotals,
    events: events.length,
    totalQuestions: counters.totalQuestions + migratedLegacyTotals.questions,
    totalSubmitted: counters.totalQuestions + counters.rejectedQuestions + migratedLegacyTotals.questions,
    averageLatencyMs: counters.latencySamples
      ? Math.round(counters.totalLatencyMs / counters.latencySamples)
      : 0,
    totalSessions: sessions.size + migratedLegacyTotals.sessions,
    topEvents: [...topEvents.entries()],
    topQuestions: [...topQuestions.entries()],
    topProducts: [...topProducts.entries()],
    topTopics: [...topTopics.entries()],
    sessions: [...sessions.entries()],
    eventLog: events,
    lastEvents: events.slice(0, 50),
    savedAt: new Date().toISOString()
  };
}

function normalizeLegacyTotals(value) {
  return {
    questions: Math.max(0, Number(value?.questions || 0)),
    sessions: Math.max(0, Number(value?.sessions || 0))
  };
}

function mergeLegacyTotals(left, right) {
  const leftTotals = normalizeLegacyTotals(left);
  const rightTotals = normalizeLegacyTotals(right);
  return {
    questions: Math.max(leftTotals.questions, rightTotals.questions),
    sessions: Math.max(leftTotals.sessions, rightTotals.sessions)
  };
}

function mergeSessionEntries(leftEntries, rightEntries) {
  const sessions = new Map();
  for (const entries of [leftEntries, rightEntries]) {
    if (!Array.isArray(entries)) continue;
    for (const [id, session] of entries) {
      if (!id) continue;
      const lastSeen = normalizeSessionLastSeen(session);
      if (!lastSeen) continue;
      const previous = sessions.get(id);
      if (!previous || lastSeen >= normalizeSessionLastSeen(previous)) {
        sessions.set(id, lastSeen);
      }
    }
  }
  return [...sessions.entries()];
}

function normalizeSessionLastSeen(session) {
  const lastSeen = typeof session === 'object' ? Number(session?.lastSeen || 0) : Number(session || 0);
  return Number.isFinite(lastSeen) && lastSeen > 0 ? lastSeen : 0;
}

function mergeEventLogs(leftEvents, rightEvents) {
  const seen = new Set();
  const events = [];
  for (const event of [...(leftEvents || []), ...(rightEvents || [])]) {
    if (!event || typeof event !== 'object') continue;
    const key = event.id || `${event.type || ''}|${event.at || ''}|${JSON.stringify(event.payload || {})}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  return events.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

function hydrateAnalytics(stored) {
  if (!stored || typeof stored !== 'object') return;
  const derived = deriveAnalyticsSnapshot(stored);
  analytics.schemaVersion = derived.schemaVersion;
  analytics.legacyTotals = derived.legacyTotals;
  analytics.startedAt = derived.startedAt || analytics.startedAt;
  analytics.events = Number(derived.events || 0);
  analytics.chats = Number(derived.chats || 0);
  analytics.totalQuestions = Number(derived.totalQuestions || 0);
  analytics.totalSubmitted = Number(derived.totalSubmitted || derived.totalQuestions || 0);
  analytics.rejectedQuestions = Number(derived.rejectedQuestions || 0);
  analytics.totalSessions = Number(derived.totalSessions || 0);
  analytics.blocked = Number(derived.blocked || 0);
  analytics.errors = Number(derived.errors || 0);
  analytics.attachments = Number(derived.attachments || 0);
  analytics.contacts = Number(derived.contacts || 0);
  analytics.contactOffers = Number(derived.contactOffers || 0);
  analytics.sourceClicks = Number(derived.sourceClicks || 0);
  analytics.quickActions = Number(derived.quickActions || 0);
  analytics.clientErrors = Number(derived.clientErrors || 0);
  analytics.inputTokens = Number(derived.inputTokens || 0);
  analytics.outputTokens = Number(derived.outputTokens || 0);
  analytics.totalTokens = Number(derived.totalTokens || 0);
  analytics.averageLatencyMs = Number(derived.averageLatencyMs || 0);
  analytics.topEvents = new Map(derived.topEvents);
  analytics.topQuestions = new Map(derived.topQuestions);
  analytics.topProducts = new Map(derived.topProducts);
  analytics.topTopics = new Map(derived.topTopics);
  analytics.sessions = new Map(derived.sessions);
  analytics.eventLog = derived.eventLog;
  analytics.lastEvents = derived.lastEvents;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function blockCrossOriginApiRequests(req, res, next) {
  if (!req.path.startsWith('/api/') || !['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const origin = String(req.headers.origin || '').trim();
  if (!origin) return next();

  const forwardedProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const sameOrigin = forwardedHost ? [forwardedProto, '://', forwardedHost].join('') : '';
  const configuredOrigins = String(process.env.PUBLIC_APP_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const allowedOrigins = new Set([sameOrigin, ...configuredOrigins].filter(Boolean));

  if (allowedOrigins.has(origin)) return next();
  return res.status(403).json({ error: 'cross_origin_forbidden' });
}

function getOrCreateChatSession(req, res) {
  const cookies = parseCookies(req.headers.cookie || '');
  let sessionId = cookies[CHAT_SESSION_COOKIE];

  if (!/^[a-f0-9]{32}$/.test(sessionId || '')) {
    sessionId = crypto.randomBytes(16).toString('hex');
    const secure = process.env.VERCEL === '1' ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${CHAT_SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`
    );
  }

  if (!analytics.sessions.has(sessionId)) {
    analytics.totalSessions += 1;
  }

  analytics.sessions.set(sessionId, Date.now());
  req.chatSessionId = sessionId;
  pruneChatSessions();
  return sessionId;
}

function normalizeQuestion(question) {
  return String(question || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
}

function getProductInterestLabels(question) {
  const text = normalizeAnalyticsText(question);
  if (!text) return [];

  const matched = new Set();
  for (const term of productAnalyticsTerms) {
    if (term.aliases.some((alias) => text.includes(alias))) matched.add(term.label);
  }
  return [...matched].slice(0, 8);
}

function getTopicLabels(question) {
  const text = normalizeAnalyticsText(question);
  if (!text) return ['Sonstiges'];

  const matched = new Set();
  for (const term of topicAnalyticsTerms) {
    if (term.aliases.some((alias) => text.includes(alias))) matched.add(term.label);
  }
  return matched.size ? [...matched].slice(0, 8) : ['Sonstiges'];
}

function normalizeRequestId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{12,80}$/.test(id) ? id : '';
}

function buildRequestEventKey(event) {
  const requestId = normalizeRequestId(event?.payload?.requestId);
  if (!requestId) return String(event?.id || '');
  const sessionId = /^[a-f0-9]{32}$/.test(event?.sessionId || '') ? event.sessionId : 'legacy';
  return `${sessionId}:${requestId}`;
}

function normalizeOpenAiUsage(usage = {}) {
  const inputTokens = Math.max(0, Number(usage.input_tokens || usage.prompt_tokens || 0));
  const outputTokens = Math.max(0, Number(usage.output_tokens || usage.completion_tokens || 0));
  const totalTokens = Math.max(0, Number(usage.total_tokens || inputTokens + outputTokens));
  return { inputTokens, outputTokens, totalTokens };
}

function buildProductAnalyticsTerms() {
  const terms = new Map();
  const add = (label, aliases = []) => {
    const normalizedLabel = String(label || '').trim();
    if (!normalizedLabel) return;
    const existing = terms.get(normalizedLabel) || new Set();
    for (const value of [normalizedLabel, ...aliases]) {
      const alias = normalizeAnalyticsText(value);
      if (alias && alias.length >= 3) existing.add(alias);
    }
    terms.set(normalizedLabel, existing);
  };

  for (const product of productCatalog) {
    add(product.name, [product.id, product.category, ...(product.triggerWords || []), ...(product.bestFor || [])]);
    for (const keyProduct of product.keyProducts || []) {
      add(keyProduct, [product.name, product.id]);
    }
  }

  add('Dachhaken', ['dach haken', 'roof hook', 'sl a2', 'a2 dachhaken', 'alu multi hook', 'multi hook', '3d sl alu', 'erlus e58']);
  add('Dachhaken SL A2', ['sl a2', 'a2 dachhaken', 'dachhaken sl a2']);
  add('SL Alu Multi Hook', ['alu multi hook', 'multi hook', 'sl alu multi hook']);
  add('3D SL Alu', ['3d sl alu', '3d alu', 'dachhaken 3d sl alu']);
  add('Alpha-Platte', ['alpha platte', 'alphaplatte']);
  add('Beta-Platte', ['beta platte', 'betaplatte']);
  add('D-Platte / Delta-Platte', ['d platte', 'd-platte', 'delta platte', 'deltaplatte', 'erlus e58', 'erlus e58s']);
  add('SL Fast Flat', ['fast flat', 'flachdachsystem sl fast flat', 'sl fast flat de']);
  add('Flachdach Generation 2.0', ['flachdach generation', 'generation 2.0', 'flachdach 2.0']);
  add('RAIL', ['rail 40', 'rail 60', 'tragprofil', 'montageschiene', 'schiene']);
  add('RAIL 40', ['rail 40', 'rail40']);
  add('RAIL 60', ['rail 60', 'rail60']);
  add('Modulklemmen', ['modulklemme', 'mittelklemme', 'endklemme', 'modul klemme']);
  add('Falzklemmen', ['falzklemme', 'falz klemme', 'stehfalzklemme', 'dfalzcu', 'dfalzcu', 'zambelli']);
  add('Stehfalzklemme 2.0 - DFalzCU', ['dfalzcu', 'd falz cu', 'stehfalzklemme dfalzcu', 'stehfalzklemme 2.0 dfalzcu']);
  add('Zambelli RIB Roof', ['zambelli rib roof500', 'zambelli rib roof465', 'zambelli rib roof evo', 'zambelli']);
  add('Trapez 1-6', ['trapez', 'trapezblech', 'trapez 1', 'trapez 2', 'trapez 3', 'trapez 4', 'trapez 5', 'trapez 6']);
  add('SL Energy Wall', ['energy wall', 'fassade', 'fassadensystem']);
  add('SL Agri Wall', ['agri wall', 'agri pv', 'agri-pv']);
  add('SL Tracker', ['tracker', 'tracking']);
  add('Carportsysteme', ['carport', 'carportpfette', 'carportbinder', 'fundamentschuh']);
  add('Freiflaechensysteme', ['freiflaeche', 'freiflaechensystem', 'solar park', 'w-rammprofil', 'rammprofil', 'binder', 'z-strebe', 'z-pfette']);

  return [...terms.entries()].map(([label, aliases]) => ({ label, aliases: [...aliases] }));
}

function buildTopicAnalyticsTerms() {
  const terms = new Map();
  const add = (label, aliases = []) => {
    const normalizedLabel = String(label || '').trim();
    if (!normalizedLabel) return;
    const existing = terms.get(normalizedLabel) || new Set();
    for (const value of [normalizedLabel, ...aliases]) {
      const alias = normalizeAnalyticsText(value);
      if (alias && alias.length >= 3) existing.add(alias);
    }
    terms.set(normalizedLabel, existing);
  };

  add('Dachhaken', ['dachhaken', 'dach haken', 'roof hook', 'haken', 'edelstahlhaken', 'sl a2', '3d sl alu', 'multi hook']);
  add('Schraeg-/Ziegeldach', ['schraeg dach', 'schraegdach', 'schragdach', 'ziegeldach', 'ziegel', 'tonziegel', 'betondachstein', 'erlus', 'e58', 'favorit', 'topwinner']);
  add('Flachdach', ['flachdach', 'flat roof', 'fast flat', 'ballast', 'ost west', 'sued', 'sud', 'suedausrichtung', 'sudausrichtung', 'dachlast']);
  add('Freiflaeche', ['freiflaeche', 'freiflache', 'freifl che', 'freiflachensystem', 'ground mount', 'solarpark', 'rammprofil', 'pfettensystem', 'sparrensystem']);
  add('Dokumentation / PDF', ['dokumentation', 'dokument', 'pdf', 'datenblatt', 'produktdatenblatt', 'montageanleitung', 'prospekt', 'checkliste', 'zertifikat', 'garantie']);
  add('Preise / Kosten', ['preis', 'preise', 'kosten', 'kostet', 'guenstig', 'gunstig', 'gunstige', 'guenstige', 'g nstig', 'g nstige', 'günstig', 'günstige', 'preiswert', 'angebot', 'rabatt', 'budget']);
  add('Statik / Planung', ['statik', 'planung', 'auslegung', 'windlast', 'schneelast', 'last', 'ueberspannung', 'uberspannung', 'rail 40', 'solar.pro.tool', 'sl planner']);
  add('Kontakt / Vertrieb', ['kontakt', 'vertrieb', 'sales', 'angebot anfordern', 'mail', 'email', 'telefon', 'ansprechpartner', 'beratung']);
  add('Montage', ['montage', 'montieren', 'installation', 'installieren', 'befestigung', 'drehmoment', 'werkzeug', 'schraube']);
  add('RAIL / Schienen', ['rail', 'schiene', 'tragschiene', 'montageschiene', 'rail 40', 'rail 60', 'rail inlay']);
  add('Modulklemmen', ['modulklemme', 'mittelklemme', 'endklemme', 'klemme', 'klemmen']);
  add('Blechdach / Falz', ['blechdach', 'falz', 'falzklemme', 'stehfalz', 'trapez', 'trapezblech', 'zambelli', 'dfalzcu', 'kupferfalzdach']);
  add('Fassade', ['fassade', 'fassadensystem', 'energy wall', 'wall']);
  add('Carport', ['carport', 'parkplatz', 'stellplatz']);
  add('Agri-PV / Tracker', ['agri', 'agri pv', 'tracker', 'tracking', 'landwirtschaft']);
  add('Unternehmen', ['sl rack', 'firma', 'unternehmen', 'umsatz', 'revenue', 'promet', 'prihod']);

  return [...terms.entries()].map(([label, aliases]) => ({ label, aliases: [...aliases] }));
}

function normalizeAnalyticsText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getActiveSessionCount() {
  const now = Date.now();
  let active = 0;
  for (const lastSeen of analytics.sessions.values()) {
    if (now - lastSeen <= ACTIVE_SESSION_MS) active += 1;
  }
  return active;
}

function pruneChatSessions() {
  if (analytics.sessions.size < 5000) return;
  const now = Date.now();
  for (const [sessionId, lastSeen] of analytics.sessions.entries()) {
    if (now - lastSeen > 24 * 60 * 60 * 1000) {
      analytics.sessions.delete(sessionId);
    }
  }
}

function isValidAdminLogin(username, password) {
  if (!ADMIN_USER || (!ADMIN_PASSWORD_SCRYPT && !ADMIN_PASSWORD_HASH)) return false;
  const userOk = timingSafeEqualString(username, ADMIN_USER);
  const passwordOk = ADMIN_PASSWORD_SCRYPT
    ? verifyScryptPassword(password, ADMIN_PASSWORD_SCRYPT)
    : timingSafeEqualString(crypto.createHash('sha256').update(password).digest('hex'), ADMIN_PASSWORD_HASH);
  return userOk && passwordOk;
}

function verifyScryptPassword(password, encoded) {
  const [salt, expectedHex] = String(encoded || '').split(':');
  if (!/^[a-f0-9]{32}$/i.test(salt || '') || !/^[a-f0-9]{128}$/i.test(expectedHex || '')) return false;
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(actual, Buffer.from(expectedHex, 'hex'));
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
    const value = rawValue.join('=') || '';
    try {
      cookies[rawName] = decodeURIComponent(value);
    } catch {
      cookies[rawName] = value;
    }
  }
  return cookies;
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function recordAnalyticsEvent(type = 'unknown', payload = {}, sessionId = '') {
  const eventType = String(type || 'unknown').slice(0, 80);
  const event = {
    id: crypto.randomUUID(),
    type: eventType,
    at: new Date().toISOString(),
    sessionId: /^[a-f0-9]{32}$/.test(sessionId) ? sessionId : '',
    payload: sanitizeAnalyticsPayload(payload)
  };
  analytics.eventLog.unshift(event);
  pendingAnalyticsEvents.push(event);
  analytics.lastEvents = analytics.eventLog.slice(0, 50);
  if (event.sessionId) analytics.sessions.set(event.sessionId, Date.now());
}

function buildEventLogCsv(events) {
  const rows = [['Zeit (Europe/Berlin)', 'Zeit (UTC)', 'Event', 'Session', 'Details']];
  for (const event of mergeEventLogs(events, [])) {
    rows.push([
      formatBerlinDateTime(event.at),
      event.at || '',
      event.type || 'unknown',
      event.sessionId || '',
      Object.entries(event.payload || {})
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ')
    ]);
  }
  return rows.map((row) => row.map(csvCell).join(';')).join('\r\n');
}

function buildQuestionsCsv(events) {
  const rows = [
    [
      'Nr.',
      'Zeit (Europe/Berlin)',
      'Zeit (UTC)',
      'Status',
      'Frage',
      'Session',
      'Request ID',
      'Quelle',
      'Erkannte Produkte / Modelle',
      'Ablehnungsgrund'
    ]
  ];
  const questions = getQuestionLogRows(events, { includeRejected: true });

  questions.forEach((event, index) => {
    const question = normalizeQuestion(event.payload?.question);
    rows.push([
      index + 1,
      formatBerlinDateTime(event.at),
      event.at || '',
      event.type === 'question_rejected' ? 'Abgelehnt' : 'Akzeptiert',
      question,
      event.sessionId || '',
      event.payload?.requestId || '',
      event.payload?.source || '',
      getProductInterestLabels(question).join(', '),
      event.payload?.reason || ''
    ]);
  });

  return rows.map((row) => row.map(csvCell).join(';')).join('\r\n');
}

function buildTopicsCsv(events) {
  const topicCounts = getTopicCountRows(events);
  const total = topicCounts.reduce((sum, item) => sum + item.count, 0);
  const rows = [['Thema / Kategorie', 'Anzahl', 'Anteil %']];

  for (const item of topicCounts) {
    rows.push([
      item.topic,
      item.count,
      total ? Math.round((item.count / total) * 1000) / 10 : 0
    ]);
  }

  return rows.map((row) => row.map(csvCell).join(';')).join('\r\n');
}

function buildUnresolvedQuestionsCsv(events) {
  const rows = [
    [
      'Nr.',
      'Zeit (Europe/Berlin)',
      'Zeit (UTC)',
      'Frage',
      'Grund',
      'Antwortmodus',
      'Session',
      'Request ID',
      'Themen',
      'Erkannte Produkte / Modelle'
    ]
  ];

  getUnresolvedQuestionRows(events).forEach((row, index) => {
    rows.push([
      index + 1,
      formatBerlinDateTime(row.at),
      row.at || '',
      row.question,
      row.reason,
      row.mode,
      row.sessionId || '',
      row.requestId || '',
      row.topics.join(', '),
      row.products.join(', ')
    ]);
  });

  return rows.map((row) => row.map(csvCell).join(';')).join('\r\n');
}

function getQuestionLogRows(events, { includeRejected = false } = {}) {
  const seen = new Set();
  return mergeEventLogs(events, [])
    .filter(
      (event) =>
        (event?.type === 'question_asked' || (includeRejected && event?.type === 'question_rejected')) &&
        normalizeQuestion(event.payload?.question)
    )
    .filter((event) => {
      const key = buildRequestEventKey(event);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getTopicCountRows(events) {
  const topics = new Map();
  for (const event of getQuestionLogRows(events)) {
    const question = normalizeQuestion(event.payload?.question);
    for (const topic of getTopicLabels(question)) {
      topics.set(topic, (topics.get(topic) || 0) + 1);
    }
  }
  return [...topics.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([topic, count]) => ({ topic, count }));
}

function getUnresolvedQuestionRows(events) {
  const mergedEvents = mergeEventLogs(events, []);
  const questionsByRequest = new Map();
  const unresolvedByRequest = new Map();

  for (const event of mergedEvents) {
    const requestId = event?.payload?.requestId || '';
    const requestKey = buildRequestEventKey(event);
    if (event?.type === 'question_asked') {
      const question = normalizeQuestion(event.payload?.question);
      if (question && requestKey && !questionsByRequest.has(requestKey)) {
        questionsByRequest.set(requestKey, event);
      }
    }

    if (event?.type === 'chat_answered' && requestKey && isUnresolvedPayload(event.payload)) {
      unresolvedByRequest.set(requestKey, {
        requestKey,
        at: event.at,
        sessionId: event.sessionId,
        requestId,
        mode: event.payload?.mode || 'ai',
        reason: event.payload?.unresolvedReason || 'Antwort als unsicher markiert'
      });
    }

    if (event?.type === 'chat_error' && requestKey) {
      unresolvedByRequest.set(requestKey, {
        requestKey,
        at: event.at,
        sessionId: event.sessionId,
        requestId,
        mode: 'error',
        reason: 'Technischer Fehler oder API-Fehler'
      });
    }
  }

  return [...unresolvedByRequest.values()]
    .map((entry) => {
      const questionEvent = questionsByRequest.get(entry.requestKey);
      const question = normalizeQuestion(questionEvent?.payload?.question);
      if (!question) return null;
      return {
        ...entry,
        at: questionEvent?.at || entry.at,
        sessionId: questionEvent?.sessionId || entry.sessionId,
        question,
        topics: getTopicLabels(question),
        products: getProductInterestLabels(question)
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

function isUnresolvedPayload(payload = {}) {
  return payload?.quality === 'needs_review' || payload?.unresolved === true || Boolean(payload?.unresolvedReason);
}

function csvCell(value) {
  let safe = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(safe)) safe = `'${safe}`;
  return `"${safe.replaceAll('"', '""')}"`;
}

function sanitizeAnalyticsPayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const clean = {};
  for (const [key, value] of Object.entries(payload).slice(0, 10)) {
    if (typeof value === 'string') clean[key] = value.slice(0, key === 'question' ? MAX_MESSAGE_CHARS : 240);
    else if (typeof value === 'number' || typeof value === 'boolean') clean[key] = value;
  }
  return clean;
}

function formatBerlinDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: ANALYTICS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

function getAnalyticsSummary() {
  hydrateAnalytics(serializeAnalytics());
  const recentCutoff = Date.now() - ADMIN_EVENT_WINDOW_MS;
  const unresolvedQuestions = getUnresolvedQuestionRows(analytics.eventLog);
  const recentEvents = analytics.eventLog
    .filter((event) => {
      const timestamp = Date.parse(event?.at || '');
      return Number.isFinite(timestamp) && timestamp >= recentCutoff;
    })
    .slice(0, ADMIN_EVENT_PREVIEW_LIMIT);

  return {
    timeZone: ANALYTICS_TIME_ZONE,
    startedAt: analytics.startedAt,
    events: analytics.events,
    chats: analytics.chats,
    totalQuestions: analytics.totalQuestions,
    totalSubmitted: analytics.totalSubmitted,
    rejectedQuestions: analytics.rejectedQuestions,
    totalSessions: analytics.totalSessions,
    activeSessions: getActiveSessionCount(),
    blocked: analytics.blocked,
    errors: analytics.errors,
    attachments: analytics.attachments,
    contacts: analytics.contacts,
    contactOffers: analytics.contactOffers,
    sourceClicks: analytics.sourceClicks,
    quickActions: analytics.quickActions,
    clientErrors: analytics.clientErrors,
    inputTokens: analytics.inputTokens,
    outputTokens: analytics.outputTokens,
    totalTokens: analytics.totalTokens,
    averageLatencyMs: analytics.averageLatencyMs,
    topEvents: Object.fromEntries([...analytics.topEvents.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)),
    topQuestions: [...analytics.topQuestions.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([question, count]) => ({ question, count })),
    topProducts: [...analytics.topProducts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([product, count]) => ({ product, count })),
    topTopics: [...analytics.topTopics.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([topic, count]) => ({ topic, count })),
    unresolvedQuestions: unresolvedQuestions.slice(0, 20),
    unresolvedQuestionCount: unresolvedQuestions.length,
    lastEvents: recentEvents,
    eventPreviewHours: ADMIN_EVENT_WINDOW_MS / (60 * 60 * 1000),
    eventPreviewLimit: ADMIN_EVENT_PREVIEW_LIMIT,
    eventLogCount: analytics.eventLog.length
  };
}

function buildAdminSummary() {
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    model: client ? model : 'fallback-recommender',
    aiEnabled: Boolean(client),
    aiRuntime: {
      configured: Boolean(client),
      lastSuccessAt: lastAiSuccessAt,
      lastErrorAt: lastAiErrorAt,
      lastErrorCode: lastAiErrorCode
    },
    infrastructure: {
      analyticsStorage: hasAnalyticsDatabase() ? 'postgres' : HAS_BLOB_STORAGE ? 'blob' : 'memory',
      distributedRateLimit: hasDistributedRateLimit()
    },
    knowledge: getKnowledgeStatus(),
    timeZone: ANALYTICS_TIME_ZONE,
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

function analyzeReplyQuality(reply = '', mode = 'ai') {
  const text = normalizeAnalyticsText(reply);
  const reasons = [];

  if (mode === 'fallback' || mode === 'quota_fallback' || mode === 'error_fallback') {
    reasons.push('Fallback-Antwort statt vollstaendiger AI-Antwort');
  }
  if (/(keinen belastbaren beleg|nicht belastbar|nicht pauschal|keine verbindliche aussage|unsicher|uncertain)/i.test(text)) {
    reasons.push('Antwort enthaelt Unsicherheit oder keinen belastbaren Beleg');
  }
  if (/(nicht genug|nicht ausreichend|zu wenig|fehlende angaben|brauche.*angaben|benoetige.*angaben|benotige.*angaben|mehr daten|weitere daten)/i.test(text)) {
    reasons.push('Antwort benoetigt weitere Kundendaten');
  }
  if (/(kontaktieren sie|vertrieb|technical sales|technische.*pruefung|technische.*prufung|technisch.*pruefen|technisch.*prufen|sl rack.*pruefen|sl rack.*prufen|technical review)/i.test(text)) {
    reasons.push('Antwort verweist auf Vertrieb oder technische Pruefung');
  }
  if (/(keine information|nicht verfuegbar|nicht in den unterlagen|sehe ich nicht|nicht dokumentiert)/i.test(text)) {
    reasons.push('Information fehlt oder ist in den Unterlagen nicht dokumentiert');
  }

  const unresolvedReason = reasons.filter(Boolean).join(' | ');
  return {
    quality: unresolvedReason ? 'needs_review' : 'good',
    unresolved: Boolean(unresolvedReason),
    unresolvedReason
  };
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
    if (result?.category === 'Interne Antwortlogik') continue;
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

function buildKnowledgeContext(message = '', profile = {}, limit = 4) {
  const guidanceResults = buildSalesGuidanceResults(message);
  const officialResults = searchKnowledge(message, profile, limit);
  return [...guidanceResults, ...officialResults].slice(0, limit + guidanceResults.length);
}

function buildSalesGuidanceResults(message = '') {
  const text = String(message || '');
  const isTileRoofQuestion = /(ziegel|zieldach|dachhaken|erlus|erus|e58|favorit|topwinner|top winner|tonziegel|betondachstein)/i.test(text);
  if (!isTileRoofQuestion) return [];

  return [
    {
      id: 'sales-guidance-tile-roof-options',
      title: 'SL Rack Vertriebsleitlinie: Ziegeldach-Vorqualifikation',
      category: 'Interne Antwortlogik',
      page: null,
      sourceUrl: 'https://www.sl-rack.com/downloads',
      score: 999,
      excerpt:
        'Bei Ziegeldach-Anfragen keine pauschale Ein-Produkt-Empfehlung geben. Neben Dachhaken muessen auch Dachersatzplatten und Plattenloesungen geprueft werden: Alpha-Platte, Beta-Platte, Delta-Platte sowie Dachhaken 3D SL Alu und SL Alu Multi Hook. Fuer eine belastbare Empfehlung werden Hersteller, exaktes Ziegelmodell, Tonziegel oder Betondachstein, Dachneigung, Lattungsabstand, Sparrenlage und Lastannahmen benoetigt.'
    },
    {
      id: 'sales-guidance-favorit-topwinner',
      title: 'SL Rack Vertriebsleitlinie: Favorit / TopWinner',
      category: 'Interne Antwortlogik',
      page: null,
      sourceUrl: 'https://www.sl-rack.com/downloads',
      score: 998,
      excerpt:
        'Bei Favorit und TopWinner nicht behaupten, dass beide pauschal denselben Edelstahl-Dachhaken verwenden. Keine Aussage wie "meistverkauft", "selten verkauft" oder "preiswert" ohne offizielle SL Rack Verkaufsdaten. Stattdessen sagen: In den vorliegenden Unterlagen ist diese exakte Zuordnung nicht belastbar belegt; relevante Optionen sind Delta-Platte bzw. modellbezogene Dachersatzplatte, 3D SL Alu, SL Alu Multi Hook sowie Alpha-/Beta-Platte je nach Ziegeltyp und Dachaufbau. Fuer TopWinner/Favorit technische Pruefung mit exaktem Hersteller- und Modelldatenblatt empfehlen.'
    },
    {
      id: 'official-delta-plate-erlus-models',
      title: 'D-Platte (Delta-Platte)',
      category: 'Datenblaetter',
      page: 9,
      sourceUrl: 'https://www.sl-rack.com/fileadmin/user_upload/downloads/Datenblaetter/D-Platte/SL_Rack_D-Platte_Produktblatt-DE.pdf',
      score: 997,
      excerpt:
        'Die Delta-Platte ist als modellbezogene Dachersatzplatte dokumentiert. In der SL Rack Produktuebersicht sind Varianten unter anderem fuer Frankfurter Pfanne, Erlus Forma, Erlus E58/E58S, Erlus Reformpfanne XXL, Creaton MZ3 Neu und Biberschwanz aufgefuehrt. Das ist ein wichtiger Gegencheck, bevor nur ein Dachhaken empfohlen wird.'
    },
    {
      id: 'official-3d-sl-alu-options',
      title: 'Dachhaken 3D SL Alu',
      category: 'Datenblaetter',
      page: 1,
      sourceUrl: 'https://www.sl-rack.com/fileadmin/user_upload/downloads/Datenblaetter/Dachhaken_3D_SL_Alu/SL_Rack_Dachhaken_3D_SL_Alu_Produktblatt_DE.pdf',
      score: 996,
      excerpt:
        'Dachhaken 3D SL Alu ist als SL Rack Option fuer Ziegeldach-Anbindungen dokumentiert, mit Varianten K, L, 36 L und XL. Er darf als zu pruefende Alternative genannt werden, aber nicht als exakte Loesung fuer ein konkretes Ziegelmodell ohne Beleg und Projektpruefung.'
    }
  ];
}

function isRevenueQuestion(message = '') {
  return /\b(umsatz|jahresumsatz|erl(?:ö|oe)s|revenue|turnover|promet|prihod)\b/i.test(String(message));
}

function buildPublicCompanySources(message = '') {
  if (!isRevenueQuestion(message)) return [];
  const financials = companyFacts.publicFinancialInformation;
  return [
    {
      title: financials.revenue.sourceTitle,
      category: 'Öffentliche Unternehmensinformation',
      url: financials.revenue.sourceUrl
    },
    {
      title: financials.balanceSheetTotal.sourceTitle,
      category: 'Registerbasierte Finanzinformation',
      url: financials.balanceSheetTotal.sourceUrl
    }
  ];
}

function buildPublicRevenueReply(message = '') {
  const financials = companyFacts.publicFinancialInformation;
  const text = String(message);

  if (/\b(revenue|turnover)\b/i.test(text)) {
    return [
      `Publicly accessible company profiles currently place SL Rack GmbH's revenue in the range of **EUR ${financials.revenue.value.replace(' EUR', '')}**.`,
      `Source: ${financials.revenue.sourceTitle} – ${financials.revenue.sourceUrl}`,
      'This is a public third-party range, not an audited exact revenue figure published by SL Rack.',
      `For additional context, register-based data reports total assets of **${financials.balanceSheetTotal.value} as of ${financials.balanceSheetTotal.date}**. Total assets are not revenue.`,
      `Source: ${financials.balanceSheetTotal.sourceTitle} – ${financials.balanceSheetTotal.sourceUrl}`
    ].join('\n\n');
  }

  if (/\b(promet|prihod)\b/i.test(text)) {
    return [
      `Javno dostupan profil kompanije trenutno svrstava promet SL Rack GmbH u raspon od **${financials.revenue.value}**.`,
      `Izvor: ${financials.revenue.sourceTitle} – ${financials.revenue.sourceUrl}`,
      'To je javno objavljen raspon treće strane, a ne tačan revidirani iznos koji je objavio SL Rack.',
      `Kao dodatni kontekst, register-bazirani podaci navode bilančnu sumu od **${financials.balanceSheetTotal.value} na dan ${financials.balanceSheetTotal.date}**. Bilančna suma nije promet.`,
      `Izvor: ${financials.balanceSheetTotal.sourceTitle} – ${financials.balanceSheetTotal.sourceUrl}`
    ].join('\n\n');
  }

  return [
    `Öffentlich zugängliche Unternehmensprofile ordnen den Umsatz der SL Rack GmbH derzeit in die Spanne von **${financials.revenue.value}** ein.`,
    `Quelle: ${financials.revenue.sourceTitle} – ${financials.revenue.sourceUrl}`,
    'Dabei handelt es sich um eine öffentlich angegebene Bandbreite eines Drittanbieters, nicht um einen von SL Rack veröffentlichten, testierten Einzelwert.',
    `Als zusätzlicher Kontext nennen registerbasierte Daten eine Bilanzsumme von **${financials.balanceSheetTotal.value} zum ${financials.balanceSheetTotal.date}**. Die Bilanzsumme ist nicht mit dem Umsatz gleichzusetzen.`,
    `Quelle: ${financials.balanceSheetTotal.sourceTitle} – ${financials.balanceSheetTotal.sourceUrl}`
  ].join('\n\n');
}

async function validateChatRequest(req, rawMessages) {
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

  const latestUserMessage = [...messages].reverse().find((message) => message.role !== 'assistant')?.content || '';
  if (isOffTopicRequest(latestUserMessage, messages)) {
    return {
      ok: false,
      status: 400,
      error: 'off_topic_request',
      reply: buildOffTopicReply(latestUserMessage)
    };
  }

  const bucketResult = await checkRateLimit(req, totalChars);
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

function buildRateLimitIdentifier(req, scope = 'request') {
  const cookies = parseCookies(req.headers.cookie || '');
  const sessionId = req.chatSessionId || cookies[CHAT_SESSION_COOKIE] || '';
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 120);
  const rawIdentifier = [scope, sessionId, getClientIp(req), userAgent].join('|');
  return hashRateLimitIdentifier(rawIdentifier, ADMIN_SESSION_SECRET);
}

function setRateLimitHeaders(res, result = {}) {
  if (!Number.isFinite(result.limit)) return;
  res.setHeader('X-RateLimit-Limit', String(result.limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.remaining || 0)));
  if (Number.isFinite(result.reset)) {
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.reset / 1000)));
  }
}

function hasSessionEvent(sessionId, type) {
  if (!sessionId) return false;
  return analytics.eventLog.some((event) => event.sessionId === sessionId && event.type === type);
}

async function checkRateLimit(req, inputChars) {
  const identifier = buildRateLimitIdentifier(req, 'chat');
  const [shortWindow, dailyRequests, dailyChars] = await Promise.all([
    enforceRateLimit({
      scope: 'chat-window',
      identifier,
      limit: RATE_MAX_REQUESTS,
      windowMs: RATE_WINDOW_MS
    }),
    enforceRateLimit({
      scope: 'chat-daily-requests',
      identifier,
      limit: DAILY_MAX_REQUESTS,
      windowMs: 24 * 60 * 60 * 1000
    }),
    enforceRateLimit({
      scope: 'chat-daily-input',
      identifier,
      limit: DAILY_MAX_INPUT_CHARS,
      windowMs: 24 * 60 * 60 * 1000,
      cost: inputChars
    })
  ]);

  if (!shortWindow.ok) {
    return {
      ok: false,
      error: 'rate_limited',
      reply: 'Zu viele Anfragen in kurzer Zeit. Bitte warten Sie einen Moment und versuchen Sie es erneut.'
    };
  }

  if (!dailyRequests.ok || !dailyChars.ok) {
    return {
      ok: false,
      error: 'daily_limit_reached',
      reply: 'Das Tageslimit fuer diese Verbindung wurde erreicht. Bitte versuchen Sie es spaeter erneut oder kontaktieren Sie SL Rack direkt.'
    };
  }

  return { ok: true };
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

function isOffTopicRequest(latestMessage = '', messages = []) {
  const latest = normalizeAnalyticsText(latestMessage);
  if (!latest) return false;

  const offTopicPatterns = [
    /\b(lektira|lektiru|lektire|lektüre|lektuere|buchzusammenfassung|prepricaj|prepricati|sastav|esej|seminarski|referat|maturski|domaci|zadaca|zadacu|school essay|book report)\b/i,
    /\b(write|writ(e|ing)|napisi|napisati|sastavi|sastaviti|create|generate|generisi|generiraj|erstelle|schreib(e|en)?)\b.{0,80}\b(poem|pjesm|pesm|story|pric|roman|buch|lektira|lektüre|lektuere|essay|aufsatz|bewerbung|cv|resume|code|program|script|rezept|recipe)\b/i,
    /\b(recept|recipe|kuhanje|cooking|fitness|trening|dijeta|diet|horoskop|astrolog|vic|joke|song|lyrics|pjesma|pesma|film|movie)\b/i,
    /\b(javascript|python|java|c\+\+|html|css|sql|programir|kod|code|skripta|script|app|website)\b/i,
    /\b(prevodi|translate|uebersetze|übersetze|gramatika|grammar)\b/i
  ];

  if (offTopicPatterns.some((pattern) => pattern.test(latest))) return true;

  if (hasSlRackDomainSignal(latest)) return false;

  const priorUserText = messages
    .filter((message) => message.role === 'user' && message.content !== latestMessage)
    .map((message) => message.content)
    .join(' ');
  const conversationText = normalizeAnalyticsText(priorUserText);
  if (hasSlRackDomainSignal(conversationText) && isFollowUpQuestion(latest)) return false;

  const generalQuestion = /\b(ko je|sta je|šta je|kako se|objasni|explain|who is|what is|how to|hilfe bei|help me)\b/i.test(latest);
  return generalQuestion && !hasSlRackDomainSignal(conversationText);
}

function hasSlRackDomainSignal(text = '') {
  return [
    /\b(sl rack|slrack|schletter ludwig|pv|photovoltaik|photovoltaic|solar|solaranlage|module|modul|montage|unterkonstruktion|montagesystem)\b/i,
    /\b(dach|roof|ziegel|dachhaken|flachdach|freiflaeche|freiflache|fassade|carport|agri|tracker|trapez|falz|rail|schiene)\b/i,
    /\b(alpha platte|beta platte|delta platte|fast flat|energy wall|solar\.pro\.tool|sl planner|windlast|schneelast|statik)\b/i,
    /\b(datenblatt|montageanleitung|produktdatenblatt|prospekt|checkliste|garantie|zertifikat)\b/i,
    /\b(umsatz|jahresumsatz|revenue|turnover|promet|prihod)\b/i
  ].some((pattern) => pattern.test(text));
}

function isFollowUpQuestion(text = '') {
  return [
    /\b(und|oder|auch|dazu|davon|welche|wie viel|wieviel|was ist mit|gibt es|pdf|datenblatt|link|preis|kosten)\b/i,
    /\b(kannst du|mozes li|možeš li|bitte|please|zeige|pokazi|pošalji|senden)\b/i
  ].some((pattern) => pattern.test(text));
}

function buildOffTopicReply(message = '') {
  const text = normalizeAnalyticsText(message);

  if (/\b(lektira|lektiru|lektire|sastav|esej|domaci|zadaca|zadacu)\b/i.test(text)) {
    return 'Razumijem pitanje, ali ovaj chatbot nije namijenjen za lektire, skolske zadatke ili opste pisanje tekstova. Ja sam SL Rack asistent i mogu pomoci oko PV montaznih sistema, Dachhaken, Flachdach/Freiflaeche rjesenja, dokumentacije, statike, planiranja i kontakta sa SL Rack timom. Postavite mi konkretno pitanje vezano za SL Rack ili PV projekat.';
  }

  if (/\b(essay|book report|homework|poem|story|recipe|code|program|script|translate)\b/i.test(text)) {
    return 'I can only help with SL Rack and photovoltaic mounting topics. I cannot process general homework, writing, coding, recipes or unrelated requests here. Please ask a concrete question about SL Rack products, mounting systems, documentation, planning or technical sales support.';
  }

  if (/\b(aufsatz|hausaufgabe|rezept|gedicht|geschichte|programm|code|uebersetze|übersetze)\b/i.test(text)) {
    return 'Ich kann hier nur bei SL Rack und PV-Montagesystemen helfen. Allgemeine Aufgaben wie Aufsaetze, Hausaufgaben, Rezepte, Programmierung oder Uebersetzungen bearbeite ich in diesem Chat nicht. Bitte stellen Sie eine konkrete Frage zu SL Rack Produkten, Montage, Dokumentation, Planung oder technischem Vertrieb.';
  }

  return 'Ovaj chatbot je ogranicen na SL Rack i PV montazne sisteme. Ne obradjujem opste teme izvan toga. Rado mogu pomoci ako pitate za SL Rack proizvode, montazu, dokumentaciju, planiranje, statiku, Flachdach, Freiflaeche, Dachhaken, RAIL ili kontakt sa Vertrieb timom.';
}

function postProcessSalesReplySafe(reply, userMessage = '') {
  let output = String(reply || '');
  const query = String(userMessage || '').toLowerCase();
  const isTileRoofQuestion = /(ziegel|zieldach|dachhaken|erlus|erus|e58|favorit|topwinner|top winner|tonziegel|betondachstein)/i.test(query);
  const isFavoritTopWinnerQuestion = /(favorit|topwinner|top winner)/i.test(query);
  const asksHookQuantity = /(wie viele|wieviele|anzahl|dachhaken.*ben[o\u00f6]tig|ben[o\u00f6]tige.*dachhaken)/i.test(query);

  if (isTileRoofQuestion && (!/Alpha-Platte/i.test(output) || !/Delta-Platte/i.test(output) || !/(3D SL Alu|SL Alu Multi Hook)/i.test(output))) {
    output += [
      '',
      'Zusatzhinweis aus der SL Rack Vertriebslogik:',
      'Bei Ziegeld\u00e4chern bitte nicht nur einen Dachhaken betrachten. Je nach Ziegeltyp und Projekt k\u00f6nnen auch Alpha-Platte, Beta-Platte, Delta-Platte, Dachhaken 3D SL Alu und SL Alu Multi Hook relevante SL Rack Optionen sein. F\u00fcr eine belastbare Auswahl bitte Hersteller, exaktes Ziegelmodell, Tonziegel/Betondachstein, Dachneigung, Lattungsabstand und Sparrenlage pr\u00fcfen.'
    ].join('\n');
  }

  if (/dachhaken|edelstahl|sl a2/i.test(output) && /preiswert|g\u00fcnstig|guenstig|cheap|low-cost/i.test(output)) {
    output += [
      '',
      'Hinweis zur Preisbewertung:',
      'Eine pauschale Aussage wie preiswert oder g\u00fcnstig ist bei Edelstahl-Dachhaken nicht belastbar. Die wirtschaftlich passende L\u00f6sung h\u00e4ngt vom Dach, Material, Ziegeltyp, statischer Auslegung und den verf\u00fcgbaren SL Rack Alternativen ab.'
    ].join('\n');
  }

  if (isFavoritTopWinnerQuestion && /(edelstahl|sl a2|dachhaken)/i.test(output)) {
    output += [
      '',
      'Korrektur f\u00fcr Favorit / TopWinner:',
      'Favorit und TopWinner d\u00fcrfen nicht pauschal demselben Edelstahl-Dachhaken zugeordnet werden. In den vorliegenden Unterlagen sehe ich daf\u00fcr keinen belastbaren Beleg. Bitte diese Ziegel mit exaktem Hersteller- und Modelldatenblatt technisch pr\u00fcfen und parallel Delta-Platte bzw. passende Dachersatzplatte, 3D SL Alu, SL Alu Multi Hook sowie Alpha-/Beta-Platte als Alternativen betrachten.'
    ].join('\n');
  }

  if (isFavoritTopWinnerQuestion && /(meistverkauft|selten verkauft|topseller|top-seller|best[- ]seller)/i.test(output)) {
    output += [
      '',
      'Hinweis zu Verkaufs-/Popularit\u00e4tsaussagen:',
      'Ohne offizielle SL Rack Verkaufsdaten sollte der Chatbot keine Aussage treffen, ob ein Produkt besonders h\u00e4ufig oder selten verkauft wird. Besser ist die technische Bewertung anhand von Ziegeltyp, Dachaufbau und Projektparametern.'
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
