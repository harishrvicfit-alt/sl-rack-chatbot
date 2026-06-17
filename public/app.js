const chatLog = document.querySelector('#chatLog');
const chatForm = document.querySelector('#chatForm');
const messageInput = document.querySelector('#messageInput');
const statusBadge = document.querySelector('#statusBadge');
const recommendButton = document.querySelector('#recommendButton');
const recommendationList = document.querySelector('#recommendationList');

const fields = {
  projectType: document.querySelector('#projectType'),
  surface: document.querySelector('#surface'),
  priority: document.querySelector('#priority'),
  orientation: document.querySelector('#orientation')
};

const productImages = {
  'pitched-roof': 'https://www.sl-rack.com/fileadmin/_processed_/3/e/csm_202508_christophorus_kirche_schraegdach_sl-rack_web_ac91c7a6f5.jpg',
  'flat-roof': 'https://www.sl-rack.com/fileadmin/_processed_/0/1/csm_flachdach_generation_2-0_systemabbildung_ost-west-aufbau_2_web-min_b7e22a4841.jpg',
  'ground-mount': 'https://www.sl-rack.com/fileadmin/_processed_/6/b/csm_headerimage_freiflaechensysteme_agri-pv_alpaka_web-min_69b453d25e.jpg',
  facade: 'https://www.sl-rack.com/fileadmin/_processed_/2/c/csm_SL-Energy-Wall_Referenz_Kunzi_8366-260119_ohne_Plakat_web_855605b6ad.jpg',
  carport: 'https://www.sl-rack.com/fileadmin/_processed_/f/e/csm_headerimage_carportsystem_web_e5c5c4c69b.jpg',
  'agri-pv': 'https://www.sl-rack.com/fileadmin/_processed_/8/7/csm_headerimage_sl-rack_sl-agri-wall_2025-06_web_9f4a86e121.jpg'
};

const quickPrompts = [
  { label: 'Ziegeldach ausw\u00e4hlen', text: 'Ich habe ein Ziegeldach. Bitte hilf mir, das passende SL Rack System auszuw\u00e4hlen.' },
  { label: 'PDF Anleitung finden', text: 'Bitte finde mir die passende PDF Montageanleitung oder das Datenblatt.' },
  { label: 'Dachhaken planen', text: 'Wie gehe ich bei der Planung der Dachhaken und RAIL 40 vor?' },
  { label: 'Flachdach planen', text: 'Ich plane ein Flachdachprojekt. Welche SL Rack L\u00f6sung passt?' }
];

const guidedTopics = [
  {
    match: /(ziegel|dachhaken|erus|e58|tonziegel|betondachstein)/i,
    actions: [
      { label: 'Tonziegel', text: 'Es handelt sich um Tonziegel. Welche Angaben brauchst du als N\u00e4chstes?' },
      { label: 'Betondachstein', text: 'Es handelt sich um Betondachstein. Welche SL Rack Optionen kommen in Frage?' },
      { label: 'Dachneigung angeben', text: 'Die Dachneigung betr\u00e4gt ' },
      { label: 'Ziegeltyp nennen', text: 'Der genaue Ziegeltyp ist ' }
    ]
  },
  {
    match: /(wie viele|anzahl|dachhaken|rail 40|planung|auslegung)/i,
    actions: [
      { label: 'Modulbelegung', text: 'Die Modulbelegung ist ' },
      { label: 'Sparrenabstand', text: 'Der Sparrenabstand betr\u00e4gt ' },
      { label: 'Wind/Schnee', text: 'Die Windlastzone und Schneelastzone sind ' },
      { label: 'SL Planner', text: 'Welche Angaben brauche ich f\u00fcr eine saubere Auslegung im SL Planner?' }
    ]
  },
  {
    match: /(pdf|datenblatt|montageanleitung|dokumentation|anleitung)/i,
    actions: [
      { label: 'Montageanleitung', text: 'Ich suche die Montageanleitung f\u00fcr ' },
      { label: 'Datenblatt', text: 'Ich suche das Produktdatenblatt f\u00fcr ' },
      { label: 'Produkt nennen', text: 'Das Produkt hei\u00dft ' }
    ]
  },
  {
    match: /(flachdach|fast flat|ballast|ost-west|s\u00fcd)/i,
    actions: [
      { label: 'Ost-West', text: 'Das Flachdach soll als Ost-West System geplant werden. Welche Angaben brauchst du?' },
      { label: 'S\u00fcd-Ausrichtung', text: 'Das Flachdach soll nach S\u00fcd ausgerichtet werden. Welche SL Rack L\u00f6sung passt?' },
      { label: 'Dachlast', text: 'Die verf\u00fcgbare Dachlast betr\u00e4gt ' }
    ]
  }
];

const messages = [
  {
    role: 'assistant',
    content:
      'Hallo, ich bin der SL Rack AI Assistant. Beschreiben Sie Ihr PV-Projekt und ich f\u00fchre Sie zum passenden Montagesystem: Schr\u00e4gdach, Flachdach, Freifl\u00e4che, Fassade, Carport oder Agri-PV.',
    actions: quickPrompts
  }
];

renderMessages();
updateHealth();
updateRecommendations();
syncViewportHeight();
trackEvent('session_started');
window.addEventListener('resize', syncViewportHeight);
window.visualViewport?.addEventListener('resize', syncViewportHeight);

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = messageInput.value.trim();
  if (!content) return;

  messages.push({ role: 'user', content });
  messageInput.value = '';
  renderMessages();
  trackEvent('chat_submitted', { messageLength: content.length });
  trackEvent('question_asked', { question: content });

  const typing = addMessage('assistant', 'Thinking through the project details...');

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: buildOutgoingMessages(content),
        profile: getProfile(content),
        analyticsTracked: true
      })
    });

    const data = await response.json();
    typing.remove();

    const reply = data.reply || 'I could not generate a response. Please try again with more project details.';
    const actions = getGuidedActions(content, reply);
    const offerContact = shouldOfferContact(reply, data.documentSources || []);
    messages.push({
      role: 'assistant',
      content: reply,
      sources: data.documentSources || [],
      actions,
      contact: offerContact
    });
    renderMessages();
    renderRecommendations(data.recommendations || []);
    trackEvent('chat_answered', { mode: data.mode, sourceCount: (data.documentSources || []).length });
    if (offerContact) trackEvent('contact_offered', { reason: 'assistant_answer' });
  } catch (error) {
    console.error(error);
    typing.remove();
    messages.push({
      role: 'assistant',
      content: 'Die Antwort konnte gerade nicht geladen werden. Bitte versuchen Sie es erneut oder kontaktieren Sie SL Rack direkt.',
      contact: true
    });
    renderMessages();
    trackEvent('chat_failed');
  }
});

messageInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  chatForm.requestSubmit();
});

messageInput.addEventListener('focus', () => {
  requestAnimationFrame(() => {
    chatLog.scrollTop = chatLog.scrollHeight;
  });
});

chatLog.addEventListener('click', (event) => {
  const chip = event.target.closest('[data-prompt]');
  if (!chip) return;
  const text = chip.getAttribute('data-prompt') || '';
  const mode = chip.getAttribute('data-mode') || 'send';
  trackEvent('quick_action_clicked', { label: chip.textContent.trim() });

  if (mode === 'fill') {
    messageInput.value = text;
    messageInput.focus();
    return;
  }

  messageInput.value = text;
  chatForm.requestSubmit();
});

recommendButton.addEventListener('click', updateRecommendations);
Object.values(fields).forEach((field) => field.addEventListener('change', updateRecommendations));

async function updateHealth() {
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    const docs = data.knowledge?.available ? ` \u00b7 ${data.knowledge.documentCount} docs` : '';
    statusBadge.textContent = data.aiEnabled ? `AI aktiv: ${data.model}${docs}` : `Demo mode${docs}`;
    statusBadge.classList.toggle('ai', data.aiEnabled);
  } catch {
    statusBadge.textContent = 'Offline';
  }
}

async function updateRecommendations() {
  const response = await fetch('/api/recommend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: getProfile() })
  });
  const data = await response.json();
  renderRecommendations(data.recommendations || []);
}

function getProfile(message = '') {
  return {
    projectType: fields.projectType.value,
    surface: fields.surface.value,
    priority: fields.priority.value,
    orientation: fields.orientation.value,
    message
  };
}

function renderMessages() {
  chatLog.innerHTML = '';
  for (const message of messages) {
    addMessage(message.role, message.content, message.sources || [], message);
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addMessage(role, content, sources = [], options = {}) {
  const element = document.createElement('div');
  element.className = `message ${role}`;
  element.innerHTML = formatMessage(content);

  if (role === 'assistant' && sources.length) {
    element.append(renderSources(sources));
  }

  if (role === 'assistant' && options.actions?.length) {
    element.append(renderActions(options.actions));
  }

  if (role === 'assistant' && options.contact) {
    element.append(renderContactActions());
  }

  chatLog.append(element);
  chatLog.scrollTop = chatLog.scrollHeight;
  return element;
}

function renderActions(actions) {
  const wrapper = document.createElement('div');
  wrapper.className = actions === quickPrompts ? 'quick-actions' : 'guided-actions';

  for (const action of actions) {
    const button = document.createElement('button');
    button.className = actions === quickPrompts ? 'quick-chip' : 'guide-chip';
    button.type = 'button';
    button.textContent = action.label;
    button.setAttribute('data-prompt', action.text);
    button.setAttribute('data-mode', action.text.endsWith(' ') ? 'fill' : 'send');
    wrapper.append(button);
  }

  return wrapper;
}

function renderContactActions() {
  const wrapper = document.createElement('div');
  wrapper.className = 'contact-actions';

  const link = document.createElement('a');
  link.className = 'contact-link';
  link.href = buildContactMailto();
  link.textContent = 'Technisches Team kontaktieren';
  link.addEventListener('click', () => trackEvent('contact_clicked', { channel: 'vertrieb_email' }));
  wrapper.append(link);

  return wrapper;
}

function renderSources(sources) {
  const wrapper = document.createElement('div');
  wrapper.className = 'source-list';

  const title = document.createElement('strong');
  title.className = 'source-title';
  title.textContent = 'Offizielle PDF-Quellen';
  wrapper.append(title);

  for (const source of sources.slice(0, 4)) {
    const link = document.createElement('a');
    link.className = 'source-link';
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.addEventListener('click', () => trackEvent('source_clicked', { title: source.title, category: source.category }));
    link.innerHTML = `
      <strong>${escapeHtml(source.title || 'SL Rack Dokument')}</strong>
      <span class="source-meta">${escapeHtml(source.category || 'Dokument')}${source.page ? ` \u00b7 Seite ${escapeHtml(source.page)}` : ''}</span>
      <span class="source-open">PDF \u00f6ffnen</span>
    `;
    wrapper.append(link);
  }

  return wrapper;
}

function renderRecommendations(recommendations) {
  recommendationList.innerHTML = '';

  for (const item of recommendations.slice(0, 3)) {
    const card = document.createElement('article');
    card.className = 'recommendation-card';
    card.innerHTML = `
      <img src="${escapeHtml(productImages[item.id] || '/assets/hero-sl-tracker.jpg')}" alt="" loading="lazy" />
      <div class="recommendation-body">
        <strong>${escapeHtml(item.name)}</strong>
        <p>${escapeHtml(item.shortPitch)}</p>
        <div class="confidence" aria-label="Confidence ${item.confidence}%">
          <span style="width: ${item.confidence}%"></span>
        </div>
      </div>
    `;
    recommendationList.append(card);
  }
}

function getGuidedActions(userText, reply) {
  const combined = `${userText}\n${reply}`;
  const topic = guidedTopics.find((item) => item.match.test(combined));
  return topic?.actions || [];
}

function shouldOfferContact(reply, sources) {
  return /nicht belastbar|nicht verbindlich|technische pr\u00fcfung|projektspezifisch|keinen beleg|nicht sicher/i.test(reply) || sources.length === 0;
}

function buildOutgoingMessages(currentContent) {
  return [
    ...messages.slice(1, -1).map((message) => ({
      role: message.role,
      content: message.content
    })),
    { role: 'user', content: currentContent }
  ].slice(-8);
}

function buildContactMailto() {
  const subject = encodeURIComponent('SL Rack AI Assistant - technische Projektanfrage');
  const body = encodeURIComponent(buildConversationSummary());
  return `mailto:sales@sl-rack.de?subject=${subject}&body=${body}`;
}

function buildConversationSummary() {
  const recent = messages
    .slice(-6)
    .map((message) => `${message.role === 'user' ? 'Kunde' : 'AI'}: ${trimForEmail(message.content, 520)}`)
    .join('\n\n');

  const summary = [
    'Hallo SL Rack Team,',
    '',
    'bitte pr\u00fcfen Sie folgende Anfrage aus dem AI Assistant:',
    '',
    recent || 'Noch keine Chat-Historie vorhanden.',
    '',
    'Projektangaben:',
    `- Projekttyp: ${fields.projectType.value || '-'}`,
    `- Untergrund/Dach: ${fields.surface.value || '-'}`,
    `- Priorit\u00e4t: ${fields.priority.value || '-'}`,
    `- Ausrichtung: ${fields.orientation.value || '-'}`,
    '',
    'Vielen Dank.'
  ].join('\n');

  return trimForEmail(summary, 2600);
}

function formatMessage(value) {
  return escapeHtml(value)
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/(https?:\/\/[^\s<]+?)(?=[).,;!?]*($|\s))/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\n/g, '<br />');
}

function trimForEmail(value, maxLength) {
  const text = String(value || '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}â€¦`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function syncViewportHeight() {
  const height = window.visualViewport?.height || window.innerHeight;
  document.documentElement.style.setProperty('--viewport-height', `${height}px`);
}

function trackEvent(type, payload = {}) {
  const body = JSON.stringify({ type, payload, at: new Date().toISOString() });
  const reliableEvents = new Set(['session_started', 'question_asked', 'contact_offered', 'contact_clicked']);

  if (reliableEvents.has(type)) {
    fetch('/api/analytics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true
    }).catch(() => {});
    return;
  }

  if (navigator.sendBeacon) {
    navigator.sendBeacon('/api/analytics', new Blob([body], { type: 'application/json' }));
    return;
  }

  fetch('/api/analytics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true
  }).catch(() => {});
}
