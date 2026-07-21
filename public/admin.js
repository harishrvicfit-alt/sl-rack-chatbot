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
  'AI Status': 'Shows whether the chatbot is currently using the OpenAI API model or controlled fallback logic.',
  Documents: 'Number of documents and text chunks in the SL Rack knowledge base used to generate answers.',
  'Total submitted': 'All recorded question attempts, including accepted and security-rejected requests.',
  'Accepted questions': 'Total number of unique user questions accepted and recorded by the chat API.',
  'Rejected questions': 'Requests not sent to the AI model because they were off-topic, too long, or blocked by security controls.',
  'Completed answers': 'Number of requests for which the chatbot returned an AI or controlled fallback answer.',
  'Average response time': 'Average processing time for completed answers where latency data is available.',
  'AI tokens': 'Total OpenAI input and output tokens recorded since token tracking was enabled.',
  'Client errors': 'Errors recorded in the user browser, separate from server and API errors.',
  'Active sessions': 'Number of user sessions active within the last 30 minutes.',
  'Total sessions': 'Total number of unique chat sessions recorded since analytics tracking began.',
  Blocked: 'Number of requests blocked by rate limits, input length limits, or security rules.',
  'Quick Actions': 'Number of times users selected initial or follow-up suggestion buttons in the chatbot.',
  'PDF clicks': 'Number of clicks on sources, documentation, or PDF cards offered by the chatbot.',
  'Contact offered': 'Number of times the chatbot offered contact with the SL Rack team or Sales department.',
  'Sales referrals': 'Number of times users clicked the contact or email call-to-action for the SL Rack Sales team.',
  Errors: 'Number of technical chatbot, API, or runtime errors.',
  'Top products / models': 'Products and exact models users asked about most frequently.',
  'Top topics / categories': 'Most common topics across all user questions, such as roof hooks, flat roofs, documentation, pricing, structural design, or contact.',
  'Most asked questions': 'Most frequently repeated or similar user questions.',
  'Answers requiring review': 'Questions where the chatbot gave an uncertain answer, requested more information, referred the user for technical review, or used a technical fallback.',
  'Conversation Review': 'Latest stored question-and-answer pairs for quality review. Email addresses and phone numbers are masked before storage.',
  'Top events': 'Most frequent system events, such as login, submitted question, contact offer, or source click.',
  'Recent events': 'Events from the last 5 hours, limited to 10 rows. The complete event log is available as CSV.',
  'Active limits': 'Current security and usage limits configured for the chatbot.'
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
    loginError.textContent = 'Invalid username or password.';
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
  statusText.textContent = 'Loading data...';
  const data = await requestJson('/api/admin/summary');

  if (!data?.ok) {
    showLogin();
    return;
  }

  adminTimeZone = data.timeZone || 'Europe/Berlin';
  statusText.textContent = `Updated: ${formatAdminDateTime(data.generatedAt)} (${adminTimeZone})`;
  renderSummary(data);
}

function renderSummary(data) {
  const analytics = data.analytics || {};
  const knowledge = data.knowledge || {};
  const limits = data.limits || {};
  const topEvents = Object.entries(analytics.topEvents || {});
  const topQuestions = analytics.topQuestions || [];
  const topProducts = analytics.topProducts || [];
  const topTopics = analytics.topTopics || [];
  const unresolvedQuestions = analytics.unresolvedQuestions || [];
  const conversations = analytics.conversations || [];
  const lastEvents = analytics.lastEvents || [];

  metrics.innerHTML = [
    metricCard('AI Status', data.aiEnabled ? 'Active' : 'Fallback', data.model, data.aiEnabled ? 'ok' : 'warn'),
    metricCard('Documents', knowledge.documentCount ?? '-', `${knowledge.chunkCount ?? '-'} chunks`),
    metricCard('Total submitted', analytics.totalSubmitted ?? analytics.totalQuestions ?? 0, 'Accepted + rejected'),
    metricCard('Accepted questions', analytics.totalQuestions ?? analytics.chats ?? 0, 'Accepted by the chat API'),
    metricCard('Rejected questions', analytics.rejectedQuestions ?? 0, 'Not sent to the AI model'),
    metricCard('Completed answers', analytics.chats ?? 0, 'AI + controlled fallback'),
    metricCard('Active sessions', analytics.activeSessions ?? 0, 'Last 30 minutes'),
    metricCard('Total sessions', analytics.totalSessions ?? 0, 'Since tracking began'),
    metricCard('Blocked', analytics.blocked ?? 0, 'Rate / security'),
    metricCard('Quick Actions', analytics.quickActions ?? 0, 'Initial and follow-up suggestions'),
    metricCard('PDF clicks', analytics.sourceClicks ?? 0, 'Source cards'),
    metricCard('Contact offered', analytics.contactOffers ?? 0, 'Contact CTA displayed'),
    metricCard('Sales referrals', analytics.contacts ?? 0, 'Email CTA clicks'),
    metricCard('Errors', analytics.errors ?? 0, 'Runtime / API'),
    metricCard('Client errors', analytics.clientErrors ?? 0, 'Browser / UI'),
    metricCard('Average response time', formatDuration(analytics.averageLatencyMs), 'Request to response'),
    metricCard('AI tokens', analytics.totalTokens ?? 0, `${analytics.inputTokens ?? 0} input / ${analytics.outputTokens ?? 0} output`),
    productStatsCard(
      'Top products / models',
      ['Product / model', 'Count'],
      topProducts.map((item) => [item.product, item.count])
    ),
    topicStatsCard(
      'Top topics / categories',
      ['Topic / category', 'Count'],
      topTopics.map((item) => [item.topic, item.count])
    ),
    unresolvedQuestionsCard(
      'Answers requiring review',
      ['Time', 'Question', 'Reason'],
      unresolvedQuestions.map((item) => [formatAdminDateTime(item.at), item.question, item.reason]),
      analytics.unresolvedQuestionCount || 0
    ),
    conversationReviewCard(
      conversations,
      analytics.conversationCount || 0,
      analytics.conversationPreviewLimit || 20
    ),
    questionsTableCard(
      'Most asked questions',
      ['Question', 'Count'],
      topQuestions.map((item) => [item.question, item.count])
    ),
    tableCard('Top events', ['Event', 'Count'], topEvents.map(([event, count]) => [event, count])),
    eventLogCard(lastEvents, analytics.eventPreviewHours, analytics.eventPreviewLimit, analytics.eventLogCount),
    tableCard('Active limits', ['Limit', 'Value'], Object.entries(limits))
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

function formatDuration(milliseconds) {
  const value = Number(milliseconds || 0);
  if (!value) return '-';
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

function tableCard(title, headers, rows) {
  const tooltip = metricTooltips[title] || '';
  const body = rows.length
    ? rows.map((row) => `<tr>${row.map((cell, index) => `<td data-label="${escapeHtml(headers[index] || '')}">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" class="muted">No data available</td></tr>`;

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
    : '<p class="muted">No product data available yet.</p>';
  const tableBody = rows.length
    ? rows.map((row) => `<tr>${row.map((cell, index) => `<td data-label="${escapeHtml(headers[index] || '')}">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" class="muted">No data available</td></tr>`;

  return `
    <article class="card wide" ${tooltipAttr(tooltip)}>
      <div class="card-heading">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <span class="muted">Visual analysis of the most frequently mentioned products and models.</span>
        </div>
        <div class="chart-summary" aria-label="Top product summary">
          <span><strong>${escapeHtml(totalMentions)}</strong> mentions</span>
          <span><strong>${escapeHtml(topShare)}%</strong> top share</span>
        </div>
      </div>
      <div class="product-chart" aria-label="Top products and models chart">
        ${chart}
      </div>
      <table>
        <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
        <tbody>${tableBody}</tbody>
      </table>
    </article>
  `;
}

function topicStatsCard(title, headers, rows) {
  const tooltip = metricTooltips[title] || '';
  const maxCount = Math.max(...rows.map((row) => Number(row[1]) || 0), 0);
  const totalMentions = rows.reduce((sum, row) => sum + (Number(row[1]) || 0), 0);
  const chartRows = rows.slice(0, 12);
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
    : '<p class="muted">No topic data available yet.</p>';
  const tableBody = rows.length
    ? rows.map((row) => `<tr>${row.map((cell, index) => `<td data-label="${escapeHtml(headers[index] || '')}">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" class="muted">No data available</td></tr>`;

  return `
    <article class="card wide" ${tooltipAttr(tooltip)}>
      <div class="card-heading">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <span class="muted">Automatically categorized from all stored user questions.</span>
        </div>
        <div class="card-actions">
          <div class="chart-summary" aria-label="Top topic summary">
            <span><strong>${escapeHtml(totalMentions)}</strong> assignments</span>
          </div>
          <a class="download-link" href="/api/admin/topics.csv" download>Topics</a>
        </div>
      </div>
      <div class="product-chart" aria-label="Top topics and categories chart">
        ${chart}
      </div>
      <table>
        <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
        <tbody>${tableBody}</tbody>
      </table>
    </article>
  `;
}

function unresolvedQuestionsCard(title, headers, rows, totalCount = 0) {
  const tooltip = metricTooltips[title] || '';
  const body = rows.length
    ? rows.map((row) => `<tr>${row.map((cell, index) => `<td data-label="${escapeHtml(headers[index] || '')}">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" class="muted">No answers have required review since answer evaluation was enabled</td></tr>`;

  return `
    <article class="card wide" ${tooltipAttr(tooltip)}>
      <div class="card-heading">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <span class="muted">${escapeHtml(totalCount)} total since answer evaluation was enabled · latest ${escapeHtml(rows.length)} shown</span>
        </div>
        <a class="download-link" href="/api/admin/unresolved-questions.csv" download>Review data</a>
      </div>
      <table>
        <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </article>
  `;
}

function questionsTableCard(title, headers, rows) {
  const tooltip = metricTooltips[title] || '';
  const body = rows.length
    ? rows.map((row) => `<tr>${row.map((cell, index) => `<td data-label="${escapeHtml(headers[index] || '')}">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${headers.length}" class="muted">No data available</td></tr>`;

  return `
    <article class="card wide" ${tooltipAttr(tooltip)}>
      <div class="card-heading">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <span class="muted">Top questions in the panel, with the complete question history available as CSV.</span>
        </div>
        <a class="download-link" href="/api/admin/questions.csv" download>All questions</a>
      </div>
      <table>
        <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </article>
  `;
}

function conversationReviewCard(conversations, totalCount = 0, previewLimit = 20) {
  const tooltip = metricTooltips['Conversation Review'] || '';
  const items = conversations.length
    ? conversations.map((conversation) => {
        const sources = Array.isArray(conversation.sources) ? conversation.sources : [];
        const sourceLinks = sources.length
          ? sources.map((source) => {
              const title = escapeHtml(source.title || 'SL Rack source');
              const url = safeExternalUrl(source.url);
              return url
                ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${title}</a>`
                : `<span>${title}</span>`;
            }).join('')
          : '<span class="muted">No sources recorded</span>';
        const quality = conversation.quality === 'good' ? 'good' : 'review';
        const qualityLabel = quality === 'good' ? 'Good' : 'Review';

        return `
          <details class="conversation-item ${quality}">
            <summary>
              <span class="conversation-time">${escapeHtml(formatAdminDateTime(conversation.at))}</span>
              <strong>${escapeHtml(conversation.question)}</strong>
              <span class="quality-badge">${escapeHtml(qualityLabel)}</span>
            </summary>
            <div class="conversation-body">
              <div class="conversation-meta">
                <span>Mode: <strong>${escapeHtml(conversation.mode || 'unknown')}</strong></span>
                ${conversation.reason ? `<span>Review reason: ${escapeHtml(conversation.reason)}</span>` : ''}
              </div>
              <div class="conversation-answer">
                <span class="conversation-label">Chatbot answer</span>
                <p>${escapeHtml(conversation.answer)}</p>
              </div>
              <div class="conversation-sources">
                <span class="conversation-label">Sources</span>
                <div>${sourceLinks}</div>
              </div>
            </div>
          </details>
        `;
      }).join('')
    : '<p class="muted">No complete conversations have been recorded yet. New question-and-answer pairs will appear here.</p>';

  return `
    <article class="card wide" ${tooltipAttr(tooltip)}>
      <div class="card-heading">
        <div>
          <h2>Conversation Review</h2>
          <span class="muted">${escapeHtml(totalCount)} stored conversations · latest ${escapeHtml(Math.min(previewLimit, conversations.length))} shown · personal contact details are masked</span>
        </div>
        <a class="download-link" href="/api/admin/conversations.csv" download>All conversations</a>
      </div>
      <div class="conversation-list">${items}</div>
    </article>
  `;
}

function eventLogCard(events, previewHours = 5, previewLimit = 10, totalCount = 0) {
  const tooltip = metricTooltips['Recent events'] || '';
  const rows = events.map((event) => [
    formatAdminDateTime(event.at),
    event.type,
    Object.entries(event.payload || {})
      .filter(([key]) => !['question', 'answer', 'sourcesJson'].includes(key))
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ') || '-'
  ]);
  const body = rows.length
    ? rows.map((row) => `<tr>${row.map((cell, index) => `<td data-label="${escapeHtml(['Time', 'Event', 'Details'][index])}">${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')
    : '<tr><td colspan="3" class="muted">No events in this period</td></tr>';

  return `
    <article class="card wide" ${tooltipAttr(tooltip)}>
      <div class="card-heading">
        <div>
          <h2>Recent events</h2>
          <span class="muted">Last ${escapeHtml(previewHours)} hours · max. ${escapeHtml(previewLimit)} events · ${escapeHtml(totalCount)} total</span>
        </div>
        <a class="download-link" href="/api/admin/events.csv" download>Download event log</a>
      </div>
      <table>
        <thead><tr><th>Time</th><th>Event</th><th>Details</th></tr></thead>
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

function safeExternalUrl(value) {
  const url = String(value || '');
  return /^https:\/\//i.test(url) ? url : '';
}

function tooltipAttr(value) {
  if (!value) return '';
  const safe = escapeHtml(value);
  return `title="${safe}" data-tooltip="${safe}" aria-label="${safe}"`;
}

function formatAdminDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('en-GB', {
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
