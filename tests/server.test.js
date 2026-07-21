import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';

const port = 34871;
const baseUrl = `http://127.0.0.1:${port}`;
const adminSalt = Buffer.alloc(16, 7);
const adminScrypt = `${adminSalt.toString('hex')}:${crypto.scryptSync('test-password', adminSalt, 64).toString('hex')}`;
let server;

before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      OPENAI_API_KEY: '',
      BLOB_READ_WRITE_TOKEN: '',
      BLOB_STORE_ID: '',
      DATABASE_URL: '',
      POSTGRES_URL: '',
      UPSTASH_REDIS_REST_URL: '',
      UPSTASH_REDIS_REST_TOKEN: '',
      ADMIN_PATH: '/private-test-admin',
      ADMIN_USER: 'test-admin',
      ADMIN_PASSWORD_HASH: '',
      ADMIN_PASSWORD_SCRYPT: adminScrypt,
      ADMIN_SESSION_SECRET: 'test-session-secret-with-at-least-32-characters'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Test server did not start');
});

after(() => server?.kill());

test('health endpoint exposes no model or secret details', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal('model' in body, false);
});

test('cross-origin API writes are rejected', async () => {
  const response = await fetch(`${baseUrl}/api/recommend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
    body: JSON.stringify({ profile: {} })
  });
  assert.equal(response.status, 403);
});

test('explicitly unrelated prompt is rejected even when it mentions SL Rack', async () => {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: 'request_offtopic_123',
      messages: [{ role: 'user', content: 'SL Rack: napiši mi lektiru o Malom princu.' }]
    })
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.mode, 'blocked');
});

test('German school-writing request is rejected', async () => {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: 'request_offtopic_de_123',
      messages: [{ role: 'user', content: 'Schreibe mir eine Lektüre über ein beliebiges Buch.' }]
    })
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).mode, 'blocked');
});

test('valid SL Rack question works with malformed cookie input', async () => {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: 'slrack_chat_session=%E0%A4%A' },
    body: JSON.stringify({
      requestId: 'request_valid_12345',
      messages: [{ role: 'user', content: 'Meine E-Mail ist kunde@example.com und Telefon +49 8072 123456. Welche SL Rack Lösung passt für ein Ziegeldach?' }]
    })
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.mode, 'fallback');
  assert.ok(body.reply);
});

test('invalid JSON returns a controlled response', async () => {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{bad json'
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_json');
});

test('admin summary and CSV retain accepted and rejected questions across login', async () => {
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'test-admin', password: 'test-password' })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const summaryResponse = await fetch(`${baseUrl}/api/admin/summary`, { headers: { cookie } });
  const summary = await summaryResponse.json();
  assert.equal(summaryResponse.status, 200);
  assert.ok(summary.analytics.totalSubmitted >= 2);
  assert.ok(summary.analytics.totalQuestions >= 1);
  assert.ok(summary.analytics.rejectedQuestions >= 1);
  assert.ok(summary.analytics.conversationCount >= 1);
  const storedConversation = summary.analytics.conversations.find((item) => item.requestId === 'request_valid_12345');
  assert.ok(storedConversation);
  assert.match(storedConversation.question, /\[email redacted\]/);
  assert.match(storedConversation.question, /\[phone redacted\]/);
  assert.doesNotMatch(storedConversation.question, /kunde@example\.com/);
  assert.ok(storedConversation.answer);

  const csvResponse = await fetch(`${baseUrl}/api/admin/questions.csv`, { headers: { cookie } });
  const csv = await csvResponse.text();
  assert.equal(csvResponse.status, 200);
  assert.match(csv, /SL Rack: napiši mi lektiru/);
  assert.match(csv, /Welche SL Rack Lösung passt/);

  const conversationCsvResponse = await fetch(`${baseUrl}/api/admin/conversations.csv`, { headers: { cookie } });
  const conversationCsv = await conversationCsvResponse.text();
  assert.equal(conversationCsvResponse.status, 200);
  assert.match(conversationCsv, /Chatbot answer/);
  assert.match(conversationCsv, /\[email redacted\]/);
  assert.match(conversationCsv, /\[phone redacted\]/);
  assert.doesNotMatch(conversationCsv, /kunde@example\.com/);

  await fetch(`${baseUrl}/api/admin/logout`, { method: 'POST', headers: { cookie } });
  const secondLogin = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'test-admin', password: 'test-password' })
  });
  assert.equal(secondLogin.status, 200);
  const secondCookie = secondLogin.headers.get('set-cookie').split(';')[0];
  const secondSummary = await (await fetch(`${baseUrl}/api/admin/summary`, { headers: { cookie: secondCookie } })).json();
  assert.equal(secondSummary.analytics.totalSubmitted, summary.analytics.totalSubmitted);
});

test('admin login is rate limited and CSV stays private', async () => {
  let status = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'wrong', password: 'wrong' })
    });
    status = response.status;
  }
  assert.equal(status, 429);
  assert.equal((await fetch(`${baseUrl}/api/admin/questions.csv`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/admin/conversations.csv`)).status, 404);
});
