import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const INDEX_PATH = path.join(process.cwd(), 'data', 'knowledge-index.json');
let cachedIndex = null;

export function getKnowledgeStatus() {
  const index = loadIndex();
  return {
    available: Boolean(index),
    documentCount: index?.documentCount || 0,
    chunkCount: index?.chunkCount || 0,
    generatedAt: index?.generatedAt || null,
    sourceUrl: index?.sourceUrl || null
  };
}

export function searchKnowledge(query, profile = {}, limit = 6) {
  const index = loadIndex();
  if (!index?.chunks?.length) return [];

  const queryText = [
    query,
    expandSalesTerms(query),
    profile.projectType,
    profile.surface,
    profile.priority,
    profile.orientation,
    profile.message
  ]
    .filter(Boolean)
    .join(' ');

  const terms = tokenize(queryText);
  if (!terms.length) return [];

  return index.chunks
    .map((chunk) => ({ chunk, score: scoreChunk(chunk, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ chunk, score }) => ({
      id: chunk.id,
      title: chunk.title,
      category: chunk.category,
      page: chunk.page,
      sourceUrl: chunk.sourceUrl,
      score,
      excerpt: excerpt(chunk.content, terms)
    }));
}

function loadIndex() {
  if (cachedIndex) return cachedIndex;
  if (!existsSync(INDEX_PATH)) return null;
  cachedIndex = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  return cachedIndex;
}

function scoreChunk(chunk, terms) {
  const content = String(chunk.content || '').toLowerCase();
  const title = String(chunk.title || '').toLowerCase();
  const category = String(chunk.category || '').toLowerCase();
  const keywords = new Set(chunk.keywords || []);
  let score = 0;

  for (const term of terms) {
    if (title.includes(term)) score += 8;
    if (category.includes(term)) score += 4;
    if (keywords.has(term)) score += 5;
    const matches = content.match(new RegExp(escapeRegExp(term), 'g'));
    if (matches) score += Math.min(matches.length, 8);
  }

  return score;
}

function excerpt(content, terms) {
  const lower = content.toLowerCase();
  const hit = terms
    .map((term) => lower.indexOf(term))
    .filter((position) => position >= 0)
    .sort((a, b) => a - b)[0];
  const start = Math.max(0, (hit || 0) - 260);
  return content.slice(start, start + 900).trim();
}

function tokenize(value) {
  const stopWords = new Set([
    'und',
    'oder',
    'der',
    'die',
    'das',
    'den',
    'dem',
    'ein',
    'eine',
    'mit',
    'fÃ¼r',
    'von',
    'auf',
    'zur',
    'the',
    'and',
    'for',
    'with',
    'from',
    'need',
    'haben',
    'brauchen'
  ]);

  return [...new Set(String(value || '').toLowerCase().match(/[a-zÃ¤Ã¶Ã¼ÃŸ0-9-]{3,}/gi) || [])].filter(
    (term) => !stopWords.has(term)
  );
}

function expandSalesTerms(query = '') {
  const text = String(query).toLowerCase();
  const expansions = [];

  if (/(ziegel|dachhaken|erus|e58|tonziegel|betondachstein)/i.test(text)) {
    expansions.push('Dachhaken Alpha-Platte Delta-Platte Beta-Platte Ziegeldach Tonziegel Betondachstein Dachersatzplatte');
  }

  if (/(anzahl|wie viele|wieviele|dachhaken|befestigungspunkte|haken)/i.test(text)) {
    expansions.push('Projektierung Planung Windlast Schneelast Modulgroesse Rafter Sparrenabstand RAIL 40 Ueberspannung');
  }

  if (/(falz|kupfer|stehfalz|zambelli|dfalz|falzklemme)/i.test(text)) {
    expansions.push('Falzklemme Blechfalzklemme Stehfalzklemme DFalzCU Zambelli Kupferfalzdach Produktdatenblatt');
  }

  return expansions.join(' ');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
