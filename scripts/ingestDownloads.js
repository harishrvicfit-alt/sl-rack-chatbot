import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { DOWNLOADS_URL, extractDocuments, fetchText, fetchWithRetry } from './knowledgeDownloads.js';
const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'data');
const DOC_DIR = path.join(DATA_DIR, 'sl-rack-documents');
const TEXT_DIR = path.join(DATA_DIR, 'sl-rack-text');
const INDEX_FILE = path.join(DATA_DIR, 'knowledge-index.json');
const PYTHON = process.env.PYTHON_PATH || process.env.PYTHON || 'python';

await mkdir(DOC_DIR, { recursive: true });
await mkdir(TEXT_DIR, { recursive: true });

const html = await fetchText(DOWNLOADS_URL);
const documents = extractDocuments(html);
const previousIndex = await readJson(INDEX_FILE);
const previousDocuments = new Map((previousIndex?.documents || []).map((document) => [document.sourceUrl, document]));
let nextDocumentNumber = Math.max(0, ...(previousIndex?.documents || []).map((document) => idNumber(document.id)));
const chunks = [];
const indexedDocuments = [];

for (const [position, document] of documents.entries()) {
  const previousDocument = previousDocuments.get(document.url);
  const id = previousDocument?.id || `doc-${++nextDocumentNumber}`;
  const filename = previousDocument?.localPdf
    ? path.basename(previousDocument.localPdf)
    : `${String(idNumber(id)).padStart(3, '0')}-${safeFilename(document.title)}.pdf`;
  const pdfPath = path.join(DOC_DIR, filename);
  const textPath = path.join(TEXT_DIR, filename.replace(/\.pdf$/i, '.json'));

  console.log(`Downloading ${position + 1}/${documents.length}: ${document.title}`);
  await downloadFile(document.url, pdfPath);
  const pdf = await readFile(pdfPath);
  const sourceSha256 = createHash('sha256').update(pdf).digest('hex');

  const extracted = extractPdf(pdfPath);
  await writeFile(textPath, JSON.stringify(extracted, null, 2), 'utf8');

  const documentChunks = chunkDocument({
    id,
    title: document.title,
    category: document.category,
    sourceUrl: document.url,
    localPdf: pdfPath,
    pages: extracted.pages
  });

  chunks.push(...documentChunks);
  indexedDocuments.push({
    id,
    title: document.title,
    category: document.category,
    sourceUrl: document.url,
    localPdf: relativePath(pdfPath),
    localText: relativePath(textPath),
    pageCount: extracted.pageCount,
    chunkCount: documentChunks.length,
    sourceBytes: pdf.byteLength,
    sourceSha256
  });
}

const index = {
  generatedAt: new Date().toISOString(),
  sourceUrl: DOWNLOADS_URL,
  documentCount: indexedDocuments.length,
  chunkCount: chunks.length,
  documents: indexedDocuments,
  chunks
};

const changes = summarizeChanges(previousIndex, index);
if (sameIndex(previousIndex, index)) {
  console.log('Knowledge index is already current; no file changes written.');
} else {
  await writeFile(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
  console.log(`Knowledge index written to ${INDEX_FILE}`);
}
console.log(`Changes: ${changes.added} added, ${changes.removed} removed, ${changes.updated} updated.`);
console.log(`Documents: ${index.documentCount}, chunks: ${index.chunkCount}`);

function extractPdf(pdfPath) {
  const script = path.join(ROOT, 'scripts', 'extractPdfText.py');
  const result = spawnSync(PYTHON, [script, pdfPath], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 80
  });

  if (result.status !== 0) {
    throw new Error(`PDF extraction failed for ${pdfPath}: ${result.stderr || result.stdout}`);
  }

  return JSON.parse(result.stdout);
}

function chunkDocument({ id, title, category, sourceUrl, localPdf, pages }) {
  const chunkSize = 1800;
  const overlap = 240;
  const chunks = [];

  for (const page of pages) {
    const text = normalizeText(page.text);
    if (!text) continue;

    for (let start = 0; start < text.length; start += chunkSize - overlap) {
      const content = text.slice(start, start + chunkSize).trim();
      if (content.length < 80) continue;

      chunks.push({
        id: `${id}-p${page.page}-${chunks.length + 1}`,
        documentId: id,
        title,
        category,
        sourceUrl,
        localPdf: relativePath(localPdf),
        page: page.page,
        content,
        keywords: buildKeywords(`${title} ${category} ${content}`)
      });
    }
  }

  return chunks;
}

async function downloadFile(url, outputPath) {
  const response = await fetchWithRetry(url);
  if (!response.body) throw new Error(`Empty download response for ${url}`);
  await pipeline(response.body, createWriteStream(outputPath));
}

function buildKeywords(text) {
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
    'from'
  ]);

  const counts = new Map();
  for (const word of normalizeText(text).toLowerCase().match(/[a-zäöüß0-9-]{3,}/gi) || []) {
    if (stopWords.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 18)
    .map(([word]) => word);
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripTags(value) {
  return String(value).replace(/<[^>]*>/g, ' ');
}

function decodeHtml(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&uuml;/g, 'ü')
    .replace(/&auml;/g, 'ä')
    .replace(/&ouml;/g, 'ö')
    .replace(/&Uuml;/g, 'Ü')
    .replace(/&Auml;/g, 'Ä')
    .replace(/&Ouml;/g, 'Ö')
    .replace(/&szlig;/g, 'ß')
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, '-');
}

function safeFilename(value) {
  return decodeHtml(value)
    .normalize('NFKD')
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 96);
}

function relativePath(value) {
  return path.relative(ROOT, value).replace(/\\/g, '/');
}

async function readJson(filename) {
  try {
    return JSON.parse(await readFile(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function idNumber(id) {
  const match = String(id || '').match(/^doc-(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function sameIndex(previous, current) {
  if (!previous) return false;
  return JSON.stringify(withoutGeneratedAt(previous)) === JSON.stringify(withoutGeneratedAt(current));
}

function withoutGeneratedAt(index) {
  const { generatedAt: _generatedAt, ...rest } = index;
  return rest;
}

function summarizeChanges(previous, current) {
  const oldDocuments = new Map((previous?.documents || []).map((document) => [document.sourceUrl, document]));
  const newDocuments = new Map(current.documents.map((document) => [document.sourceUrl, document]));
  let updated = 0;

  for (const [url, document] of newDocuments) {
    const oldDocument = oldDocuments.get(url);
    if (oldDocument && oldDocument.sourceSha256 && oldDocument.sourceSha256 !== document.sourceSha256) updated += 1;
  }

  return {
    added: [...newDocuments.keys()].filter((url) => !oldDocuments.has(url)).length,
    removed: [...oldDocuments.keys()].filter((url) => !newDocuments.has(url)).length,
    updated
  };
}
