import { createServer } from 'node:http';
import { timingSafeEqual, createHmac, randomBytes } from 'node:crypto';
import { readFile, readdir, mkdir, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { openMessages, storedMessageId } from './messages.mjs';
import { openStore } from './store.mjs';
import { mcpHandler } from './mcp.mjs';
import { openAiConfig, createRouterClient, buildAiMessages } from './ai.mjs';
import { createAutoReply } from './auto-reply.mjs';
import { extractKnowledgePdf } from './pdf-knowledge.mjs';
import { readConversation } from './read-receipts.mjs';
import { createInstanceManager } from './instance-manager.mjs';

const token = process.env.GATEWAY_TOKEN;
if (!token || token.length < 32) throw new Error('GATEWAY_TOKEN must contain at least 32 characters');
const logger = pino({ level: 'silent' });
const dbPath = process.env.MESSAGE_DB || ':memory:';
const messages = openMessages(dbPath);
const store = openStore(dbPath);
for (;;) {
  const legacyPdfs = store.knowledge.pendingPdfExtraction();
  if (!legacyPdfs.length) break;
  for (const legacy of legacyPdfs) {
    try { store.knowledge.saveExtractedPdf(legacy.id, await extractKnowledgePdf(legacy.content)); }
    catch { store.knowledge.markPdfNeedsUpload(legacy.id); }
  }
}
const aiConfig = openAiConfig(dbPath, token);
const currentAgent = store.agent('default');
if (store.settings().autoReply && (!currentAgent.enabled || !currentAgent.instructions.trim() || !aiConfig.publicConfig().hasApiKey)) store.saveSettings({ autoReply: false });
let autoReplyFailure = null;
const aiRouter = createRouterClient(aiConfig);
const autoReply = createAutoReply({ store, config: aiConfig, router: aiRouter, messages, buildMessages: buildAiMessages,
  onError: error => {
    const code = Number.isInteger(error?.status) ? error.status : 500;
    const message = error?.fallbackSent ? 'Balasan bantuan sudah dikirim; koneksi AI perlu diperiksa.'
      : code === 400 ? 'Konfigurasi AI tidak valid.'
      : code === 401 ? 'API key 9Router ditolak.'
        : code === 422 ? 'Model 9Router tidak tersedia atau responsnya tidak valid.'
          : code === 502 ? '9Router atau pengiriman WhatsApp gagal setelah beberapa percobaan.'
            : 'Balasan AI gagal diproses.';
    autoReplyFailure = { code, message, at: Date.now() };
    console.error(`AI auto-reply failed (status=${code})`);
  },
  onSuccess: () => { autoReplyFailure = null; },
});
const handleMcp = mcpHandler({ token: process.env.MCP_TOKEN, messages, getStatus: () => status });

let status = 'idle';
let qr = null;
let socket = null;
let retry = null;
let stopping = false;
let connectionGeneration = 0;
let retryAttempt = 0;
let connectedAt = null;
let lastClose = null;

const sessionDir = process.env.SESSION_DIR || './session';
let auth = await useMultiFileAuthState(sessionDir);
let state = auth.state;
let saveCreds = auth.saveCreds;
const hasSession = () => Boolean(state.creds?.me || state.creds?.registered);

// Controlled re-pairing: archive the current linked-device credentials, then start
// from a clean auth state. Never deletes the old session without a copy on disk.
async function resetSession() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archive = join(process.env.SESSION_BACKUP_DIR || join(sessionDir, '..', 'session-backups'), stamp);
  await mkdir(archive, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(sessionDir)) {
    if (entry === 'session-backups') continue;
    await cp(join(sessionDir, entry), join(archive, entry), { recursive: true, force: true });
  }
  for (const entry of await readdir(sessionDir)) {
    if (entry === 'session-backups') continue;
    await rm(join(sessionDir, entry), { recursive: true, force: true });
  }
  auth = await useMultiFileAuthState(sessionDir);
  state = auth.state;
  saveCreds = auth.saveCreds;
  return archive;
}

const loginAttempts = new Map();
const equal = (a, b) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const sign = value => createHmac('sha256', token).update(value).digest('hex');
function sessionValid(cookie = '') {
  const value = cookie.split(';').map(x => x.trim()).find(x => x.startsWith('chat_session='))?.slice(13);
  if (!value) return false;
  const [expires, nonce, signature] = value.split('.');
  return Number(expires) > Date.now() && !!nonce && !!signature && equal(sign(`${expires}.${nonce}`), signature);
}

const loginHtml = `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Masuk Chat WA Bot</title><body><main><h1>Masuk Chat WA Bot</h1><p>Gunakan akun dashboard, bukan password SSH VPS.</p><form method="post" action="/login"><p><label>Username <input name="username" autocomplete="username" required value="admin"></label></p><p><label>Password <input type="password" name="password" autocomplete="current-password" required></label></p><button type="submit">Masuk dashboard</button></form></main></body></html>`;

function statusPayload() {
  return {
    status,
    connectedAt,
    lastClose,
    hasSession: hasSession(),
    retryPending: Boolean(retry),
    aiReplyFailure: autoReplyFailure,
  };
}

function scheduleRetry(delay) {
  if (stopping) return;
  clearTimeout(retry);
  retry = setTimeout(() => { retry = null; connect(); }, delay);
}

function retire(target) {
  try { target.ev.removeAllListeners(); } catch {}
  try { target.end(undefined); } catch {}
}

function connect() {
  if (stopping) return;
  const generation = ++connectionGeneration;
  clearTimeout(retry);
  retry = null;
  qr = null;
  status = 'connecting';

  let current;
  try {
    current = makeWASocket({ auth: state, logger, markOnlineOnConnect: false, syncFullHistory: false });
  } catch (error) {
    status = 'disconnected';
    lastClose = { code: null, at: Date.now(), reason: 'socket-init-failed' };
    console.error(`WhatsApp socket could not start: ${error?.message ?? 'unknown'}`);
    scheduleRetry(Math.min(30000, 2000 * 2 ** retryAttempt++));
    return;
  }

  socket = current;
  const isCurrent = () => generation === connectionGeneration && socket === current;
  const replyTo = message => autoReply(message, { isCurrent: () => isCurrent() && status === 'connected', send: (jid, payload) => current.sendMessage(jid, payload), markRead: item => readConversation(messages, isCurrent() && status === 'connected' ? current : null, item.jid, [item.id], 'default') });

  current.ev.on('creds.update', () => {
    if (!isCurrent()) return;
    saveCreds().catch(() => console.error('Unable to persist WhatsApp credentials'));
  });

  current.ev.on('messages.upsert', ({ messages: batch }) => {
    if (!isCurrent()) return;
    try {
      for (const message of batch) {
        const jid = message.key?.remoteJid;
        const text = message.message?.conversation || message.message?.extendedTextMessage?.text;
        if (!jid || !message.key?.id || !text || !/\@(s\.whatsapp\.net|lid)$/.test(jid)) continue;
        const saved = { id: storedMessageId('default', message.key.id), waId: message.key.id, jid, text, name: message.pushName || '', outgoing: Boolean(message.key.fromMe), status: message.status, timestamp: Number(message.messageTimestamp) * 1000 || Date.now(), instanceId: 'default' };
        const fresh = messages.add(saved);
        if (!saved.outgoing && Math.abs(Date.now() - saved.timestamp) < 120000) {
          void replyTo(fresh ? saved : messages.byId(saved.id));
        }
      }
    } catch { console.error('Unable to persist incoming messages'); }
  });

  current.ev.on('messages.update', updates => {
    if (!isCurrent()) return;
    for (const { key, update } of updates) messages.updateReceipt(key, update.status, 'default');
  });
  current.ev.on('message-receipt.update', updates => {
    if (!isCurrent()) return;
    for (const { key, receipt } of updates) messages.updateReceipt(key, receipt.readTimestamp || receipt.playedTimestamp ? 4 : receipt.receiptTimestamp ? 3 : 0, 'default');
  });

  current.ev.on('connection.update', update => {
    // A superseded socket must never overwrite the state owned by the newest socket.
    if (!isCurrent()) return;

    if (update.qr) { qr = update.qr; status = 'awaiting_scan'; }

    if (update.connection === 'open') {
      qr = null;
      status = 'connected';
      connectedAt = Date.now();
      retryAttempt = 0;
      lastClose = null;
      console.error('WhatsApp connection open');
      for (const id of aiConfig.pendingReplies()) {
        const message = messages.byId(id);
        if (message && !message.outgoing) void replyTo(message);
      }
    }

    if (update.connection === 'close') {
      qr = null;
      const code = update.lastDisconnect?.error?.output?.statusCode ?? null;
      const reason = update.lastDisconnect?.error?.message ?? 'unknown';
      lastClose = { code, at: Date.now(), reason: String(reason).slice(0, 200) };
      console.error(`WhatsApp connection closed: code=${code ?? 'unknown'} message=${String(reason).slice(0, 200)}`);
      // The stream is already closed here. Calling end() again would send an extra
      // close frame and can make WhatsApp unlink the freshly paired device.
      try { current.ev.removeAllListeners(); } catch {}
      if (socket === current) socket = null;

      if (code === DisconnectReason.loggedOut) {
        status = 'logged_out';
        console.error('WhatsApp session logged out; controlled re-pairing required');
        return;
      }
      if (stopping) { status = 'idle'; return; }

      status = 'disconnected';
      // 515 restart-required is expected right after a fresh pairing; reconnect quickly.
      const delay = code === DisconnectReason.restartRequired ? 1500 : Math.min(30000, 2000 * 2 ** retryAttempt++);
      scheduleRetry(delay);
    }
  });
}

async function connectPrimary() {
  if (status === 'logged_out') throw Object.assign(new Error('Sesi keluar. Putuskan perangkat lalu hubungkan ulang untuk membuat QR baru.'), { status: 409 });
  store.instances.setEnabled('default', true);
  if (status === 'connected') return statusPayload();
  if (status === 'awaiting_scan') {
    connectionGeneration++; qr = null; if (socket) retire(socket); socket = null;
  }
  connect();
  return statusPayload();
}

async function disconnectPrimary() {
  store.instances.setEnabled('default', false);
  stopping = true; clearTimeout(retry); retry = null; connectionGeneration++;
  const previous = socket; socket = null; const wasConnected = status === 'connected';
  qr = null; status = 'idle'; connectedAt = null;
  try {
    if (previous) {
      try { previous.ev.removeAllListeners(); if (wasConnected) await previous.logout(); else previous.end(undefined); } catch { try { previous.end(undefined); } catch {} }
    }
    await resetSession();
  } finally { stopping = false; }
  return statusPayload();
}

const instanceManager = createInstanceManager({ store, messages, config: aiConfig, router: aiRouter, buildMessages: buildAiMessages, primaryStatus: statusPayload, primaryConnect: connectPrimary, primaryDisconnect: disconnectPrimary });

async function readJson(req, limit = 1_000_000) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw Object.assign(new Error('Payload terlalu besar'), { status: 413 });
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('JSON tidak valid'), { status: 400 }); }
}

const send = (res, code, payload) => { res.writeHead(code); res.end(JSON.stringify(payload)); };

const server = createServer(async (req, res) => {
  if (req.url === '/mcp') { await handleMcp(req, res); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/login' && req.method === 'GET') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(loginHtml); return;
  }
  if (req.url === '/login' && req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin !== `https://${req.headers.host}` && origin !== `http://${req.headers.host}`) { res.writeHead(403); res.end(); return; }
    const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
    const now = Date.now();
    if (loginAttempts.size > 10000) for (const [key, entry] of loginAttempts) if (entry.until < now) loginAttempts.delete(key);
    const attempt = loginAttempts.get(ip) || { count: 0, until: now + 60000 };
    if (attempt.until < now) { attempt.count = 0; attempt.until = now + 60000; }
    if (++attempt.count > 10) { send(res, 429, { error: 'Terlalu banyak percobaan. Tunggu satu menit.' }); return; }
    loginAttempts.set(ip, attempt);
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 4096) { res.writeHead(413); res.end(); return; } }
    const fields = new URLSearchParams(body);
    // The generated hex password cannot contain whitespace; terminal copies may include a newline.
    const submittedPassword = (fields.get('password') || '').trim();
    if (!process.env.DASHBOARD_PASSWORD || !equal((fields.get('username') || '').trim(), 'admin') || !equal(submittedPassword, process.env.DASHBOARD_PASSWORD)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(401);
      res.end(loginHtml.replace('<form ', '<p role="alert">Username atau password dashboard belum cocok. Gunakan admin dan password dashboard 48 karakter, bukan password SSH. Jangan sertakan tulisan DASHBOARD_PASSWORD=.</p><form ')); return;
    }
    const value = `${now + 8 * 3600000}.${randomBytes(24).toString('hex')}`;
    res.setHeader('Set-Cookie', `chat_session=${value}.${sign(value)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`);
    res.writeHead(303, { Location: '/' }); res.end(); return;
  }

  const supplied = Buffer.from(req.headers.authorization || '');
  const valid = (value) => {
    const expected = Buffer.from(value);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  const dashboardAuth = sessionValid(req.headers.cookie) || (process.env.DASHBOARD_PASSWORD && valid(`Basic ${Buffer.from(`admin:${process.env.DASHBOARD_PASSWORD}`).toString('base64')}`));
  if (!valid(`Bearer ${token}`) && !dashboardAuth) {
    if (req.url === '/') { res.writeHead(303, { Location: '/login' }); res.end(); return; }
    send(res, 401, { error: 'Unauthorized' }); return;
  }

  try {
    if (dashboardAuth && req.method !== 'GET' && req.headers['sec-fetch-site'] !== 'same-origin') {
      send(res, 403, { error: 'Same-origin request required' }); return;
    }

    const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/whatsapp.js': ['whatsapp.js', 'text/javascript'], '/inbox.js': ['inbox.js', 'text/javascript'] };
    if (req.method === 'GET' && assets[req.url] && process.env.DASHBOARD_DIR) {
      const [file, type] = assets[req.url];
      const data = await readFile(`${process.env.DASHBOARD_DIR}/${file}`);
      res.setHeader('Content-Type', type); res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(data); return;
    }

    if (req.url.startsWith('/api/whatsapp/')) req.url = req.url.slice('/api/whatsapp'.length);
    if (req.method === 'POST' && req.url === '/logout') {
      res.setHeader('Set-Cookie', 'chat_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
      send(res, 200, { status: 'signed_out' }); return;
    }

    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method;

    if (method === 'GET' && path === '/instances') { send(res, 200, await instanceManager.list()); return; }
    if (method === 'POST' && path === '/instances') { const body = await readJson(req, 4096); send(res, 201, await instanceManager.create(body.label)); return; }
    const instanceDelete = path.match(/^\/instances\/([0-9a-f-]{36})$/i);
    if (method === 'DELETE' && instanceDelete) { send(res, 200, await instanceManager.remove(instanceDelete[1])); return; }

    const selectedInstance = url.searchParams.get('instance') || 'default';
    if (method === 'GET' && path === '/status') { send(res, 200, await instanceManager.status(selectedInstance)); return; }

    if (method === 'GET' && path === '/qr') {
      if (selectedInstance !== 'default') { send(res, 200, await instanceManager.qr(selectedInstance)); return; }
      if (!qr) { send(res, 409, statusPayload()); return; }
      send(res, 200, { image: await QRCode.toDataURL(qr) }); return;
    }

    if (method === 'POST' && path === '/connect') {
      send(res, 200, await instanceManager.connect(selectedInstance)); return;
    }

    if (method === 'POST' && path === '/disconnect') {
      send(res, 200, await instanceManager.disconnect(selectedInstance)); return;
    }

    if (method === 'POST' && path === '/re-pair') {
      const body = await readJson(req, 4096);
      if (body.confirm !== 'PAIRING-ULANG') { send(res, 400, { error: 'Konfirmasi "PAIRING-ULANG" diperlukan.' }); return; }
      if (status === 'connected') { send(res, 409, { error: 'Koneksi masih aktif. Putuskan dulu sebelum pairing ulang.' }); return; }
      store.instances.setEnabled('default', true);
      connectionGeneration++;
      if (socket) retire(socket);
      socket = null;
      clearTimeout(retry); retry = null;
      const archived = await resetSession();
      retryAttempt = 0; lastClose = null; connectedAt = null;
      connect();
      send(res, 200, { ...statusPayload(), archived });
      return;
    }

    if (method === 'GET' && path === '/conversations') { send(res, 200, messages.list()); return; }
    if (method === 'GET' && path === '/messages') { send(res, 200, messages.thread(url.searchParams.get('jid') || '', url.searchParams.get('instance') || 'default')); return; }

    if (method === 'GET' && path === '/labels') { send(res, 200, messages.labels()); return; }
    if (method === 'POST' && path === '/labels') { send(res, 200, messages.saveLabel(await readJson(req, 4000))); return; }
    if (method === 'DELETE' && /^\/labels\/[a-zA-Z0-9-]{1,64}$/.test(path)) { send(res, 200, { removed: messages.deleteLabel(path.split('/')[2]) }); return; }
    if (method === 'POST' && path === '/conversations/labels') {
      const body = await readJson(req, 12000);
      messages.setLabels(body.jid, body.labelIds);
      send(res, 200, { saved: true }); return;
    }
    if (method === 'POST' && path === '/conversations/unread') {
      const body = await readJson(req, 4000);
      messages.markUnread(body.jid, body.instanceId || 'default');
      send(res, 200, { unread: true }); return;
    }
    if (method === 'POST' && path === '/conversations/read') {
      const body = await readJson(req, 50000);
      const instanceId = body.instanceId || 'default';
      send(res, 200, instanceId === 'default'
        ? await readConversation(messages, status === 'connected' ? socket : null, body.jid, body.ids, instanceId)
        : await instanceManager.read(instanceId, body.jid, body.ids)); return;
    }

    if (method === 'POST' && path === '/send') {
      const body = await readJson(req, 200000);
      const phone = String(body.phone || '').replace(/\D/g, '').replace(/^0/, '62');
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if ((body.jid === undefined && !/^\d{8,15}$/.test(phone)) || !text || text.length > 4000) { send(res, 400, { error: 'Nomor atau pesan tidak valid' }); return; }
      const jid = body.jid === undefined ? `${phone}@s.whatsapp.net` : body.jid;
      let instanceId = body.instanceId || (body.jid ? messages.instanceForConversation(jid) : 'default');
      if (body.jid === undefined && !body.instanceId && status !== 'connected') instanceId = (await instanceManager.list()).find(item => item.status === 'connected')?.id || 'default';
      if (body.jid !== undefined && (typeof jid !== 'string' || !/^\d+@(s\.whatsapp\.net|lid)$/.test(jid) || !messages.hasConversation(jid, instanceId))) { send(res, 400, { error: 'Percakapan tidak valid.' }); return; }
      let result;
      if (instanceId === 'default') {
        if (status !== 'connected' || !socket) { send(res, 409, { error: 'Nomor WhatsApp utama belum terhubung.' }); return; }
        result = await socket.sendMessage(jid, { text });
      } else result = await instanceManager.send(instanceId, jid, text);
      const id = storedMessageId(instanceId, result.key.id);
      messages.add({ id, waId: result.key.id, jid, text, name: '', outgoing: true, status: result.status, timestamp: Date.now(), instanceId });
      send(res, 200, { id, status: 'submitted' }); return;
    }

    if (method === 'GET' && path === '/settings') { send(res, 200, store.settings()); return; }
    if (method === 'POST' && path === '/settings') {
      const patch = await readJson(req, 12000000);
      if (typeof patch.shippingPdfContent === 'string' && patch.shippingPdfMime === 'application/pdf') {
        patch.shippingPdfText = await extractKnowledgePdf(patch.shippingPdfContent);
      }
      const agent = store.agent('default');
      if (patch.autoReply === true && (!agent.enabled || !agent.instructions.trim() || !aiConfig.publicConfig().hasApiKey)) {
        send(res, 409, { error: 'Simpan instruksi AI Agent dan koneksi API key 9Router sebelum mengaktifkan balasan AI.' }); return;
      }
      send(res, 200, store.saveSettings(patch)); return;
    }

    if (method === 'GET' && path === '/agent') { send(res, 200, store.agent(url.searchParams.get('instance') || 'default')); return; }
    if (method === 'POST' && path === '/agent') { send(res, 200, store.saveAgent(await readJson(req, 10000000))); return; }

    if (method === 'GET' && path === '/ai/config') { send(res, 200, aiConfig.publicConfig()); return; }
    if (method === 'POST' && path === '/ai/config') { send(res, 200, aiConfig.save(await readJson(req, 12000))); return; }
    if (method === 'GET' && path === '/ai/models') { send(res, 200, { models: await aiRouter.models() }); return; }
    if (method === 'POST' && path === '/ai/test') {
      const input = await readJson(req, 12000);
      const prompt = input.prompt === undefined ? 'Jawab singkat: koneksi CSPoint berhasil.' : input.prompt;
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 4000) { send(res, 400, { error: 'Pesan uji wajib diisi, maksimal 4.000 karakter.' }); return; }
      const text = await aiRouter.complete(buildAiMessages(store.agent('default'), [{ text: prompt, outgoing: false }], store.products.list(), store.knowledge.relevant(prompt)));
      send(res, 200, { reply: text, model: aiConfig.publicConfig().model }); return;
    }

    for (const name of ['products', 'orders', 'forms', 'knowledge', 'contacts', 'templates']) {
      const listPath = `/${name}`;
      const itemPattern = new RegExp(`^/${name}/([A-Za-z0-9-]{1,64})$`);
      if (method === 'GET' && path === listPath) { send(res, 200, store[name].list()); return; }
      if (method === 'POST' && path === listPath) {
        const input = await readJson(req, name === 'knowledge' ? 12000000 : 1000000);
        if (name === 'knowledge' && input.mime === 'application/pdf') {
          input.sourceContent = input.content;
          input.content = await extractKnowledgePdf(input.content);
        }
        send(res, 200, store[name].create(input)); return;
      }
      const item = path.match(itemPattern);
      if (method === 'DELETE' && item) {
        const removed = store[name].remove(item[1]);
        if (!removed) { send(res, 404, { error: 'Data tidak ditemukan' }); return; }
        send(res, 200, { deleted: true }); return;
      }
    }

    send(res, 404, { error: 'Not found' });
  } catch (error) {
    if (!res.headersSent) send(res, error?.status || 500, { error: error?.status ? error.message : 'Gateway operation failed' });
  }
});

await instanceManager.startSaved();
server.listen(Number(process.env.PORT || 18181), '127.0.0.1');

// A saved linked-device session must reconnect after a service restart.
// Baileys only sets creds.registered during pairing-code linking, so the presence
// of creds.me is the reliable signal that a QR-paired session already exists.
if (hasSession() && store.instances.list().find(item => item.id === 'default')?.enabled) connect();

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stopping = true; clearTimeout(retry); retry = null;
  if (socket) retire(socket);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
