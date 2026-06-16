import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import { productCatalog, companyFacts, scoreProducts } from './src/slRackKnowledge.js';
import { buildSystemPrompt } from './src/systemPrompt.js';
import { getKnowledgeStatus, searchKnowledge } from './src/knowledgeSearch.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

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

  if (!messages.length) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  if (!client) {
    return res.json({
      mode: 'fallback',
      reply: buildFallbackReply(profile, recommendations),
      recommendations
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

    res.json({
      mode: 'ai',
      reply: response.output_text,
      recommendations,
      knowledgeResults
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
      knowledgeResults
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
