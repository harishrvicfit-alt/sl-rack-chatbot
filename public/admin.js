const loginView = document.querySelector('#loginView');
const panelView = document.querySelector('#panelView');
const loginForm = document.querySelector('#loginForm');
const loginError = document.querySelector('#loginError');
const refreshButton = document.querySelector('#refreshButton');
const logoutButton = document.querySelector('#logoutButton');
const metrics = document.querySelector('#metrics');
const statusText = document.querySelector('#statusText');

const metricTooltips = {
  'AI Status': 'Pokazuje da li chatbot trenutno koristi OpenAI API model ili fallback logiku bez AI odgovora.',
  Dokumente: 'Broj dokumenata i tekstualnih dijelova iz SL Rack baze znanja koje chatbot koristi za odgovore.',
  'Ukupno upita': 'Ukupan broj korisnickih pitanja koja su evidentirana u admin statistici.',
  'Aktivne sesije': 'Broj korisnickih sesija koje su bile aktivne u zadnjih 30 minuta.',
  'Sesije ukupno': 'Ukupan broj jedinstvenih chat sesija koje su evidentirane od pocetka mjerenja.',
  Blockiert: 'Broj zahtjeva koje je sistem blokirao zbog rate limita, predugog unosa ili sigurnosnih pravila.',
  'Quick Actions': 'Koliko puta su korisnici kliknuli na pocetne ili dodatne brze prijedloge u chatbotu.',
  'PDF Klicks': 'Koliko puta su korisnici kliknuli na izvor, dokumentaciju ili PDF karticu koju je chatbot ponudio.',
  'Kontakt angeboten': 'Koliko puta je chatbot u odgovoru korisniku ponudio kontakt sa SL Rack timom ili Vertriebom.',
  'Weiterleitung Vertrieb': 'Koliko puta je korisnik kliknuo na kontakt/Email CTA i bio preusmjeren prema SL Rack Vertrieb timu.',
  'Top Produkt': 'Najcesce prepoznati proizvod ili model iz korisnickih pitanja.',
  Fehler: 'Broj tehnickih gresaka u radu chatbota, API pozivima ili runtime obradi.',
  'Top Produkte / Modelle': 'Lista proizvoda i tacnih modela za koje su se korisnici najvise raspitivali.',
  'Najtrazenija pitanja': 'Najcesce ponovljena ili slicna korisnicka pitanja.',
  'Top Events': 'Najcesci sistemski dogadjaji, npr. login, poslano pitanje, ponudjen kontakt ili klik na izvor.',
  'Letzte Events': 'Zadnji evidentirani dogadjaji u admin statistici sa vremenom i kratkim detaljima.',
  'Aktive Limits': 'Trenutno podesena sigurnosna i potrosacka ogranicenja za chatbot.'
};

init();

async function init() {
  const session = await requestJson('/api/admin/session');
  if (session?.authenticated) {
    showPanel();
    await loadSummary();
    return;
  }

  showLogin();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginError.textContent = '';

  const response = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: document.querySelector('#adminUser').value,
      password: document.querySelector('#adminPass').value
    })
  });

  if (!response.ok) {
    loginError.textContent = 'Login nicht korrekt.';
    return;
  }

  loginForm.reset();
  showPanel();
  await loadSummary();
});

refreshButton.addEventListener('click', loadSummary);

logoutButton.addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  metrics.innerHTML = '';
  showLogin();
});

async function loadSummary() {
  statusText.textContent = 'Lade Daten...';
  const data = await requestJson('/api/admin/summary');

  if (!data?.ok) {
    showLogin();
    return;
  }

  statusText.textContent = `Aktualisiert: ${new Date(data.generatedAt).toLocaleString('de-DE')}`;
  renderSummary(data);
}

function renderSummary(data) {
  const analytics = data.analytics || {};
  const knowledge = data.knowledge || {};
  const limits = data.limits || {};
  const topEvents = Object.entries(analytics.topEvents || {});
  const topQuestions = analytics.topQuestions || [];
  const topProducts = analytics.topProducts || [];
  const lastEvents = analytics.lastEvents || [];
  const leadingProduct = topProducts[0]?.product || '-';

  metrics.innerHTML = [
    metricCard('AI Status', data.aiEnabled ? 'Aktiv' : 'Fallback', data.model, data.aiEnabled ? 'ok' : 'warn'),
    metricCard('Dokumente', knowledge.documentCount ?? '-', `${knowledge.chunkCount ?? '-'} Chunks`),
    metricCard('Ukupno upita', analytics.totalQuestions ?? analytics.chats ?? 0, 'Korisnicka pitanja'),
    metricCard('Aktivne sesije', analytics.activeSessions ?? 0, 'Zadnjih 30 min'),
    metricCard('Sesije ukupno', analytics.totalSessions ?? 0, 'Od pocetka mjerenja'),
    metricCard('Blockiert', analytics.blocked ?? 0, 'Rate/Security'),
    metricCard('Quick Actions', analytics.quickActions ?? 0, 'Start- und Folgechips'),
    metricCard('PDF Klicks', analytics.sourceClicks ?? 0, 'Source cards'),
    metricCard('Kontakt angeboten', analytics.contactOffers ?? 0, 'CTA angezeigt'),
    metricCard('Weiterleitung Vertrieb', analytics.contacts ?? 0, 'Klick auf Mail CTA'),
    metricCard('Top Produkt', leadingProduct, 'Meist gefragt'),
    metricCard('Fehler', analytics.errors ?? 0, 'Runtime/API'),
    tableCard(
      'Top Produkte / Modelle',
      ['Produkt / Modell', 'Broj'],
      topProducts.map((item) => [item.product, item.count])
    ),
    tableCard(
      'Najtrazenija pitanja',
      ['Pitanje', 'Broj'],
      topQuestions.map((item) => [item.question, item.count])
    ),
    tableCard('Top Events', ['Event', 'Anzahl'], topEvents.map(([event, count]) => [event, count])),
    tableCard(
      'Letzte Events',
      ['Zeit', 'Event', 'Details'],
      lastEvents.map((event) => [
        new Date(event.at).toLocaleString('de-DE'),
        event.type,
        Object.entries(event.payload || {})
          .map(([key, value]) => `${key}: ${value}`)
          .join(', ') || '-'
      ])
    ),
    tableCard('Aktive Limits', ['Limit', 'Wert'], Object.entries(limits))
  ].join('');
}

function metricCard(label, value, hint = '', tone = '') {
  const tooltip = metricTooltips[label] || '';
  return `
    <article class="card ${escapeHtml(tone)}" ${tooltipAttr(tooltip)}>
      <span class="metric">${escapeHtml(label)}</span>
      <span class="value">${escapeHtml(value)}</span>
      <span class="muted">${escapeHtml(hint)}</span>
    </article>
  `;
}

function tableCard(title, headers, rows) {
  const tooltip = metricTooltips[title] || '';
  const body = rows.length
    ? rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" class="muted">Keine Daten</td></tr>`;

  return `
    <article class="card wide" ${tooltipAttr(tooltip)}>
      <h2>${escapeHtml(title)}</h2>
      <table>
        <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </article>
  `;
}

function showLogin() {
  loginView.classList.remove('hidden');
  panelView.classList.add('hidden');
}

function showPanel() {
  loginView.classList.add('hidden');
  panelView.classList.remove('hidden');
}

async function requestJson(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function tooltipAttr(value) {
  if (!value) return '';
  const safe = escapeHtml(value);
  return `title="${safe}" data-tooltip="${safe}" aria-label="${safe}"`;
}
