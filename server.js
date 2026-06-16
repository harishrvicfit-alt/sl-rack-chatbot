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

app.use(cors());
app.use(express.json({ limit: '1mb' }));
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
  const messages = Array.isArray(req.body?.messages) ? req.body.messages.slice(-12) : [];
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
        ...messages.map((message) => ({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: String(message.content || '').slice(0, 2000)
        }))
      ]
    });

    const reply = postProcessSalesReply(response.output_text, latestUserMessage);

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
