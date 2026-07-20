import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { getKnowledgeStatus, searchKnowledge } from '../src/knowledgeSearch.js';

test('knowledge index is populated', () => {
  const status = getKnowledgeStatus();
  assert.ok(status.documentCount >= 70);
  assert.ok(status.chunkCount >= 100);
});

test('every indexed PDF has a verified source fingerprint', async () => {
  const index = JSON.parse(await readFile(new URL('../data/knowledge-index.json', import.meta.url), 'utf8'));
  assert.equal(index.documents.length, index.documentCount);
  assert.ok(index.documents.every((document) => Number.isInteger(document.sourceBytes) && document.sourceBytes > 0));
  assert.ok(index.documents.every((document) => /^[a-f0-9]{64}$/.test(document.sourceSha256)));
});

test('Delta/D-Platte query ranks the matching document', () => {
  const results = searchKnowledge('Delta-Platte Erlus E58 Produktdatenblatt PDF', {}, 4);
  assert.ok(results.length > 0);
  assert.match(`${results[0].title} ${results[0].sourceUrl}`, /(Delta|D-Platte)/i);
  assert.match(results[0].sourceUrl, /\.pdf$/i);
});

test('Fast Flat documentation query returns a direct PDF source', () => {
  const results = searchKnowledge('SL Fast Flat Montageanleitung PDF', {}, 4);
  assert.ok(results.some((result) => /Fast.Flat/i.test(`${result.title} ${result.sourceUrl}`)));
  assert.ok(results.every((result) => /^https:\/\/www\.sl-rack\.com\/.+\.pdf$/i.test(result.sourceUrl)));
});
