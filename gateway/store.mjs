import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

const now = () => Date.now();
const id = () => randomUUID();

export function openStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL, sku TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0, description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, customer TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Menunggu Bayar', total INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS forms (id TEXT PRIMARY KEY, name TEXT NOT NULL, fields TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS knowledge (id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL, mime TEXT NOT NULL DEFAULT 'text/plain', status TEXT NOT NULL DEFAULT 'siap', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS agents (instance TEXT PRIMARY KEY, assistant_name TEXT NOT NULL DEFAULT 'Kak', instructions TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', tag TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', stage TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
  `);
  const phone = value => String(value ?? '').replace(/\D/g, '').replace(/^0/, '62').slice(0, 15);

  const text = (value, max) => String(value ?? '').trim().slice(0, max);
  const int = (value, fallback = 0) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    settings() {
      const stored = Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map(row => [row.key, row.value]));
      return {
        minInterval: int(stored.minInterval, 2),
        maxInterval: int(stored.maxInterval, 5),
        rotation: stored.rotation || 'Round Robin (Bergantian)',
        couriers: stored.couriers ? JSON.parse(stored.couriers) : [],
        scheduleEnabled: stored.scheduleEnabled === 'true',
        scheduleStart: stored.scheduleStart || '08:00',
        scheduleEnd: stored.scheduleEnd || '21:00',
        dailyLimit: int(stored.dailyLimit, 100),
        sendMode: stored.sendMode || 'Aman (bertahap)',
        autoReply: stored.autoReply === 'true',
        saveHistory: stored.saveHistory !== 'false',
        shippingPdfName: stored.shippingPdfName || '',
        shippingPdfSize: int(stored.shippingPdfSize, 0),
        manualShippingPriority: stored.manualShippingPriority !== 'false',
      };
    },
    saveSettings(patch = {}) {
      const current = this.settings();
      const next = {
        minInterval: Math.min(600, Math.max(1, int(patch.minInterval, current.minInterval))),
        maxInterval: Math.min(600, Math.max(1, int(patch.maxInterval, current.maxInterval))),
        rotation: ['Round Robin (Bergantian)', 'Random (Acak)'].includes(patch.rotation) ? patch.rotation : current.rotation,
        couriers: Array.isArray(patch.couriers) ? patch.couriers.map(value => text(value, 40)).filter(Boolean).slice(0, 20) : current.couriers,
        scheduleEnabled: patch.scheduleEnabled === undefined ? Boolean(current.scheduleEnabled) : Boolean(patch.scheduleEnabled),
        scheduleStart: /^\d{2}:\d{2}$/.test(patch.scheduleStart || '') ? patch.scheduleStart : (current.scheduleStart || '08:00'),
        scheduleEnd: /^\d{2}:\d{2}$/.test(patch.scheduleEnd || '') ? patch.scheduleEnd : (current.scheduleEnd || '21:00'),
        dailyLimit: Math.max(0, int(patch.dailyLimit, current.dailyLimit)),
        sendMode: ['Aman (bertahap)', 'Normal'].includes(patch.sendMode) ? patch.sendMode : (current.sendMode || 'Aman (bertahap)'),
        autoReply: patch.autoReply === undefined ? Boolean(current.autoReply) : Boolean(patch.autoReply),
        saveHistory: patch.saveHistory === undefined ? current.saveHistory !== false : Boolean(patch.saveHistory),
        shippingPdfName: patch.shippingPdfName === undefined ? current.shippingPdfName : text(patch.shippingPdfName, 180),
        shippingPdfContent: patch.shippingPdfContent === undefined ? undefined : String(patch.shippingPdfContent),
        shippingPdfMime: patch.shippingPdfMime === undefined ? undefined : text(patch.shippingPdfMime, 80),
        shippingPdfSize: patch.shippingPdfSize === undefined ? current.shippingPdfSize : Math.max(0, int(patch.shippingPdfSize)),
        manualShippingPriority: patch.manualShippingPriority === undefined ? current.manualShippingPriority !== false : Boolean(patch.manualShippingPriority),
      };
      if (next.maxInterval < next.minInterval) next.maxInterval = next.minInterval;
      if (next.shippingPdfContent && Buffer.byteLength(next.shippingPdfContent, 'base64') > 1000000) throw Object.assign(new Error('Ukuran PDF ongkir melebihi batas 1.000.000 byte'), { status: 413 });
      const statement = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      for (const [key, value] of Object.entries(next)) { if (value === undefined) continue; statement.run(key, key === 'couriers' ? JSON.stringify(value) : String(value)); }
      return next;
    },

    products: {
      list: () => db.prepare('SELECT * FROM products ORDER BY created_at DESC LIMIT 500').all(),
      create(input = {}) {
        const name = text(input.name, 120);
        if (!name) throw Object.assign(new Error('Nama produk wajib diisi'), { status: 400 });
        const row = { id: id(), name, sku: text(input.sku, 60), price: Math.max(0, int(input.price)), stock: Math.max(0, int(input.stock)), description: text(input.description, 2000), created_at: now() };
        db.prepare('INSERT INTO products VALUES (?,?,?,?,?,?,?)').run(row.id, row.name, row.sku, row.price, row.stock, row.description, row.created_at);
        return row;
      },
      remove(productId) { return db.prepare('DELETE FROM products WHERE id=?').run(String(productId)).changes > 0; },
    },

    orders: {
      list: () => db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500').all(),
      create(input = {}) {
        const customer = text(input.customer, 120);
        if (!customer) throw Object.assign(new Error('Nama pelanggan wajib diisi'), { status: 400 });
        const row = { id: id(), customer, phone: text(input.phone, 20), status: text(input.status, 40) || 'Menunggu Bayar', total: Math.max(0, int(input.total)), note: text(input.note, 2000), created_at: now() };
        db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?,?)').run(row.id, row.customer, row.phone, row.status, row.total, row.note, row.created_at);
        return row;
      },
      remove(orderId) { return db.prepare('DELETE FROM orders WHERE id=?').run(String(orderId)).changes > 0; },
    },

    forms: {
      list: () => db.prepare('SELECT * FROM forms ORDER BY created_at DESC LIMIT 200').all().map(row => ({ ...row, fields: JSON.parse(row.fields) })),
      create(input = {}) {
        const name = text(input.name, 120);
        if (!name) throw Object.assign(new Error('Nama form wajib diisi'), { status: 400 });
        const fields = Array.isArray(input.fields) ? input.fields.slice(0, 40).map(field => ({ type: text(field?.type, 20) || 'text', label: text(field?.label, 80), required: Boolean(field?.required) })) : [];
        const row = { id: id(), name, fields, created_at: now() };
        db.prepare('INSERT INTO forms VALUES (?,?,?,?)').run(row.id, row.name, JSON.stringify(row.fields), row.created_at);
        return row;
      },
      remove(formId) { return db.prepare('DELETE FROM forms WHERE id=?').run(String(formId)).changes > 0; },
    },

    knowledge: {
      list: () => db.prepare('SELECT id, name, mime, status, created_at, length(content) AS size FROM knowledge ORDER BY created_at DESC LIMIT 200').all(),
      create(input = {}) {
        const name = text(input.name, 160);
        const content = String(input.content ?? '').trim();
        if (!name || !content) throw Object.assign(new Error('Nama dan isi knowledge wajib diisi'), { status: 400 });
        if (content.length > 500000) throw Object.assign(new Error('Isi knowledge PDF melebihi batas 500.000 karakter'), { status: 413 });
        const row = { id: id(), name, content, mime: text(input.mime, 80) || 'text/plain', status: input.mime === 'application/pdf' ? 'PDF tersimpan' : 'siap', created_at: now() };
        db.prepare('INSERT INTO knowledge VALUES (?,?,?,?,?,?)').run(row.id, row.name, row.content, row.mime, row.status, row.created_at);
        return { id: row.id, name: row.name, mime: row.mime, status: row.status, created_at: row.created_at, size: content.length };
      },
      remove(knowledgeId) { return db.prepare('DELETE FROM knowledge WHERE id=?').run(String(knowledgeId)).changes > 0; },
    },

    contacts: {
      list: () => db.prepare('SELECT * FROM contacts ORDER BY created_at DESC LIMIT 500').all(),
      create(input = {}) {
        const name = text(input.name, 120);
        if (!name) throw Object.assign(new Error('Nama kontak wajib diisi'), { status: 400 });
        const row = { id: id(), name, phone: phone(input.phone), tag: text(input.tag, 40), created_at: now() };
        db.prepare('INSERT INTO contacts VALUES (?,?,?,?,?)').run(row.id, row.name, row.phone, row.tag, row.created_at);
        return row;
      },
      remove(contactId) { return db.prepare('DELETE FROM contacts WHERE id=?').run(String(contactId)).changes > 0; },
    },

    templates: {
      list: () => db.prepare('SELECT * FROM templates ORDER BY created_at DESC LIMIT 300').all(),
      create(input = {}) {
        const name = text(input.name, 120);
        if (!name) throw Object.assign(new Error('Nama template wajib diisi'), { status: 400 });
        const row = { id: id(), name, body: text(input.body, 4000), stage: text(input.stage, 40), created_at: now() };
        db.prepare('INSERT INTO templates VALUES (?,?,?,?,?)').run(row.id, row.name, row.body, row.stage, row.created_at);
        return row;
      },
      remove(templateId) { return db.prepare('DELETE FROM templates WHERE id=?').run(String(templateId)).changes > 0; },
    },

    agent(instance = 'default') {
      const row = db.prepare('SELECT * FROM agents WHERE instance=?').get(String(instance));
      return row ? { instance: row.instance, assistantName: row.assistant_name, instructions: row.instructions, enabled: Boolean(row.enabled), updatedAt: row.updated_at } : { instance: String(instance), assistantName: 'Kak', instructions: '', enabled: false, updatedAt: null };
    },
    saveAgent(input = {}) {
      const instance = text(input.instance, 60) || 'default';
      const assistantName = text(input.assistantName, 60) || 'Kak';
      const instructions = text(input.instructions, 8000);
      const enabled = input.enabled ? 1 : 0;
      db.prepare('INSERT INTO agents (instance, assistant_name, instructions, enabled, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(instance) DO UPDATE SET assistant_name=excluded.assistant_name, instructions=excluded.instructions, enabled=excluded.enabled, updated_at=excluded.updated_at').run(instance, assistantName, instructions, enabled, now());
      return this.agent(instance);
    },

    close() { db.close(); },
  };
}
