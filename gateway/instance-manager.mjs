import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createAutoReply } from './auto-reply.mjs';
import { readConversation } from './read-receipts.mjs';
import { storedMessageId } from './messages.mjs';

export function createInstanceManager({ store, messages, config, router, buildMessages, primaryStatus, primaryConnect, primaryDisconnect }) {
  const runtimes = new Map();
  const logger = pino({ level: 'silent' });
  const root = process.env.MULTI_SESSION_DIR || join(process.env.SESSION_DIR || './session', '..', 'instances');

  function find(id) {
    if (!store.instances.has(id)) throw Object.assign(new Error('Nomor WhatsApp tidak ditemukan.'), { status: 404 });
    if (id === 'default') return null;
    if (!runtimes.has(id)) runtimes.set(id, { id, status: 'idle', qr: null, socket: null, auth: null, saveCreds: null, retry: null, retryAttempt: 0, generation: 0, connectedAt: null, lastClose: null, failure: null, stopping: false });
    return runtimes.get(id);
  }

  const payload = runtime => ({ id: runtime.id, status: runtime.status, connectedAt: runtime.connectedAt, lastClose: runtime.lastClose, retryPending: Boolean(runtime.retry), hasSession: Boolean(runtime.auth?.state.creds?.me || runtime.auth?.state.creds?.registered), aiReplyFailure: runtime.failure });

  async function loadAuth(runtime) {
    const dir = join(root, runtime.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    runtime.auth = await useMultiFileAuthState(dir);
    runtime.saveCreds = runtime.auth.saveCreds;
  }

  async function archiveAndClear(runtime) {
    const dir = join(root, runtime.id);
    const entries = await readdir(dir).catch(() => []);
    if (entries.length) {
      const archive = join(root, 'backups', `${runtime.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      await mkdir(archive, { recursive: true, mode: 0o700 });
      for (const entry of entries) await cp(join(dir, entry), join(archive, entry), { recursive: true, force: true });
    }
    await rm(dir, { recursive: true, force: true });
    runtime.auth = null;
    runtime.saveCreds = null;
  }

  function schedule(runtime, delay) {
    if (runtime.stopping || !store.instances.list().find(item => item.id === runtime.id)?.enabled) return;
    clearTimeout(runtime.retry);
    runtime.retry = setTimeout(() => { runtime.retry = null; void connect(runtime); }, delay);
  }

  async function connect(runtime) {
    if (runtime.stopping || runtime.socket || runtime.status === 'connecting') return;
    const generation = ++runtime.generation;
    runtime.status = 'connecting';
    try { if (!runtime.auth) await loadAuth(runtime); }
    catch (error) {
      if (runtime.stopping || generation !== runtime.generation) return;
      runtime.status = 'disconnected';
      runtime.lastClose = { code: null, at: Date.now(), reason: String(error?.message || 'session-load-failed').slice(0, 200) };
      schedule(runtime, Math.min(30000, 2000 * 2 ** runtime.retryAttempt++));
      return;
    }
    if (runtime.stopping || generation !== runtime.generation || !store.instances.list().find(item => item.id === runtime.id)?.enabled) return;
    runtime.qr = null;
    runtime.status = 'connecting';
    let socket;
    try { socket = makeWASocket({ auth: runtime.auth.state, logger, markOnlineOnConnect: false, syncFullHistory: false }); }
    catch (error) {
      runtime.status = 'disconnected';
      runtime.lastClose = { code: null, at: Date.now(), reason: String(error?.message || 'socket-init-failed').slice(0, 200) };
      schedule(runtime, Math.min(30000, 2000 * 2 ** runtime.retryAttempt++));
      return;
    }
    runtime.socket = socket;
    const current = () => generation === runtime.generation && runtime.socket === socket;
    const autoReply = createAutoReply({ store, config, router, messages, buildMessages,
      onError: error => { runtime.failure = { code: error.status || 500, at: Date.now() }; },
      onSuccess: () => { runtime.failure = null; },
    });
    socket.ev.on('creds.update', () => { if (current()) runtime.saveCreds?.().catch(() => {}); });
    socket.ev.on('messages.upsert', ({ messages: batch }) => {
      if (!current()) return;
      try {
        for (const message of batch) {
          const jid = message.key?.remoteJid;
          const text = message.message?.conversation || message.message?.extendedTextMessage?.text;
          if (!jid || !message.key?.id || !text || !/@(s\.whatsapp\.net|lid)$/.test(jid)) continue;
          const saved = { id: storedMessageId(runtime.id, message.key.id), waId: message.key.id, jid, text, name: message.pushName || '', outgoing: Boolean(message.key.fromMe), status: message.status, timestamp: Number(message.messageTimestamp) * 1000 || Date.now(), instanceId: runtime.id };
          const fresh = messagesStore.add(saved);
          if (!saved.outgoing && Math.abs(Date.now() - saved.timestamp) < 120000) void autoReply(fresh ? saved : messagesStore.byId(saved.id), {
            isCurrent: () => current() && runtime.status === 'connected',
            send: (recipient, body) => socket.sendMessage(recipient, body),
            markRead: item => readConversation(messagesStore, current() && runtime.status === 'connected' ? socket : null, item.jid, [item.id], runtime.id),
          });
        }
      } catch { console.error(`Unable to persist incoming messages for ${runtime.id}`); }
    });
    socket.ev.on('messages.update', updates => { if (current()) for (const { key, update } of updates) messagesStore.updateReceipt(key, update.status, runtime.id); });
    socket.ev.on('message-receipt.update', updates => { if (current()) for (const { key, receipt } of updates) messagesStore.updateReceipt(key, receipt.readTimestamp || receipt.playedTimestamp ? 4 : receipt.receiptTimestamp ? 3 : 0, runtime.id); });
    socket.ev.on('connection.update', update => {
      if (!current()) return;
      if (update.qr) { runtime.qr = update.qr; runtime.status = 'awaiting_scan'; }
      if (update.connection === 'open') {
        runtime.qr = null; runtime.status = 'connected'; runtime.connectedAt = Date.now(); runtime.retryAttempt = 0; runtime.lastClose = null;
        for (const id of config.pendingReplies()) { const pending = messagesStore.byId(id); if (pending?.instanceId === runtime.id && !pending.outgoing) void autoReply(pending, { isCurrent: () => current() && runtime.status === 'connected', send: (recipient, body) => socket.sendMessage(recipient, body), markRead: item => readConversation(messagesStore, socket, item.jid, [item.id], runtime.id) }); }
      }
      if (update.connection === 'close') {
        const code = update.lastDisconnect?.error?.output?.statusCode ?? null;
        runtime.qr = null; runtime.lastClose = { code, at: Date.now(), reason: String(update.lastDisconnect?.error?.message || 'unknown').slice(0, 200) };
        socket.ev.removeAllListeners(); runtime.socket = null;
        if (code === DisconnectReason.loggedOut) { runtime.status = 'logged_out'; return; }
        if (runtime.stopping) { runtime.status = 'idle'; return; }
        runtime.status = 'disconnected';
        schedule(runtime, code === DisconnectReason.restartRequired ? 1500 : Math.min(30000, 2000 * 2 ** runtime.retryAttempt++));
      }
    });
  }

  const messagesStore = messages;
  async function list() {
    const records = store.instances.list();
    return Promise.all(records.map(async item => {
      if (item.id === 'default') return { ...item, ...primaryStatus() };
      const runtime = find(item.id);
      if (item.enabled && runtime.status === 'idle') void connect(runtime);
      return { ...item, ...payload(runtime) };
    }));
  }
  async function create(label) {
    const item = store.instances.create(label);
    const runtime = find(item.id);
    void connect(runtime);
    return { ...item, ...payload(runtime) };
  }
  async function status(id = 'default') {
    if (id === 'default') return { id, ...primaryStatus() };
    const runtime = find(id);
    if (store.instances.list().find(item => item.id === id)?.enabled && runtime.status === 'idle') void connect(runtime);
    return payload(runtime);
  }
  async function qr(id = 'default') {
    if (id === 'default') return null;
    const runtime = find(id);
    if (!runtime.qr) throw Object.assign(new Error('QR belum tersedia. Muat ulang status sebentar lagi.'), { status: 409 });
    return { image: await QRCode.toDataURL(runtime.qr) };
  }
  async function connectId(id = 'default') {
    if (id === 'default') return primaryConnect();
    const runtime = find(id);
    store.instances.setEnabled(id, true);
    runtime.stopping = false;
    if (runtime.status === 'logged_out') await archiveAndClear(runtime);
    if (runtime.status === 'awaiting_scan' && runtime.socket) {
      runtime.generation++; runtime.socket.ev.removeAllListeners(); runtime.socket.end(undefined); runtime.socket = null; runtime.qr = null;
    }
    if (!runtime.socket) { clearTimeout(runtime.retry); runtime.retry = null; await connect(runtime); }
    return payload(runtime);
  }
  async function disconnect(id = 'default') {
    if (id === 'default') return primaryDisconnect();
    const runtime = find(id);
    store.instances.setEnabled(id, false);
    runtime.stopping = true; clearTimeout(runtime.retry); runtime.retry = null; runtime.generation++;
    const socket = runtime.socket; runtime.socket = null; runtime.qr = null;
    try {
      if (socket) { try { if (runtime.status === 'connected') await socket.logout(); else socket.end(undefined); } catch { try { socket.end(undefined); } catch {} } finally { socket.ev.removeAllListeners(); } }
      await archiveAndClear(runtime);
      runtime.status = 'idle'; runtime.connectedAt = null;
    } finally { runtime.stopping = false; }
    return payload(runtime);
  }
  async function remove(id) {
    if (id === 'default') throw Object.assign(new Error('Nomor utama tidak dapat dihapus.'), { status: 409 });
    const runtime = find(id);
    if (runtime.socket || store.instances.list().find(item => item.id === id)?.enabled) throw Object.assign(new Error('Putuskan nomor terlebih dahulu sebelum menghapusnya.'), { status: 409 });
    await archiveAndClear(runtime);
    runtimes.delete(id);
    return { deleted: store.instances.remove(id) };
  }
  async function send(id, jid, text) {
    if (id === 'default') return null;
    const runtime = find(id);
    if (runtime.status !== 'connected' || !runtime.socket) throw Object.assign(new Error('Nomor WhatsApp yang dipilih belum terhubung.'), { status: 409 });
    return runtime.socket.sendMessage(jid, { text });
  }
  async function read(id, jid, ids) {
    const runtime = find(id);
    return readConversation(messagesStore, runtime.status === 'connected' ? runtime.socket : null, jid, ids, id);
  }
  async function startSaved() { for (const item of store.instances.list()) if (item.id !== 'default' && item.enabled) { const runtime = find(item.id); void connect(runtime); } }
  return { list, create, status, qr, connect: connectId, disconnect, remove, send, read, startSaved };
}
