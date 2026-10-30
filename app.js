const token = localStorage.getItem('whispr_token');
if (!token) location.replace('login.html');
const $ = (selector) => document.querySelector(selector);
function syncAppViewport() { const viewport = window.visualViewport; document.documentElement.style.setProperty('--app-height', `${Math.round(viewport?.height || window.innerHeight)}px`); document.documentElement.style.setProperty('--app-top', `${Math.round(viewport?.offsetTop || 0)}px`); }
syncAppViewport(); window.visualViewport?.addEventListener('resize', syncAppViewport); window.addEventListener('resize', syncAppViewport);
const esc = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const initials = (name = '?') => name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
const clock = (value) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
const api = async (url, options = {}) => {
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  if (response.status === 401) { localStorage.removeItem('whispr_token'); location.replace('login.html'); throw new Error('Your session expired.'); }
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(result?.error || 'Request failed.');
  return result;
};

let me, chats = [], activeChat = null, selectedUsers = [], call = null, incomingCall = null, voiceRecorder = null, voiceStream = null, voiceChunks = [], ringTimer = null, ringAudioContext = null, callNotification = null, pushSubscribed = false, serviceWorkerRegistration = null, aiPrefs = { enabled: false }, aiConfigured = false;
const earlyIce = new Map();
const socket = io({ auth: { token }, reconnection: true, reconnectionAttempts: Infinity });
socket.on('connect_error', (error) => { if (/unauthorized/i.test(error.message)) { localStorage.removeItem('whispr_token'); location.replace('login.html'); } else toast('Live connection lost. Retrying…', 'error'); });
socket.on('connect', () => {
  if (!me) return;
  loadChats().then(() => activeChat && openChat(activeChat.id)).catch(() => toast('Could not sync the latest messages.', 'error'));
});

function avatarMarkup(user) { return user?.avatar ? `<img src="${esc(user.avatar)}" alt="">` : esc(initials(user?.name || user?.title)); }
function toast(message, kind = '') {
  let node = $('#toast');
  if (!node) { node = document.createElement('div'); node.id = 'toast'; node.setAttribute('role', 'status'); document.body.append(node); }
  node.textContent = message; node.className = kind; node.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.hidden = true; }, 5000);
}
function renderChats() {
  const query = $('#chat-search').value.trim().toLocaleLowerCase();
  const visible = chats.filter((chat) => (query === '' || chat.title.toLocaleLowerCase().includes(query) || chat.lastMessage?.body.toLocaleLowerCase().includes(query)) && (window.chatFilter !== 'online' || chat.online));
  $('#chat-list').innerHTML = visible.length ? visible.map((chat) => `<button class="chat-item ${chat.id === activeChat?.id ? 'active' : ''}" data-chat-id="${esc(chat.id)}"><span class="chat-item-avatar"><span class="avatar-ph">${avatarMarkup({ name: chat.title, avatar: chat.avatar })}</span><i class="status-dot ${chat.online ? 'online' : 'away'}"></i></span><span class="chat-item-body"><span class="chat-item-top"><b>${esc(chat.title)}</b><small>${chat.lastMessage ? clock(chat.lastMessage.createdAt) : ''}</small></span><span class="chat-item-bottom"><span class="chat-preview">${esc(chat.lastMessage?.deletedForEveryone ? 'Message deleted' : chat.lastMessage?.body || 'No messages yet')}</span></span></span></button>`).join('') : '<p class="list-empty">No conversations match.</p>';
  document.querySelectorAll('[data-chat-id]').forEach((button) => button.addEventListener('click', () => openChat(button.dataset.chatId)));
}
async function loadChats() {
  chats = await api('/api/chats');
  if (activeChat) activeChat = chats.find((chat) => chat.id === activeChat.id) || null;
  renderChats();
}
function renderHeader() {
  if (!activeChat) return;
  const other = activeChat.participants.find((participant) => participant.id !== me.id);
  $('#chat-header').innerHTML = `<button class="back-button" id="back-to-chats" aria-label="Back to chats">‹</button><span class="chat-main-who"><span class="chat-item-avatar"><span class="avatar-ph">${avatarMarkup(other || { name: activeChat.title })}</span><i class="status-dot ${activeChat.online ? 'online' : 'away'}"></i></span><span><b class="chat-main-name">${esc(activeChat.title)}</b><small class="chat-main-status">${activeChat.isGroup ? `${activeChat.participants.length} members` : activeChat.online ? 'Online' : 'Offline'}</small></span></span><span class="chat-main-actions"><button class="icon-btn-round" id="voice-call" aria-label="Start ${activeChat.isGroup ? 'group ' : ''}voice call" title="${activeChat.isGroup ? 'Start group voice call' : 'Start voice call'}"><i class="fa-solid fa-phone"></i></button><button class="icon-btn-round" id="video-call" aria-label="Start ${activeChat.isGroup ? 'group ' : ''}video call" title="${activeChat.isGroup ? 'Start group video call' : 'Start video call'}"><i class="fa-solid fa-video"></i></button><button class="icon-btn-round ai-header-button" id="ai-tools" aria-label="AI conversation tools" title="AI conversation tools"><i class="fa-solid fa-wand-magic-sparkles"></i></button><button class="icon-btn-round" id="chat-info" aria-label="Conversation info"><i class="fa-solid fa-circle-info"></i></button></span>`;
  $('#message-input').disabled = $('#file-button').disabled = $('#voice-record').disabled = $('#emoji-toggle').disabled = $('.send-btn').disabled = $('#report').disabled = false;
  $('#back-to-chats').onclick = () => $('.chat-shell').classList.remove('chat-open');
  $('#voice-call').onclick = () => startCall(false);
  $('#video-call').onclick = () => startCall(true);
  $('#ai-tools').onclick = () => { $('#ai-dialog-note').textContent = aiConfigured ? (aiPrefs.enabled ? 'Only the selected messages and bounded context needed for each tool will be processed.' : 'AI tools are off. Review consent and enable specific features in your profile.') : 'The AI provider is not configured on the server. The server owner must configure a key for the selected provider.'; $('#ai-dialog').showModal(); };
  $('#chat-info').onclick = () => $('.chat-profile').classList.toggle('mobile-visible');
}
function updateAIControls() {
  const enabled = aiPrefs.enabled && aiConfigured;
  $('#rewrite-draft').disabled = !enabled || !aiPrefs.rewriting || !activeChat;
  for (const [id, preference] of [['ai-summarize', 'summaries'], ['ai-actions', 'actionExtraction'], ['ai-smart-replies', 'smartReplies'], ['ai-search', 'naturalSearch']]) $(`#${id}`).disabled = !enabled || !aiPrefs[preference];
}
function renderMessage(message) {
  const mine = message.senderId === me.id;
  const clientData = message.clientId ? `data-client-id="${esc(message.clientId)}"` : '';
  const recipients = activeChat?.participants.filter((person) => person.id !== message.senderId).map((person) => person.id) || [];
  const deliveredTo = message.deliveredTo || []; const readBy = message.readBy || [];
  const status = recipients.length && recipients.every((id) => readBy.includes(id)) ? 'seen' : recipients.length && recipients.every((id) => deliveredTo.includes(id)) ? 'delivered' : 'sent';
  const statusMarkup = status === 'seen' ? '<span class="message-ticks seen" role="img" aria-label="Seen" title="Seen">✓✓</span>' : status === 'delivered' ? '<span class="message-ticks" role="img" aria-label="Delivered" title="Delivered">✓✓</span>' : '<span class="message-ticks" role="img" aria-label="Sent" title="Sent">✓</span>';
  const body = message.deletedForEveryone ? `<span class="deleted-message"><i class="fa-solid fa-ban" aria-hidden="true"></i> ${mine ? 'You deleted this message' : 'This message was deleted'}</span>` : esc(message.body);
  const hasHttpLink = !message.deletedForEveryone && /(?:https?:\\/\\/|www\\.)[^\\s<>"'\x60]+/i.test(message.body || '');
  const actions = message.pending ? '' : `<details class="message-actions"><summary aria-label="Message options" title="Message options"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i></summary><div class="message-action-menu">${!mine && aiPrefs.enabled && aiConfigured && aiPrefs.translation && !message.deletedForEveryone ? `<button type="button" data-ai-translate="${esc(message.id)}">Translate…</button>` : ''}${!mine && aiPrefs.enabled && aiConfigured && aiPrefs.scamAnalysis && !message.deletedForEveryone ? `<button type="button" data-ai-analyze="${esc(message.id)}">Check for scam indicators</button>` : ''}${hasHttpLink && aiPrefs.enabled && aiConfigured && aiPrefs.linkAnalysis ? `<button type="button" data-ai-link-check="${esc(message.id)}">Check link safety</button>` : ''}<button type="button" data-delete-scope="me" data-message-id="${esc(message.id)}">Delete for me</button>${mine && !message.deletedForEveryone ? `<button type="button" data-delete-scope="everyone" data-message-id="${esc(message.id)}">Delete for everyone</button>` : ''}</div></details>`;
  const dismissedScam = message.id && sessionStorage.getItem('scam-dismissed-' + message.id) === '1';
  const scam = message.scamAnalysis && !dismissedScam ? `<details class="scam-warning ${message.scamAnalysis.riskScore >= 65 ? 'high-risk' : ''}"><summary><i class="fa-solid fa-shield-halved" aria-hidden="true"></i> AI risk estimate: ${esc(message.scamAnalysis.severity)} (${message.scamAnalysis.riskScore}/100)</summary><p>${esc(message.scamAnalysis.explanation)}</p><p><b>Evidence:</b> ${esc(message.scamAnalysis.evidence.join(' · ') || 'No verifiable exact evidence returned')}</p><p><b>Next steps:</b> ${esc(message.scamAnalysis.nextSteps.join(' · ') || 'Use your judgment')}</p><small>AI can be wrong. This is not proof of fraud or a safety guarantee.</small><div class="scam-actions"><button type="button" data-dismiss-scam="${esc(message.id)}">Dismiss warning</button><button type="button" data-report-scam>Report conversation</button></div></details>` : '';
  const receipt = mine ? message.pending ? '<small class="delivery-state">Sending…</small>' : `<small class="delivery-state" data-message-status="${esc(message.id)}">${message.failed ? 'Not sent' : statusMarkup}</small>` : '';
  return `<article class="msg-row ${mine ? 'mine' : ''} ${message.deletedForEveryone ? 'message-deleted' : ''}" data-message-id="${esc(message.id || '')}" data-sender-id="${esc(message.senderId)}" ${clientData}><div class="msg-bubble ${mine ? 'mine' : ''}"><div class="msg-meta"><b>${mine ? 'You' : esc(message.sender?.name || activeChat.title)}</b><time>${clock(message.createdAt)}</time></div><div class="message-text">${body}</div>${scam}${receipt}${actions}</div></article>`;
}
async function markMessagesRead(chatId, messageIds) {
  if (!chatId || !messageIds.length) return;
  const ids = [...new Set(messageIds)];
  for (let offset = 0; offset < ids.length; offset += 200) socket.emit('messages:read', { chatId, messageIds: ids.slice(offset, offset + 200) });
}
function markVisibleMessagesRead(chatId = activeChat?.id) {
  if (!chatId || chatId !== activeChat?.id || document.visibilityState !== 'visible') return;
  const ids = [...$('#messages').querySelectorAll('.msg-row[data-message-id]')].filter((row) => !row.classList.contains('file-message') && row.dataset.senderId !== me.id).map((row) => row.dataset.messageId).filter((id) => id && !id.startsWith('pending-') && !id.startsWith('local-'));
  markMessagesRead(chatId, ids);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') markVisibleMessagesRead(); });
function updateMessageStatus({ chatId, messageId, deliveredTo, readBy }) {
  if (chatId !== activeChat?.id) return;
  const recipients = (activeChat?.participants || []).filter((person) => person.id !== me.id).map((person) => person.id);
  const seen = recipients.length > 0 && recipients.every((id) => readBy.includes(id));
  const delivered = recipients.length > 0 && recipients.every((id) => deliveredTo.includes(id));
  const node = $(`#messages [data-message-status="${CSS.escape(messageId)}"]`); if (!node) return;
  node.innerHTML = seen ? '<span class="message-ticks seen" role="img" aria-label="Seen" title="Seen">✓✓</span>' : delivered ? '<span class="message-ticks" role="img" aria-label="Delivered" title="Delivered">✓✓</span>' : '<span class="message-ticks" role="img" aria-label="Sent" title="Sent">✓</span>';
}
function renderFileMessage(file) {
  const mine = file.senderId === me.id;
  const preview = file.type.startsWith('image/') ? `<a href="${esc(file.url)}" target="_blank" rel="noopener"><img class="inline-image" src="${esc(file.url)}" alt="${esc(file.name)}"></a>`
    : file.type.startsWith('video/') ? `<video class="inline-video" src="${esc(file.url)}" controls preload="metadata"></video>`
      : file.type.startsWith('audio/') ? `<audio class="inline-audio" src="${esc(file.url)}" controls preload="metadata"></audio>`
        : `<a class="inline-document" href="${esc(file.url)}" target="_blank" rel="noopener" download><i class="fa-solid fa-file-arrow-down"></i><span>${esc(file.name)}<small>${(file.size / 1024).toFixed(0)} KB</small></span></a>`;
  return `<article class="msg-row file-message ${mine ? 'mine' : ''}" data-file-id="${esc(file.id)}"><div class="msg-bubble ${mine ? 'mine' : ''}"><div class="msg-meta"><b>${mine ? 'You' : esc(file.senderName || activeChat.title)}</b><time>${clock(file.createdAt)}</time></div>${preview}<div class="attachment-name">${esc(file.name)}</div></div></article>`;
}
function appendMessage(node, key, value) {
  const current = $(`#messages [${key}="${CSS.escape(value)}"]`);
  if (current) return current;
  $('#messages .empty-state')?.remove();
  $('#messages').insertAdjacentHTML('beforeend', node);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  return $(`#messages [${key}="${CSS.escape(value)}"]`);
}
async function renderFiles(files = null) {
  files ||= await api(`/api/chats/${activeChat.id}/files`);
  $('#files').innerHTML = files.length ? files.map((file) => file.type.startsWith('image/') ? `<a class="media-preview" href="${esc(file.url)}" target="_blank" rel="noopener"><img src="${esc(file.url)}" alt="${esc(file.name)}"></a>` : `<a class="file-link" href="${esc(file.url)}" target="_blank" rel="noopener" download>${esc(file.name)}</a>`).join('') : '<p class="profile-status">No shared files yet.</p>';
}
async function openChat(chatId) {
  activeChat = chats.find((chat) => chat.id === chatId);
  if (!activeChat) return;
  socket.emit('chat:join', { chatId });
  $('.chat-shell').classList.add('chat-open');
  $('.chat-profile').classList.remove('mobile-visible');
  renderHeader(); renderChats();
  const [messages, sharedFiles] = await Promise.all([api(`/api/chats/${chatId}/messages`), api(`/api/chats/${chatId}/files`)]);
  const timeline = [...messages.map((item) => ({ ...item, kind: 'message' })), ...sharedFiles.map((item) => ({ ...item, kind: 'file' }))].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  $('#messages').innerHTML = timeline.length ? timeline.map((item) => item.kind === 'file' ? renderFileMessage(item) : renderMessage(item)).join('') : '<p class="empty-state">Start the conversation.</p>';
  $('#messages').scrollTop = $('#messages').scrollHeight;
  markVisibleMessagesRead(chatId);
  const latestIncoming = [...messages].reverse().find((message) => message.senderId !== me.id);
  if (latestIncoming) maybeLoadSmartReplies(chatId, latestIncoming.id);
  const other = activeChat.participants.find((participant) => participant.id !== me.id);
  const isGroupAdmin = activeChat.isGroup && (activeChat.adminIds || []).includes(me.id);
  $('#conversation-info').innerHTML = `<span class="profile-avatar"><span class="avatar-ph">${avatarMarkup(other || { name: activeChat.title })}</span></span><p class="profile-name">${esc(activeChat.title)}</p><p class="profile-status">${activeChat.isGroup ? `${activeChat.participants.length} members` : esc(other?.bio || 'No about information')}</p>${activeChat.isGroup ? `<div class="group-member-list"><b>Members</b>${activeChat.participants.map((person) => `<div class="group-member-row"><span>${esc(person.name)}${(activeChat.adminIds || []).includes(person.id) ? ' · admin' : ''}</span>${isGroupAdmin && person.id !== me.id ? `<button type="button" data-remove-group-member="${esc(person.id)}" aria-label="Remove ${esc(person.name)}">Remove</button>` : ''}</div>`).join('')}</div>${isGroupAdmin ? '<button type="button" id="manage-group-add">Add members</button>' : ''}<button type="button" id="leave-group">Leave group</button>` : ''}`;
  if (activeChat.isGroup) {
    $('#manage-group-add')?.addEventListener('click', () => { groupMemberSelection.clear(); $('#group-member-search').value = ''; $('#group-member-results').replaceChildren(); $('#add-group-members').disabled = true; $('#group-members-dialog').showModal(); $('#group-member-search').focus(); });
    $('#leave-group').onclick = () => leaveGroup(activeChat.id, me.id);
    $('#conversation-info').querySelectorAll('[data-remove-group-member]').forEach((button) => button.addEventListener('click', () => removeGroupMember(activeChat.id, button.dataset.removeGroupMember)));
  }
  await renderFiles(sharedFiles);
  updateAIControls();
}

$('#message-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const body = $('#message-input').value.trim(); if (!activeChat || !body) return;
  const chatId = activeChat.id, clientId = crypto.randomUUID(), createdAt = new Date().toISOString();
  $('#message-input').value = '';
  appendMessage(renderMessage({ id: `pending-${clientId}`, clientId, chatId, senderId: me.id, body, createdAt, pending: true }), 'data-client-id', clientId);
  try {
    const sent = await api(`/api/chats/${chatId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, clientId }) });
    const pending = $(`#messages [data-client-id="${CSS.escape(clientId)}"]`);
    if (pending) pending.outerHTML = renderMessage(sent);
  } catch (error) {
    const pending = $(`#messages [data-client-id="${CSS.escape(clientId)}"]`);
    pending?.classList.add('send-failed');
    pending?.querySelector('.delivery-state')?.replaceChildren(document.createTextNode('Not sent ✕ · retry by resending'));
    $('#message-input').value ||= body;
    toast(error.message, 'error');
  }
});
$('#messages').addEventListener('click', async (event) => {
  const dismissScam = event.target.closest('[data-dismiss-scam]');
  if (dismissScam) { sessionStorage.setItem('scam-dismissed-' + dismissScam.dataset.dismissScam, '1'); dismissScam.closest('.scam-warning')?.remove(); return; }
  if (event.target.closest('[data-report-scam]')) { $('#report').click(); return; }
  const analyzeButton = event.target.closest('[data-ai-analyze]');
  if (analyzeButton) {
    analyzeButton.disabled = true;
    try { await api('/api/ai/messages/' + encodeURIComponent(analyzeButton.dataset.aiAnalyze) + '/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
    catch (error) { toast(error.message, 'error'); analyzeButton.disabled = false; }
    return;
  }
  const linkButton = event.target.closest('[data-ai-link-check]');
  if (linkButton) {
    linkButton.disabled = true;
    try {
      const result = await api('/api/ai/messages/' + encodeURIComponent(linkButton.dataset.aiLinkCheck) + '/link-check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      showAIToolResult(result);
      $('#ai-dialog-note').textContent = 'Link safety review completed. Whispr did not open or follow the link.';
      if (!$('#ai-dialog').open) $('#ai-dialog').showModal();
    } catch (error) { toast(error.message, 'error'); }
    finally { linkButton.disabled = false; }
    return;
  }
  const translateButton = event.target.closest('[data-ai-translate]');
  if (translateButton) {
    const language = prompt('Translate this message into which language?'); if (!language?.trim()) return;
    translateButton.disabled = true;
    try { const result = await api('/api/ai/translate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageId: translateButton.dataset.aiTranslate, language: language.trim() }) }); alert(result.translation); }
    catch (error) { toast(error.message, 'error'); }
    finally { translateButton.disabled = false; }
    return;
  }
  const button = event.target.closest('[data-delete-scope]'); if (!button) return;
  const { deleteScope, messageId } = button.dataset;
  if (deleteScope === 'everyone' && !confirm('Delete this message for everyone in the conversation?')) return;
  const chatId = activeChat?.id; if (!chatId || !messageId) return;
  button.disabled = true;
  try {
    await api(`/api/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: deleteScope }) });
    if (deleteScope === 'me') removeMessageFromView(chatId, messageId);
  } catch (error) { button.disabled = false; toast(error.message, 'error'); }
});
function removeMessageFromView(chatId, messageId) {
  if (chatId !== activeChat?.id) return;
  $(`#messages [data-message-id="${CSS.escape(messageId)}"]`)?.remove();
  if (!$('#messages .msg-row')) $('#messages').innerHTML = '<p class="empty-state">Start the conversation.</p>';
}
socket.on('message:deleted', ({ chatId, messageId, scope, userId, message }) => {
  if (scope === 'me') { if (userId === me.id) removeMessageFromView(chatId, messageId); return; }
  if (chatId !== activeChat?.id || !message) return;
  const row = $(`#messages [data-message-id="${CSS.escape(messageId)}"]`);
  if (row) row.outerHTML = renderMessage(message);
  loadChats().catch(() => {});
});
socket.on('message:new', (message) => {
  if (message.chatId === activeChat?.id) {
    const pending = message.clientId && $(`#messages [data-client-id="${CSS.escape(message.clientId)}"]`);
    if (pending) pending.outerHTML = renderMessage(message);
    else if (!$(`#messages [data-message-id="${CSS.escape(message.id)}"]`)) appendMessage(renderMessage(message), 'data-message-id', message.id);
    if (message.senderId !== me.id && document.visibilityState === 'visible') markMessagesRead(message.chatId, [message.id]);
    if (message.senderId !== me.id) maybeLoadSmartReplies(message.chatId, message.id);
  }
  loadChats().catch(() => {});
});
socket.on('message:status', updateMessageStatus);
socket.on('chat:created', () => { loadChats().catch(() => toast('A new conversation could not be loaded. Refresh your chat list and try again.', 'error')); });
socket.on('group:updated', async ({ chatId }) => { try { await loadChats(); if (activeChat?.id === chatId) await openChat(chatId); } catch (error) { toast(error.message, 'error'); } });
socket.on('group:removed', async ({ chatId, left }) => { if (activeChat?.id === chatId) { activeChat = null; $('#chat-header').innerHTML = '<div class="empty-header">Choose a conversation</div>'; $('#messages').innerHTML = '<p class="empty-state">Choose a chat or start a new conversation.</p>'; $('.chat-shell').classList.remove('chat-open'); } try { await loadChats(); } catch {} toast(left ? 'You left the group.' : 'You were removed from the group.'); });
socket.on('ai:scam-analysis:updated', async ({ chatId, messageId }) => {
  if (chatId !== activeChat?.id) return;
  try {
    const messages = await api('/api/chats/' + encodeURIComponent(chatId) + '/messages');
    const message = messages.find((item) => item.id === messageId); const row = $('#messages [data-message-id="' + CSS.escape(messageId) + '"]');
    if (message && row) row.outerHTML = renderMessage(message);
  } catch {}
});
socket.on('file:new', async (file) => {
  if (file.chatId !== activeChat?.id) return;
  try { const files = await api(`/api/chats/${file.chatId}/files`); const saved = files.find((item) => item.id === file.id); if (saved) appendMessage(renderFileMessage(saved), 'data-file-id', saved.id); await renderFiles(files); }
  catch (error) { toast(`Attachment could not load: ${error.message}`, 'error'); }
});
socket.on('presence', ({ userId, online }) => { chats.forEach((chat) => { if (!chat.isGroup && chat.participants.some((person) => person.id === userId && person.id !== me.id)) chat.online = online; }); renderChats(); if (activeChat) { activeChat = chats.find((chat) => chat.id === activeChat.id); renderHeader(); } });
socket.on('typing', ({ chatId, userId, active }) => { if (chatId !== activeChat?.id || userId === me.id) return; let indicator = $('#typing-indicator'); if (active && !indicator) $('#messages').insertAdjacentHTML('beforeend', '<p class="typing" id="typing-indicator">Typing…</p>'); if (!active) indicator?.remove(); });
let typingTimer; $('#message-input').addEventListener('input', () => { if (!activeChat) return; socket.emit('typing', { chatId: activeChat.id, active: true }); clearTimeout(typingTimer); typingTimer = setTimeout(() => socket.emit('typing', { chatId: activeChat.id, active: false }), 1100); });

$('#chat-search').addEventListener('input', renderChats);
const groupMemberSelection = new Set();
async function searchGroupPeople() {
  if (!activeChat?.isGroup) return;
  const query = $('#group-member-search').value.trim(); const results = await api(`/api/users?q=${encodeURIComponent(query)}`);
  const candidates = results.filter((person) => !activeChat.memberIds.includes(person.id));
  $('#group-member-results').innerHTML = candidates.length ? candidates.map((person) => `<button type="button" class="user-result ${groupMemberSelection.has(person.id) ? 'selected' : ''}" data-add-group-user="${esc(person.id)}"><span>${esc(person.name)}</span><small>${esc(person.email)}</small></button>`).join('') : '<p class="list-empty">No people available to add.</p>';
  $('#group-member-results').querySelectorAll('[data-add-group-user]').forEach((button) => button.addEventListener('click', () => { const id = button.dataset.addGroupUser; groupMemberSelection.has(id) ? groupMemberSelection.delete(id) : groupMemberSelection.add(id); button.classList.toggle('selected', groupMemberSelection.has(id)); $('#add-group-members').disabled = !groupMemberSelection.size; }));
}
$('#group-member-search').addEventListener('input', () => searchGroupPeople().catch((error) => toast(error.message, 'error')));
$('#group-members-form').addEventListener('submit', async (event) => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault(); if (!activeChat || !groupMemberSelection.size) return;
  const chatId = activeChat.id; $('#add-group-members').disabled = true;
  try { await api(`/api/chats/${encodeURIComponent(chatId)}/members`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberIds: [...groupMemberSelection] }) }); $('#group-members-dialog').close(); await loadChats(); await openChat(chatId); toast('Members added to the group.'); }
  catch (error) { toast(error.message, 'error'); $('#add-group-members').disabled = false; }
});
async function removeGroupMember(chatId, userId) {
  if (!confirm('Remove this person from the group?')) return;
  try { await api(`/api/chats/${encodeURIComponent(chatId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }); await loadChats(); if (activeChat?.id === chatId) await openChat(chatId); }
  catch (error) { toast(error.message, 'error'); }
}
async function leaveGroup(chatId, userId) {
  if (!confirm('Leave this group? You will no longer see its messages or calls.')) return;
  try { await api(`/api/chats/${encodeURIComponent(chatId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }); }
  catch (error) { toast(error.message, 'error'); }
}
$('#group-members-form').addEventListener('click', (event) => { if (event.target.value === 'cancel') groupMemberSelection.clear(); });
document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => { window.chatFilter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('active', item === button)); renderChats(); }));
$('#logout').onclick = async () => { try { const subscription = await serviceWorkerRegistration?.pushManager.getSubscription(); if (subscription) { await api('/api/push/subscriptions', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: subscription.endpoint }) }).catch(() => {}); await subscription.unsubscribe(); } } finally { localStorage.removeItem('whispr_token'); location.replace('login.html'); } };
function updateNotificationButton() {
  const button = $('#notifications-toggle');
  if (!('Notification' in window)) { button.disabled = true; button.title = 'This browser does not support system notifications'; return; }
  const enabled = Notification.permission === 'granted' && pushSubscribed;
  button.classList.toggle('notification-enabled', enabled);
  button.title = enabled ? 'Background call notifications enabled' : Notification.permission === 'granted' ? 'Enable background call notifications' : 'Enable call notifications';
  button.setAttribute('aria-label', button.title);
}
$('#notifications-toggle').onclick = async () => {
  if (!('Notification' in window)) return toast('System notifications are not supported in this browser.', 'error');
  if (!window.isSecureContext) return toast('Notifications require HTTPS or localhost.', 'error');
  if (Notification.permission === 'denied') return toast('Notifications are blocked in browser settings. Allow them for this site, then try again.', 'error');
  try {
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    updateNotificationButton(); if (permission !== 'granted') return toast('Notification permission was not granted.', 'error');
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return toast('Notifications are enabled while Whispr is open. Background push is not supported by this browser.', 'error');
    serviceWorkerRegistration ||= await navigator.serviceWorker.register('/service-worker.js');
    serviceWorkerRegistration = await navigator.serviceWorker.ready;
    const config = await api('/api/push/public-key');
    if (!config.enabled || !config.publicKey) return toast('Foreground notifications are enabled. Background call notifications need VAPID keys configured on the server.', 'error');
    let subscription = await serviceWorkerRegistration.pushManager.getSubscription();
    if (!subscription) subscription = await serviceWorkerRegistration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeVapidKey(config.publicKey) });
    await api('/api/push/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(subscription) });
    pushSubscribed = true; updateNotificationButton(); toast('Background call notifications are enabled on this device.');
  } catch (error) { toast(error.message || 'Could not enable notifications in this browser.', 'error'); }
};
function decodeVapidKey(value) { const normalized = value.replace(/-/g, '+').replace(/_/g, '/'); const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); }
updateNotificationButton();
function updateGroupForm() { const isGroup = selectedUsers.length > 1; $('#group-name').hidden = $('#group-name-label').hidden = !isGroup; $('#create-chat').disabled = !selectedUsers.length; $('#create-chat').textContent = isGroup ? `Create group (${selectedUsers.length})` : 'Start chat'; }
$('#new-chat').onclick = () => { selectedUsers = []; $('#group-name').value = ''; $('#user-picker').value = ''; $('#user-results').innerHTML = ''; updateGroupForm(); $('#new-chat-dialog').showModal(); $('#user-picker').focus(); };
$('#user-picker').addEventListener('input', async () => { const users = await api(`/api/users?q=${encodeURIComponent($('#user-picker').value)}`); $('#user-results').innerHTML = users.map((user) => `<button type="button" class="user-option ${selectedUsers.some((item) => item.id === user.id) ? 'selected' : ''}" data-user-id="${esc(user.id)}" aria-pressed="${selectedUsers.some((item) => item.id === user.id)}">${esc(user.name)} <small>${esc(user.email)}</small></button>`).join('') || '<p>No registered users found.</p>'; document.querySelectorAll('[data-user-id]').forEach((button) => button.onclick = () => { const user = users.find((item) => item.id === button.dataset.userId); selectedUsers = selectedUsers.some((item) => item.id === user.id) ? selectedUsers.filter((item) => item.id !== user.id) : [...selectedUsers, user]; button.classList.toggle('selected', selectedUsers.some((item) => item.id === user.id)); button.setAttribute('aria-pressed', String(selectedUsers.some((item) => item.id === user.id))); updateGroupForm(); }); });
$('#new-chat-form').addEventListener('submit', async (event) => { event.preventDefault(); if (!selectedUsers.length) return; const isGroup = selectedUsers.length > 1; try { const chat = await api('/api/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberIds: selectedUsers.map((item) => item.id), isGroup, name: isGroup ? $('#group-name').value.trim() : '' }) }); $('#new-chat-dialog').close(); await loadChats(); await openChat(chat.id); } catch (error) { toast(error.message, 'error'); } });
const emojiSet = ['😀','😂','🥹','😍','🥳','👍','👎','❤️','🔥','🎉','🙏','👀','🤝','💯','✅','😭','😎','🙌','✨','💬'];
$('#emoji-picker').innerHTML = emojiSet.map((emoji) => `<button type="button" aria-label="Insert ${emoji}">${emoji}</button>`).join('');
$('#emoji-toggle').onclick = () => { $('#emoji-picker').hidden = !$('#emoji-picker').hidden; };
$('#emoji-picker').addEventListener('click', (event) => { const button = event.target.closest('button'); if (!button) return; const input = $('#message-input'); const start = input.selectionStart, end = input.selectionEnd; input.setRangeText(button.textContent, start, end, 'end'); input.focus(); input.dispatchEvent(new Event('input', { bubbles: true })); $('#emoji-picker').hidden = true; });
async function uploadAttachment(file, chatId = activeChat?.id) {
  if (!chatId) return;
  if (file.size > 25 * 1024 * 1024) { toast('Files must be smaller than 25 MB.', 'error'); return; }
  const data = new FormData(); data.append('file', file);
  const button = $('#file-button'); button.disabled = true; button.classList.add('uploading');
  try { const uploaded = await api(`/api/chats/${chatId}/files`, { method: 'POST', body: data }); if (activeChat?.id === chatId) { appendMessage(renderFileMessage(uploaded), 'data-file-id', uploaded.id); await renderFiles(); } }
  catch (error) { toast(error.message, 'error'); }
  finally { button.disabled = !activeChat; button.classList.remove('uploading'); }
}
$('#file-button').onclick = () => activeChat && $('#file-input').click();
$('#file-input').addEventListener('change', async () => { const file = $('#file-input').files[0]; if (file && activeChat) await uploadAttachment(file, activeChat.id); $('#file-input').value = ''; });
$('#voice-record').onclick = async () => {
  if (voiceRecorder?.state === 'recording') { voiceRecorder.stop(); return; }
  if (!activeChat) return;
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const formats = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    const mimeType = formats.find((format) => MediaRecorder.isTypeSupported(format));
    voiceChunks = []; voiceRecorder = new MediaRecorder(voiceStream, mimeType ? { mimeType } : undefined);
    const chatId = activeChat.id; const button = $('#voice-record');
    button.classList.add('recording'); button.setAttribute('aria-label', 'Stop recording and send voice message'); toast('Recording voice message… press the microphone again to send.');
    voiceRecorder.ondataavailable = (event) => { if (event.data.size) voiceChunks.push(event.data); };
    voiceRecorder.onerror = () => { voiceStream?.getTracks().forEach((track) => track.stop()); button.classList.remove('recording'); toast('Voice recording failed.', 'error'); };
    voiceRecorder.onstop = async () => { const blob = new Blob(voiceChunks, { type: voiceRecorder.mimeType || 'audio/webm' }); voiceStream?.getTracks().forEach((track) => track.stop()); voiceStream = null; button.classList.remove('recording'); if (blob.size) { const extension = blob.type.includes('mp4') ? 'm4a' : 'webm'; await uploadAttachment(new File([blob], `voice-message.${extension}`, { type: blob.type }), chatId); } };
    voiceRecorder.start();
  } catch (error) { voiceStream?.getTracks().forEach((track) => track.stop()); voiceStream = null; toast(error.name === 'NotAllowedError' ? 'Allow microphone access to record a voice message.' : error.message, 'error'); }
};
$('#report').onclick = async () => { if (!activeChat) return; const reason = prompt('Why are you reporting this conversation?'); if (reason === null) return; try { await api(`/api/chats/${activeChat.id}/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }); toast('Report sent.'); } catch (error) { toast(error.message, 'error'); } };

async function loadAIPreferences() {
  try {
    const result = await api('/api/ai/preferences'); aiPrefs = result.preferences || { enabled: false }; aiConfigured = result.configured;
    $('#ai-consent').checked = !!aiPrefs.enabled;
    document.querySelectorAll('[data-ai-pref]').forEach((input) => { input.checked = !!aiPrefs[input.dataset.aiPref]; });
    $('#ai-config-status').textContent = aiConfigured ? 'AI provider configured on the server.' : 'AI features unavailable until the server owner configures the provider key.';
    updateAIControls();
  } catch { aiPrefs = { enabled: false }; aiConfigured = false; }
}
$('#profile-button').onclick = async () => { $('#profile-name').value = me.name; $('#profile-bio').value = me.bio || ''; $('#avatar-input').value = ''; $('#profile-error').textContent = ''; await loadAIPreferences(); $('#profile-dialog').showModal(); };
$('#profile-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const prefs = Object.fromEntries([...document.querySelectorAll('[data-ai-pref]')].map((input) => [input.dataset.aiPref, input.checked]));
  const consent = $('#ai-consent').checked;
  if (Object.values(prefs).some(Boolean) && !consent) { $('#profile-error').textContent = 'Review and accept the AI processing disclosure before enabling features.'; return; }
  try {
    me = await api('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('#profile-name').value, bio: $('#profile-bio').value }) });
    const image = $('#avatar-input').files[0]; if (image) { const data = new FormData(); data.append('avatar', image); me = await api('/api/me/avatar', { method: 'POST', body: data }); }
    const saved = await api('/api/ai/preferences', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...prefs, enabled: consent, consent }) }); aiPrefs = saved.preferences; aiConfigured = saved.configured;
    $('#profile-dialog').close(); $('#me-name').textContent = me.name; $('#me-bio').textContent = me.bio || 'Available'; $('#me-initial').innerHTML = avatarMarkup(me); await loadChats(); updateAIControls(); if (activeChat) await openChat(activeChat.id);
  } catch (error) { $('#profile-error').textContent = error.message; }
});

function renderAIList(target, items, emptyText) {
  const list = document.createElement('ul');
  list.className = 'ai-result-list';
  if (Array.isArray(items) && items.length) {
    for (const item of items) {
      const row = document.createElement('li');
      row.textContent = String(item);
      list.append(row);
    }
  } else {
    const empty = document.createElement('p');
    empty.className = 'ai-result-empty';
    empty.textContent = emptyText || 'None identified in the available messages.';
    target.append(empty);
    return;
  }
  target.append(list);
}
function renderAISection(target, title, items, emptyText) {
  const section = document.createElement('section');
  section.className = 'ai-result-section';
  const heading = document.createElement('h3');
  heading.textContent = title;
  section.append(heading);
  renderAIList(section, items, emptyText);
  target.append(section);
}
function showAIToolResult(value) {
  const output = $('#ai-results');
  output.replaceChildren();
  if (typeof value === 'string') {
    output.textContent = value;
    return;
  }
  if (!value || typeof value !== 'object') {
    output.textContent = 'No result was returned.';
    return;
  }

  const summary = value.summary && typeof value.summary === 'object' ? value.summary : null;
  if (summary) {
    const heading = document.createElement('h3');
    heading.className = 'ai-result-title';
    heading.textContent = 'Conversation summary';
    output.append(heading);
    if (Number.isFinite(value.messageCount)) {
      const meta = document.createElement('p');
      meta.className = 'ai-result-meta';
      meta.textContent = 'Based on ' + value.messageCount + ' recent message' + (value.messageCount === 1 ? '' : 's');
      output.append(meta);
    }
    renderAISection(output, 'Topics discussed', summary.topics);
    renderAISection(output, 'Decisions', summary.decisions);
    renderAISection(output, 'Open questions', summary.openQuestions);
    renderAISection(output, 'Action items', summary.tasks);
    renderAISection(output, 'Deadlines', summary.deadlines);
    renderAISection(output, 'Key points', summary.keyPoints);
    if (value.limitedContext || summary.limitedContext) {
      const note = document.createElement('p');
      note.className = 'ai-result-note';
      note.textContent = 'This summary uses a limited recent-message window and may not include earlier conversation details.';
      output.append(note);
    }
    return;
  }

  if (Array.isArray(value.actions)) {
    const heading = document.createElement('h3');
    heading.className = 'ai-result-title';
    heading.textContent = 'Action items';
    output.append(heading);
    if (!value.actions.length) {
      const empty = document.createElement('p');
      empty.className = 'ai-result-empty';
      empty.textContent = 'No clear action items were found in the available messages.';
      output.append(empty);
      return;
    }
    for (const item of value.actions) {
      const card = document.createElement('article');
      card.className = 'ai-action-card';
      const action = document.createElement('p');
      action.className = 'ai-action-text';
      action.textContent = item.action || 'Unspecified action';
      card.append(action);
      const details = [item.owner && 'Owner: ' + item.owner, item.dueDate && 'Due: ' + item.dueDate].filter(Boolean);
      if (details.length) {
        const meta = document.createElement('p');
        meta.className = 'ai-result-meta';
        meta.textContent = details.join(' · ');
        card.append(meta);
      }
      if (Array.isArray(item.evidence) && item.evidence.length) {
        const evidence = document.createElement('p');
        evidence.className = 'ai-result-evidence';
        evidence.textContent = 'Evidence: ' + item.evidence.join(' · ');
        card.append(evidence);
      }
      if (item.uncertain) {
        const note = document.createElement('p');
        note.className = 'ai-result-note';
        note.textContent = 'This action is uncertain and should be confirmed.';
        card.append(note);
      }
      output.append(card);
    }
    return;
  }

  if (Array.isArray(value.links)) {
    const heading = document.createElement('h3');
    heading.className = 'ai-result-title';
    heading.textContent = 'Link safety assessment';
    output.append(heading);
    for (const item of value.links) {
      const card = document.createElement('article');
      card.className = 'ai-link-result ' + (item.severity || 'low');
      const top = document.createElement('div');
      top.className = 'ai-link-result-top';
      const status = document.createElement('strong');
      status.textContent = (item.severity || 'unknown').toUpperCase() + ' · ' + Number(item.riskScore || 0) + '/100';
      const host = document.createElement('span');
      host.textContent = item.hostname || item.url || 'Unrecognized link';
      top.append(status, host);
      card.append(top);
      const url = document.createElement('p');
      url.className = 'ai-link-url';
      url.textContent = item.url || '';
      card.append(url);
      const explanation = document.createElement('p');
      explanation.textContent = item.explanation || 'No explanation was returned.';
      card.append(explanation);
      if (Array.isArray(item.indicators) && item.indicators.length) {
        const indicators = document.createElement('p');
        indicators.className = 'ai-result-evidence';
        indicators.textContent = 'Indicators: ' + item.indicators.map((entry) => String(entry).replace(/_/g, ' ')).join(' · ');
        card.append(indicators);
      }
      if (Array.isArray(item.recommendations) && item.recommendations.length) {
        renderAISection(card, 'Recommended precautions', item.recommendations);
      }
      output.append(card);
    }
    const note = document.createElement('p');
    note.className = 'ai-result-note';
    note.textContent = value.note || 'This is an advisory assessment, not proof that a link is safe or malicious.';
    output.append(note);
    return;
  }
  output.textContent = JSON.stringify(value, null, 2);
}
let lastSmartReplyKey = '';
async function maybeLoadSmartReplies(chatId, messageId) {
  if (!aiConfigured || !aiPrefs.enabled || !aiPrefs.smartReplies || chatId !== activeChat?.id || !messageId) return;
  const key = chatId + ':' + messageId; if (lastSmartReplyKey === key) return; lastSmartReplyKey = key;
  try {
    const result = await api('/api/ai/smart-replies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chatId }) });
    if (chatId !== activeChat?.id || key !== lastSmartReplyKey) return;
    const tray = $('#smart-reply-tray'); tray.replaceChildren();
    result.replies.forEach((reply) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = reply; button.onclick = () => { $('#message-input').value = reply; $('#message-input').focus(); tray.hidden = true; }; tray.append(button); });
    tray.hidden = !result.replies.length;
  } catch (error) { if (error.status !== 403) console.warn('Smart reply suggestions unavailable.'); }
}
async function runAITool(button, url, payload = {}) {
  if (!activeChat && !url.startsWith('/api/ai/search')) return toast('Open a conversation first.', 'error');
  button.disabled = true; $('#ai-results').textContent = 'Working…';
  try { const result = await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); showAIToolResult(result); return result; }
  catch (error) { $('#ai-results').textContent = error.message; toast(error.message, 'error'); }
  finally { updateAIControls(); }
}
$('#ai-summarize').onclick = () => runAITool($('#ai-summarize'), '/api/ai/conversations/' + encodeURIComponent(activeChat.id) + '/summarize');
$('#ai-actions').onclick = () => runAITool($('#ai-actions'), '/api/ai/conversations/' + encodeURIComponent(activeChat.id) + '/actions');
$('#ai-search').onclick = async () => {
  const result = await runAITool($('#ai-search'), '/api/ai/search', { query: $('#ai-search-query').value.trim() });
  if (!result) return;
  const output = $('#ai-results'); output.replaceChildren();
  if (!result.results.length) { output.textContent = 'No relevant messages were found in the searched recent message set.'; return; }
  for (const hit of result.results) { const button = document.createElement('button'); button.type = 'button'; button.className = 'ai-search-result'; button.textContent = hit.conversation + ' · ' + hit.sender + ' · ' + clock(hit.timestamp) + ' — ' + hit.text; button.onclick = async () => { $('#ai-dialog').close(); await openChat(hit.chatId); const row = $('#messages [data-message-id="' + CSS.escape(hit.id) + '"]'); row?.scrollIntoView({ behavior: 'smooth', block: 'center' }); row?.classList.add('ai-search-highlight'); setTimeout(() => row?.classList.remove('ai-search-highlight'), 1800); }; output.append(button); }
};
$('#ai-smart-replies').onclick = async () => {
  const result = await runAITool($('#ai-smart-replies'), '/api/ai/smart-replies', { chatId: activeChat?.id }); if (!result) return;
  const tray = $('#smart-reply-tray'); tray.replaceChildren();
  result.replies.forEach((reply) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = reply; button.onclick = () => { $('#message-input').value = reply; $('#message-input').focus(); tray.hidden = true; }; tray.append(button); });
  tray.hidden = !result.replies.length; if (!result.replies.length) showAIToolResult('No reply suggestions for the latest conversation context.');
};
$('#ai-close').onclick = () => $('#ai-dialog').close();
$('#rewrite-draft').onclick = async () => {
  const draft = $('#message-input').value.trim(); if (!draft) return toast('Write a draft first.', 'error');
  const tone = prompt('Rewrite tone: professional, friendly, concise, or polite', 'friendly'); if (!tone) return;
  const result = await runAITool($('#rewrite-draft'), '/api/ai/rewrite', { text: draft, tone });
  if (result?.text && confirm('Replace your draft with this AI rewrite?')) $('#message-input').value = result.text;
};

function stopRinging() { clearInterval(ringTimer); ringTimer = null; if (callNotification) { callNotification.close(); callNotification = null; } }
function playRingPattern() {
  if (!ringAudioContext) { const AudioContextClass = window.AudioContext || window.webkitAudioContext; if (AudioContextClass) ringAudioContext = new AudioContextClass(); }
  if (!ringAudioContext) return;
  ringAudioContext.resume().then(() => {
    if (!incomingCall) return;
    const now = ringAudioContext.currentTime;
    [0, 0.24].forEach((offset) => { const oscillator = ringAudioContext.createOscillator(); const gain = ringAudioContext.createGain(); oscillator.type = 'sine'; oscillator.frequency.value = 760; gain.gain.setValueAtTime(0.0001, now + offset); gain.gain.exponentialRampToValueAtTime(0.12, now + offset + 0.025); gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.2); oscillator.connect(gain).connect(ringAudioContext.destination); oscillator.start(now + offset); oscillator.stop(now + offset + 0.22); });
  }).catch(() => {});
}
function startRinging() {
  stopRinging(); playRingPattern(); ringTimer = setInterval(playRingPattern, 1800);
  if (!pushSubscribed && 'Notification' in window && Notification.permission === 'granted') {
    const { from, video, type, groupName } = incomingCall;
    callNotification = new Notification(type === 'group' ? `Group ${video ? 'video' : 'voice'} call` : video ? 'Incoming video call' : 'Incoming voice call', { body: type === 'group' ? `${from.name} started a call in ${groupName}` : `${from.name} is calling you`, tag: `whispr-call-${incomingCall.callId}`, renotify: true, requireInteraction: true });
    callNotification.onclick = () => { window.focus(); if (incomingCall && !$('#incoming-call-dialog').open) $('#incoming-call-dialog').showModal(); callNotification?.close(); };
    callNotification.onclose = () => { callNotification = null; };
  }
}
function dismissIncomingCall(notifyCaller = true) {
  if (!incomingCall) return;
  const { callId, chatId, from, timeout, type } = incomingCall; clearTimeout(timeout); incomingCall = null; stopRinging();
  if ($('#incoming-call-dialog').open) $('#incoming-call-dialog').close();
  if (callId && 'serviceWorker' in navigator) navigator.serviceWorker.getRegistration('/').then((registration) => registration?.getNotifications({ tag: `whispr-call-${callId}` }).then((notifications) => notifications.forEach((notification) => notification.close()))).catch(() => {});
  if (notifyCaller) socket.emit(type === 'group' ? 'group-call:decline' : 'call:end', type === 'group' ? { callId } : { chatId, callId, targetId: from.id });
}
function stopCall(notify = true) { if (!call) return; clearTimeout(call.ringTimer); if (call.isGroup && notify) socket.emit('group-call:leave', { callId: call.callId }); else if (notify && call.peerId) socket.emit('call:end', { chatId: call.chatId, callId: call.callId, targetId: call.peerId }); call.stream?.getTracks().forEach((track) => track.stop()); call.pc?.close(); call.peers?.forEach((peer) => peer.pc.close()); call = null; $('#local-video').srcObject = null; $('#remote-video').srcObject = null; $('#group-participants').replaceChildren(); $('#call-dialog').classList.remove('has-remote-video', 'group-call'); if (document.fullscreenElement === $('#call-dialog')) document.exitFullscreen().catch(() => {}); if ($('#call-dialog').open) $('#call-dialog').close(); }
function setCallControl(selector, icon, label, pressed = false) { const button = $(selector); button.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i><span>${label}</span>`; button.setAttribute('aria-label', label); button.setAttribute('title', label); button.setAttribute('aria-pressed', String(pressed)); }
async function prepareCall(video) { if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Calls require HTTPS and a browser with camera/microphone support.'); const config = await api('/api/rtc-config'); const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video }); const pc = new RTCPeerConnection(config); call = { chatId: activeChat.id, peerId: null, callId: null, stream, pc, pendingIce: [] }; $('#call-dialog').classList.remove('group-call'); $('#call-avatar').hidden = false; $('#call-dialog').classList.toggle('audio-only', !video); $('#call-dialog').classList.remove('has-remote-video'); $('#remote-video').srcObject = null; $('#toggle-camera').hidden = !video; setCallControl('#toggle-camera', 'fa-video', 'Camera off'); setCallControl('#toggle-mic', 'fa-microphone', 'Mute'); $('#toggle-fullscreen').hidden = false; stream.getTracks().forEach((track) => pc.addTrack(track, stream)); pc.ontrack = (event) => { if (event.streams[0]) { $('#remote-video').srcObject = event.streams[0]; $('#call-dialog').classList.add('has-remote-video'); } }; pc.onicecandidate = (event) => { if (event.candidate && call?.peerId) socket.emit('call:ice', { chatId: call.chatId, callId: call.callId, targetId: call.peerId, candidate: event.candidate }); }; pc.onconnectionstatechange = () => { if (pc.connectionState === 'connected') $('#call-title').textContent = 'Connected'; if (pc.connectionState === 'failed') toast('Call could not connect. Add a TURN service in deployment settings for this network.', 'error'); }; $('#local-video').srcObject = stream; $('#call-dialog').showModal(); }
async function startCall(video) { if (!activeChat) return; if (activeChat.isGroup) return startGroupCall(video); try { const peer = activeChat.participants.find((person) => person.id !== me.id); await prepareCall(video); call.peerId = peer.id; call.callId = crypto.randomUUID(); $('#call-avatar').innerHTML = avatarMarkup(peer); $('#call-title').textContent = `Calling ${peer.name}…`; call.ringTimer = setTimeout(() => { stopCall(); toast('No answer.'); }, 45000); const offer = await call.pc.createOffer(); await call.pc.setLocalDescription(offer); socket.emit('call:offer', { chatId: call.chatId, callId: call.callId, targetId: call.peerId, offer, video }); } catch (error) { stopCall(false); toast(error.name === 'NotAllowedError' ? 'Allow camera and microphone access in the browser, then try again.' : error.message, 'error'); } }
function groupParticipantTile(userId, user) {
  const tile = document.createElement('div'); tile.className = 'group-call-tile'; tile.dataset.participantId = userId;
  const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = userId === me.id;
  const avatar = document.createElement('span'); avatar.className = 'group-call-avatar'; avatar.innerHTML = avatarMarkup(user);
  const name = document.createElement('span'); name.className = 'group-call-name'; name.textContent = userId === me.id ? `${user.name} · You` : user.name;
  tile.append(video, avatar, name); return tile;
}
function renderGroupCallParticipants() {
  if (!call?.isGroup) return;
  const root = $('#group-participants'); const fragment = document.createDocumentFragment();
  for (const [userId, user] of call.participants) {
    let tile = root.querySelector(`[data-participant-id="${CSS.escape(userId)}"]`);
    if (!tile) tile = groupParticipantTile(userId, user);
    const peer = call.peers.get(userId); const stream = userId === me.id ? call.stream : peer?.stream;
    const video = tile.querySelector('video');
    if (stream) { if (video.srcObject !== stream) video.srcObject = stream; tile.classList.toggle('has-video', call.video && stream.getVideoTracks().some((track) => track.enabled && track.readyState === 'live')); }
    else { video.srcObject = null; tile.classList.remove('has-video'); }
    fragment.append(tile);
  }
  root.replaceChildren(fragment);
  $('#call-title').textContent = `${call.groupName} · ${call.participants.size} participant${call.participants.size === 1 ? '' : 's'}`;
}
async function createGroupPeer(user) {
  if (!call?.isGroup || user.id === me.id) return null;
  const existing = call.peers.get(user.id); if (existing) return existing;
  const peer = { pc: new RTCPeerConnection(call.rtcConfig), stream: null, pendingIce: [] }; call.peers.set(user.id, peer);
  call.stream.getTracks().forEach((track) => peer.pc.addTrack(track, call.stream));
  peer.pc.ontrack = (event) => { peer.stream = event.streams[0] || peer.stream || new MediaStream([event.track]); renderGroupCallParticipants(); };
  peer.pc.onicecandidate = (event) => { if (event.candidate && call?.isGroup) socket.emit('group-call:ice', { callId: call.callId, targetId: user.id, candidate: event.candidate }); };
  peer.pc.onconnectionstatechange = () => { if (peer.pc.connectionState === 'failed') toast(`Could not connect to ${user.name}. Check network or TURN settings.`, 'error'); };
  return peer;
}
async function sendGroupOffer(user) {
  const peer = await createGroupPeer(user); if (!peer || !call?.isGroup) return;
  const offer = await peer.pc.createOffer(); await peer.pc.setLocalDescription(offer);
  socket.emit('group-call:offer', { callId: call.callId, targetId: user.id, offer });
}
async function prepareGroupCall(video, groupCallId) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Calls require HTTPS and a browser with camera/microphone support.');
  const rtcConfig = await api('/api/rtc-config'); const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
  call = { isGroup: true, chatId: activeChat.id, callId: groupCallId, groupName: activeChat.title, video, stream, rtcConfig, peers: new Map(), participants: new Map([[me.id, me]]) };
  const dialog = $('#call-dialog'); dialog.classList.add('group-call'); dialog.classList.toggle('audio-only', !video); dialog.classList.remove('has-remote-video');
  $('#remote-video').srcObject = null; $('#call-avatar').hidden = true; $('#group-participants').replaceChildren();
  $('#toggle-camera').hidden = !video; setCallControl('#toggle-camera', 'fa-video', 'Camera off'); setCallControl('#toggle-mic', 'fa-microphone', 'Mute'); $('#toggle-fullscreen').hidden = false;
  $('#local-video').srcObject = null; renderGroupCallParticipants(); dialog.showModal();
}
async function startGroupCall(video) {
  if (!activeChat?.isGroup || call) return;
  const chat = activeChat; const callId = crypto.randomUUID();
  try { await prepareGroupCall(video, callId); socket.emit('group-call:start', { chatId: chat.id, callId, video }); }
  catch (error) { stopCall(false); toast(error.name === 'NotAllowedError' ? 'Allow camera and microphone access, then try again.' : error.message, 'error'); }
}
async function acceptGroupCall(incoming) {
  try {
    activeChat = chats.find((item) => item.id === incoming.chatId) || null;
    if (!activeChat?.isGroup) throw new Error('This group is no longer available.');
    $('.chat-shell').classList.add('chat-open'); renderHeader(); renderChats();
    await prepareGroupCall(incoming.video, incoming.callId); socket.emit('group-call:join', { callId: incoming.callId });
  } catch (error) { socket.emit('group-call:decline', { callId: incoming.callId }); stopCall(false); toast(error.name === 'NotAllowedError' ? 'Allow camera and microphone access, then answer again.' : error.message, 'error'); }
}
socket.on('group-call:participants', async ({ callId, participants }) => {
  if (!call?.isGroup || call.callId !== callId) return;
  for (const person of participants) call.participants.set(person.id, person);
  renderGroupCallParticipants();
  await Promise.all(participants.filter((person) => person.id !== me.id).map(sendGroupOffer));
});
socket.on('group-call:participant-joined', ({ callId, participant }) => {
  if (!call?.isGroup || call.callId !== callId || participant.id === me.id) return;
  call.participants.set(participant.id, participant); renderGroupCallParticipants();
});
socket.on('group-call:offer', async ({ callId, from, offer }) => {
  if (!call?.isGroup || call.callId !== callId) return;
  const user = call.participants.get(from); if (!user) return;
  try { const peer = await createGroupPeer(user); await peer.pc.setRemoteDescription(offer); for (const candidate of peer.pendingIce) await peer.pc.addIceCandidate(candidate); peer.pendingIce = []; const answer = await peer.pc.createAnswer(); await peer.pc.setLocalDescription(answer); socket.emit('group-call:answer', { callId, targetId: from, answer }); }
  catch (error) { toast(`Could not connect to ${user.name}: ${error.message}`, 'error'); }
});
socket.on('group-call:answer', async ({ callId, from, answer }) => {
  const peer = call?.isGroup && call.callId === callId ? call.peers.get(from) : null;
  if (!peer) return;
  try { await peer.pc.setRemoteDescription(answer); for (const candidate of peer.pendingIce) await peer.pc.addIceCandidate(candidate); peer.pendingIce = []; } catch (error) { toast(`Could not finish connecting: ${error.message}`, 'error'); }
});
socket.on('group-call:ice', async ({ callId, from, candidate }) => {
  const peer = call?.isGroup && call.callId === callId ? call.peers.get(from) : null;
  if (!peer) return;
  if (!peer.pc.remoteDescription) peer.pendingIce.push(candidate); else try { await peer.pc.addIceCandidate(candidate); } catch (error) { console.warn('Group ICE candidate was rejected', error); }
});
socket.on('group-call:participant-left', ({ callId, userId }) => {
  if (!call?.isGroup || call.callId !== callId) return;
  call.peers.get(userId)?.pc.close(); call.peers.delete(userId); call.participants.delete(userId); renderGroupCallParticipants();
});
socket.on('group-call:declined', ({ callId, user }) => { if (call?.isGroup && call.callId === callId) toast(`${user.name} declined the group call.`); });
socket.on('group-call:already-active', (active) => {
  if (!call?.isGroup || call.chatId !== active.chatId) return;
  call.callId = active.callId; call.groupName = active.groupName; call.video = active.video;
  if (!active.video) call.stream.getVideoTracks().forEach((track) => { track.enabled = false; track.stop(); });
  $('#call-dialog').classList.toggle('audio-only', !active.video); $('#toggle-camera').hidden = !call.stream.getVideoTracks().some((track) => track.readyState === 'live'); renderGroupCallParticipants();
  socket.emit('group-call:join', { callId: active.callId });
});
socket.on('group-call:error', ({ callId, message }) => { if (!call?.isGroup || (callId && call.callId !== callId)) return; stopCall(false); toast(message || 'Group call could not start.', 'error'); });
socket.on('group-call:answered-elsewhere', ({ callId }) => { if (incomingCall?.type === 'group' && incomingCall.callId === callId) dismissIncomingCall(false); });
function showIncomingCall({ type = 'direct', callId, chatId, offer, video, from, groupName }) {
  if (incomingCall?.callId === callId) return;
  if (!chats.some((item) => item.id === chatId) || call || incomingCall) return socket.emit(type === 'group' ? 'group-call:decline' : 'call:end', type === 'group' ? { callId } : { chatId, callId, targetId: from.id });
  incomingCall = { type, callId, chatId, offer, video, from, groupName };
  $('#incoming-call-kind').textContent = type === 'group' ? `INCOMING GROUP ${video ? 'VIDEO' : 'VOICE'} CALL` : video ? 'INCOMING VIDEO CALL' : 'INCOMING VOICE CALL';
  $('#incoming-call-title').textContent = type === 'group' ? groupName : from.name;
  $('#incoming-call-avatar').innerHTML = avatarMarkup(from);
  $('#incoming-call-status').textContent = type === 'group' ? `${from.name} started the call · answering will ask for ${video ? 'camera and microphone' : 'microphone'} access` : `${video ? 'Video' : 'Voice'} call · answering will ask for ${video ? 'camera and microphone' : 'microphone'} access`;
  $('#incoming-call-dialog').showModal(); startRinging();
  incomingCall.timeout = setTimeout(() => { dismissIncomingCall(true); toast(type === 'group' ? 'Missed group call from ' + groupName : 'Missed call from ' + from.name); }, 45000);
}
socket.on('call:incoming', showIncomingCall);
socket.on('group-call:incoming', (payload) => showIncomingCall({ ...payload, type: 'group' }));
async function acceptIncomingCall() {
  if (!incomingCall) return;
  const incoming = incomingCall; clearTimeout(incoming.timeout); incomingCall = null; stopRinging();
  if ($('#incoming-call-dialog').open) $('#incoming-call-dialog').close();
  if (incoming.type === 'group') return acceptGroupCall(incoming);
  try {
    activeChat = chats.find((item) => item.id === incoming.chatId) || null;
    if (!activeChat) throw new Error('This conversation is no longer available.');
    $('#call-avatar').innerHTML = avatarMarkup(incoming.from);
    $('.chat-shell').classList.add('chat-open');
    renderHeader(); renderChats();
    await prepareCall(incoming.video); call.peerId = incoming.from.id; call.callId = incoming.callId;
    call.pendingIce = earlyIce.get(`${incoming.chatId}:${incoming.from.id}`) || []; earlyIce.delete(`${incoming.chatId}:${incoming.from.id}`);
    await call.pc.setRemoteDescription(incoming.offer);
    for (const candidate of call.pendingIce) await call.pc.addIceCandidate(candidate);
    call.pendingIce = [];
    const answer = await call.pc.createAnswer(); await call.pc.setLocalDescription(answer);
    socket.emit('call:answer', { chatId: incoming.chatId, callId: incoming.callId, targetId: incoming.from.id, answer });
    $('#call-title').textContent = `In call with ${incoming.from.name}`;
  } catch (error) { socket.emit('call:end', { chatId: incoming.chatId, callId: incoming.callId, targetId: incoming.from.id }); stopCall(false); toast(error.name === 'NotAllowedError' ? 'Allow camera and microphone access, then answer again.' : error.message, 'error'); }
}
$('#accept-call').onclick = acceptIncomingCall;
$('#decline-call').onclick = () => dismissIncomingCall(true);
$('#incoming-call-dialog').addEventListener('cancel', (event) => { event.preventDefault(); dismissIncomingCall(true); });
socket.on('call:answer', async ({ chatId, callId, answer, from }) => { if (!call || call.chatId !== chatId || call.peerId !== from || (call.callId && callId && call.callId !== callId)) return; try { clearTimeout(call.ringTimer); await call.pc.setRemoteDescription(answer); for (const candidate of call.pendingIce) await call.pc.addIceCandidate(candidate); call.pendingIce = []; $('#call-title').textContent = 'Connecting…'; } catch (error) { toast(`Could not establish call: ${error.message}`, 'error'); stopCall(false); } });
socket.on('call:ice', async ({ chatId, candidate, from }) => { if (!call || call.chatId !== chatId || call.peerId !== from) { const key = `${chatId}:${from}`; earlyIce.set(key, [...(earlyIce.get(key) || []), candidate]); setTimeout(() => earlyIce.delete(key), 60000); return; } if (!call.pc.remoteDescription) call.pendingIce.push(candidate); else try { await call.pc.addIceCandidate(candidate); } catch (error) { console.warn('ICE candidate was rejected', error); } });
socket.on('call:end', ({ chatId, callId, from }) => { if (incomingCall?.chatId === chatId && incomingCall.from.id === from && (!callId || incomingCall.callId === callId)) { dismissIncomingCall(false); toast('Caller ended the call.'); } if (call?.chatId === chatId && call.peerId === from && (!callId || call.callId === callId)) { stopCall(false); toast('Call ended.'); } });
socket.on('call:answered-elsewhere', ({ chatId, callId, from }) => { if (incomingCall?.chatId === chatId && incomingCall.from.id === from && (!callId || incomingCall.callId === callId)) dismissIncomingCall(false); });
$('#end-call').onclick = () => stopCall();
$('#toggle-mic').onclick = () => { const track = call?.stream.getAudioTracks()[0]; if (!track) return; track.enabled = !track.enabled; setCallControl('#toggle-mic', track.enabled ? 'fa-microphone' : 'fa-microphone-slash', track.enabled ? 'Mute' : 'Unmute', !track.enabled); };
$('#toggle-camera').onclick = () => { const track = call?.stream.getVideoTracks()[0]; if (!track) return; track.enabled = !track.enabled; setCallControl('#toggle-camera', track.enabled ? 'fa-video' : 'fa-video-slash', track.enabled ? 'Camera off' : 'Camera on', !track.enabled); renderGroupCallParticipants(); };
$('#toggle-fullscreen').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('#call-dialog').requestFullscreen(); } catch { toast('Fullscreen is not available in this browser.', 'error'); } };
document.addEventListener('fullscreenchange', () => { const enabled = !!document.fullscreenElement; setCallControl('#toggle-fullscreen', enabled ? 'fa-compress' : 'fa-expand', enabled ? 'Exit fullscreen' : 'Fullscreen', enabled); });
$('#call-dialog').addEventListener('cancel', () => stopCall());
let swipeStart = null;
document.addEventListener('touchstart', (event) => { const touch = event.changedTouches[0]; swipeStart = { x: touch.clientX, y: touch.clientY }; }, { passive: true });
document.addEventListener('touchend', (event) => { if (!swipeStart || !$('.chat-shell').classList.contains('chat-open')) return; const touch = event.changedTouches[0]; const dx = touch.clientX - swipeStart.x; const dy = Math.abs(touch.clientY - swipeStart.y); if (swipeStart.x < 36 && dx > 90 && dy < 70) $('.chat-shell').classList.remove('chat-open'); swipeStart = null; }, { passive: true });

(async () => {
  try {
    me = await api('/api/me'); $('#me-name').textContent = me.name; $('#me-bio').textContent = me.bio || 'Available'; $('#me-initial').innerHTML = avatarMarkup(me); await loadAIPreferences(); await loadChats();
    if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && Notification.permission === 'granted') {
      serviceWorkerRegistration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await serviceWorkerRegistration?.pushManager.getSubscription();
      pushSubscribed = !!subscription;
      if (subscription) await api('/api/push/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(subscription) });
      updateNotificationButton();
    }
    const notificationCallId = new URLSearchParams(location.search).get('callId');
    if (notificationCallId) {
      history.replaceState(null, '', location.pathname);
      const pending = await api(`/api/calls/pending/${encodeURIComponent(notificationCallId)}`);
      showIncomingCall(pending);
    }
  } catch (error) { toast(error.message, 'error'); }
})();
