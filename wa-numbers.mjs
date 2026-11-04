import { readdir, mkdir, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_NUMBERS = 10;
const failure = (message, status) => Object.assign(new Error(message), { status });
const userOf = jid => String(jid || '').split(/[:@]/)[0];
const slotOf = id => (id === 'default' ? 1 : Number(id.slice(1)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// One linked device per slot. 'default' keeps the original session folder, so the existing number needs no new scan.
export async function openNumbers({ sessionDir, makeSocket, useAuth, closeCodes, messages, onMessages, onOpen, logoutTimeout = 10000 }) {
  const backupDir = process.env.SESSION_BACKUP_DIR || join(sessionDir, '..', 'session-backups');
  const numbersDir = join(sessionDir, '..', 'numbers');
  const slots = new Map();
  let stopping = false;
  const list = () => [...slots.values()].sort((a, b) => a.slot - b.slot);

  function retire(target) {
    try { target.ev.removeAllListeners(); } catch {}
    try { target.end(undefined); } catch {}
  }

  function createNumber(id, dir) {
    let auth, socket = null, retry = null, attempt = 0;
    const scheduleRetry = delay => {
      if (stopping) return;
      clearTimeout(retry);
      retry = setTimeout(() => { retry = null; number.connect(); }, delay);
    };
    const number = {
      id, slot: slotOf(id), label: `Nomor ${slotOf(id)}`, status: 'idle', qr: null, connectedAt: null, lastClose: null, notice: '', busy: false,
      get socket() { return socket; },
      get phone() { return userOf(auth?.state.creds?.me?.id); },
      get lid() { return userOf(auth?.state.creds?.me?.lid); },
      get hasSession() { return Boolean(auth?.state.creds?.me || auth?.state.creds?.registered); },
      async load() { auth = await useAuth(dir); },

      view() {
        return { id, label: number.label, phone: number.phone, status: number.status, connectedAt: number.connectedAt, lastClose: number.lastClose, hasSession: number.hasSession, retryPending: Boolean(retry), notice: number.notice };
      },

      // Stops the socket without touching the session on disk.
      detach() {
        const current = socket;
        socket = null;
        clearTimeout(retry); retry = null;
        number.qr = null;
        return current;
      },

      // Never deletes a paired session without a copy on disk.
      async wipe() {
        let archive = null;
        const entries = (await readdir(dir).catch(() => [])).filter(entry => entry !== 'session-backups');
        if (number.hasSession) {
          archive = join(backupDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${id}`);
          await mkdir(archive, { recursive: true, mode: 0o700 });
          for (const entry of entries) await cp(join(dir, entry), join(archive, entry), { recursive: true, force: true });
        }
        for (const entry of entries) await rm(join(dir, entry), { recursive: true, force: true });
        await number.load();
        attempt = 0; number.lastClose = null; number.connectedAt = null;
        return archive;
      },

      async request() {
        if (number.busy) throw failure('Nomor ini sedang diproses.', 409);
        if (number.status === 'connected' || number.status === 'connecting') return;
        if (number.status === 'logged_out') await number.wipe();
        // Force a fresh QR.
        if (number.status === 'awaiting_scan') { const current = number.detach(); if (current) retire(current); }
        number.connect();
      },

      connect() {
        if (stopping) return;
        clearTimeout(retry); retry = null;
        number.qr = null;
        number.status = 'connecting';
        number.notice = '';

        let current;
        try { current = makeSocket(auth.state); }
        catch (error) {
          number.status = 'disconnected';
          number.lastClose = { code: null, at: Date.now(), reason: 'socket-init-failed' };
          console.error(`WhatsApp socket could not start (${id}): ${error?.message ?? 'unknown'}`);
          scheduleRetry(Math.min(30000, 2000 * 2 ** attempt++));
          return;
        }

        socket = current;
        // A superseded socket must never overwrite the state owned by the newest socket.
        const isCurrent = () => socket === current;
        const { saveCreds } = auth;

        current.ev.on('creds.update', () => {
          if (!isCurrent()) return;
          saveCreds().catch(() => console.error(`Unable to persist WhatsApp credentials (${id})`));
        });
        current.ev.on('messages.upsert', ({ messages: batch }) => {
          if (isCurrent()) onMessages(number, current, batch);
        });
        current.ev.on('messages.update', updates => {
          if (!isCurrent()) return;
          for (const { key, update } of updates) messages.updateReceipt(key, update.status);
        });
        current.ev.on('message-receipt.update', updates => {
          if (!isCurrent()) return;
          for (const { key, receipt } of updates) messages.updateReceipt(key, receipt.readTimestamp || receipt.playedTimestamp ? 4 : receipt.receiptTimestamp ? 3 : 0);
        });

        current.ev.on('connection.update', update => {
          if (!isCurrent()) return;
          if (update.qr) { number.qr = update.qr; number.status = 'awaiting_scan'; }

          if (update.connection === 'open') {
            number.qr = null;
            number.status = 'connected';
            number.connectedAt = Date.now();
            attempt = 0;
            number.lastClose = null;
            console.error(`WhatsApp connection open (${id})`);
            // Two slots on one phone would answer every customer twice.
            const twin = list().find(other => other !== number && other.hasSession && other.phone === number.phone);
            if (twin) {
              disconnect(id, { keepSlot: true, notice: `Nomor ini sudah terhubung di ${twin.label}.` }).catch(() => console.error(`Unable to unlink duplicate number (${id})`));
              return;
            }
            onOpen(number, current);
          }

          if (update.connection === 'close') {
            number.qr = null;
            const code = update.lastDisconnect?.error?.output?.statusCode ?? null;
            const reason = update.lastDisconnect?.error?.message ?? 'unknown';
            number.lastClose = { code, at: Date.now(), reason: String(reason).slice(0, 200) };
            console.error(`WhatsApp connection closed (${id}): code=${code ?? 'unknown'} message=${String(reason).slice(0, 200)}`);
            // The stream is already closed here. Calling end() again would send an extra
            // close frame and can make WhatsApp unlink the freshly paired device.
            try { current.ev.removeAllListeners(); } catch {}
            socket = null;

            if (code === closeCodes.loggedOut) {
              number.status = 'logged_out';
              console.error(`WhatsApp session logged out (${id}); controlled re-pairing required`);
              return;
            }
            if (stopping) { number.status = 'idle'; return; }
            // An expired QR must not keep a socket alive for a slot nobody is scanning.
            if (!number.hasSession) { number.status = 'idle'; return; }

            number.status = 'disconnected';
            // 515 restart-required is expected right after a fresh pairing; reconnect quickly.
            scheduleRetry(code === closeCodes.restartRequired ? 1500 : Math.min(30000, 2000 * 2 ** attempt++));
          }
        });
      },
    };
    return number;
  }

  function get(id) {
    const number = slots.get(id);
    if (!number) throw failure('Nomor tidak ditemukan.', 404);
    return number;
  }

  async function disconnect(id, { keepSlot = false, notice = '' } = {}) {
    const number = get(id);
    if (number.busy) throw failure('Nomor ini sedang diproses.', 409);
    number.busy = true;
    try {
      const wasConnected = number.status === 'connected';
      const current = number.detach();
      number.status = 'idle';
      let unlinked = false;
      // Unlink on WhatsApp too, otherwise the old device stays listed on the phone.
      if (current && wasConnected) {
        let timer;
        unlinked = await Promise.race([current.logout().then(() => true), new Promise(resolve => { timer = setTimeout(resolve, logoutTimeout, false); })]).catch(() => false);
        clearTimeout(timer);
      }
      if (current) retire(current);
      const archived = await number.wipe();
      number.notice = notice;
      if (id !== 'default' && !keepSlot) {
        await rm(join(numbersDir, id), { recursive: true, force: true });
        slots.delete(id);
      }
      return { archived, unlinked, wasConnected };
    } finally { number.busy = false; }
  }

  async function add() {
    let slot = 2;
    while (slots.has(`n${slot}`)) slot++;
    if (slot > MAX_NUMBERS) throw failure(`Maksimal ${MAX_NUMBERS} nomor WhatsApp.`, 409);
    const number = createNumber(`n${slot}`, join(numbersDir, `n${slot}`));
    slots.set(number.id, number);
    try { await mkdir(numbersDir, { recursive: true, mode: 0o700 }); await number.load(); }
    catch (error) { slots.delete(number.id); throw error; }
    number.connect();
    return number;
  }

  const main = createNumber('default', sessionDir);
  await main.load();
  slots.set(main.id, main);
  for (const entry of await readdir(numbersDir).catch(() => [])) {
    if (!/^n([2-9]|10)$/.test(entry)) continue;
    const number = createNumber(entry, join(numbersDir, entry));
    await number.load();
    slots.set(entry, number);
  }

  return {
    list, get, add, disconnect,
    has: id => slots.has(id),
    // The number that represents the gateway as a whole in status and default sends.
    primary: () => list().find(number => number.status === 'connected') || list().find(number => number.status === 'awaiting_scan') || main,
    // Lets the bots of two linked numbers ignore each other instead of replying forever.
    owns: jid => list().some(number => number.hasSession && [number.phone, number.lid].includes(userOf(jid))),
    // A saved linked-device session must reconnect after a service restart; spaced to avoid a CPU spike under the unit's quota.
    async start(gap = 3000) {
      for (const number of list()) if (number.hasSession && !stopping) { number.connect(); await sleep(gap); }
    },
    close() {
      stopping = true;
      for (const number of list()) { const current = number.detach(); if (current) retire(current); }
    },
  };
}
