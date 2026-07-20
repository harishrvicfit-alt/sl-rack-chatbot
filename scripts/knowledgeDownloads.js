import * as cheerio from 'cheerio';

export const DOWNLOADS_URL = 'https://www.sl-rack.com/downloads';
export const SITE_ORIGIN = 'https://www.sl-rack.com';

export function extractDocuments(htmlText) {
  const $ = cheerio.load(htmlText);
  const result = [];
  let category = 'Downloads';

  $('h2, a[href]').each((_index, element) => {
    if (element.tagName === 'h2') {
      category = normalizeCategory($(element).text()) || category;
      return;
    }

    const href = $(element).attr('href');
    if (!href) return;
    const url = new URL(href, SITE_ORIGIN).toString();
    if (!url.toLowerCase().includes('/fileadmin/') || !url.toLowerCase().includes('.pdf')) return;

    const title = normalizeText($(element).attr('title') || $(element).text());
    if (!title) return;
    result.push({ title, category: normalizeCategory(category), url });
  });

  const unique = new Map();
  for (const document of result) unique.set(document.url, document);
  return [...unique.values()];
}

export async function fetchText(url) {
  const response = await fetchWithRetry(url);
  return response.text();
}

export async function fetchWithRetry(url, { attempts = 5, timeoutMs = 60_000 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
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

    if (attempt < attempts) {
      const delayMs = Math.min(8_000, attempt * 1_500);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeCategory(value) {
  return normalizeText(value);
}
