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

export function searchKnowledge(query, profile = {}, limit = 4) {
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

  const ranked = index.chunks
    .map((chunk) => ({ chunk, score: scoreChunk(chunk, terms, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const selected = [];
  const seenDocuments = new Set();
  for (const entry of ranked) {
    const documentKey = entry.chunk.documentId || entry.chunk.sourceUrl;
    if (seenDocuments.has(documentKey)) continue;
    seenDocuments.add(documentKey);
    selected.push(entry);
    if (selected.length >= limit) break;
  }

  return selected.map(({ chunk, score }) => ({
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

function scoreChunk(chunk, terms, rawQuery = '') {
  const content = String(chunk.content || '').toLowerCase();
  const title = String(chunk.title || '').toLowerCase();
  const category = String(chunk.category || '').toLowerCase();
  const keywords = new Set(chunk.keywords || []);
  let score = 0;
  const normalizedQuery = normalizeSearchText(rawQuery);
  const normalizedTitle = normalizeSearchText(title);

  if (normalizedQuery && normalizedTitle && normalizedQuery.includes(normalizedTitle)) score += 35;
  if (/delta[- ]?platte/i.test(rawQuery) && /^d platte$/i.test(normalizedTitle)) score += 140;
  if (/\b(pdf|datenblatt|produktblatt|montageanleitung|anleitung|dokument)/i.test(rawQuery)) score += 4;

  for (const term of terms) {
    if (title.includes(term)) score += 12;
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
  return content.slice(start, start + 600).trim();
}

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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
    'für',
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

  return [...new Set(String(value || '').toLowerCase().match(/[\p{L}\p{N}-]{3,}/gu) || [])].filter(
    (term) => !stopWords.has(term)
  );
}

function expandSalesTerms(query = '') {
  const text = String(query).toLowerCase();
  const expansions = [];

  if (/(ziegel|dachhaken|erlus|erus|e58|favorit|topwinner|top winner|tonziegel|betondachstein)/i.test(text)) {
    expansions.push(
      'Dachhaken Alpha-Platte Delta-Platte Beta-Platte Ziegeldach Tonziegel Betondachstein Dachersatzplatte 3D SL Alu SL Alu Multi Hook Erlus E58 Favorit TopWinner'
    );
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
