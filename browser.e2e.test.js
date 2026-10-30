import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';
import { getBrowserE2EConfig } from './browser-e2e-config.js';

const browserConfig = getBrowserE2EConfig();
const browserTest = (name, options, callback) => test(name, { ...options, skip: browserConfig.browserSkipReason }, callback);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function waveFile(durationSeconds = 1) {
  const sampleRate = 16000; const samples = Math.floor(sampleRate * durationSeconds); const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) data.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / sampleRate) * 3500), index * 2);
  const header = Buffer.alloc(44); header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8); header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

browserTest('Whispr browser journeys with synthetic users and fake media devices', { timeout: 240_000 }, async (t) => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'whispr-browser-e2e-'));
  const port = 3000;
  const origin = `http://localhost:${port}`;
  const existingServer = await fetch(origin).catch(() => null);
  assert.equal(existingServer, null, 'Port 3000 is already serving an app; stop it before running the isolated browser test.');
  const secret = 'browser-integration-only-jwt-secret-0123456789';
  const bootstrap = 'browser-integration-only-admin-token-0123456789';
  const { aiProvider, aiCredentialVariable, aiRequested: aiBrowserRequested, aiBrowserOptIn, aiModel, aiSkipReason } = browserConfig;
  const env = { ...process.env, NODE_ENV: 'production', PORT: String(port), JWT_SECRET: secret, ADMIN_BOOTSTRAP_TOKEN: bootstrap, DATABASE_URL: '', AI_ENABLED: aiBrowserOptIn ? 'true' : 'false', AI_PROVIDER: aiProvider, AI_MODEL: aiModel, DB_FILE: path.join(workDir, 'state.json'), UPLOAD_DIR: path.join(workDir, 'uploads'), AUTH_REGISTER_IP_LIMIT: '100', AUTH_LOGIN_IP_LIMIT: '500' };
  if (aiBrowserRequested && !aiCredentialVariable) assert.fail('RUN_BROWSER_AI_E2E=true requires AI_PROVIDER=gemini, AI_PROVIDER=openrouter, or AI_PROVIDER=openai.');
  const server = spawn(process.execPath, ['server.js'], { cwd: process.cwd(), env, stdio: 'ignore' });
  let browser;
  const contexts = [];
  const diagnostics = []; const apiResponses = [];
  t.after(async () => {
    for (const context of contexts) await context.close().catch(() => {});
    await browser?.close().catch(() => {});
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => server.once('exit', resolve)), wait(5000)]);
      if (server.exitCode === null) server.kill('SIGKILL');
    }
    await rm(workDir, { recursive: true, force: true });
  });
  for (let index = 0; index < 100; index += 1) {
    if (server.exitCode !== null) throw new Error('The isolated browser test server exited during startup.');
    try { if ((await fetch(origin)).ok) break; } catch {}
    await wait(100);
    if (index === 99) throw new Error('The isolated browser test server did not start on localhost:3000.');
  }
  browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const newUser = async (name, email, adminToken = '') => {
    const context = await browser.newContext({ permissions: ['camera', 'microphone', 'notifications'], viewport: { width: 1440, height: 900 } }); contexts.push(context);
    const page = await context.newPage();
    page.on('pageerror', (error) => diagnostics.push(`pageerror:${error.name}`));
    page.on('console', (message) => { if (message.type() === 'error') diagnostics.push(`console:${message.text().slice(0, 100)}`); });
    page.on('response', (response) => { if (response.url().startsWith(origin)) { const route = new URL(response.url()).pathname; apiResponses.push({ route, status: response.status() }); if (response.status() >= 500) diagnostics.push(`http-${response.status()}:${route}`); } });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('#switch-auth').click();
    await page.locator('#name').fill(name);
    await page.locator('#email').fill(email);
    await page.locator('#password').fill('browser-test-password-123');
    if (adminToken) await page.locator('#admin-bootstrap-token').fill(adminToken);
    await page.locator('#auth-submit').click();
    await page.waitForURL('**/interface.html');
    await page.locator('#me-name').waitFor();
    return { context, page };
  };
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const alice = await newUser('Synthetic Alice', `alice-${tag}@example.test`, bootstrap);
  const bob = await newUser('Synthetic Bob', `bob-${tag}@example.test`);
  const carol = await newUser('Synthetic Carol', `carol-${tag}@example.test`);
  const dave = await newUser('Synthetic Dave', `dave-${tag}@example.test`);

  await alice.page.locator('#profile-button').click();
  await alice.page.locator('#profile-name').fill('Alice Profile Updated');
  await alice.page.locator('#profile-bio').fill('Synthetic browser test profile');
  await alice.page.locator('#ai-consent').check();
  for (const feature of ['smartReplies', 'scamAnalysis', 'linkAnalysis', 'summaries', 'translation', 'rewriting', 'actionExtraction', 'naturalSearch']) await alice.page.locator(`[data-ai-pref="${feature}"]`).check();
  await alice.page.locator('#profile-form button[type="submit"], #profile-form menu button:not([value="cancel"])').last().click();
  await alice.page.locator('#profile-dialog').waitFor({ state: 'hidden' });
  assert.equal(await alice.page.locator('#me-name').textContent(), 'Alice Profile Updated');
  const savedAIPreferences = await alice.page.evaluate(async () => (await (await fetch('/api/ai/preferences', { headers: { Authorization: `Bearer ${localStorage.getItem('whispr_token')}` } })).json()).preferences);
  assert.equal(savedAIPreferences.enabled, true, 'AI consent did not persist through the profile UI');
  for (const feature of ['smartReplies', 'scamAnalysis', 'linkAnalysis', 'summaries', 'translation', 'rewriting', 'actionExtraction', 'naturalSearch']) assert.equal(savedAIPreferences[feature], true, `AI preference ${feature} did not persist`);
  if (aiBrowserOptIn) {
    const status = await alice.page.evaluate(async () => (await (await fetch('/api/ai/status', { headers: { Authorization: `Bearer ${localStorage.getItem('whispr_token')}` } })).json()));
    assert.equal(status.configured, true, 'real AI provider is not configured in the isolated backend');
    assert.equal(status.provider, aiProvider, 'isolated backend selected a different provider');
    assert.equal(status.model, aiModel, 'isolated backend selected a different model');
  }
  await alice.page.reload(); await alice.page.locator('#me-name').waitFor();
  assert.equal(await alice.page.locator('#me-bio').textContent(), 'Synthetic browser test profile');
  await alice.page.locator('#logout').click(); await alice.page.waitForURL('**/login.html');
  await alice.page.locator('#email').fill(`alice-${tag}@example.test`); await alice.page.locator('#password').fill('browser-test-password-123'); await alice.page.locator('#auth-submit').click(); await alice.page.waitForURL('**/interface.html');

  await alice.page.locator('#new-chat').click();
  await alice.page.locator('#user-picker').fill('Synthetic Bob');
  await alice.page.locator('[data-user-id]').first().click();
  await alice.page.locator('#create-chat').click();
  await alice.page.locator('#message-input').waitFor({ state: 'visible' });
  await bob.page.waitForTimeout(250);
  const directChatId = await alice.page.locator('#chat-list [data-chat-id]').first().getAttribute('data-chat-id');
  await bob.page.locator(`#chat-list [data-chat-id="${directChatId}"]`).click();
  await bob.page.locator('#message-input').fill('Synthetic scam study: please review the ordinary planning note.');
  await bob.page.locator('.send-btn').click();
  await alice.page.getByText('Synthetic scam study: please review the ordinary planning note.').waitFor();
  await alice.page.locator('#typing-indicator').waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
  await alice.page.locator('#message-input').fill('I am typing');
  await bob.page.locator('#typing-indicator').waitFor({ timeout: 4000 });
  await alice.page.locator('#message-input').fill('');
  await alice.page.locator('#messages .msg-row[data-sender-id]').last().waitFor();
  await alice.page.waitForTimeout(500);
  assert.match(await bob.page.locator('.delivery-state').last().innerText(), /✓✓|Seen|Delivered/);

  const ownMessage = await bob.page.locator('#messages .msg-row').last();
  await ownMessage.locator('summary[aria-label="Message options"]').click();
  await ownMessage.locator('[data-delete-scope="me"]').click();
  await ownMessage.waitFor({ state: 'detached' });
  await alice.page.locator('#message-input').fill('Synthetic message to delete everywhere'); await alice.page.locator('.send-btn').click();
  const deletable = alice.page.locator('#messages .msg-row').filter({ hasText: 'Synthetic message to delete everywhere' }); await deletable.waitFor();
  await deletable.locator('summary[aria-label="Message options"]').click();
  alice.page.once('dialog', (dialog) => dialog.accept());
  await deletable.locator('[data-delete-scope="everyone"]').click();
  await alice.page.getByText('You deleted this message').waitFor();
  await bob.page.getByText('This message was deleted').waitFor();

  await alice.page.locator('#new-chat').click();
  await alice.page.locator('#user-picker').fill('Synthetic Bob'); await alice.page.locator('[data-user-id]').first().click();
  await alice.page.locator('#user-picker').fill('Synthetic Carol'); await alice.page.locator('[data-user-id]').first().click();
  await alice.page.locator('#group-name').fill('Synthetic browser group');
  await alice.page.locator('#create-chat').click();
  await alice.page.locator('#chat-info').click();
  await alice.page.locator('#manage-group-add').click();
  await alice.page.locator('#group-member-search').fill('Synthetic');
  await alice.page.locator('#group-members-dialog').waitFor({ state: 'visible' });
  await alice.page.locator('#group-member-results [data-add-group-user]').filter({ hasText: 'Synthetic Dave' }).click();
  await alice.page.locator('#add-group-members').click();
  await alice.page.locator('#conversation-info').getByText('Synthetic Dave').waitFor();
  const daveId = await dave.page.evaluate(async () => (await (await fetch('/api/me', { headers: { Authorization: `Bearer ${localStorage.getItem('whispr_token')}` } })).json()).id);
  alice.page.once('dialog', (dialog) => dialog.accept());
  await alice.page.locator('#conversation-info').locator(`[data-remove-group-member="${daveId}"]`).click();
  await alice.page.locator('#conversation-info').getByText('Synthetic Dave').waitFor({ state: 'detached' });
  await dave.page.waitForTimeout(300);
  const groupChatId = await alice.page.locator('#chat-list [data-chat-id]').first().getAttribute('data-chat-id');
  assert.equal(await dave.page.locator(`#chat-list [data-chat-id="${groupChatId}"]`).count(), 0);

  await bob.page.locator(`#chat-list [data-chat-id="${groupChatId}"]`).click();
  await alice.page.locator(`#chat-list [data-chat-id="${directChatId}"]`).click();
  await bob.page.locator(`#chat-list [data-chat-id="${directChatId}"]`).click();

  await alice.page.locator('#voice-call').click();
  await bob.page.locator('#incoming-call-dialog').waitFor({ state: 'visible', timeout: 12000 });
  await bob.page.locator('#decline-call').click();
  await alice.page.locator('#call-dialog').waitFor({ state: 'hidden', timeout: 8000 });
  await alice.page.locator('#voice-call').click();
  await bob.page.locator('#incoming-call-dialog').waitFor({ state: 'visible', timeout: 12000 });
  await bob.page.locator('#accept-call').click();
  await alice.page.locator('#call-dialog.audio-only').waitFor({ state: 'visible' });
  await bob.page.locator('#call-dialog.audio-only').waitFor({ state: 'visible' });
  await alice.page.waitForFunction(() => document.querySelector('#remote-video')?.srcObject?.getAudioTracks().length > 0, null, { timeout: 20000 });
  await alice.page.locator('#end-call').click();
  await alice.page.locator('#call-dialog').waitFor({ state: 'hidden', timeout: 8000 });
  await bob.page.locator('#call-dialog').waitFor({ state: 'hidden', timeout: 8000 });
  await alice.page.locator('#video-call').click();
  await bob.page.locator('#incoming-call-dialog').waitFor({ state: 'visible', timeout: 12000 });
  await bob.page.locator('#accept-call').click();
  await alice.page.locator('#call-dialog').waitFor({ state: 'visible' });
  await bob.page.locator('#call-dialog').waitFor({ state: 'visible' });
  await alice.page.waitForFunction(() => document.querySelector('#remote-video')?.srcObject?.getVideoTracks().length > 0, null, { timeout: 20000 });
  await alice.page.locator('#toggle-mic').click();
  assert.equal(await alice.page.locator('#toggle-mic').getAttribute('aria-label'), 'Unmute');
  await alice.page.locator('#toggle-mic').click();
  await alice.page.locator('#toggle-camera').click();
  assert.equal(await alice.page.locator('#toggle-camera').getAttribute('aria-label'), 'Camera on');
  await alice.page.locator('#toggle-camera').click();
  await alice.page.locator('#end-call').click();
  await alice.page.locator('#call-dialog').waitFor({ state: 'hidden', timeout: 8000 });
  await bob.page.locator('#call-dialog').waitFor({ state: 'hidden', timeout: 8000 });
  await alice.page.locator(`#chat-list [data-chat-id="${directChatId}"]`).click();

  const activeGroup = alice.page.locator('#chat-list [data-chat-id]').filter({ hasText: 'Synthetic browser group' });
  const stillGroupId = await activeGroup.getAttribute('data-chat-id');
  await alice.page.locator(`#chat-list [data-chat-id="${stillGroupId}"]`).click();
  await bob.page.locator(`#chat-list [data-chat-id="${stillGroupId}"]`).click();
  await alice.page.locator('#video-call').click();
  await bob.page.locator('#incoming-call-dialog').waitFor({ state: 'visible', timeout: 12000 });
  await carol.page.locator('#incoming-call-dialog').waitFor({ state: 'visible', timeout: 12000 });
  await bob.page.locator('#accept-call').click();
  await carol.page.locator('#accept-call').click();
  await alice.page.locator('#call-dialog.group-call').waitFor({ state: 'visible' });
  await bob.page.locator('#call-dialog.group-call').waitFor({ state: 'visible' });
  await alice.page.waitForFunction(() => document.querySelectorAll('#group-participants .group-call-tile').length >= 3, null, { timeout: 12000 });
  await alice.page.waitForFunction(() => [...document.querySelectorAll('#group-participants .group-call-tile video')].some((video) => video.srcObject?.getVideoTracks().length > 0), null, { timeout: 20000 });
  await alice.page.locator('#end-call').click();
  await alice.page.locator('#call-dialog').waitFor({ state: 'hidden', timeout: 8000 });
  await bob.page.locator('#end-call').click();
  await bob.page.locator('#call-dialog').waitFor({ state: 'hidden', timeout: 8000 });
  await carol.page.locator('#end-call').click();
  await carol.page.locator('#call-dialog').waitFor({ state: 'hidden', timeout: 8000 });
  await alice.page.locator('#voice-call').click();
  await bob.page.locator('#incoming-call-dialog').waitFor({ state: 'visible', timeout: 12000 });
  await carol.page.locator('#incoming-call-dialog').waitFor({ state: 'visible', timeout: 12000 });
  await bob.page.locator('#accept-call').click();
  await carol.page.locator('#accept-call').click();
  await alice.page.locator('#call-dialog.group-call.audio-only').waitFor({ state: 'visible' });
  await bob.page.locator('#call-dialog.group-call.audio-only').waitFor({ state: 'visible' });
  await alice.page.waitForFunction(() => [...document.querySelectorAll('#group-participants .group-call-tile video')].some((video) => video.srcObject?.getAudioTracks().length > 0), null, { timeout: 20000 });
  await alice.page.locator('#end-call').click();
  await alice.page.locator('#call-dialog').waitFor({ state: 'hidden', timeout: 8000 });
  await bob.page.locator('#end-call').click();
  await bob.page.locator('#call-dialog').waitFor({ state: 'hidden', timeout: 8000 });
  await carol.page.locator('#end-call').click();
  await carol.page.locator('#call-dialog').waitFor({ state: 'hidden', timeout: 8000 });
  await bob.page.locator(`#chat-list [data-chat-id="${stillGroupId}"]`).click();
  await bob.page.locator('#chat-info').click();
  bob.page.once('dialog', (dialog) => dialog.accept());
  await bob.page.locator('#leave-group').click();
  await bob.page.locator(`#chat-list [data-chat-id="${stillGroupId}"]`).waitFor({ state: 'detached' });
  await alice.page.locator(`#chat-list [data-chat-id="${directChatId}"]`).click();
  await bob.page.locator(`#chat-list [data-chat-id="${directChatId}"]`).click();

  await bob.page.locator('#message-input').fill('Synthetic security test notice: review this fictional example link https://paypal-login.example/verify?token=synthetic-e2e before entering any credentials.');
  await bob.page.locator('.send-btn').click();
  const scamTarget = alice.page.locator('#messages .msg-row').filter({ hasText: 'Synthetic security test notice' }); await scamTarget.waitFor();

  if (aiBrowserOptIn) {
    const requestedRoutes = new Set();
    const aiResponseCount = (route) => apiResponses.filter((item) => item.route === route).length;
    const assertNewAIResponse = async (route, before, feature) => {
      await wait(100);
      const response = apiResponses.filter((item) => item.route === route)[before];
      assert.ok(response, `${feature} did not send a real backend request to ${route}`);
      assert.equal(response.status, 200, `${feature} backend request returned HTTP ${response.status}`);
    };
    await alice.page.locator('#ai-tools').click();
    let before = aiResponseCount('/api/ai/smart-replies');
    await alice.page.locator('#ai-smart-replies').click();
    await alice.page.waitForFunction(() => document.querySelector('#ai-results')?.textContent !== 'Working…', null, { timeout: 60000 });
    await assertNewAIResponse('/api/ai/smart-replies', before, 'Smart replies');
    assert.ok((await alice.page.locator('#smart-reply-tray button').count()) > 0, 'smart replies did not render reply drafts');
    requestedRoutes.add('/api/ai/smart-replies');
    before = aiResponseCount('/api/ai/conversations/' + directChatId + '/summarize');
    await alice.page.locator('#ai-summarize').click();
    await alice.page.waitForFunction(() => document.querySelector('#ai-results')?.textContent !== 'Working…', null, { timeout: 60000 });
    await assertNewAIResponse('/api/ai/conversations/' + directChatId + '/summarize', before, 'Conversation summary');
    assert.ok((await alice.page.locator('#ai-results').innerText()).length > 10, 'conversation summary did not render'); requestedRoutes.add('/api/ai/conversations/' + directChatId + '/summarize');
    before = aiResponseCount('/api/ai/conversations/' + directChatId + '/actions');
    await alice.page.locator('#ai-actions').click();
    await alice.page.waitForFunction(() => document.querySelector('#ai-results')?.textContent !== 'Working…', null, { timeout: 60000 });
    await assertNewAIResponse('/api/ai/conversations/' + directChatId + '/actions', before, 'Action extraction');
    assert.ok((await alice.page.locator('#ai-results').innerText()).length > 10, 'action extraction did not render'); requestedRoutes.add('/api/ai/conversations/' + directChatId + '/actions');
    before = aiResponseCount('/api/ai/search');
    await alice.page.locator('#ai-search-query').fill('What was the synthetic security test notice?'); await alice.page.locator('#ai-search').click();
    await alice.page.waitForFunction(() => document.querySelector('#ai-results')?.textContent !== 'Working…', null, { timeout: 60000 });
    await assertNewAIResponse('/api/ai/search', before, 'AI-assisted search');
    assert.ok((await alice.page.locator('#ai-search-result, .ai-search-result').count()) > 0, 'AI search did not render a matching message'); requestedRoutes.add('/api/ai/search');
    await alice.page.locator('#ai-close').click();
    const messageActions = scamTarget.locator('details.message-actions');
    await messageActions.evaluate((element) => { element.open = true; });
    const linkRoute = `/api/ai/messages/${await scamTarget.getAttribute('data-message-id')}/link-check`;
    before = aiResponseCount(linkRoute);
    await scamTarget.locator('[data-ai-link-check]').click();
    await alice.page.locator('#ai-dialog').waitFor({ state: 'visible' });
    await alice.page.locator('#ai-results .ai-link-result').waitFor({ timeout: 60000 });
    await assertNewAIResponse(linkRoute, before, 'AI link safety analysis');
    assert.match(await alice.page.locator('#ai-results').innerText(), /not query a live threat-intelligence\/reputation database/i);
    requestedRoutes.add(linkRoute);
    await alice.page.locator('#ai-close').click();
    await messageActions.evaluate((element) => { element.open = true; });
    const scamRoute = `/api/ai/messages/${await scamTarget.getAttribute('data-message-id')}/analyze`;
    before = aiResponseCount(scamRoute);
    await scamTarget.locator('[data-ai-analyze]').click();
    await scamTarget.locator('.scam-warning').waitFor({ timeout: 60000 });
    await assertNewAIResponse(scamRoute, before, 'Scam analysis'); requestedRoutes.add(scamRoute);
    await messageActions.evaluate((element) => { element.open = true; });
    let translated = '';
    const translateDialogDone = new Promise((resolve) => {
      const handler = async (dialog) => { if (dialog.type() === 'prompt') await dialog.accept('Spanish'); else { translated = dialog.message(); await dialog.accept(); alice.page.off('dialog', handler); resolve(); } };
      alice.page.on('dialog', handler);
    });
    before = aiResponseCount('/api/ai/translate');
    await scamTarget.locator('[data-ai-translate]').click();
    await translateDialogDone;
    await assertNewAIResponse('/api/ai/translate', before, 'Translation');
    requestedRoutes.add('/api/ai/translate');
    await alice.page.locator('#ai-close').click().catch(() => {});
    await alice.page.locator('#message-input').fill('Please send the synthetic launch checklist when convenient.');
    before = aiResponseCount('/api/ai/rewrite');
    const rewriteDone = new Promise((resolve) => {
      const handler = async (dialog) => { if (dialog.type() === 'prompt') await dialog.accept('polite'); else { await dialog.accept(); alice.page.off('dialog', handler); resolve(); } };
      alice.page.on('dialog', handler);
    });
    await alice.page.locator('#rewrite-draft').click();
    await rewriteDone; requestedRoutes.add('/api/ai/rewrite');
    await assertNewAIResponse('/api/ai/rewrite', before, 'Draft rewriting');
    for (const route of requestedRoutes) {
      const statuses = apiResponses.filter((item) => item.route === route).map((item) => item.status);
      assert.ok(statuses.some((status) => status < 400), `AI UI request did not complete successfully: ${route} (${statuses.join(',') || 'no HTTP response'})`);
    }
    assert.ok(translated.length > 0 || apiResponses.some((item) => item.route === '/api/ai/translate' && item.status === 200), 'translation did not return a provider response');
  }

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/NuoAAAAASUVORK5CYII=', 'base64');
  await alice.page.locator('#file-input').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: png });
  await alice.page.locator('#messages .inline-image').last().waitFor();
  assert.equal(await alice.page.locator('#messages .inline-image').last().evaluate((img) => img.complete && img.naturalWidth > 0), true);
  const imageUrl = await alice.page.locator('#messages .inline-image').last().getAttribute('src');
  assert.equal(await alice.page.evaluate(async (url) => (await fetch(url)).ok, imageUrl), true, 'signed image download failed in the browser');
  await alice.page.locator('#file-input').setInputFiles({ name: 'synthetic-audio.wav', mimeType: 'audio/wav', buffer: waveFile() });
  await alice.page.locator('#messages .inline-audio').last().waitFor();
  await alice.page.locator('#messages .inline-audio').last().evaluate((audio) => audio.readyState >= 1 ? true : new Promise((resolve, reject) => { audio.addEventListener('loadedmetadata', resolve, { once: true }); audio.addEventListener('error', reject, { once: true }); audio.load(); setTimeout(() => reject(new Error('audio metadata timeout')), 5000); }));
  await alice.page.locator('#messages .inline-audio').last().evaluate((audio) => audio.play());
  assert.equal(await alice.page.locator('#messages .inline-audio').last().evaluate((audio) => !audio.paused), true);

  const syntheticVideo = await alice.page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
    const context = canvas.getContext('2d'); const stream = canvas.captureStream(12); const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    const timer = setInterval(() => { context.fillStyle = `hsl(${Date.now() % 360} 80% 50%)`; context.fillRect(0, 0, 160, 90); }, 80);
    const complete = new Promise((resolve) => { recorder.onstop = async () => { clearInterval(timer); stream.getTracks().forEach((track) => track.stop()); resolve(Array.from(new Uint8Array(await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer()))); }; });
    recorder.start(); setTimeout(() => recorder.stop(), 700); return complete;
  });
  await alice.page.locator('#file-input').setInputFiles({ name: 'synthetic-video.webm', mimeType: 'video/webm', buffer: Buffer.from(syntheticVideo) });
  await alice.page.locator('#messages .inline-video').last().waitFor();
  await alice.page.locator('#messages .inline-video').last().evaluate((video) => video.readyState >= 1 ? true : new Promise((resolve, reject) => { video.addEventListener('loadedmetadata', resolve, { once: true }); video.addEventListener('error', reject, { once: true }); video.load(); setTimeout(() => reject(new Error('video metadata timeout')), 5000); }));
  await alice.page.locator('#messages .inline-video').last().evaluate((video) => video.play());
  assert.equal(await alice.page.locator('#messages .inline-video').last().evaluate((video) => !video.paused), true);

  await alice.page.locator('#voice-record').click();
  await alice.page.locator('#voice-record.recording').waitFor({ timeout: 5000 });
  await wait(800);
  await alice.page.locator('#voice-record').click({ force: true });
  await alice.page.locator('#messages .inline-audio').last().waitFor({ timeout: 10000 });

  const reportResponse = alice.page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/report'));
  alice.page.once('dialog', (dialog) => dialog.accept('Synthetic browser report'));
  await alice.page.locator('#report').click();
  assert.equal((await reportResponse).status(), 201, 'report submission did not return success');
  await alice.page.locator('#toast').getByText('Report sent.').waitFor();
  await alice.page.goto(`${origin}/admin.html`);
  await alice.page.getByText('Whispr administration').waitFor();
  await alice.page.getByText(/Synthetic browser report/).waitFor();
  const registrationSetting = alice.page.locator('#registration-open');
  await registrationSetting.uncheck(); await alice.page.waitForTimeout(250);
  assert.equal(await alice.page.evaluate(async () => (await (await fetch('/api/admin/settings', { headers: { Authorization: `Bearer ${localStorage.getItem('whispr_token')}` } })).json()).registrationOpen), false);
  await registrationSetting.check(); await alice.page.waitForTimeout(250);
  assert.equal(await alice.page.evaluate(async () => (await (await fetch('/api/admin/settings', { headers: { Authorization: `Bearer ${localStorage.getItem('whispr_token')}` } })).json()).registrationOpen), true);

  await alice.page.goto(`${origin}/interface.html`);
  const workerReady = await alice.page.evaluate(async () => { const registration = await navigator.serviceWorker.register('/service-worker.js'); await navigator.serviceWorker.ready; return registration.active?.state || registration.installing?.state || registration.waiting?.state; });
  assert.ok(workerReady === 'activated' || workerReady === 'activating', 'service worker did not install');
  const pushStatus = await alice.page.evaluate(async () => (await (await fetch('/api/push/public-key', { headers: { Authorization: `Bearer ${localStorage.getItem('whispr_token')}` } })).json()));
  assert.equal(pushStatus.enabled, false, 'the isolated server should not claim push delivery is configured without VAPID keys');

  await bob.page.locator(`#chat-list [data-chat-id="${directChatId}"]`).click();
  await bob.page.setViewportSize({ width: 390, height: 844 });
  await bob.page.locator('#message-input').waitFor();
  assert.ok(await bob.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile chat has horizontal overflow');
  assert.deepEqual(diagnostics, [], `browser console or HTTP errors: ${diagnostics.join(', ')}`);
  console.log('PASS: browser auth, profile, realtime direct chat and receipts, deletion scopes, groups and membership, direct/group voice and video calls with live media tracks, image/audio/video uploads and playback, voice recording, reporting/admin, service worker install, and responsive layout.');
  if (aiBrowserOptIn) console.log(`PASS: all eight AI operations returned HTTP success from the real ${aiProvider} provider through authenticated browser UI controls after consent was persisted.`);
  else console.log(`SKIP: ${aiSkipReason}`);
});
