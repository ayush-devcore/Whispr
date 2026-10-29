import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createHmac } from 'node:crypto';
import pg from 'pg';
import webpush from 'web-push';
import { createAIService } from './ai-service.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
const uploadDir = process.env.UPLOAD_DIR || path.join(root, 'uploads');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });
const dbPath = process.env.DB_FILE || path.join(dataDir, 'whispr.json');
const secretPath = path.join(dataDir, '.jwt-secret');
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) throw new Error('JWT_SECRET must be set in production.');
if (process.env.NODE_ENV === 'production' && process.env.ADMIN_BOOTSTRAP_TOKEN && process.env.ADMIN_BOOTSTRAP_TOKEN.length < 32) throw new Error('ADMIN_BOOTSTRAP_TOKEN must contain at least 32 characters.');
const secret = process.env.JWT_SECRET || (fs.existsSync(secretPath) ? fs.readFileSync(secretPath, 'utf8') : crypto.randomBytes(32).toString('hex'));
if (!process.env.JWT_SECRET && !fs.existsSync(secretPath)) fs.writeFileSync(secretPath, secret, { mode: 0o600 });
const app = express();
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS);
app.set('trust proxy', Number.isInteger(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : (process.env.RENDER ? 1 : 0));
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1_000_000 });
const upload = multer({ dest: uploadDir, limits: { fileSize: 25 * 1024 * 1024 } });
const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined }) : null;
const configuredAIProvider = (process.env.AI_PROVIDER || 'openai').trim().toLowerCase();
const ai = createAIService({ providerName: configuredAIProvider, model: process.env.AI_MODEL || (configuredAIProvider === 'openrouter' ? 'openai/gpt-6-luna' : 'gpt-6-luna'), timeoutMs: Math.min(60_000, Math.max(1_000, Number(process.env.AI_REQUEST_TIMEOUT_MS) || 20_000)), maxOutputTokens: Math.min(4_000, Math.max(100, Number(process.env.AI_MAX_OUTPUT_TOKENS) || 700)) });
console.info('AI configuration loaded:', JSON.stringify({ provider: ai.providerName, model: ai.model, endpointHost: ai.diagnostics.endpointHost, credentialVariable: ai.diagnostics.credentialVariable, credentialPresent: ai.diagnostics.credentialPresent, enabled: ai.diagnostics.enabled, clientConfigured: ai.configured }));
const aiMaxContext = Math.min(100, Math.max(5, Number(process.env.AI_MAX_CONTEXT_MESSAGES) || 30));
const aiDailyLimit = Math.min(500, Math.max(1, Number(process.env.AI_DAILY_USER_LIMIT) || 30));
const cacheTtlValue = process.env.AI_CACHE_TTL_SECONDS === undefined ? 120 : Number(process.env.AI_CACHE_TTL_SECONDS);
const aiCacheTtlMs = Math.min(3600, Math.max(0, Number.isFinite(cacheTtlValue) ? cacheTtlValue : 120)) * 1000;
const aiCache = new Map();
const aiInflight = new Map();
const aiJobs = new Set();
let activeAIRequests = 0;
const aiConcurrencyLimit = 4;
const authWindowMs = Math.min(60 * 60_000, Math.max(10_000, Number(process.env.AUTH_RATE_WINDOW_MS) || 15 * 60_000));
const loginIpLimit = Math.min(1000, Math.max(10, Number(process.env.AUTH_LOGIN_IP_LIMIT) || 120));
const loginAccountLimit = Math.min(100, Math.max(3, Number(process.env.AUTH_LOGIN_ACCOUNT_LIMIT) || 10));
const registerIpLimit = Math.min(300, Math.max(3, Number(process.env.AUTH_REGISTER_IP_LIMIT) || 20));
const authIpWindows = new Map();
const loginFailures = new Map();

const blank = () => ({ users: [], chats: [], messages: [], files: [], reports: [], settings: { registrationOpen: true, adminBootstrapUsed: false } });
let db = fs.existsSync(dbPath) ? JSON.parse(fs.readFileSync(dbPath, 'utf8')) : blank();
let migrationNeeded = false;
if (!db.settings) { db.settings = { registrationOpen: true }; migrationNeeded = true; }
if (db.settings.registrationOpen == null) { db.settings.registrationOpen = true; migrationNeeded = true; }
if (db.settings.adminBootstrapUsed == null) { db.settings.adminBootstrapUsed = db.users?.some((user) => user.role === 'admin') || false; migrationNeeded = true; }
for (const key of ['users', 'chats', 'messages', 'files', 'reports']) if (!Array.isArray(db[key])) { db[key] = []; migrationNeeded = true; }
function migrateGroups() {
  let changed = false;
  for (const chat of db.chats) if (chat.isGroup) {
    const currentMembers = Array.isArray(chat.memberIds) ? chat.memberIds : [];
    const existingAdmins = Array.isArray(chat.adminIds) ? chat.adminIds.filter((memberId) => currentMembers.includes(memberId)) : [];
    const adminIds = existingAdmins.length ? existingAdmins : [currentMembers.includes(chat.createdBy) ? chat.createdBy : currentMembers[0]].filter(Boolean);
    const createdBy = currentMembers.includes(chat.createdBy) ? chat.createdBy : adminIds[0] || null;
    if (JSON.stringify(chat.adminIds || []) !== JSON.stringify(adminIds) || (chat.createdBy || null) !== createdBy) changed = true;
    chat.adminIds = adminIds; chat.createdBy = createdBy;
  }
  return changed;
}
migrationNeeded = migrateGroups() || migrationNeeded;
if (!Array.isArray(db.pushSubscriptions)) { db.pushSubscriptions = []; migrationNeeded = true; }
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
const vapidConfigured = !!(vapidPublicKey && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
if (vapidConfigured) webpush.setVapidDetails(process.env.VAPID_SUBJECT, vapidPublicKey, process.env.VAPID_PRIVATE_KEY);
const pendingCalls = new Map();
const activeDirectCalls = new Map();
let saveQueue = Promise.resolve();
const save = () => {
  const state = JSON.stringify(db);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const temporaryPath = `${dbPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryPath, dbPath);
  if (!pool) return Promise.resolve();
  saveQueue = saveQueue.then(() => pool.query('UPDATE whispr_state SET state = $1::jsonb, updated_at = NOW() WHERE id = 1', [state]));
  return saveQueue;
};
const id = () => crypto.randomUUID();
function sniffContentType(filename, claimedType = '') {
  let fd;
  try {
    fd = fs.openSync(filename, 'r');
    const header = Buffer.alloc(32);
    const bytes = fs.readSync(fd, header, 0, header.length, 0);
    const data = header.subarray(0, bytes);
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
    if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (data.subarray(0, 3).toString() === 'GIF') return 'image/gif';
    if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
    if (data.length >= 12 && data.subarray(4, 8).toString() === 'ftyp' && /^(avif|avis)$/.test(data.subarray(8, 12).toString())) return 'image/avif';
    if (data.length >= 12 && data.subarray(4, 8).toString() === 'ftyp') return claimedType.startsWith('audio/') ? 'audio/mp4' : 'video/mp4';
    if (data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return claimedType.startsWith('audio/') ? 'audio/webm' : 'video/webm';
    if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WAVE') return 'audio/wav';
    if (data.subarray(0, 4).toString() === 'OggS') return 'audio/ogg';
    if (data.subarray(0, 3).toString() === 'ID3' || (data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
    if (data.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
    return 'application/octet-stream';
  } catch { return 'application/octet-stream'; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
const inlineMediaType = (type) => /^(image\/(jpeg|png|gif|webp|avif)|video\/(mp4|webm)|audio\/(mpeg|mp4|webm|wav|ogg))$/.test(type);
const publicUser = (u) => u && ({ id: u.id, name: u.name, email: u.email, avatar: u.avatar ? `/avatars/${u.id}` : null, bio: u.bio || '', role: u.role, createdAt: u.createdAt, online: onlineUsers.has(u.id), lastSeen: u.lastSeen || null });
const onlineUsers = new Map();
const groupCalls = new Map();
const activeGroupCallsByChat = new Map();
const tokenFor = (u) => jwt.sign({ id: u.id }, secret, { expiresIn: '7d' });
const mediaUrl = (file, userId) => `/media/${file.id}?token=${encodeURIComponent(jwt.sign({ scope: 'media', fileId: file.id, userId }, secret, { expiresIn: '30m' }))}`;
async function pushToUser(userId, payload, ttl = 60) {
  if (!vapidConfigured) return;
  let removed = false;
  await Promise.all(db.pushSubscriptions.filter((item) => item.userId === userId).map(async (item) => {
    try { await webpush.sendNotification(item.subscription, JSON.stringify(payload), { TTL: ttl, urgency: 'high' }); }
    catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) { db.pushSubscriptions = db.pushSubscriptions.filter((saved) => saved.subscription.endpoint !== item.subscription.endpoint); removed = true; }
      else console.warn('Call push notification failed:', JSON.stringify({ statusCode: Number.isInteger(error.statusCode) ? error.statusCode : null, category: error.code === 'ETIMEDOUT' ? 'timeout' : 'delivery_error' }));
    }
  }));
  if (removed) await save();
}
const getUser = (req) => db.users.find((u) => u.id === req.user.id);
const members = (chat) => chat.memberIds.map((memberId) => db.users.find((u) => u.id === memberId)).filter(Boolean);
const peer = (chat, userId) => members(chat).find((u) => u.id !== userId);
function chatView(chat, userId) {
  const last = db.messages.filter((m) => m.chatId === chat.id && !(m.deletedFor || []).includes(userId)).at(-1);
  const other = peer(chat, userId);
  return { ...chat, adminIds: chat.isGroup ? (chat.adminIds || []) : [], participants: members(chat).map(publicUser), title: chat.isGroup ? chat.name : other?.name || 'Unknown user', avatar: chat.isGroup ? null : other?.avatar || null, online: !chat.isGroup && !!other && onlineUsers.has(other.id), lastMessage: last || null };
}
function authorize(req, res, next) {
  const raw = req.headers.authorization?.replace('Bearer ', '');
  try {
    const claims = jwt.verify(raw, secret);
    if (typeof claims?.id !== 'string' || !db.users.some((user) => user.id === claims.id)) return res.status(401).json({ error: 'Please sign in again.' });
    req.user = { id: claims.id };
    next();
  } catch { res.status(401).json({ error: 'Please sign in again.' }); }
}
function admin(req, res, next) { const u = getUser(req); if (u?.role === 'admin') next(); else res.status(403).json({ error: 'Admin access required.' }); }
function authRateLimited(res, window) {
  const remaining = Math.max(1, Math.ceil((window.resetAt - Date.now()) / 1000));
  return res.set('Retry-After', String(remaining)).status(429).json({ error: 'Too many authentication attempts. Wait briefly and try again.' });
}
function limitAuthByIp(kind, limit) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${kind}:${crypto.createHash('sha256').update(ip).digest('hex')}`;
    const now = Date.now();
    let window = authIpWindows.get(key);
    if (!window || window.resetAt <= now) { window = { count: 0, resetAt: now + authWindowMs }; authIpWindows.set(key, window); }
    if (window.count >= limit) return authRateLimited(res, window);
    window.count += 1;
    if (authIpWindows.size > 5000) {
      for (const [entry, value] of authIpWindows) if (value.resetAt <= now) authIpWindows.delete(entry);
      while (authIpWindows.size > 5000) authIpWindows.delete(authIpWindows.keys().next().value);
    }
    next();
  };
}
function accountFailureKey(email) { return crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex'); }
function recordLoginFailure(email) {
  const key = accountFailureKey(email); const now = Date.now();
  let window = loginFailures.get(key);
  if (!window || window.resetAt <= now) { window = { count: 0, resetAt: now + authWindowMs }; loginFailures.set(key, window); }
  window.count += 1;
  if (loginFailures.size > 5000) {
    for (const [entry, value] of loginFailures) if (value.resetAt <= now) loginFailures.delete(entry);
    while (loginFailures.size > 5000) loginFailures.delete(loginFailures.keys().next().value);
  }
}
function bootstrapTokenMatches(candidate) {
  const expected = process.env.ADMIN_BOOTSTRAP_TOKEN;
  if (typeof candidate !== 'string' || typeof expected !== 'string' || expected.length < 32) return false;
  const left = Buffer.from(candidate); const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function aiPreferences(user) { return user.aiPreferences || { enabled: false, smartReplies: false, scamAnalysis: false }; }
function aiConsent(req, res, next) { const prefs = aiPreferences(getUser(req)); if (!prefs.enabled) return res.status(403).json({ error: 'Enable AI processing and consent in your profile settings first.' }); next(); }
function consumeAIQuota(user, reserveConcurrency = true) {
  const today = new Date().toISOString().slice(0, 10);
  if (user.aiUsage?.date !== today) user.aiUsage = { date: today, count: 0 };
  if (user.aiUsage.count >= aiDailyLimit) { const error = new Error('Your daily AI request limit has been reached. Try again tomorrow.'); error.status = 429; throw error; }
  if (reserveConcurrency && activeAIRequests >= aiConcurrencyLimit) { const error = new Error('AI is busy right now. Please try again shortly.'); error.status = 429; throw error; }
  user.aiUsage.count += 1; activeAIRequests += 1;
}
async function withAI(user, feature, operation) {
  consumeAIQuota(user);
  try {
    await save();
    const result = await operation();
    const currentUser = db.users.find((item) => item.id === user.id);
    const preferences = aiPreferences(currentUser || {});
    if (!currentUser || !preferences.enabled || !preferences[feature]) { const error = new Error('AI consent or this feature was disabled during processing.'); error.code = 'AI_CONSENT_REVOKED'; throw error; }
    return result;
  } finally { activeAIRequests = Math.max(0, activeAIRequests - 1); }
}
function aiMessages(chat, userId, limit = aiMaxContext) {
  const visible = db.messages.filter((message) => message.chatId === chat.id && !(message.deletedFor || []).includes(userId) && !message.deletedForEveryone);
  return visible.slice(-limit).map((message) => ({ id: message.id, sender: db.users.find((user) => user.id === message.senderId)?.name || 'Unknown', mine: message.senderId === userId, text: message.body.slice(0, 2000), createdAt: message.createdAt }));
}
function aiRouteError(res, error) {
  if (error.code === 'AI_UNAVAILABLE') return res.status(503).json({ error: 'AI is unavailable. Check AI_ENABLED, AI_PROVIDER, and the matching provider API key on the server.' });
  if (error.code === 'AI_CONSENT_REVOKED') return res.status(403).json({ error: 'AI consent or this feature was disabled while the request was processing. No result was saved.' });
  if (error.status === 429) return res.status(429).json({ error: 'AI is busy or your AI request limit has been reached. Try again later.' });
  const status = Number.isInteger(error.status) ? error.status : null;
  const category = status === 401 ? 'credential_rejected' : status === 403 ? 'access_denied' : status === 429 ? 'rate_limited' : status >= 500 ? 'provider_error' : status ? 'request_rejected' : 'network_or_client_error';
  const headers = error.headers || error.response?.headers;
  const rawRequestId = error.request_id || error.requestID || headers?.get?.('x-request-id') || headers?.['x-request-id'];
  const requestId = typeof rawRequestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(rawRequestId) ? rawRequestId : null;
  const rawCode = typeof error.code === 'string' ? error.code : null;
  const providerCode = rawCode && /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode) ? rawCode : null;
  console.warn('AI operation failed:', JSON.stringify({ provider: ai.providerName, model: ai.model, endpointHost: ai.diagnostics.endpointHost, credentialVariable: ai.diagnostics.credentialVariable, credentialPresent: ai.diagnostics.credentialPresent, httpStatus: status, category, providerCode, requestId }));
  if (status === 401) return res.status(503).json({ error: 'The AI provider rejected server authentication. Verify the selected provider and server key, then restart Whispr after changing environment variables.' });
  return res.status(502).json({ error: 'AI could not complete that request. Your chat is unaffected; try again later.' });
}
function cachedAI(key, producer) {
  const cached = aiCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
  if (aiInflight.has(key)) return aiInflight.get(key);
  const pending = producer().then((value) => { if (aiCacheTtlMs) { aiCache.set(key, { value, expiresAt: Date.now() + aiCacheTtlMs }); if (aiCache.size > 500) aiCache.delete(aiCache.keys().next().value); } return value; }).finally(() => aiInflight.delete(key));
  aiInflight.set(key, pending); return pending;
}
function queueScamAnalysis(chat, message) {
  if (!ai.configured) return;
  const recipients = chat.memberIds.filter((memberId) => memberId !== message.senderId);
  if (!recipients.length || !chat.memberIds.every((memberId) => { const prefs = aiPreferences(db.users.find((user) => user.id === memberId) || {}); return prefs.enabled && prefs.scamAnalysis; })) return;
  const jobKey = `scam:${message.id}`;
  if (aiJobs.has(jobKey)) return;
  aiJobs.add(jobKey);
  setImmediate(async () => {
    let reserved = false;
    try {
      if (!chat.memberIds.every((memberId) => { const prefs = aiPreferences(db.users.find((user) => user.id === memberId) || {}); return prefs.enabled && prefs.scamAnalysis; })) return;
      for (const userId of recipients) if ((db.users.find((user) => user.id === userId)?.aiScamAnalyses || {})[message.id]) return;
      const users = recipients.map((userId) => db.users.find((user) => user.id === userId)).filter(Boolean);
      if (activeAIRequests >= aiConcurrencyLimit) return;
      users.forEach((user) => consumeAIQuota(user, false)); activeAIRequests += 1; reserved = true; await save();
      const sharedHistory = db.messages.filter((item) => item.chatId === chat.id && !item.deletedForEveryone && !(item.deletedFor || []).length && item.id !== message.id).slice(-8).map((item) => ({ sender: db.users.find((user) => user.id === item.senderId)?.name || 'Unknown', text: item.body.slice(0, 1000), createdAt: item.createdAt }));
      const context = { target: { sender: db.users.find((user) => user.id === message.senderId)?.name || 'Unknown', text: message.body.slice(0, 2000), createdAt: message.createdAt }, sharedHistory };
      const analysis = await ai.scamAnalysis(context);
      const currentMessage = db.messages.find((item) => item.id === message.id && !item.deletedForEveryone);
      const allStillConsented = chat.memberIds.every((memberId) => { const prefs = aiPreferences(db.users.find((user) => user.id === memberId) || {}); return prefs.enabled && prefs.scamAnalysis; });
      if (!currentMessage || !allStillConsented || recipients.some((userId) => (currentMessage.deletedFor || []).includes(userId))) return;
      const allowedEvidence = [message.body, ...sharedHistory.map((item) => item.text)].join(' ').toLocaleLowerCase();
      analysis.evidence = analysis.evidence.filter((item) => allowedEvidence.includes(item.toLocaleLowerCase())); analysis.uncertain = true;
      users.forEach((user) => { user.aiScamAnalyses ||= {}; user.aiScamAnalyses[message.id] = analysis; });
      await save();
      recipients.forEach((userId) => io.to(`user:${userId}`).emit('ai:scam-analysis:updated', { chatId: chat.id, messageId: message.id, analysis }));
    } catch (error) { console.warn('Automatic scam analysis unavailable:', error.code || error.name || 'Error'); }
    finally { if (reserved) activeAIRequests = Math.max(0, activeAIRequests - 1); aiJobs.delete(jobKey); }
  });
}
function emitPresence(userId) { io.emit('presence', { userId, online: onlineUsers.has(userId) }); }
function socketChat(socket, chatId) { return db.chats.find((c) => c.id === chatId && c.memberIds.includes(socket.user.id)); }
function groupCallRoom(callId) { return `group-call:${callId}`; }
function groupCallView(call) { return { callId: call.id, chatId: call.chatId, video: call.video, groupName: call.name, participants: [...call.participants.keys()].map((userId) => publicUser(db.users.find((user) => user.id === userId))).filter(Boolean) }; }
function removeGroupCallParticipant(call, userId) {
  if (!call.participants.has(userId)) return;
  call.participants.delete(userId);
  io.to(groupCallRoom(call.id)).emit('group-call:participant-left', { callId: call.id, userId });
  if (!call.participants.size) { groupCalls.delete(call.id); activeGroupCallsByChat.delete(call.chatId); }
}

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => { if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) req.body = {}; next(); });
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()' });
  next();
});
app.get('/avatars/:userId', (req, res) => { const user = db.users.find((u) => u.id === req.params.userId && u.avatar); if (!user) return res.sendStatus(404); const filename = path.join(uploadDir, path.basename(user.avatar)); const type = sniffContentType(filename); if (!type.startsWith('image/')) return res.sendStatus(404); res.sendFile(filename, { headers: { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, max-age=60' } }); });
app.get('/media/:fileId', (req, res) => { try { const claims = jwt.verify(req.query.token, secret); const file = db.files.find((item) => item.id === req.params.fileId && item.id === claims.fileId); const chat = db.chats.find((item) => item.id === file?.chatId && item.memberIds.includes(claims.userId)); if (claims.scope !== 'media' || !file || !chat) return res.sendStatus(404); const storedName = path.basename(file.storageName || file.url || ''); if (!storedName) return res.sendStatus(404); const filename = path.join(uploadDir, storedName); const type = sniffContentType(filename, file.type); res.set('Content-Disposition', inlineMediaType(type) ? 'inline' : 'attachment'); res.sendFile(filename, { headers: { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=60' } }); } catch { res.sendStatus(401); } });
app.use((req, res, next) => { if (/^\/(data|uploads|node_modules|\.git)(\/|$)/.test(req.path) || ['/server.js', '/smoke.js', '/package.json', '/package-lock.json', '/render.yaml', '/README.md'].includes(req.path)) return res.sendStatus(404); next(); });
app.use(express.static(root));
app.get('/', (req, res) => res.sendFile(path.join(root, 'login.html')));

app.post('/api/auth/register', limitAuthByIp('register', registerIpLimit), async (req, res) => {
  const { name, email, password } = req.body;
  if (!db.settings.registrationOpen) return res.status(403).json({ error: 'Registration is currently closed.' });
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60 || typeof email !== 'string' || email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || typeof password !== 'string' || password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Enter a valid email, a name up to 60 characters, and a password between 8 and 128 characters.' });
  if (db.users.some((u) => u.email.toLowerCase() === email.trim().toLowerCase())) return res.status(409).json({ error: 'An account already uses that email.' });
  const hasAdmin = db.users.some((u) => u.role === 'admin');
  const requestedBootstrap = Object.hasOwn(req.body, 'adminBootstrapToken');
  if (process.env.NODE_ENV === 'production' && requestedBootstrap && (hasAdmin || db.settings.adminBootstrapUsed || !bootstrapTokenMatches(req.body.adminBootstrapToken))) return res.status(403).json({ error: 'Administrator bootstrap is unavailable or invalid.' });
  const bootstrapAdmin = process.env.NODE_ENV === 'production'
    ? !hasAdmin && !db.settings.adminBootstrapUsed && bootstrapTokenMatches(req.body.adminBootstrapToken)
    : db.users.length === 0;
  if (bootstrapAdmin) db.settings.adminBootstrapUsed = true;
  const user = { id: id(), name: name.trim(), email: email.trim().toLowerCase(), password: await bcrypt.hash(password, 12), bio: '', role: bootstrapAdmin ? 'admin' : 'member', createdAt: new Date().toISOString(), lastSeen: null, aiPreferences: { enabled: false, smartReplies: false, scamAnalysis: false, summaries: false, translation: false, rewriting: false, actionExtraction: false, naturalSearch: false } };
  db.users.push(user); await save(); res.status(201).json({ token: tokenFor(user), user: publicUser(user) });
});
app.post('/api/auth/login', limitAuthByIp('login', loginIpLimit), async (req, res) => {
  const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (email.length > 254 || password.length > 128) return res.status(401).json({ error: 'Incorrect email or password.' });
  const accountKey = accountFailureKey(email);
  const failures = loginFailures.get(accountKey);
  const accountLimited = failures?.resetAt > Date.now() && failures.count >= loginAccountLimit;
  const user = db.users.find((u) => u.email === email);
  if (!user || !(await bcrypt.compare(password, user.password))) { if (accountLimited) return authRateLimited(res, failures); recordLoginFailure(email); return res.status(401).json({ error: 'Incorrect email or password.' }); }
  loginFailures.delete(accountKey);
  res.json({ token: tokenFor(user), user: publicUser(user) });
});
app.get('/api/me', authorize, (req, res) => res.json(publicUser(getUser(req))));
app.get('/api/ai/status', authorize, (req, res) => res.set('Cache-Control', 'no-store').json({ configured: ai.configured, provider: ai.providerName, model: ai.configured ? ai.model : null }));
app.get('/api/ai/preferences', authorize, (req, res) => res.set('Cache-Control', 'no-store').json({ preferences: aiPreferences(getUser(req)), configured: ai.configured }));
app.patch('/api/ai/preferences', authorize, async (req, res) => {
  const user = getUser(req); const current = aiPreferences(user);
  if (req.body.enabled === true && req.body.consent !== true) return res.status(400).json({ error: 'Confirm that enabled AI features may send selected message content to the configured external AI provider.' });
  const allowed = ['enabled', 'smartReplies', 'scamAnalysis', 'summaries', 'translation', 'rewriting', 'actionExtraction', 'naturalSearch'];
  const next = { ...current };
  for (const key of allowed) if (Object.hasOwn(req.body, key)) { if (typeof req.body[key] !== 'boolean') return res.status(400).json({ error: `AI preference ${key} must be true or false.` }); next[key] = req.body[key]; }
  if (next.enabled !== true) next.enabled = false;
  user.aiPreferences = next; await save();
  res.json({ preferences: next, configured: ai.configured });
});
app.post('/api/ai/smart-replies', authorize, aiConsent, async (req, res) => {
  const user = getUser(req); if (!aiPreferences(user).smartReplies) return res.status(403).json({ error: 'Smart replies are disabled in your AI preferences.' });
  const chat = db.chats.find((item) => item.id === req.body.chatId && item.memberIds.includes(user.id)); if (!chat) return res.status(404).json({ error: 'Conversation not found.' });
  const context = aiMessages(chat, user.id, Math.min(16, aiMaxContext)); if (!context.length || context.at(-1).mine) return res.json({ replies: [] });
  try { const key = crypto.createHash('sha256').update(JSON.stringify({ operation: 'replies', user: user.id, chat: chat.id, context })).digest('hex'); const result = await cachedAI(key, () => withAI(user, 'smartReplies', () => ai.smartReplies({ conversationType: chat.isGroup ? 'group' : 'direct', currentUser: user.name, history: context }))); res.json(result); }
  catch (error) { aiRouteError(res, error); }
});
app.post('/api/ai/conversations/:chatId/summarize', authorize, aiConsent, async (req, res) => {
  const user = getUser(req); if (!aiPreferences(user).summaries) return res.status(403).json({ error: 'Conversation summaries are disabled in your AI preferences.' });
  const chat = db.chats.find((item) => item.id === req.params.chatId && item.memberIds.includes(user.id)); if (!chat) return res.status(404).json({ error: 'Conversation not found.' });
  const context = aiMessages(chat, user.id); if (!context.length) return res.status(400).json({ error: 'There are not enough messages to summarize.' });
  try { const key = crypto.createHash('sha256').update(JSON.stringify({ operation: 'summary', user: user.id, chat: chat.id, context })).digest('hex'); const summary = await cachedAI(key, () => withAI(user, 'summaries', () => ai.summary({ conversationType: chat.isGroup ? 'group' : 'direct', messages: context, suppliedMessageCount: context.length, contextMayBeIncomplete: context.length >= aiMaxContext }))); res.json({ summary, messageCount: context.length, limitedContext: context.length >= aiMaxContext }); }
  catch (error) { aiRouteError(res, error); }
});
app.post('/api/ai/messages/:messageId/analyze', authorize, aiConsent, async (req, res) => {
  const user = getUser(req); const message = db.messages.find((item) => item.id === req.params.messageId && item.senderId !== user.id && !(item.deletedFor || []).includes(user.id));
  const chat = message && db.chats.find((item) => item.id === message.chatId && item.memberIds.includes(user.id)); if (!message || !chat) return res.status(404).json({ error: 'Message not found.' });
  user.aiScamAnalyses ||= {}; if (user.aiScamAnalyses[message.id]) return res.json({ analysis: user.aiScamAnalyses[message.id], cached: true });
  const jobKey = `scam:${user.id}:${message.id}`; if (aiJobs.has(jobKey)) return res.status(409).json({ error: 'This message is already being analyzed. Try again shortly.' });
  aiJobs.add(jobKey);
  try {
    const history = aiMessages(chat, user.id, 8);
    const analysis = await withAI(user, 'scamAnalysis', () => ai.scamAnalysis({ target: { sender: db.users.find((item) => item.id === message.senderId)?.name || 'Unknown', text: message.body.slice(0, 2000), createdAt: message.createdAt }, history }));
    const currentMessage = db.messages.find((item) => item.id === message.id && !item.deletedForEveryone && !(item.deletedFor || []).includes(user.id));
    if (!currentMessage || !aiPreferences(user).enabled || !aiPreferences(user).scamAnalysis) return res.status(404).json({ error: 'Message not found.' });
    const allowedEvidence = [message.body, ...history.map((item) => item.text)].join(' ').toLocaleLowerCase();
    analysis.evidence = analysis.evidence.filter((item) => allowedEvidence.includes(item.toLocaleLowerCase())); analysis.uncertain = true;
    user.aiScamAnalyses[message.id] = analysis; await save();
    io.to(`user:${user.id}`).emit('ai:scam-analysis:updated', { chatId: chat.id, messageId: message.id, analysis }); res.json({ analysis, cached: false });
  } catch (error) { aiRouteError(res, error); } finally { aiJobs.delete(jobKey); }
});
app.post('/api/ai/translate', authorize, aiConsent, async (req, res) => {
  const user = getUser(req); if (!aiPreferences(user).translation) return res.status(403).json({ error: 'Message translation is disabled in your AI preferences.' });
  const message = db.messages.find((item) => item.id === req.body.messageId && !(item.deletedFor || []).includes(user.id) && !item.deletedForEveryone);
  const chat = message && db.chats.find((item) => item.id === message.chatId && item.memberIds.includes(user.id));
  const language = String(req.body.language || '').trim(); if (!message || !chat) return res.status(404).json({ error: 'Message not found.' });
  if (!language || language.length > 60) return res.status(400).json({ error: 'Enter a target language up to 60 characters.' });
  try { res.json({ translation: await withAI(user, 'translation', () => ai.translate(message.body.slice(0, 4000), language)) }); } catch (error) { aiRouteError(res, error); }
});
app.post('/api/ai/rewrite', authorize, aiConsent, async (req, res) => {
  const user = getUser(req); if (!aiPreferences(user).rewriting) return res.status(403).json({ error: 'Draft rewriting is disabled in your AI preferences.' });
  const text = String(req.body.text || '').trim(); const tone = String(req.body.tone || 'friendly').trim();
  if (!text || text.length > 4000) return res.status(400).json({ error: 'Enter a draft between 1 and 4,000 characters.' });
  if (!['professional', 'friendly', 'concise', 'polite'].includes(tone)) return res.status(400).json({ error: 'Choose a supported rewrite tone.' });
  try { res.json({ text: await withAI(user, 'rewriting', () => ai.rewrite(text, tone)) }); } catch (error) { aiRouteError(res, error); }
});
app.post('/api/ai/conversations/:chatId/actions', authorize, aiConsent, async (req, res) => {
  const user = getUser(req); if (!aiPreferences(user).actionExtraction) return res.status(403).json({ error: 'Action extraction is disabled in your AI preferences.' });
  const chat = db.chats.find((item) => item.id === req.params.chatId && item.memberIds.includes(user.id)); if (!chat) return res.status(404).json({ error: 'Conversation not found.' });
  const context = aiMessages(chat, user.id); if (!context.length) return res.status(400).json({ error: 'There are not enough messages to inspect.' });
  try { res.json({ ...await withAI(user, 'actionExtraction', () => ai.actions({ messages: context, contextMayBeIncomplete: context.length >= aiMaxContext })), messageCount: context.length }); } catch (error) { aiRouteError(res, error); }
});
app.post('/api/ai/search', authorize, aiConsent, async (req, res) => {
  const user = getUser(req); if (!aiPreferences(user).naturalSearch) return res.status(403).json({ error: 'Natural-language search is disabled in your AI preferences.' });
  const query = String(req.body.query || '').trim(); if (!query || query.length > 300) return res.status(400).json({ error: 'Enter a search query up to 300 characters.' });
  const chats = db.chats.filter((item) => item.memberIds.includes(user.id));
  const chatById = new Map(chats.map((chat) => [chat.id, chat]));
  const candidates = db.messages.filter((message) => chatById.has(message.chatId) && !(message.deletedFor || []).includes(user.id) && !message.deletedForEveryone).slice(-100).map((message) => ({ id: message.id, chatId: message.chatId, conversation: chatById.get(message.chatId).name || peer(chatById.get(message.chatId), user.id)?.name || 'Conversation', sender: db.users.find((item) => item.id === message.senderId)?.name || 'Unknown', timestamp: message.createdAt, text: message.body.slice(0, 500) }));
  if (!candidates.length) return res.json({ results: [], limitedContext: false });
  try { const messageIds = await withAI(user, 'naturalSearch', () => ai.search(query, candidates)); const allowed = new Set(messageIds); res.json({ results: candidates.filter((item) => allowed.has(item.id)), limitedContext: candidates.length >= 100 }); }
  catch (error) { aiRouteError(res, error); }
});
app.get('/api/rtc-config', authorize, (req, res) => {
  const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL && process.env.TURN_SHARED_SECRET) {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const username = `${expiresAt}:${req.user.id}`;
    const credential = createHmac('sha1', process.env.TURN_SHARED_SECRET).update(username).digest('base64');
    iceServers.push({ urls: process.env.TURN_URL.split(',').map((value) => value.trim()), username, credential });
  }
  res.set('Cache-Control', 'no-store').json({ iceServers });
});
app.get('/api/push/public-key', authorize, (req, res) => res.set('Cache-Control', 'no-store').json({ enabled: vapidConfigured, publicKey: vapidConfigured ? vapidPublicKey : null }));
app.post('/api/push/subscriptions', authorize, async (req, res) => {
  if (!vapidConfigured) return res.status(503).json({ error: 'Background notifications are not configured on this server yet.' });
  const subscription = req.body;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return res.status(400).json({ error: 'A valid push subscription is required.' });
  let endpoint;
  try { endpoint = new URL(subscription.endpoint); } catch { return res.status(400).json({ error: 'Invalid push endpoint.' }); }
  const trustedPushHosts = ['fcm.googleapis.com', 'push.services.mozilla.com', 'web.push.apple.com', 'notify.windows.com'];
  if (endpoint.protocol !== 'https:' || !trustedPushHosts.some((host) => endpoint.hostname === host || endpoint.hostname.endsWith(`.${host}`))) return res.status(400).json({ error: 'Unsupported push service endpoint.' });
  db.pushSubscriptions = db.pushSubscriptions.filter((item) => item.userId !== req.user.id || item.subscription.endpoint !== subscription.endpoint);
  db.pushSubscriptions.push({ userId: req.user.id, subscription }); await save(); res.status(201).json({ ok: true });
});
app.delete('/api/push/subscriptions', authorize, async (req, res) => { const endpoint = String(req.body?.endpoint || ''); db.pushSubscriptions = db.pushSubscriptions.filter((item) => item.userId !== req.user.id || item.subscription.endpoint !== endpoint); await save(); res.status(204).end(); });
app.get('/api/calls/pending/:callId', authorize, (req, res) => {
  const pending = pendingCalls.get(req.params.callId);
  if (pending && pending.toUserId === req.user.id && pending.expiresAt >= Date.now() && !pending.answered) return res.set('Cache-Control', 'no-store').json(pending.payload);
  const groupCall = groupCalls.get(req.params.callId); const chat = groupCall && db.chats.find((item) => item.id === groupCall.chatId && item.memberIds.includes(req.user.id));
  if (groupCall && chat) return res.set('Cache-Control', 'no-store').json({ type: 'group', ...groupCallView(groupCall), from: publicUser(db.users.find((user) => user.id === groupCall.hostId)) });
  res.sendStatus(404);
});
app.patch('/api/me', authorize, async (req, res) => { const u = getUser(req); const name = String(req.body.name || '').trim(); if (!name) return res.status(400).json({ error: 'Name is required.' }); u.name = name; u.bio = String(req.body.bio || '').trim().slice(0, 160); await save(); res.json(publicUser(u)); });
app.post('/api/me/avatar', authorize, upload.single('avatar'), async (req, res) => { if (!req.file) return res.status(400).json({ error: 'Choose a JPEG, PNG, GIF, WebP, or AVIF image.' }); const detected = sniffContentType(req.file.path); if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'].includes(detected) || detected !== req.file.mimetype) { await fs.promises.unlink(req.file.path).catch(() => {}); return res.status(400).json({ error: 'The uploaded photo content does not match a supported image type.' }); } const u = getUser(req); u.avatar = `/uploads/${req.file.filename}`; u.avatarMime = detected; await save(); res.json(publicUser(u)); });

app.get('/api/users', authorize, (req, res) => { const q = String(req.query.q || '').toLowerCase(); res.json(db.users.filter((u) => u.id !== req.user.id && (!q || u.name.toLowerCase().includes(q) || u.email.includes(q))).map(publicUser)); });
app.get('/api/chats', authorize, (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const list = db.chats.filter((c) => c.memberIds.includes(req.user.id)).map((c) => chatView(c, req.user.id)).filter((c) => !q || c.title.toLowerCase().includes(q)).sort((a,b) => new Date(b.lastMessage?.createdAt || b.createdAt) - new Date(a.lastMessage?.createdAt || a.createdAt));
  res.json(list);
});
app.post('/api/chats', authorize, async (req, res) => {
  if (req.body.memberIds !== undefined && (!Array.isArray(req.body.memberIds) || req.body.memberIds.length > 99)) return res.status(400).json({ error: 'Choose up to 99 people for a conversation.' });
  const requestedName = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (requestedName.length > 60) return res.status(400).json({ error: 'Group names must be 60 characters or fewer.' });
  const ids = [...new Set([req.user.id, ...(req.body.memberIds || [])])];
  if (ids.length < 2 || ids.some((x) => typeof x !== 'string' || !db.users.some((u) => u.id === x))) return res.status(400).json({ error: 'Select at least one valid person.' });
  const isGroup = !!req.body.isGroup || ids.length > 2 || !!requestedName;
  let chat = !isGroup && db.chats.find((c) => !c.isGroup && c.memberIds.length === 2 && ids.every((x) => c.memberIds.includes(x)));
  const created = !chat;
  if (created) { chat = { id: id(), memberIds: ids, isGroup, name: isGroup ? requestedName || 'Untitled group' : null, createdBy: isGroup ? req.user.id : null, adminIds: isGroup ? [req.user.id] : [], createdAt: new Date().toISOString() }; db.chats.push(chat); await save(); }
  for (const memberId of ids) io.in(`user:${memberId}`).socketsJoin(`chat:${chat.id}`);
  if (created) for (const memberId of ids) if (memberId !== req.user.id) io.to(`user:${memberId}`).emit('chat:created', { chatId: chat.id });
  res.status(201).json(chatView(chat, req.user.id));
});
app.post('/api/chats/:chatId/members', authorize, async (req, res) => {
  const chat = db.chats.find((item) => item.id === req.params.chatId && item.isGroup && item.memberIds.includes(req.user.id));
  if (!chat) return res.status(404).json({ error: 'Group not found.' });
  if (!(chat.adminIds || []).includes(req.user.id)) return res.status(403).json({ error: 'Only group admins can add members.' });
  const requested = req.body.memberIds;
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > 50 || requested.some((memberId) => typeof memberId !== 'string')) return res.status(400).json({ error: 'Choose between 1 and 50 people to add.' });
  const ids = [...new Set(requested)].filter((memberId) => !chat.memberIds.includes(memberId));
  if (ids.some((memberId) => !db.users.some((user) => user.id === memberId))) return res.status(400).json({ error: 'One or more selected accounts do not exist.' });
  if (chat.memberIds.length + ids.length > 100) return res.status(400).json({ error: 'Groups can have up to 100 members.' });
  if (!ids.length) return res.status(400).json({ error: 'Choose someone who is not already in this group.' });
  chat.memberIds.push(...ids); await save();
  for (const memberId of ids) { io.in(`user:${memberId}`).socketsJoin(`chat:${chat.id}`); io.to(`user:${memberId}`).emit('chat:created', { chatId: chat.id }); }
  io.to(`chat:${chat.id}`).emit('group:updated', { chatId: chat.id });
  res.json(chatView(chat, req.user.id));
});
app.delete('/api/chats/:chatId/members/:userId', authorize, async (req, res) => {
  const chat = db.chats.find((item) => item.id === req.params.chatId && item.isGroup && item.memberIds.includes(req.user.id));
  if (!chat) return res.status(404).json({ error: 'Group not found.' });
  const targetId = req.params.userId;
  if (!chat.memberIds.includes(targetId)) return res.status(404).json({ error: 'Group member not found.' });
  const isLeaving = targetId === req.user.id;
  if (!isLeaving && !(chat.adminIds || []).includes(req.user.id)) return res.status(403).json({ error: 'Only group admins can remove other members.' });
  chat.memberIds = chat.memberIds.filter((memberId) => memberId !== targetId);
  chat.adminIds = (chat.adminIds || []).filter((memberId) => memberId !== targetId);
  if (chat.memberIds.length && !chat.adminIds.length) chat.adminIds = [chat.memberIds[0]];
  await save();
  io.in(`user:${targetId}`).socketsLeave(`chat:${chat.id}`);
  io.to(`user:${targetId}`).emit('group:removed', { chatId: chat.id, left: isLeaving });
  const activeCallId = activeGroupCallsByChat.get(chat.id); const activeCall = activeCallId && groupCalls.get(activeCallId);
  if (activeCall?.participants.has(targetId)) { io.in(`user:${targetId}`).socketsLeave(groupCallRoom(activeCall.id)); removeGroupCallParticipant(activeCall, targetId); io.to(`user:${targetId}`).emit('group-call:error', { callId: activeCall.id, message: 'You were removed from this group call.' }); }
  io.to(`chat:${chat.id}`).emit('group:updated', { chatId: chat.id });
  res.json(isLeaving ? { ok: true, left: true } : chatView(chat, req.user.id));
});
app.get('/api/chats/:chatId/messages', authorize, (req, res) => { const c = db.chats.find((x) => x.id === req.params.chatId && x.memberIds.includes(req.user.id)); if (!c) return res.status(404).json({ error: 'Chat not found.' }); const analyses = getUser(req).aiScamAnalyses || {}; res.json(db.messages.filter((m) => m.chatId === c.id && !(m.deletedFor || []).includes(req.user.id)).map((m) => ({ ...m, deliveredTo: m.deliveredTo || [], readBy: m.readBy || [], deletedFor: m.deletedFor || [], scamAnalysis: analyses[m.id] || null, sender: publicUser(db.users.find((u) => u.id === m.senderId)) }))); });
app.post('/api/chats/:chatId/messages', authorize, async (req, res) => {
  const c = db.chats.find((x) => x.id === req.params.chatId && x.memberIds.includes(req.user.id)); const body = String(req.body.body || '').trim();
  if (!c) return res.status(404).json({ error: 'Chat not found.' }); if (!body) return res.status(400).json({ error: 'Message cannot be empty.' });
  const clientId = String(req.body.clientId || '').slice(0, 80);
  const existing = clientId && db.messages.find((m) => m.chatId === c.id && m.senderId === req.user.id && m.clientId === clientId);
  if (existing) return res.json({ ...existing, sender: publicUser(db.users.find((u) => u.id === existing.senderId)) });
  const message = { id: id(), clientId: clientId || null, chatId: c.id, senderId: req.user.id, body, createdAt: new Date().toISOString(), deliveredTo: c.memberIds.filter((memberId) => memberId !== req.user.id && onlineUsers.has(memberId)), readBy: [], deletedFor: [] }; db.messages.push(message); await save();
  const result = { ...message, sender: publicUser(getUser(req)), scamAnalysis: null }; io.to(`chat:${c.id}`).emit('message:new', result); res.status(201).json(result); queueScamAnalysis(c, message);
});
app.delete('/api/chats/:chatId/messages/:messageId', authorize, async (req, res) => {
  const chat = db.chats.find((item) => item.id === req.params.chatId && item.memberIds.includes(req.user.id));
  const message = db.messages.find((item) => item.id === req.params.messageId && item.chatId === req.params.chatId);
  if (!chat || !message) return res.status(404).json({ error: 'Message not found.' });
  const scope = req.body?.scope;
  if (scope === 'me') {
    message.deletedFor ||= [];
    if (!message.deletedFor.includes(req.user.id)) message.deletedFor.push(req.user.id);
    const user = getUser(req); if (user.aiScamAnalyses) delete user.aiScamAnalyses[message.id];
    await save();
    io.to(`user:${req.user.id}`).emit('message:deleted', { chatId: chat.id, messageId: message.id, scope: 'me', userId: req.user.id });
    return res.json({ ok: true });
  }
  if (scope !== 'everyone') return res.status(400).json({ error: 'Choose whether to delete the message for you or everyone.' });
  if (message.senderId !== req.user.id) return res.status(403).json({ error: 'Only the sender can delete a message for everyone.' });
  if (!message.deletedForEveryone) { message.deletedForEveryone = true; message.deletedAt = new Date().toISOString(); message.body = ''; chat.memberIds.forEach((memberId) => { const user = db.users.find((item) => item.id === memberId); if (user?.aiScamAnalyses) delete user.aiScamAnalyses[message.id]; }); await save(); }
  const payload = { chatId: chat.id, messageId: message.id, scope: 'everyone', message: { ...message, sender: publicUser(db.users.find((user) => user.id === message.senderId)) } };
  io.to(`chat:${chat.id}`).emit('message:deleted', payload);
  res.json({ ok: true });
});
app.post('/api/chats/:chatId/files', authorize, (req, res, next) => { if (!db.chats.some((chat) => chat.id === req.params.chatId && chat.memberIds.includes(req.user.id))) return res.status(404).json({ error: 'Chat not found.' }); next(); }, upload.single('file'), async (req, res) => {
  const c = db.chats.find((x) => x.id === req.params.chatId && x.memberIds.includes(req.user.id)); if (!c || !req.file) return res.status(400).json({ error: 'A chat and file are required.' });
  const safeName = String(req.file.originalname || 'attachment').replace(/\\/g, '/').split('/').pop().replace(/[\r\n\0]/g, '').slice(0, 180) || 'attachment';
  const file = { id: id(), chatId: c.id, senderId: req.user.id, senderName: getUser(req).name, name: safeName, type: sniffContentType(req.file.path, req.file.mimetype), size: req.file.size, storageName: req.file.filename, createdAt: new Date().toISOString() }; db.files.push(file); await save(); io.to(`chat:${c.id}`).emit('file:new', { ...file, url: undefined }); res.status(201).json({ ...file, url: mediaUrl(file, req.user.id) });
});
app.get('/api/chats/:chatId/files', authorize, (req, res) => { const c = db.chats.find((x) => x.id === req.params.chatId && x.memberIds.includes(req.user.id)); if (!c) return res.status(404).json({ error: 'Chat not found.' }); res.json(db.files.filter((f) => f.chatId === c.id).map((file) => ({ ...file, url: mediaUrl(file, req.user.id) }))); });
app.post('/api/chats/:chatId/report', authorize, async (req, res) => { const c = db.chats.find((x) => x.id === req.params.chatId && x.memberIds.includes(req.user.id)); if (!c) return res.status(404).json({ error: 'Chat not found.' }); const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : ''; if (!reason || reason.length > 2000) return res.status(400).json({ error: 'Enter a report reason between 1 and 2,000 characters.' }); db.reports.push({ id: id(), chatId: c.id, reporterId: req.user.id, reason, createdAt: new Date().toISOString(), status: 'open' }); await save(); res.status(201).json({ ok: true }); });

app.get('/api/admin/summary', authorize, admin, (req,res) => res.json({ users: db.users.length, online: onlineUsers.size, chats: db.chats.length, messages: db.messages.length, reports: db.reports.filter((r) => r.status === 'open').length }));
app.get('/api/admin/users', authorize, admin, (req,res) => res.json(db.users.map(publicUser)));
app.delete('/api/admin/users/:id', authorize, admin, async (req,res) => { if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' }); const removedId = req.params.id; db.users = db.users.filter((u) => u.id !== removedId); db.chats = db.chats.filter((c) => !c.memberIds.includes(removedId)); db.pushSubscriptions = db.pushSubscriptions.filter((item) => item.userId !== removedId); await save(); io.in(`user:${removedId}`).disconnectSockets(true); onlineUsers.delete(removedId); emitPresence(removedId); res.status(204).end(); });
app.get('/api/admin/reports', authorize, admin, (req,res) => res.json(db.reports));
app.get('/api/admin/settings', authorize, admin, (req,res) => res.json(db.settings));
app.patch('/api/admin/settings', authorize, admin, async (req,res) => { if (typeof req.body.registrationOpen !== 'boolean') return res.status(400).json({ error: 'registrationOpen must be true or false.' }); db.settings = { ...db.settings, registrationOpen: req.body.registrationOpen }; await save(); res.json(db.settings); });

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.code === 'LIMIT_FILE_SIZE' || error?.type === 'entity.too.large') return res.status(413).json({ error: 'The request or uploaded file is too large.' });
  if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ error: 'Request JSON is invalid.' });
  return res.status(500).json({ error: 'The server could not complete that request.' });
});

io.use((socket, next) => { try { const claims = jwt.verify(socket.handshake.auth.token, secret); if (typeof claims?.id !== 'string' || !db.users.some((user) => user.id === claims.id)) return next(new Error('Unauthorized')); socket.user = { id: claims.id }; next(); } catch { next(new Error('Unauthorized')); } });
io.on('connection', (socket) => {
  socket.use(([event, payload], next) => {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return next(new Error('Invalid event payload.'));
    next();
  });
  const uid = socket.user.id;
  const wasOffline = !onlineUsers.has(uid);
  onlineUsers.set(uid, (onlineUsers.get(uid) || 0) + 1);
  socket.join(`user:${uid}`);
  if (wasOffline) emitPresence(uid);
  db.chats.filter((c) => c.memberIds.includes(uid)).forEach((c) => socket.join(`chat:${c.id}`));
  socket.on('chat:join', ({ chatId }) => { if (socketChat(socket, chatId)) socket.join(`chat:${chatId}`); });
  socket.on('typing', ({ chatId, active }) => { if (socketChat(socket, chatId)) socket.to(`chat:${chatId}`).emit('typing', { chatId, userId: uid, active: !!active }); });
  socket.on('messages:read', async ({ chatId, messageIds }) => {
    const chat = socketChat(socket, chatId); if (!chat || !Array.isArray(messageIds)) return;
    const requested = new Set(messageIds.slice(0, 200).map(String)); const changed = [];
    for (const message of db.messages) {
      if (message.chatId !== chatId || message.senderId === uid || !requested.has(message.id) || (message.deletedFor || []).includes(uid)) continue;
      message.deliveredTo ||= []; message.readBy ||= [];
      let touched = false;
      if (!message.deliveredTo.includes(uid)) { message.deliveredTo.push(uid); touched = true; }
      if (!message.readBy.includes(uid)) { message.readBy.push(uid); touched = true; }
      if (touched) changed.push(message);
    }
    if (!changed.length) return;
    await save();
    changed.forEach((message) => io.to(`user:${message.senderId}`).emit('message:status', { chatId, messageId: message.id, deliveredTo: message.deliveredTo, readBy: message.readBy }));
  });
  socket.on('call:offer', async ({ chatId, callId: requestedCallId, offer, video, targetId }) => {
    const c = socketChat(socket, chatId); if (!c || c.isGroup || !c.memberIds.includes(targetId) || targetId === uid || !offer || typeof offer.sdp !== 'string') return;
    const callId = String(requestedCallId || id()); if (callId.length > 100 || pendingCalls.has(callId) || activeDirectCalls.has(callId)) return;
    const payload = { callId, chatId, offer, video: !!video, from: publicUser(db.users.find((u) => u.id === uid)) };
    const pending = { fromUserId: uid, toUserId: targetId, chatId, payload, expiresAt: Date.now() + 45000, iceCandidates: [], answered: false };
    pendingCalls.set(callId, pending); setTimeout(() => { if (pendingCalls.get(callId) === pending) pendingCalls.delete(callId); }, 45000);
    io.to(`user:${targetId}`).emit('call:incoming', payload);
    await pushToUser(targetId, { callId, chatId, from: payload.from.name, video: !!video }, 45);
  });
  socket.on('call:answer', async ({ chatId, callId, answer, targetId }) => {
    const c = socketChat(socket, chatId); const pending = pendingCalls.get(callId);
    if (!c || c.isGroup || !pending || pending.answered || pending.chatId !== chatId || pending.toUserId !== uid || pending.fromUserId !== targetId || !answer || answer.type !== 'answer' || typeof answer.sdp !== 'string') return;
    pending.answered = true; pendingCalls.delete(callId); activeDirectCalls.set(callId, { fromUserId: targetId, toUserId: uid, chatId });
    pending.iceCandidates.forEach((candidate) => socket.emit('call:ice', { chatId, callId, candidate, from: targetId }));
    io.to(`user:${targetId}`).emit('call:answer', { chatId, callId, answer, from: uid }); socket.to(`user:${uid}`).emit('call:answered-elsewhere', { chatId, callId, from: targetId }); await pushToUser(uid, { callId, dismissed: true });
  });
  socket.on('call:ice', ({ chatId, callId, candidate, targetId }) => {
    const c = socketChat(socket, chatId); if (!c || c.isGroup || !c.memberIds.includes(targetId) || !candidate) return;
    const pending = pendingCalls.get(callId);
    if (pending && !pending.answered && pending.chatId === chatId && pending.fromUserId === uid && pending.toUserId === targetId) pending.iceCandidates.push(candidate);
    else { const active = activeDirectCalls.get(callId); if (active?.chatId === chatId && ((active.fromUserId === uid && active.toUserId === targetId) || (active.toUserId === uid && active.fromUserId === targetId))) io.to(`user:${targetId}`).emit('call:ice', { chatId, callId, candidate, from: uid }); }
  });
  socket.on('call:end', async ({ chatId, callId, targetId }) => {
    const c = socketChat(socket, chatId); if (!c || c.isGroup || !c.memberIds.includes(targetId)) return;
    const pending = pendingCalls.get(callId); const active = activeDirectCalls.get(callId);
    const validPending = pending?.chatId === chatId && ((pending.fromUserId === uid && pending.toUserId === targetId) || (pending.toUserId === uid && pending.fromUserId === targetId));
    const validActive = active?.chatId === chatId && ((active.fromUserId === uid && active.toUserId === targetId) || (active.toUserId === uid && active.fromUserId === targetId));
    if (!validPending && !validActive) return;
    pendingCalls.delete(callId); activeDirectCalls.delete(callId);
    if (validPending && pending.toUserId === uid) socket.to(`user:${uid}`).emit('call:answered-elsewhere', { chatId, callId, from: targetId });
    io.to(`user:${targetId}`).emit('call:end', { chatId, callId, from: uid });
    await Promise.all([pushToUser(uid, { callId, dismissed: true }), pushToUser(targetId, { callId, dismissed: true })]);
  });
  socket.on('group-call:start', async ({ chatId, callId: requestedCallId, video }) => {
    const chat = socketChat(socket, chatId); if (!chat?.isGroup || chat.memberIds.length < 2) return socket.emit('group-call:error', { message: 'Group calls need a valid group chat.' });
    const activeId = activeGroupCallsByChat.get(chatId); const activeCall = activeId && groupCalls.get(activeId);
    if (activeCall) return socket.emit('group-call:already-active', groupCallView(activeCall));
    const callId = String(requestedCallId || id()); const groupCall = { id: callId, chatId, name: chat.name, hostId: uid, video: !!video, participants: new Map([[uid, socket.id]]), createdAt: Date.now() };
    groupCalls.set(callId, groupCall); activeGroupCallsByChat.set(chatId, callId); socket.join(groupCallRoom(callId));
    socket.emit('group-call:participants', { callId, participants: [] });
    const payload = { type: 'group', callId, chatId, video: groupCall.video, groupName: chat.name, from: publicUser(db.users.find((user) => user.id === uid)) };
    await Promise.all(chat.memberIds.filter((memberId) => memberId !== uid).map(async (memberId) => {
      io.to(`user:${memberId}`).emit('group-call:incoming', payload);
      await pushToUser(memberId, { callId, chatId, from: payload.from.name, groupName: chat.name, video: groupCall.video, group: true }, 45);
    }));
  });
  socket.on('group-call:join', async ({ callId }) => {
    const groupCall = groupCalls.get(callId); const chat = groupCall && socketChat(socket, groupCall.chatId);
    if (!groupCall || !chat?.isGroup) return socket.emit('group-call:error', { callId, message: 'This group call has ended.' });
    if (groupCall.participants.has(uid)) return socket.emit('group-call:error', { callId, message: 'Your account is already connected to this group call on another device.' });
    if (groupCall.participants.size >= 6) return socket.emit('group-call:error', { callId, message: 'This group call has reached its six-person limit.' });
    const participants = groupCallView(groupCall).participants;
    groupCall.participants.set(uid, socket.id); socket.join(groupCallRoom(callId));
    socket.emit('group-call:participants', { callId, participants });
    io.to(groupCallRoom(callId)).emit('group-call:participant-joined', { callId, participant: publicUser(db.users.find((user) => user.id === uid)) });
    socket.to(`user:${uid}`).emit('group-call:answered-elsewhere', { callId });
    await pushToUser(uid, { callId, dismissed: true });
  });
  socket.on('group-call:decline', async ({ callId }) => { const groupCall = groupCalls.get(callId); const chat = groupCall && socketChat(socket, groupCall.chatId); if (!chat?.isGroup || groupCall.participants.has(uid)) return; socket.to(`user:${uid}`).emit('group-call:answered-elsewhere', { callId }); io.to(groupCallRoom(callId)).emit('group-call:declined', { callId, user: publicUser(db.users.find((user) => user.id === uid)) }); await pushToUser(uid, { callId, dismissed: true }); });
  socket.on('group-call:offer', ({ callId, targetId, offer }) => { const groupCall = groupCalls.get(callId); const chat = groupCall && socketChat(socket, groupCall.chatId); const targetSocketId = groupCall?.participants.get(targetId); if (chat?.isGroup && groupCall.participants.get(uid) === socket.id && targetSocketId && targetId !== uid) io.to(targetSocketId).emit('group-call:offer', { callId, from: uid, offer }); });
  socket.on('group-call:answer', ({ callId, targetId, answer }) => { const groupCall = groupCalls.get(callId); const chat = groupCall && socketChat(socket, groupCall.chatId); const targetSocketId = groupCall?.participants.get(targetId); if (chat?.isGroup && groupCall.participants.get(uid) === socket.id && targetSocketId) io.to(targetSocketId).emit('group-call:answer', { callId, from: uid, answer }); });
  socket.on('group-call:ice', ({ callId, targetId, candidate }) => { const groupCall = groupCalls.get(callId); const chat = groupCall && socketChat(socket, groupCall.chatId); const targetSocketId = groupCall?.participants.get(targetId); if (chat?.isGroup && groupCall.participants.get(uid) === socket.id && targetSocketId) io.to(targetSocketId).emit('group-call:ice', { callId, from: uid, candidate }); });
  socket.on('group-call:leave', ({ callId }) => { const groupCall = groupCalls.get(callId); if (!groupCall || groupCall.participants.get(uid) !== socket.id) return; socket.leave(groupCallRoom(callId)); removeGroupCallParticipant(groupCall, uid); });
  socket.on('disconnect', async () => {
    for (const [callId, pending] of pendingCalls) if (pending.fromUserId === uid || pending.toUserId === uid) { pendingCalls.delete(callId); const otherId = pending.fromUserId === uid ? pending.toUserId : pending.fromUserId; io.to(`user:${otherId}`).emit('call:end', { chatId: pending.chatId, callId, from: uid }); await pushToUser(otherId, { callId, dismissed: true }); }
    for (const [callId, active] of activeDirectCalls) if (active.fromUserId === uid || active.toUserId === uid) { activeDirectCalls.delete(callId); const otherId = active.fromUserId === uid ? active.toUserId : active.fromUserId; io.to(`user:${otherId}`).emit('call:end', { chatId: active.chatId, callId, from: uid }); await pushToUser(otherId, { callId, dismissed: true }); }
    for (const groupCall of groupCalls.values()) if (groupCall.participants.get(uid) === socket.id) removeGroupCallParticipant(groupCall, uid);
    const n = (onlineUsers.get(uid) || 1) - 1;
    if (n) onlineUsers.set(uid, n); else { onlineUsers.delete(uid); const u = db.users.find((x) => x.id === uid); if (u) { u.lastSeen = new Date().toISOString(); await save(); } emitPresence(uid); }
  });
});

async function start() {
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS whispr_state (id INTEGER PRIMARY KEY CHECK (id = 1), state JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const { rows } = await pool.query('SELECT state FROM whispr_state WHERE id = 1');
    if (rows[0]) db = rows[0].state;
    else await pool.query('INSERT INTO whispr_state (id, state) VALUES (1, $1::jsonb)', [JSON.stringify(db)]);
    migrationNeeded = false;
    if (!db.settings) { db.settings = { registrationOpen: true }; migrationNeeded = true; }
    if (db.settings.registrationOpen == null) { db.settings.registrationOpen = true; migrationNeeded = true; }
    if (db.settings.adminBootstrapUsed == null) { db.settings.adminBootstrapUsed = db.users?.some((user) => user.role === 'admin') || false; migrationNeeded = true; }
    for (const key of ['users', 'chats', 'messages', 'files', 'reports', 'pushSubscriptions']) if (!Array.isArray(db[key])) { db[key] = []; migrationNeeded = true; }
    migrationNeeded = migrateGroups() || migrationNeeded;
    if (migrationNeeded) await pool.query('UPDATE whispr_state SET state = $1::jsonb, updated_at = NOW() WHERE id = 1', [JSON.stringify(db)]);
    console.log('Persistent PostgreSQL storage is active.');
  } else {
    if (migrationNeeded) await save();
    if (process.env.NODE_ENV === 'production') console.warn('DATABASE_URL is not set. Data is using local JSON storage and may be lost on redeploy.');
  }
  server.listen(process.env.PORT || 3000, () => console.log(`Whispr is running on port ${process.env.PORT || 3000}`));
}
start().catch((error) => { console.error('Whispr failed to start:', error); process.exit(1); });
