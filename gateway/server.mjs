import { createServer } from 'node:http';
import { timingSafeEqual, createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { openMessages } from './messages.mjs';
import { openStore } from './store.mjs';
import { mcpHandler } from './mcp.mjs';
import { openAiConfig, createRouterClient, buildAiMessages } from './ai.mjs';
import { createAutoReply } from './auto-reply.mjs';
import { extractKnowledgePdf } from './pdf-knowledge.mjs';
import { readConversation } from './read-receipts.mjs';
import { normalizeWaPhone, resolveWaJid } from './phone.mjs';
import { openNumbers, MAX_NUMBERS } from './wa-numbers.mjs';

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
const live = (number, current) => number.socket === current && number.status === 'connected';
const replyTo = (number, current, message) => autoReply({ ...message, instance: number.id }, { isCurrent: () => live(number, current), send: (jid, payload) => current.sendMessage(jid, payload), markRead: item => readConversation(messages, live(number, current) ? current : null, item.jid, [item.id], number.id) });

const numbers = await openNumbers({
  sessionDir: process.env.SESSION_DIR || './session',
  makeSocket: auth => makeWASocket({ auth, logger, markOnlineOnConnect: false, syncFullHistory: false }),
  useAuth: useMultiFileAuthState,
  closeCodes: DisconnectReason,
  messages,
  onMessages(number, current, batch) {
    try {
      for (const message of batch) {
        const jid = message.key?.remoteJid;
        const text = message.message?.conversation || message.message?.extendedTextMessage?.text;
        if (!jid || !message.key?.id || !text || !/\@(s\.whatsapp\.net|lid)$/.test(jid)) continue;
        const saved = { id: message.key.id, jid, text, name: message.pushName || '', outgoing: Boolean(message.key.fromMe), status: message.status, timestamp: Number(message.messageTimestamp) * 1000 || Date.now(), instance: number.id };
        const fresh = store.settings().saveHistory ? messages.add(saved) : true;
        if (!saved.outgoing && !numbers.owns(jid) && Math.abs(Date.now() - saved.timestamp) < 120000) {
          void replyTo(number, current, fresh ? saved : messages.byId(saved.id, number.id));
        }
      }
    } catch { console.error('Unable to persist incoming messages'); }
  },
  onOpen(number, current) {
    for (const pending of aiConfig.pendingReplies()) {
      const id = typeof pending === 'string' ? pending : pending.message_id;
      const instance = typeof pending === 'string' ? 'default' : pending.instance;
      const message = instance === number.id ? messages.byId(id, number.id) : null;
      if (message && !message.outgoing) void replyTo(number, current, message);
    }
  },
});
const handleMcp = mcpHandler({ token: process.env.MCP_TOKEN, messages, getStatus: () => numbers.primary().status });

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

const statusPayload = number => ({ ...number.view(), aiReplyFailure: autoReplyFailure });

async function readJson(req, limit = 1_000_000) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw Object.assign(new Error('Payload terlalu besar'), { status: 413 });
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('JSON tidak valid'), { status: 400 }); }
}

// A customer is answered from the number they last wrote to; if that slot is gone, from any connected number.
const ownerOf = (jid, instance) => {
  const id = instance || messages.numberFor(jid);
  return numbers.has(id) ? numbers.get(id) : instance ? null : numbers.primary();
};

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

    const selected = () => numbers.get(url.searchParams.get('number') || 'default');

    if (method === 'GET' && path === '/status') { send(res, 200, statusPayload(url.searchParams.has('number') ? selected() : numbers.primary())); return; }

    if (method === 'GET' && path === '/qr') {
      const number = selected();
      if (!number.qr) { send(res, 409, statusPayload(number)); return; }
      send(res, 200, { image: await QRCode.toDataURL(number.qr) }); return;
    }

    if (method === 'GET' && path === '/numbers') { send(res, 200, { numbers: numbers.list().map(number => number.view()), max: MAX_NUMBERS }); return; }
    if (method === 'POST' && path === '/numbers') { send(res, 200, (await numbers.add()).view()); return; }

    if (method === 'POST' && path === '/connect') {
      const number = selected();
      await number.request();
      send(res, 200, statusPayload(number)); return;
    }

    if (method === 'POST' && path === '/disconnect') {
      const body = await readJson(req, 4096);
      if (body.confirm !== 'PUTUSKAN') { send(res, 400, { error: 'Konfirmasi "PUTUSKAN" diperlukan.' }); return; }
      send(res, 200, await numbers.disconnect(selected().id)); return;
    }

    if (method === 'GET' && path === '/conversations') {
      const several = numbers.list().length > 1;
      send(res, 200, messages.list().map(row => ({ ...row, numberLabel: several && numbers.has(row.instance) ? numbers.get(row.instance).label : '' }))); return;
    }
    if (method === 'GET' && path === '/messages') { send(res, 200, messages.thread(url.searchParams.get('jid') || '', url.searchParams.get('instance') || 'default')); return; }

    if (method === 'GET' && path === '/labels') { send(res, 200, messages.labels()); return; }
    if (method === 'POST' && path === '/labels') { send(res, 200, messages.saveLabel(await readJson(req, 4000))); return; }
    if (method === 'DELETE' && /^\/labels\/[a-zA-Z0-9-]{1,64}$/.test(path)) { send(res, 200, { removed: messages.deleteLabel(path.split('/')[2]) }); return; }
    if (method === 'POST' && path === '/conversations/labels') {
      const body = await readJson(req, 12000);
      messages.setLabels(body.jid, body.labelIds, body.instance || 'default');
      send(res, 200, { saved: true }); return;
    }
    if (method === 'POST' && path === '/conversations/unread') {
      const body = await readJson(req, 4000);
      messages.markUnread(body.jid, body.instance || 'default');
      send(res, 200, { unread: true }); return;
    }
    if (method === 'POST' && path === '/conversations/read') {
      const body = await readJson(req, 50000);
      const instance = body.instance || 'default';
      const owner = ownerOf(body.jid, instance);
      send(res, 200, await readConversation(messages, owner?.status === 'connected' ? owner.socket : null, body.jid, body.ids, instance)); return;
    }

    if (method === 'POST' && path === '/send') {
      const body = await readJson(req, 200000);
      const sender = typeof body.number === 'string' ? numbers.get(body.number) : typeof body.instance === 'string' ? numbers.get(body.instance) : body.jid === undefined ? numbers.primary() : ownerOf(body.jid);
      if (!sender) { send(res, 409, { error: 'Nomor WhatsApp untuk percakapan ini tidak tersedia. Pilih nomor yang masih aktif.' }); return; }
      const socket = sender.status === 'connected' ? sender.socket : null;
      if (!socket) { send(res, 409, { error: `${numbers.list().length > 1 ? sender.label : 'WhatsApp'} belum terhubung. Scan QR di Pengaturan.` }); return; }
      const phone = normalizeWaPhone(body.phone);
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > 4000) { send(res, 400, { error: 'Pesan wajib diisi, maksimal 4.000 karakter.' }); return; }
      let jid = body.jid;
      if (jid === undefined) {
        if (!phone) { send(res, 400, { error: 'Nomor WhatsApp tidak valid. Gunakan format 08xxx atau 628xxx.' }); return; }
        try { jid = await resolveWaJid(socket, phone); }
        catch { send(res, 502, { error: 'Gagal memeriksa nomor di WhatsApp. Coba lagi.' }); return; }
        if (!jid) { send(res, 400, { error: 'Nomor tidak terdaftar di WhatsApp.' }); return; }
      } else if (typeof jid !== 'string' || !/^\d+@(s\.whatsapp\.net|lid)$/.test(jid) || !messages.hasConversation(jid, sender.id)) { send(res, 400, { error: 'Percakapan tidak valid untuk nomor WhatsApp yang dipilih.' }); return; }
      const result = await socket.sendMessage(jid, { text });
      if (store.settings().saveHistory) messages.add({ id: result.key.id, jid, text, name: '', outgoing: true, status: result.status, timestamp: Date.now(), instance: sender.id });
      send(res, 200, { id: result.key.id, status: 'submitted' }); return;
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
      if (method === 'PATCH' && item && store[name].update) {
        const updated = store[name].update(item[1], await readJson(req, 100000));
        if (!updated) { send(res, 404, { error: 'Data tidak ditemukan' }); return; }
        send(res, 200, updated); return;
      }
    }

    send(res, 404, { error: 'Not found' });
  } catch (error) {
    if (!res.headersSent) send(res, error?.status || 500, { error: error?.status ? error.message : 'Gateway operation failed' });
  }
});

server.listen(Number(process.env.PORT || 18181), '127.0.0.1');

void numbers.start();

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  numbers.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
