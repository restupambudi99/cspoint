import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
export const LABEL_COLORS = ['blue', 'green', 'amber', 'purple', 'rose', 'slate'];
const invalid = message => Object.assign(new Error(message), { status: 400 });
export function openMessages(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, jid TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, outgoing INTEGER NOT NULL, timestamp INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS messages_jid_time ON messages(jid,timestamp);');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS conversation_state (jid TEXT PRIMARY KEY, force_unread INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS message_status (jid TEXT NOT NULL, id TEXT NOT NULL, status INTEGER NOT NULL, PRIMARY KEY(jid,id));
    CREATE TABLE IF NOT EXISTS inbox_labels (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, color TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversation_labels (jid TEXT NOT NULL, label_id TEXT NOT NULL REFERENCES inbox_labels(id) ON DELETE CASCADE, PRIMARY KEY(jid,label_id));
    CREATE TABLE IF NOT EXISTS conversation_memory (jid TEXT PRIMARY KEY, entries TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox_meta (key TEXT PRIMARY KEY);`);
  const columns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(row => row.name));
  for (const column of ['read_at', 'receipt_sent_at']) if (!columns.has(column)) db.exec(`ALTER TABLE messages ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  if (!columns.has('instance')) {
    db.exec("ALTER TABLE messages ADD COLUMN instance TEXT NOT NULL DEFAULT 'default'");
    if (columns.has('instance_id')) db.exec('UPDATE messages SET instance=instance_id');
  }
  // An interim build keyed this table by number as well; a customer has one unread state here.
  if (db.prepare('PRAGMA table_info(conversation_state)').all().some(row => row.name === 'instance_id')) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE conversation_state_next (jid TEXT PRIMARY KEY, force_unread INTEGER NOT NULL DEFAULT 0);
      INSERT INTO conversation_state_next SELECT jid,MAX(force_unread) FROM conversation_state GROUP BY jid;
      DROP TABLE conversation_state;
      ALTER TABLE conversation_state_next RENAME TO conversation_state;
      COMMIT;`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_state_scoped (instance TEXT NOT NULL,jid TEXT NOT NULL,force_unread INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(instance,jid));
    CREATE TABLE IF NOT EXISTS message_status_scoped (instance TEXT NOT NULL,jid TEXT NOT NULL,id TEXT NOT NULL,status INTEGER NOT NULL,PRIMARY KEY(instance,jid,id));
    CREATE TABLE IF NOT EXISTS conversation_labels_scoped (instance TEXT NOT NULL,jid TEXT NOT NULL,label_id TEXT NOT NULL REFERENCES inbox_labels(id) ON DELETE CASCADE,PRIMARY KEY(instance,jid,label_id));
    CREATE TABLE IF NOT EXISTS conversation_memory_scoped (instance TEXT NOT NULL,jid TEXT NOT NULL,entries TEXT NOT NULL DEFAULT '[]',updated_at INTEGER NOT NULL,PRIMARY KEY(instance,jid));
    CREATE TABLE IF NOT EXISTS lead_sources (instance TEXT NOT NULL,jid TEXT NOT NULL,title TEXT NOT NULL DEFAULT '',body TEXT NOT NULL DEFAULT '',source_url TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL,PRIMARY KEY(instance,jid));
    CREATE INDEX IF NOT EXISTS messages_instance_jid_time ON messages(instance,jid,timestamp);`);
  // Rebuild memory only from messages within the same WhatsApp number and lead.
  // The old JID-only memory may have merged messages from multiple numbers, so it is never copied.
  const missingMemories = db.prepare(`SELECT DISTINCT m.instance,m.jid FROM messages m LEFT JOIN conversation_memory_scoped c
    ON c.instance=m.instance AND c.jid=m.jid WHERE c.jid IS NULL AND trim(m.text)<>''`).all();
  if (missingMemories.length) {
    const recentMessages = db.prepare("SELECT id,text,outgoing,timestamp FROM messages WHERE instance=? AND jid=? AND trim(text)<>'' ORDER BY timestamp DESC,rowid DESC LIMIT 12");
    const saveMemory = db.prepare('INSERT OR IGNORE INTO conversation_memory_scoped (instance,jid,entries,updated_at) VALUES (?,?,?,?)');
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const { instance, jid } of missingMemories) {
        const entries = recentMessages.all(instance, jid).reverse().map(entry => ({ ...entry, text: entry.text.slice(-240), outgoing: Boolean(entry.outgoing) }));
        if (entries.length) saveMemory.run(instance, jid, JSON.stringify(entries), Date.now());
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  db.exec(`INSERT OR IGNORE INTO message_status_scoped(instance,jid,id,status)
    SELECT m.instance,m.jid,s.id,s.status FROM message_status s JOIN messages m ON m.jid=s.jid AND m.id=s.id;`);
  if (!db.prepare('SELECT 1 FROM inbox_meta WHERE key=?').get('legacy-labels-scoped')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`INSERT OR IGNORE INTO conversation_labels_scoped(instance,jid,label_id)
        SELECT m.instance,m.jid,c.label_id FROM conversation_labels c JOIN messages m ON m.jid=c.jid
        WHERE m.instance=(SELECT latest.instance FROM messages latest WHERE latest.jid=m.jid ORDER BY latest.timestamp DESC,latest.rowid DESC LIMIT 1);
        INSERT INTO inbox_meta VALUES ('legacy-labels-scoped');
        COMMIT;`);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  // Manual unread marks were keyed by customer only; keep them on the number the customer wrote to last.
  if (!db.prepare('SELECT 1 FROM inbox_meta WHERE key=?').get('legacy-state-scoped')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`INSERT OR IGNORE INTO conversation_state_scoped(instance,jid,force_unread)
        SELECT (SELECT latest.instance FROM messages latest WHERE latest.jid=s.jid ORDER BY latest.timestamp DESC,latest.rowid DESC LIMIT 1),s.jid,s.force_unread
        FROM conversation_state s WHERE EXISTS (SELECT 1 FROM messages m WHERE m.jid=s.jid);
        INSERT INTO inbox_meta VALUES ('legacy-state-scoped');
        COMMIT;`);
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (!db.prepare('SELECT 1 FROM inbox_meta WHERE key=?').get('labels-seeded')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [name, color] of [['Pelanggan baru', 'blue'], ['Prospek', 'purple'], ['Menunggu pembayaran', 'amber'], ['Sudah bayar', 'green'], ['Pesanan selesai', 'slate']]) db.prepare('INSERT OR IGNORE INTO inbox_labels VALUES (?,?,?)').run(randomUUID(), name, color);
      db.prepare('INSERT INTO inbox_meta VALUES (?)').run('labels-seeded');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const hasConversation = (jid, instance = 'default') => Boolean(db.prepare('SELECT 1 FROM messages WHERE jid=? AND instance=? LIMIT 1').get(jid, instance));
  const requireConversation = (jid, instance = 'default') => { if (typeof jid !== 'string' || !hasConversation(jid, instance)) throw invalid('Percakapan tidak ditemukan.'); };
  return {
    add(message) {
      const inserted = db.prepare('INSERT OR IGNORE INTO messages (id,jid,name,text,outgoing,timestamp,instance) VALUES (?,?,?,?,?,?,?)').run(message.id, message.jid, message.name || '', message.text, message.outgoing ? 1 : 0, message.timestamp, message.instance || 'default').changes > 0;
      if (inserted && typeof message.text === 'string' && message.text.trim()) {
        const instance = message.instance || 'default';
        const existing = db.prepare('SELECT entries FROM conversation_memory_scoped WHERE instance=? AND jid=?').get(instance, message.jid);
        let entries = [];
        try { entries = JSON.parse(existing?.entries || '[]'); } catch {}
        if (!Array.isArray(entries) || !entries.length) {
          entries = db.prepare("SELECT id,text,outgoing,timestamp FROM messages WHERE instance=? AND jid=? AND id<>? AND trim(text)<>'' ORDER BY timestamp DESC,rowid DESC LIMIT 11")
            .all(instance, message.jid, message.id).reverse()
            .map(entry => ({ ...entry, text: entry.text.slice(-240), outgoing: Boolean(entry.outgoing) }));
        }
        entries = Array.isArray(entries) ? entries.filter(entry => typeof entry?.text === 'string').slice(-11) : [];
        entries.push({ id: message.id, text: message.text.trim().slice(-240), outgoing: Boolean(message.outgoing), timestamp: message.timestamp });
        db.prepare('INSERT INTO conversation_memory_scoped (instance,jid,entries,updated_at) VALUES (?,?,?,?) ON CONFLICT(instance,jid) DO UPDATE SET entries=excluded.entries,updated_at=excluded.updated_at')
          .run(instance, message.jid, JSON.stringify(entries.slice(-12)), Date.now());
      }
      const instance = message.instance || 'default';
      if (message.outgoing || Number.isInteger(message.status)) this.updateReceipt({ remoteJid: message.jid, id: message.id, fromMe: Boolean(message.outgoing) }, message.status ?? 1, instance);
      const receipt = db.prepare('SELECT status FROM message_status_scoped WHERE instance=? AND jid=? AND id=?').get(instance, message.jid, message.id);
      if (!message.outgoing && receipt?.status >= 4) this.markRead(message.jid, [message.id], true, instance);
      return inserted;
    },
    list() {
      const rows = db.prepare(`SELECT m.id,m.jid,m.text,m.outgoing,m.timestamp,m.instance,
        COALESCE((SELECT n.name FROM messages n WHERE n.instance=m.instance AND n.jid=m.jid AND n.outgoing=0 AND n.name<>'' ORDER BY n.timestamp DESC,n.rowid DESC LIMIT 1),'') AS name,
        MAX((SELECT count(*) FROM messages n WHERE n.instance=m.instance AND n.jid=m.jid AND n.outgoing=0 AND n.read_at=0),COALESCE(s.force_unread,0)) AS unreadCount
        FROM messages m LEFT JOIN conversation_state_scoped s ON s.instance=m.instance AND s.jid=m.jid
        WHERE m.rowid=(SELECT n.rowid FROM messages n WHERE n.instance=m.instance AND n.jid=m.jid ORDER BY n.timestamp DESC,n.rowid DESC LIMIT 1)
        ORDER BY m.timestamp DESC LIMIT 200`).all();
      const labels = db.prepare('SELECT c.instance,c.jid,l.* FROM conversation_labels_scoped c JOIN inbox_labels l ON l.id=c.label_id ORDER BY l.name').all();
      return rows.map(row => ({ ...row, labels: labels.filter(label => label.instance === row.instance && label.jid === row.jid).map(({ instance, jid, ...label }) => label) }));
    },
    thread(jid, instance = 'default') {
      return db.prepare(`SELECT m.*,COALESCE(s.status,0) AS status FROM
        (SELECT rowid AS sequence,* FROM messages WHERE jid=? AND instance=? ORDER BY timestamp DESC,rowid DESC LIMIT 200) m
        LEFT JOIN message_status_scoped s ON s.jid=m.jid AND s.instance=m.instance AND s.id=m.id ORDER BY m.timestamp,m.sequence`).all(jid, instance);
    },
    byId(messageId, instance) { return instance === undefined ? db.prepare('SELECT id,jid,name,text,outgoing,timestamp,instance FROM messages WHERE id=?').get(messageId) : db.prepare('SELECT id,jid,name,text,outgoing,timestamp,instance FROM messages WHERE id=? AND instance=?').get(messageId, instance); },
    saveLeadSource({ instance = 'default', jid, title = '', body = '', sourceUrl = '' }) {
      if (typeof jid !== 'string' || !jid) return;
      db.prepare('INSERT INTO lead_sources VALUES (?,?,?,?,?,?) ON CONFLICT(instance,jid) DO UPDATE SET title=excluded.title,body=excluded.body,source_url=excluded.source_url,updated_at=excluded.updated_at')
        .run(instance, jid, String(title ?? '').slice(0, 300), String(body ?? '').slice(0, 1000), String(sourceUrl ?? '').slice(0, 500), Date.now());
    },
    leadSource(jid, instance = 'default') { return db.prepare('SELECT title,body,source_url AS sourceUrl FROM lead_sources WHERE instance=? AND jid=?').get(instance, jid) || null; },
    memory(jid, instance = 'default') {
      const entries = db.prepare('SELECT entries FROM conversation_memory_scoped WHERE jid=? AND instance=?').get(jid, instance)?.entries;
      try { const parsed = JSON.parse(entries || '[]'); return Array.isArray(parsed) ? parsed.filter(entry => typeof entry?.text === 'string').slice(-12) : []; }
      catch { return []; }
    },
    renameNumber(from, to) { db.prepare('UPDATE messages SET instance=? WHERE instance=?').run(to, from); },
    numberFor(jid) {
      if (typeof jid !== 'string') return 'default';
      return db.prepare('SELECT instance FROM messages WHERE jid=? ORDER BY outgoing,timestamp DESC,rowid DESC LIMIT 1').get(jid)?.instance || 'default';
    },
    readKeys(jid, ids, instance = 'default') {
      requireConversation(jid, instance);
      if (!Array.isArray(ids) || ids.length > 200 || ids.some(id => typeof id !== 'string' || id.length > 200)) throw invalid('Daftar pesan tidak valid.');
      const find = db.prepare('SELECT id,jid,instance FROM messages WHERE id=? AND jid=? AND instance=? AND outgoing=0 AND receipt_sent_at=0');
      return [...new Set(ids)].map(id => find.get(id, jid, instance)).filter(Boolean).map(row => ({ remoteJid: row.jid, id: row.id, fromMe: false }));
    },
    markRead(jid, ids, receiptSent = false, instance = 'default') {
      const update = db.prepare('UPDATE messages SET read_at=CASE WHEN read_at=0 THEN ? ELSE read_at END,receipt_sent_at=CASE WHEN ? THEN ? ELSE receipt_sent_at END WHERE jid=? AND id=? AND instance=? AND outgoing=0');
      const now = Date.now();
      for (const id of ids) update.run(now, receiptSent ? 1 : 0, now, jid, id, instance);
      db.prepare('INSERT INTO conversation_state_scoped VALUES (?,?,0) ON CONFLICT(instance,jid) DO UPDATE SET force_unread=0').run(instance, jid);
    },
    markUnread(jid, instance = 'default') {
      requireConversation(jid, instance);
      db.prepare('INSERT INTO conversation_state_scoped VALUES (?, ?,1) ON CONFLICT(instance,jid) DO UPDATE SET force_unread=1').run(instance, jid);
    },
    updateReceipt(key, status, instance = 'default') {
      if (!key?.remoteJid || !key.id || !Number.isInteger(status) || status < 1 || status > 5) return;
      db.prepare('INSERT INTO message_status_scoped VALUES (?,?,?,?) ON CONFLICT(instance,jid,id) DO UPDATE SET status=MAX(status,excluded.status)').run(instance, key.remoteJid, key.id, status);
      if (key.fromMe === false && status >= 4) this.markRead(key.remoteJid, [key.id], true, instance);
    },
    labels() { return db.prepare('SELECT * FROM inbox_labels ORDER BY name COLLATE NOCASE').all(); },
    saveLabel(input) {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 40 || !LABEL_COLORS.includes(input.color)) throw invalid('Isi nama label (maksimal 40 karakter) dan pilih warna.');
      if (input.id && !db.prepare('SELECT 1 FROM inbox_labels WHERE id=?').get(input.id)) throw invalid('Label tidak ditemukan.');
      if (!input.id && this.labels().length >= 50) throw invalid('Maksimal 50 label.');
      const label = { id: input.id || randomUUID(), name, color: input.color };
      try { db.prepare('INSERT INTO inbox_labels VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color').run(label.id, name, label.color); }
      catch (error) { if (String(error.message).includes('UNIQUE')) throw invalid('Nama label sudah digunakan.'); throw error; }
      return label;
    },
    deleteLabel(id) { return db.prepare('DELETE FROM inbox_labels WHERE id=?').run(id).changes > 0; },
    setLabels(jid, ids, instance = 'default') {
      requireConversation(jid, instance);
      const valid = new Set(this.labels().map(label => label.id));
      if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => !valid.has(id))) throw invalid('Label tidak valid.');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM conversation_labels_scoped WHERE instance=? AND jid=?').run(instance, jid);
        for (const id of new Set(ids)) db.prepare('INSERT INTO conversation_labels_scoped VALUES (?,?,?)').run(instance, jid, id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    hasConversation,
    close() { db.close(); },
  };
}
