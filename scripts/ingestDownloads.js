import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import * as cheerio from 'cheerio';

const DOWNLOADS_URL = 'https://www.sl-rack.com/downloads';
const SITE_ORIGIN = 'https://www.sl-rack.com';
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
const chunks = [];
const indexedDocuments = [];

for (const [position, document] of documents.entries()) {
  const filename = `${String(position + 1).padStart(3, '0')}-${safeFilename(document.title)}.pdf`;
  const pdfPath = path.join(DOC_DIR, filename);
  const textPath = path.join(TEXT_DIR, filename.replace(/\.pdf$/i, '.json'));

  console.log(`Downloading ${position + 1}/${documents.length}: ${document.title}`);
  await downloadFile(document.url, pdfPath);

  const extracted = extractPdf(pdfPath);
  await writeFile(textPath, JSON.stringify(extracted, null, 2), 'utf8');

  const documentChunks = chunkDocument({
    id: `doc-${position + 1}`,
    title: document.title,
    category: document.category,
    sourceUrl: document.url,
    localPdf: pdfPath,
    pages: extracted.pages
  });

  chunks.push(...documentChunks);
  indexedDocuments.push({
    id: `doc-${position + 1}`,
    title: document.title,
    category: document.category,
    sourceUrl: document.url,
    localPdf: relativePath(pdfPath),
    localText: relativePath(textPath),
    pageCount: extracted.pageCount,
    chunkCount: documentChunks.length
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

await writeFile(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
console.log(`Knowledge index written to ${INDEX_FILE}`);
console.log(`Documents: ${index.documentCount}, chunks: ${index.chunkCount}`);

function extractDocuments(htmlText) {
  const $ = cheerio.load(htmlText);
  const result = [];
  let category = 'Downloads';
  $('h2, a[href]').each((_index, element) => {
    if (element.tagName === 'h2') {
      category = $(element).text().replace(/\s+/g, ' ').trim() || category;
      return;
    }

    const href = $(element).attr('href');
    if (!href) return;
    const url = new URL(href, SITE_ORIGIN).toString();
    if (!url.toLowerCase().includes('/fileadmin/') || !url.toLowerCase().includes('.pdf')) return;

    const title = ($(element).attr('title') || $(element).text()).replace(/\s+/g, ' ').trim();
    if (!title) return;

    result.push({ title, category: normalizeCategory(category), url });
  });

  const unique = new Map();
  for (const doc of result) unique.set(doc.url, doc);
  return [...unique.values()];
}

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

async function fetchText(url) {
  const response = await fetchWithRetry(url);
  return response.text();
}

async function downloadFile(url, outputPath) {
  const response = await fetchWithRetry(url);
  if (!response.body) throw new Error(`Empty download response for ${url}`);
  await pipeline(response.body, createWriteStream(outputPath));
}

async function fetchWithRetry(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'SL Rack chatbot knowledge indexer' },
        signal: controller.signal
      });
      if (response.ok) return response;
      lastError = new Error(`Failed to fetch ${url}: ${response.status}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
  }
  throw lastError;
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

function normalizeCategory(value) {
  return value.replace(/\s+/g, ' ').trim();
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
