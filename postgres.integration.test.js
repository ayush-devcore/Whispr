import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import pg from 'pg';
import { io as connect } from 'socket.io-client';

const enabled = process.env.RUN_POSTGRES_INTEGRATION === 'true';
const integrationTest = enabled ? test : test.skip;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

integrationTest('PostgreSQL persistence across schema, chat, membership, receipts, deletion, reports and AI preferences', async (t) => {
  const connectionString = process.env.TEST_DATABASE_URL;
  const designatedName = process.env.TEST_DATABASE_NAME;
  assert.ok(connectionString && designatedName, 'Set TEST_DATABASE_URL and TEST_DATABASE_NAME before opting into PostgreSQL integration.');
  let parsed;
  try { parsed = new URL(connectionString); } catch { assert.fail('TEST_DATABASE_URL is not a valid database URL.'); }
  const actualName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  assert.equal(actualName, designatedName, 'The database URL name must exactly match TEST_DATABASE_NAME.');
  assert.match(actualName, /^[a-zA-Z0-9_]+_test$/i, 'The designated database name must be a simple identifier ending in _test.');
  assert.notEqual(connectionString, process.env.DATABASE_URL, 'The integration URL cannot be the configured application DATABASE_URL.');
  if (process.env.DATABASE_URL) {
    let configured;
    try { configured = new URL(process.env.DATABASE_URL); } catch { assert.fail('DATABASE_URL is invalid; its value has been suppressed.'); }
    const configuredName = decodeURIComponent(configured.pathname.replace(/^\//, ''));
    assert.ok(parsed.hostname.toLowerCase() !== configured.hostname.toLowerCase() || (parsed.port || '5432') !== (configured.port || '5432') || actualName !== configuredName, 'TEST_DATABASE_URL points to the same host, port, and database as DATABASE_URL.');
  }

  const safetyPool = new pg.Pool({ connectionString });
  try {
    const relation = await safetyPool.query("SELECT to_regclass('public.whispr_state') AS table_name");
    if (relation.rows[0]?.table_name) {
      const saved = await safetyPool.query('SELECT state FROM whispr_state WHERE id = 1');
      const state = saved.rows[0]?.state;
      const dataKeys = ['users', 'chats', 'messages', 'files', 'reports', 'pushSubscriptions'];
      assert.ok(!state || dataKeys.every((key) => !Array.isArray(state[key]) || state[key].length === 0), 'The designated test database already contains application data. Use a new blank disposable _test database; existing data is left untouched.');
    }
  } catch (error) {
    if (error?.code === 'ERR_ASSERTION') throw error;
    assert.fail('Could not safely inspect the designated test database. Confirm it exists and is reachable; credentials and connection details were suppressed.');
  } finally { await safetyPool.end(); }

  const workDir = await mkdtemp(path.join(os.tmpdir(), 'whispr-pg-integration-'));
  const dbFile = path.join(workDir, 'unused-json-state.json');
  const uploadDir = path.join(workDir, 'uploads');
  const secret = 'postgres-integration-only-jwt-secret-0123456789';
  const bootstrap = 'postgres-integration-bootstrap-only-0123456789';
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const tag = `pg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  let child;
  let aliceSocket;
  let senderSocket;
  const startServer = async () => {
    child = spawn(process.execPath, ['server.js'], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'production', PORT: String(port), JWT_SECRET: secret, ADMIN_BOOTSTRAP_TOKEN: bootstrap, DATABASE_URL: connectionString, TEST_DATABASE_URL: '', TEST_DATABASE_NAME: '', AI_ENABLED: 'false', OPENAI_API_KEY: '', OPENROUTER_API_KEY: '', DB_FILE: dbFile, UPLOAD_DIR: uploadDir },
      stdio: 'ignore',
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (child.exitCode !== null) throw new Error('The isolated PostgreSQL test server exited during startup. Check schema/network configuration without sharing credentials.');
      try { const response = await fetch(origin); if (response.ok) return; } catch {}
      await wait(100);
    }
    throw new Error('The isolated PostgreSQL test server did not become ready. Check the database host and schema permissions without sharing credentials.');
  };
  const stopServer = async () => {
    aliceSocket?.close(); aliceSocket = null;
    senderSocket?.close(); senderSocket = null;
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), wait(5000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    child = null;
  };
  const request = async (route, token, options = {}) => {
    const response = await fetch(`${origin}${route}`, { ...options, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) } });
    const result = response.status === 204 ? null : await response.json();
    assert.ok(response.ok, `Request ${route} returned ${response.status}.`);
    return result;
  };
  t.after(async () => { await stopServer(); await rm(workDir, { recursive: true, force: true }); });

  await startServer();
  const register = (name, email) => request('/api/auth/register', null, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email, password: 'integration-password-123', ...(name === 'PG Integration Admin' ? { adminBootstrapToken: bootstrap } : {}) }) });
  const alice = await register('PG Integration Admin', `${tag}-alice@example.test`);
  const bob = await register('PG Integration Member', `${tag}-bob@example.test`);
  assert.equal(alice.user.role, 'admin');
  const direct = await request('/api/chats', alice.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberIds: [bob.user.id] }) });
  const group = await request('/api/chats', alice.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberIds: [bob.user.id], isGroup: true, name: `${tag} group` }) });
  await request(`/api/chats/${group.id}/members/${bob.user.id}`, alice.token, { method: 'DELETE' });
  await request(`/api/chats/${group.id}/members`, alice.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberIds: [bob.user.id] }) });
  const sent = await request(`/api/chats/${direct.id}/messages`, alice.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'PostgreSQL persistence sample', clientId: tag }) });
  await request('/api/me', alice.token, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'PG Integration Admin Updated', bio: 'Synthetic persistence profile' }) });
  await request(`/api/ai/preferences`, alice.token, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, consent: true, summaries: true, scamAnalysis: true }) });
  await request(`/api/chats/${direct.id}/report`, bob.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: `Synthetic report ${tag}` }) });

  aliceSocket = connect(origin, { auth: { token: bob.token }, reconnection: false });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Socket.IO did not connect to the PostgreSQL test server.')), 5000); aliceSocket.once('connect', () => { clearTimeout(timer); resolve(); }); aliceSocket.once('connect_error', () => { clearTimeout(timer); reject(new Error('Socket.IO authentication failed in PostgreSQL test.')); }); });
  senderSocket = connect(origin, { auth: { token: alice.token }, reconnection: false });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Sender Socket.IO did not connect.')), 5000); senderSocket.once('connect', () => { clearTimeout(timer); resolve(); }); senderSocket.once('connect_error', () => { clearTimeout(timer); reject(new Error('Sender Socket.IO authentication failed.')); }); });
  const gotStatus = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Read receipt did not reach the message sender.')), 5000); senderSocket.once('message:status', (payload) => { clearTimeout(timer); resolve(payload); }); });
  aliceSocket.emit('messages:read', { chatId: direct.id, messageIds: [sent.id] });
  const status = await gotStatus;
  assert.ok(status.readBy.includes(bob.user.id));
  senderSocket.close(); senderSocket = null;

  await request(`/api/chats/${direct.id}/messages/${sent.id}`, alice.token, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'everyone' }) });
  await stopServer();
  await startServer();
  assert.equal((await request('/api/me', alice.token)).bio, 'Synthetic persistence profile', 'Profile data was not persisted after restart.');
  const persistedMessages = await request(`/api/chats/${direct.id}/messages`, alice.token);
  assert.ok(persistedMessages.some((message) => message.id === sent.id && message.readBy.includes(bob.user.id)), 'Message and read receipt were not persisted after restart.');
  const preferences = await request('/api/ai/preferences', alice.token);
  assert.equal(preferences.preferences.summaries, true, 'AI preferences were not persisted after restart.');
  assert.ok((await request('/api/chats', bob.token)).some((chat) => chat.id === group.id), 'Group chat membership was not persisted after restart.');
  assert.ok((await request('/api/admin/reports', alice.token)).some((report) => report.reason === `Synthetic report ${tag}`), 'Report records were not persisted after restart.');
  assert.ok((await request(`/api/chats/${direct.id}/messages`, bob.token)).some((message) => message.id === sent.id && message.deletedForEveryone), 'Message deletion was not persisted in PostgreSQL.');
});
