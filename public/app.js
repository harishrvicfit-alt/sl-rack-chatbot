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

const messages = [
  {
    role: 'assistant',
    content:
      'Hallo, ich bin der SL Rack AI Assistant. Beschreiben Sie Ihr PV-Projekt und ich fÃ¼hre Sie zum passenden Montagesystem: SchrÃ¤gdach, Flachdach, FreiflÃ¤che, Fassade, Carport oder Agri-PV.'
  }
];

renderMessages();
updateHealth();
updateRecommendations();

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = messageInput.value.trim();
  if (!content) return;

  messages.push({ role: 'user', content });
  messageInput.value = '';
  renderMessages();

  const typing = addMessage('assistant', 'Thinking through the project details...');

  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: messages.slice(1),
      profile: getProfile(content)
    })
  });

  const data = await response.json();
  typing.remove();

  const reply = data.reply || 'I could not generate a response. Please try again with more project details.';
  messages.push({ role: 'assistant', content: reply });
  renderMessages();
  renderRecommendations(data.recommendations || []);
});

messageInput.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  chatForm.requestSubmit();
});

recommendButton.addEventListener('click', updateRecommendations);
Object.values(fields).forEach((field) => field.addEventListener('change', updateRecommendations));

async function updateHealth() {
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    const docs = data.knowledge?.available ? ` Â· ${data.knowledge.documentCount} docs` : '';
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
    addMessage(message.role, message.content);
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addMessage(role, content) {
  const element = document.createElement('div');
  element.className = `message ${role}`;
  element.textContent = content;
  chatLog.append(element);
  chatLog.scrollTop = chatLog.scrollHeight;
  return element;
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

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
