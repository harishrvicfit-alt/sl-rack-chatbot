const loginView = document.querySelector('#loginView');
const panelView = document.querySelector('#panelView');
const loginForm = document.querySelector('#loginForm');
const loginError = document.querySelector('#loginError');
const refreshButton = document.querySelector('#refreshButton');
const logoutButton = document.querySelector('#logoutButton');
const metrics = document.querySelector('#metrics');
const statusText = document.querySelector('#statusText');
let adminTimeZone = 'Europe/Berlin';

const metricTooltips = {
  'AI Status': 'Pokazuje da li chatbot trenutno koristi OpenAI API model ili fallback logiku bez AI odgovora.',
  Dokumente: 'Broj dokumenata i tekstualnih dijelova iz SL Rack baze znanja koje chatbot koristi za odgovore.',
  'Ukupno upita': 'Ukupan broj jedinstvenih korisnickih pitanja koja je chat API prihvatio i evidentirao.',
  'Aktivne sesije': 'Broj korisnickih sesija koje su bile aktivne u zadnjih 30 minuta.',
  'Sesije ukupno': 'Ukupan broj jedinstvenih chat sesija koje su evidentirane od pocetka mjerenja.',
  Blockiert: 'Broj zahtjeva koje je sistem blokirao zbog rate limita, predugog unosa ili sigurnosnih pravila.',
  'Quick Actions': 'Koliko puta su korisnici kliknuli na pocetne ili dodatne brze prijedloge u chatbotu.',
  'PDF Klicks': 'Koliko puta su korisnici kliknuli na izvor, dokumentaciju ili PDF karticu koju je chatbot ponudio.',
  'Kontakt angeboten': 'Koliko puta je chatbot u odgovoru korisniku ponudio kontakt sa SL Rack timom ili Vertriebom.',
  'Weiterleitung Vertrieb': 'Koliko puta je korisnik kliknuo na kontakt/Email CTA i bio preusmjeren prema SL Rack Vertrieb timu.',
  Fehler: 'Broj tehnickih gresaka u radu chatbota, API pozivima ili runtime obradi.',
  'Top Produkte / Modelle': 'Lista proizvoda i tacnih modela za koje su se korisnici najvise raspitivali.',
  'Najtrazenija pitanja': 'Najcesce ponovljena ili slicna korisnicka pitanja.',
  'Top Events': 'Najcesci sistemski dogadjaji, npr. login, poslano pitanje, ponudjen kontakt ili klik na izvor.',
  'Letzte Events': 'Dogadjaji iz posljednjih 5 sati, maksimalno 10 redova. Kompletan event log dostupan je kao CSV.',
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

  adminTimeZone = data.timeZone || 'Europe/Berlin';
  statusText.textContent = `Aktualisiert: ${formatAdminDateTime(data.generatedAt)} (${adminTimeZone})`;
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
    metricCard('Fehler', analytics.errors ?? 0, 'Runtime/API'),
    productStatsCard(
      'Top Produkte / Modelle',
      ['Produkt / Modell', 'Broj'],
      topProducts.map((item) => [item.product, item.count])
    ),
    questionsTableCard(
      'Najtrazenija pitanja',
      ['Pitanje', 'Broj'],
      topQuestions.map((item) => [item.question, item.count])
    ),
    tableCard('Top Events', ['Event', 'Anzahl'], topEvents.map(([event, count]) => [event, count])),
    eventLogCard(lastEvents, analytics.eventPreviewHours, analytics.eventPreviewLimit, analytics.eventLogCount),
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
    ? rows.map((row) => `<tr>${row.map((cell, index) => `<td data-label="${escapeHtml(headers[index] || '')}">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
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

function productStatsCard(title, headers, rows) {
  const tooltip = metricTooltips[title] || '';
  const maxCount = Math.max(...rows.map((row) => Number(row[1]) || 0), 0);
  const chartRows = rows.slice(0, 10);
  const totalMentions = rows.reduce((sum, row) => sum + (Number(row[1]) || 0), 0);
  const topShare = totalMentions && chartRows[0] ? Math.round(((Number(chartRows[0][1]) || 0) / totalMentions) * 100) : 0;
  const chart = chartRows.length
    ? chartRows.map((row, index) => {
        const label = String(row[0] ?? '');
        const count = Number(row[1]) || 0;
        const percent = maxCount ? Math.max(4, Math.round((count / maxCount) * 100)) : 0;
        return `
          <div class="bar-row ${index === 0 ? 'top' : ''}" title="${escapeHtml(`${label}: ${count}`)}" style="--bar-width: ${percent}%">
            <span class="bar-rank">${escapeHtml(index + 1)}</span>
            <span class="bar-label">${escapeHtml(label)}</span>
            <span class="bar-track" aria-hidden="true"><span class="bar-fill"></span></span>
            <span class="bar-count">${escapeHtml(count)}</span>
          </div>
        `;
      }).join('')
    : '<p class="muted">Noch keine Produktdaten vorhanden.</p>';
  const tableBody = rows.length
    ? rows.map((row) => `<tr>${row.map((cell, index) => `<td data-label="${escapeHtml(headers[index] || '')}">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" class="muted">Keine Daten</td></tr>`;

  return `
    <article class="card wide" ${tooltipAttr(tooltip)}>
      <div class="card-heading">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <span class="muted">Grafische Auswertung der am haeufigsten genannten Produkte und Modelle.</span>
        </div>
        <div class="chart-summary" aria-label="Zusammenfassung Top Produkte">
          <span><strong>${escapeHtml(totalMentions)}</strong> Erwaehnungen</span>
          <span><strong>${escapeHtml(topShare)}%</strong> Top-Anteil</span>
        </div>
      </div>
      <div class="product-chart" aria-label="Grafik Top Produkte und Modelle">
        ${chart}
      </div>
      <table>
        <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
        <tbody>${tableBody}</tbody>
      </table>
    </article>
  `;
}

function questionsTableCard(title, headers, rows) {
  const tooltip = metricTooltips[title] || '';
  const body = rows.length
    ? rows.map((row) => `<tr>${row.map((cell, index) => `<td data-label="${escapeHtml(headers[index] || '')}">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" class="muted">Keine Daten</td></tr>`;

  return `
    <article class="card wide" ${tooltipAttr(tooltip)}>
      <div class="card-heading">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <span class="muted">Top-Liste im Panel, kompletter Fragenverlauf als CSV.</span>
        </div>
        <a class="download-link" href="/api/admin/questions.csv" download>Alle Fragen CSV</a>
      </div>
      <table>
        <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </article>
  `;
}

function eventLogCard(events, previewHours = 5, previewLimit = 10, totalCount = 0) {
  const tooltip = metricTooltips['Letzte Events'] || '';
  const rows = events.map((event) => [
    formatAdminDateTime(event.at),
    event.type,
    Object.entries(event.payload || {})
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ') || '-'
  ]);
  const body = rows.length
    ? rows.map((row) => `<tr>${row.map((cell, index) => `<td data-label="${escapeHtml(['Zeit', 'Event', 'Details'][index])}">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
    : '<tr><td colspan="3" class="muted">Keine Events in diesem Zeitraum</td></tr>';

  return `
    <article class="card wide" ${tooltipAttr(tooltip)}>
      <div class="card-heading">
        <div>
          <h2>Letzte Events</h2>
          <span class="muted">Letzte ${escapeHtml(previewHours)} Stunden · max. ${escapeHtml(previewLimit)} Events · ${escapeHtml(totalCount)} gesamt</span>
        </div>
        <a class="download-link" href="/api/admin/events.csv" download>Event-Log herunterladen</a>
      </div>
      <table>
        <thead><tr><th>Zeit</th><th>Event</th><th>Details</th></tr></thead>
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

function formatAdminDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: adminTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}
