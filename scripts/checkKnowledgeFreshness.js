import { readFile } from 'node:fs/promises';
import { DOWNLOADS_URL, extractDocuments, fetchText } from './knowledgeDownloads.js';

const index = JSON.parse(await readFile(new URL('../data/knowledge-index.json', import.meta.url), 'utf8'));
const liveDocuments = extractDocuments(await fetchText(DOWNLOADS_URL));
const liveUrls = new Set(liveDocuments.map((document) => document.url));
const indexedUrls = new Set((index.documents || []).map((document) => document.sourceUrl));
const added = [...liveUrls].filter((url) => !indexedUrls.has(url));
const removed = [...indexedUrls].filter((url) => !liveUrls.has(url));
const invalidHashes = (index.documents || []).filter(
  (document) => !Number.isInteger(document.sourceBytes) || document.sourceBytes <= 0 || !/^[a-f0-9]{64}$/.test(document.sourceSha256 || '')
);

if (added.length || removed.length || invalidHashes.length) {
  if (added.length) console.error(`Missing from index (${added.length}):\n${added.join('\n')}`);
  if (removed.length) console.error(`No longer published (${removed.length}):\n${removed.join('\n')}`);
  if (invalidHashes.length) console.error(`Missing source hashes (${invalidHashes.length}).`);
  process.exitCode = 1;
} else {
  console.log(`Knowledge index matches all ${liveDocuments.length} PDFs currently published on ${DOWNLOADS_URL}.`);
}
