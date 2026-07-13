import { readFile } from 'node:fs/promises';

const index = JSON.parse(await readFile(new URL('../data/knowledge-index.json', import.meta.url), 'utf8'));
const urls = [...new Set((index.documents || []).map((document) => document.sourceUrl).filter(Boolean))];
const failures = [];

for (let offset = 0; offset < urls.length; offset += 8) {
  const batch = urls.slice(offset, offset + 8);
  const results = await Promise.all(batch.map(checkUrl));
  failures.push(...results.filter(Boolean));
}

if (failures.length) {
  console.error(`Broken knowledge links (${failures.length}):\n${failures.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Verified ${urls.length} knowledge PDF links.`);
}

async function checkUrl(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      headers: { 'user-agent': 'SL Rack chatbot link checker' },
      signal: controller.signal
    });
    return response.ok ? null : `${response.status} ${url}`;
  } catch (error) {
    return `${error.name || 'error'} ${url}`;
  } finally {
    clearTimeout(timeout);
  }
}
