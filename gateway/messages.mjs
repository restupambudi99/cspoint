import { DatabaseSync } from 'node:sqlite';
export function openMessages(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, jid TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, outgoing INTEGER NOT NULL, timestamp INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS messages_jid_time ON messages(jid,timestamp);');
  return {
    add(message) { db.prepare('INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?)').run(message.id, message.jid, message.name || '', message.text, message.outgoing ? 1 : 0, message.timestamp); },
    list() { return db.prepare('SELECT m.* FROM messages m WHERE m.rowid=(SELECT n.rowid FROM messages n WHERE n.jid=m.jid ORDER BY n.timestamp DESC,n.rowid DESC LIMIT 1) ORDER BY timestamp DESC LIMIT 200').all(); },
    thread(jid) { return db.prepare('SELECT * FROM (SELECT * FROM messages WHERE jid=? ORDER BY timestamp DESC,rowid DESC LIMIT 200) ORDER BY timestamp').all(jid); },
    close() { db.close(); },
  };
}
