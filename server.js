import 'dotenv/config';
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

app.use(cors());
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
  } catch (error) {
    console.error(error);
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
