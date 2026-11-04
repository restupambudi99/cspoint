import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNumbers, MAX_NUMBERS } from './wa-numbers.mjs';
import { openMessages } from './messages.mjs';
import { readConversation } from './read-receipts.mjs';

const root = await mkdtemp(join(tmpdir(), 'wa-numbers-'));
const sessionDir = join(root, 'session');
process.env.SESSION_BACKUP_DIR = join(root, 'backups');
const useAuth = async dir => {
  await mkdir(dir, { recursive: true });
  const creds = JSON.parse(await readFile(join(dir, 'creds.json'), 'utf8').catch(() => '{}'));
  return { state: { creds }, saveCreds: async () => writeFile(join(dir, 'creds.json'), JSON.stringify(creds)) };
};
const sockets = [];
const makeSocket = state => {
  const socket = { state, ev: new EventEmitter(), logouts: 0, ended: 0, logout: async () => { socket.logouts++; }, end() { socket.ended++; } };
  sockets.push(socket);
  return socket;
};
const pair = async (socket, phone) => {
  socket.state.creds.me = { id: `${phone}:7@s.whatsapp.net`, lid: `${phone}9@lid` };
  socket.ev.emit('creds.update');
  await tick();
  socket.ev.emit('connection.update', { connection: 'open' });
};
const close = (socket, statusCode) => socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode }, message: 'x' } } });
const opened = [], received = [];
const open = (options = {}) => openNumbers({ sessionDir, makeSocket, useAuth, closeCodes: { loggedOut: 401, restartRequired: 515 }, messages: { updateReceipt() {} }, onMessages: (number, socket, batch) => received.push([number.id, batch]), onOpen: number => opened.push(number.id), logoutTimeout: 20, ...options });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

let numbers = await open();
assert.deepEqual(numbers.list().map(item => item.id), ['default']);
assert.equal(numbers.primary().status, 'idle');
assert.throws(() => numbers.get('../etc'), error => error.status === 404);

// Slots stop at the limit and a freed slot is reused
const added = [];
for (let index = 2; index <= MAX_NUMBERS; index++) added.push(await numbers.add());
assert.equal(numbers.list().length, 10);
assert.deepEqual(added.map(item => item.label).slice(0, 2), ['Nomor 2', 'Nomor 3']);
await assert.rejects(numbers.add(), error => error.status === 409);
await numbers.disconnect('n4');
assert.equal(numbers.has('n4'), false);
assert.equal((await numbers.add()).id, 'n4');
for (const number of numbers.list().filter(item => item.id !== 'default' && item.id !== 'n2')) await numbers.disconnect(number.id);

// QR, then expiry: an unscanned slot goes idle and does not retry
const second = numbers.get('n2');
let socket = second.socket;
socket.ev.emit('connection.update', { qr: 'qr-1' });
assert.equal(second.status, 'awaiting_scan');
assert.equal(second.qr, 'qr-1');
assert.equal(numbers.primary(), second, 'a waiting QR represents the gateway over an idle one');
close(socket, 408);
assert.equal(second.status, 'idle');
assert.equal(second.view().retryPending, false);
await second.request();
socket = second.socket;

// Pairing
await pair(socket, '6281111');
assert.equal(second.status, 'connected');
assert.equal(second.phone, '6281111');
assert.deepEqual(opened, ['n2']);
assert.equal(numbers.owns('6281111@s.whatsapp.net'), true);
assert.equal(numbers.owns('62811119@lid'), true);
assert.equal(numbers.owns('6289999@s.whatsapp.net'), false);
assert.equal(numbers.primary(), second);
socket.ev.emit('messages.upsert', { messages: ['m'] });
assert.deepEqual(received, [['n2', ['m']]]);

// The same phone in a second slot is unlinked and keeps the slot free for another number
const third = await numbers.add();
const duplicate = third.socket;
await pair(duplicate, '6281111');
while (third.busy) await tick();
assert.equal(duplicate.logouts, 1);
assert.equal(third.status, 'idle');
assert.match(third.notice, /Nomor 2/);
assert.equal(third.hasSession, false);
assert.equal(numbers.has(third.id), true);
assert.deepEqual(opened, ['n2'], 'a duplicate never starts answering');

// Disconnect unlinks, archives, removes the folder, and ignores late events
const result = await numbers.disconnect('n2');
assert.equal(socket.logouts, 1);
assert.equal(result.unlinked, true);
assert.equal(numbers.has('n2'), false);
await assert.rejects(stat(join(root, 'numbers', 'n2')));
assert.ok((await readdir(result.archived)).includes('creds.json'), 'session copy is kept');
socket.ev.emit('messages.upsert', { messages: ['late'] });
assert.equal(received.length, 1);

// An unresponsive logout is reported, not presented as success
await numbers.disconnect(third.id);
const stuck = await numbers.add();
const stuckSocket = stuck.socket;
stuckSocket.logout = () => new Promise(() => {});
await pair(stuckSocket, '6282222');
assert.equal((await numbers.disconnect(stuck.id)).unlinked, false);

// The first number keeps its slot and comes back through a new QR
const main = numbers.get('default');
await main.request();
socket = main.socket;
await pair(socket, '6283333');
await numbers.disconnect('default');
assert.equal(numbers.has('default'), true);
assert.equal(main.status, 'idle');
assert.equal(main.hasSession, false);
assert.deepEqual(await readdir(sessionDir), []);

// Removed from the phone: stays logged out until asked, then starts clean
await main.request();
socket = main.socket;
await pair(socket, '6283333');
close(socket, 401);
assert.equal(main.status, 'logged_out');
await main.request();
assert.equal(main.status, 'connecting');
assert.equal(main.hasSession, false);
socket = main.socket;
await pair(socket, '6283333');

// Dropped connections retry; disconnecting cancels the retry
const count = sockets.length;
close(socket, 515);
assert.equal(main.status, 'disconnected');
assert.equal(main.view().retryPending, true);
await numbers.disconnect('default');
await new Promise(resolve => setTimeout(resolve, 1600));
assert.equal(sockets.length, count, 'disconnect cancels the pending retry');

// After a restart only paired slots reconnect, the unscanned one waits
await main.request();
await pair(main.socket, '6283333');
const paired = await numbers.add();
await pair(paired.socket, '6284444');
await numbers.add();
numbers.close();
numbers = await open();
assert.deepEqual(numbers.list().map(item => item.id), ['default', 'n2', 'n3']);
await numbers.start(0);
assert.deepEqual(numbers.list().map(item => item.status), ['connecting', 'connecting', 'idle']);
assert.equal(numbers.get('n2').phone, '6284444');
numbers.close();

// Messages remember their number, on a legacy database too
const dbPath = join(root, 'legacy.sqlite');
const legacy = new DatabaseSync(dbPath);
legacy.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, jid TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, outgoing INTEGER NOT NULL, timestamp INTEGER NOT NULL); INSERT INTO messages VALUES ('old','628@s.whatsapp.net','A','lama',0,1)");
legacy.close();
const store = openMessages(dbPath);
const jid = '628@s.whatsapp.net';
assert.equal(store.byId('old').instance, 'default');
assert.equal(store.numberFor(jid), 'default');
store.add({ id: 'in2', jid, text: 'baru', timestamp: 2, instance: 'n3' });
assert.equal(store.byId('in2').instance, 'n3');
assert.equal(store.numberFor(jid), 'n3');
store.add({ id: 'out', jid, text: 'dari nomor 1', outgoing: true, timestamp: 3, instance: 'default' });
assert.equal(store.numberFor(jid), 'n3', 'the customer last wrote to n3');
assert.equal(store.list()[0].instance, 'default');
assert.equal(store.numberFor(undefined), 'default');
assert.equal(store.numberFor('628unknown@s.whatsapp.net'), 'default');
let keys;
await readConversation(store, { readMessages: async value => { keys = value; } }, jid, ['old', 'in2'], 'n3');
assert.deepEqual(keys.map(key => key.id), ['in2'], 'a read receipt only goes out through the number that received it');
store.close();

await rm(root, { recursive: true, force: true });
console.log('wa-numbers test ok');
