import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getKnowledgeStatus, searchKnowledge } from '../src/knowledgeSearch.js';

test('knowledge index is populated', () => {
  const status = getKnowledgeStatus();
  assert.ok(status.documentCount >= 70);
  assert.ok(status.chunkCount >= 100);
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
