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
  if (!db.prepare('SELECT 1 FROM inbox_meta WHERE key=?').get('labels-seeded')) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [name, color] of [['Pelanggan baru', 'blue'], ['Prospek', 'purple'], ['Menunggu pembayaran', 'amber'], ['Sudah bayar', 'green'], ['Pesanan selesai', 'slate']]) db.prepare('INSERT OR IGNORE INTO inbox_labels VALUES (?,?,?)').run(randomUUID(), name, color);
      db.prepare('INSERT INTO inbox_meta VALUES (?)').run('labels-seeded');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const hasConversation = jid => Boolean(db.prepare('SELECT 1 FROM messages WHERE jid=? LIMIT 1').get(jid));
  const requireConversation = jid => { if (typeof jid !== 'string' || !hasConversation(jid)) throw invalid('Percakapan tidak ditemukan.'); };
  return {
    add(message) {
      const inserted = db.prepare('INSERT OR IGNORE INTO messages (id,jid,name,text,outgoing,timestamp,instance) VALUES (?,?,?,?,?,?,?)').run(message.id, message.jid, message.name || '', message.text, message.outgoing ? 1 : 0, message.timestamp, message.instance || 'default').changes > 0;
      if (inserted && typeof message.text === 'string' && message.text.trim()) {
        const existing = db.prepare('SELECT entries FROM conversation_memory WHERE jid=?').get(message.jid);
        let entries = [];
        try { entries = JSON.parse(existing?.entries || '[]'); } catch {}
        if (!Array.isArray(entries) || !entries.length) {
          entries = db.prepare("SELECT id,text,outgoing,timestamp FROM messages WHERE jid=? AND id<>? AND trim(text)<>'' ORDER BY timestamp DESC,rowid DESC LIMIT 11")
            .all(message.jid, message.id).reverse()
            .map(entry => ({ ...entry, text: entry.text.slice(-240), outgoing: Boolean(entry.outgoing) }));
        }
        entries = Array.isArray(entries) ? entries.filter(entry => typeof entry?.text === 'string').slice(-11) : [];
        entries.push({ id: message.id, text: message.text.trim().slice(-240), outgoing: Boolean(message.outgoing), timestamp: message.timestamp });
        db.prepare('INSERT INTO conversation_memory (jid,entries,updated_at) VALUES (?,?,?) ON CONFLICT(jid) DO UPDATE SET entries=excluded.entries,updated_at=excluded.updated_at')
          .run(message.jid, JSON.stringify(entries.slice(-12)), Date.now());
      }
      if (message.outgoing || Number.isInteger(message.status)) this.updateReceipt({ remoteJid: message.jid, id: message.id, fromMe: Boolean(message.outgoing) }, message.status ?? 1);
      const receipt = db.prepare('SELECT status FROM message_status WHERE jid=? AND id=?').get(message.jid, message.id);
      if (!message.outgoing && receipt?.status >= 4) this.markRead(message.jid, [message.id], true);
      return inserted;
    },
    list() {
      const rows = db.prepare(`SELECT m.id,m.jid,m.text,m.outgoing,m.timestamp,m.instance,
        COALESCE((SELECT n.name FROM messages n WHERE n.jid=m.jid AND n.outgoing=0 AND n.name<>'' ORDER BY n.timestamp DESC,n.rowid DESC LIMIT 1),'') AS name,
        MAX((SELECT count(*) FROM messages n WHERE n.jid=m.jid AND n.outgoing=0 AND n.read_at=0),COALESCE(s.force_unread,0)) AS unreadCount
        FROM messages m LEFT JOIN conversation_state s ON s.jid=m.jid
        WHERE m.rowid=(SELECT n.rowid FROM messages n WHERE n.jid=m.jid ORDER BY n.timestamp DESC,n.rowid DESC LIMIT 1)
        ORDER BY m.timestamp DESC LIMIT 200`).all();
      const labels = db.prepare('SELECT c.jid,l.* FROM conversation_labels c JOIN inbox_labels l ON l.id=c.label_id ORDER BY l.name').all();
      return rows.map(row => ({ ...row, labels: labels.filter(label => label.jid === row.jid).map(({ jid, ...label }) => label) }));
    },
    thread(jid) {
      return db.prepare(`SELECT m.*,COALESCE(s.status,0) AS status FROM
        (SELECT rowid AS sequence,* FROM messages WHERE jid=? ORDER BY timestamp DESC,rowid DESC LIMIT 200) m
        LEFT JOIN message_status s ON s.jid=m.jid AND s.id=m.id ORDER BY m.timestamp,m.sequence`).all(jid);
    },
    byId(messageId) { return db.prepare('SELECT id,jid,name,text,outgoing,timestamp,instance FROM messages WHERE id=?').get(messageId); },
    memory(jid) {
      const entries = db.prepare('SELECT entries FROM conversation_memory WHERE jid=?').get(jid)?.entries;
      try { const parsed = JSON.parse(entries || '[]'); return Array.isArray(parsed) ? parsed.filter(entry => typeof entry?.text === 'string').slice(-12) : []; }
      catch { return []; }
    },
    renameNumber(from, to) { db.prepare('UPDATE messages SET instance=? WHERE instance=?').run(to, from); },
    numberFor(jid) {
      if (typeof jid !== 'string') return 'default';
      return db.prepare('SELECT instance FROM messages WHERE jid=? ORDER BY outgoing,timestamp DESC,rowid DESC LIMIT 1').get(jid)?.instance || 'default';
    },
    readKeys(jid, ids, instance) {
      requireConversation(jid);
      if (!Array.isArray(ids) || ids.length > 200 || ids.some(id => typeof id !== 'string' || id.length > 200)) throw invalid('Daftar pesan tidak valid.');
      const find = db.prepare('SELECT id,jid,instance FROM messages WHERE id=? AND jid=? AND outgoing=0 AND receipt_sent_at=0');
      return [...new Set(ids)].map(id => find.get(id, jid)).filter(row => row && (!instance || row.instance === instance)).map(row => ({ remoteJid: row.jid, id: row.id, fromMe: false }));
    },
    markRead(jid, ids, receiptSent = false) {
      const update = db.prepare('UPDATE messages SET read_at=CASE WHEN read_at=0 THEN ? ELSE read_at END,receipt_sent_at=CASE WHEN ? THEN ? ELSE receipt_sent_at END WHERE jid=? AND id=? AND outgoing=0');
      const now = Date.now();
      for (const id of ids) update.run(now, receiptSent ? 1 : 0, now, jid, id);
      db.prepare('INSERT INTO conversation_state VALUES (?,0) ON CONFLICT(jid) DO UPDATE SET force_unread=0').run(jid);
    },
    markUnread(jid) {
      requireConversation(jid);
      db.prepare('INSERT INTO conversation_state VALUES (?,1) ON CONFLICT(jid) DO UPDATE SET force_unread=1').run(jid);
    },
    updateReceipt(key, status) {
      if (!key?.remoteJid || !key.id || !Number.isInteger(status) || status < 1 || status > 5) return;
      db.prepare('INSERT INTO message_status VALUES (?,?,?) ON CONFLICT(jid,id) DO UPDATE SET status=MAX(status,excluded.status)').run(key.remoteJid, key.id, status);
      if (key.fromMe === false && status >= 4) this.markRead(key.remoteJid, [key.id], true);
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
    setLabels(jid, ids) {
      requireConversation(jid);
      const valid = new Set(this.labels().map(label => label.id));
      if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => !valid.has(id))) throw invalid('Label tidak valid.');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM conversation_labels WHERE jid=?').run(jid);
        for (const id of new Set(ids)) db.prepare('INSERT INTO conversation_labels VALUES (?,?)').run(jid, id);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    hasConversation,
    close() { db.close(); },
  };
}
