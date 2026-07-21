import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSystemPrompt } from '../src/systemPrompt.js';

test('customer response rules preserve formal German and hide internal guidance', () => {
  const prompt = buildSystemPrompt({
    companyFacts: {},
    recommendations: [],
    knowledgeResults: []
  });

  assert.match(prompt, /always stay with formal "Sie"/);
  assert.match(prompt, /never present, cite or describe it to customers/);
});
