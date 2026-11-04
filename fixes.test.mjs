import assert from 'node:assert/strict';
import { normalizeWaPhone, resolveWaJid } from './phone.mjs';
import { openStore } from './store.mjs';
import { createAutoReply, withinSchedule } from './auto-reply.mjs';
import { openAiConfig } from './ai.mjs';

// Phone numbers
for (const input of ['081234567890', '6281234567890', '81234567890', '+62 812-3456-7890']) assert.equal(normalizeWaPhone(input), '6281234567890', input);
for (const input of ['', 'abc', '123', '0812', '12025550123', '628123456789012345', undefined]) assert.equal(normalizeWaPhone(input), '', String(input));
assert.equal(await resolveWaJid({ onWhatsApp: async () => [{ exists: true, jid: '6281@s.whatsapp.net' }] }, '6281'), '6281@s.whatsapp.net');
assert.equal(await resolveWaJid({ onWhatsApp: async () => [] }, '6281'), null, 'unregistered number');

const store = openStore(':memory:');
const rejects = (fn, status = 400) => assert.throws(fn, error => error.status === status);

// Contacts and orders
rejects(() => store.contacts.create({ name: 'A', phone: 'abc' }));
assert.equal(store.contacts.create({ name: 'A' }).phone, '', 'phone stays optional');
const contact = store.contacts.create({ name: 'A', phone: '081234567890' });
assert.equal(contact.phone, '6281234567890');
assert.equal(store.contacts.update(contact.id, { name: 'B', phone: '081234567891', tag: 'x' }).name, 'B');
rejects(() => store.contacts.update(contact.id, { name: 'B', phone: '12' }));
assert.equal(store.contacts.update('missing', { name: 'B' }), null);
rejects(() => store.orders.create({ customer: 'A', phone: '0812' }));
rejects(() => store.orders.create({ customer: 'A', status: 'Palsu' }));
const order = store.orders.create({ customer: 'A' });
assert.equal(order.status, 'Menunggu Bayar');
assert.equal(store.orders.update(order.id, { status: 'Selesai' }).status, 'Selesai');
rejects(() => store.orders.update(order.id, { status: 'Palsu' }));

// Templates: saving a stage overwrites the newest row and keeps older ones
const first = store.templates.create({ name: 'FU1', body: 'satu', stage: 'FU1' });
const second = store.templates.create({ name: 'FU1 baru', body: 'dua', stage: 'FU1' });
assert.equal(second.id, first.id);
assert.equal(store.templates.list().length, 1);
assert.equal(store.templates.list()[0].body, 'dua');
store.templates.create({ name: 'Tanpa tahap', body: 'a' });
store.templates.create({ name: 'Tanpa tahap', body: 'b' });
assert.equal(store.templates.list().length, 3, 'rows without a stage are not merged');

// Settings validation
rejects(() => store.saveSettings({ minInterval: 9, maxInterval: 3 }));
rejects(() => store.saveSettings({ scheduleStart: '99:99' }));
rejects(() => store.saveSettings({ scheduleStart: '22:00', scheduleEnd: '08:00' }));
rejects(() => store.saveSettings({ scheduleStart: '08:00', scheduleEnd: '08:00' }));
assert.equal(store.saveSettings({ minInterval: 3, maxInterval: 7 }).autoReply, false, 'partial save keeps toggles');
assert.equal(store.settings().dailyLimit, 0, 'default does not limit');
assert.equal(store.settings().scheduleEnabled, false, 'default does not limit');

// Manual shipping priority
store.saveSettings({ shippingPdfName: 'tarif.pdf', shippingPdfText: 'Bubon Rp40.000' });
assert.equal(store.knowledge.relevant('bubon').length, 1);
store.saveSettings({ manualShippingPriority: false });
assert.equal(store.knowledge.relevant('bubon').length, 0, 'switched off: PDF is not used');
store.saveSettings({ manualShippingPriority: true });

// Operating hours, in WIB
const at = iso => new Date(iso);
const hours = { scheduleEnabled: true, scheduleStart: '08:00', scheduleEnd: '21:00' };
assert.equal(withinSchedule(hours, at('2026-11-04T01:00:00Z')), true, '08:00 WIB');
assert.equal(withinSchedule(hours, at('2026-11-04T00:59:00Z')), false, '07:59 WIB');
assert.equal(withinSchedule(hours, at('2026-11-04T14:00:00Z')), false, '21:00 WIB');
assert.equal(withinSchedule({ ...hours, scheduleEnabled: false }, at('2026-11-04T18:00:00Z')), true);

// Auto reply
store.saveAgent({ instructions: 'Halo', enabled: true });
store.saveSettings({ autoReply: true });
const config = { publicConfig: () => ({ hasApiKey: true, updatedAt: 1 }), claimReply: () => true, finishReply() {}, deferReply() {} };
const fakeMessages = () => ({ added: [], thread: () => [], add(message) { this.added.push(message); } });
const inbound = { id: 'in', jid: '6281@s.whatsapp.net', text: 'halo', outgoing: false };
const connection = send => ({ isCurrent: () => true, send });
const sent = async () => ({ key: { id: 'out' }, status: 1 });
const build = (messages, extra = {}) => createAutoReply({ store, config, router: { complete: async () => 'jawab' }, messages, buildMessages: (agent, thread) => { build.thread = thread; return []; }, sleep: async () => {}, ...extra });

let messages = fakeMessages();
await build(messages)(inbound, connection(sent));
assert.equal(messages.added.length, 1, 'history on: reply is stored');
store.saveSettings({ saveHistory: false });
messages = fakeMessages();
await build(messages)(inbound, connection(sent));
assert.equal(messages.added.length, 0, 'history off: reply is not stored');
assert.equal(build.thread.at(-1).text, 'halo', 'history off: AI still sees the message');
store.saveSettings({ saveHistory: true });

let limit;
await build(fakeMessages(), { config: { ...config, claimReply: (id, day, value) => { limit = value; return false; } } })(inbound, connection(sent));
assert.equal(limit, 0, 'stored limit reaches the claim');
store.saveSettings({ dailyLimit: 5 });
await build(fakeMessages(), { config: { ...config, claimReply: (id, day, value) => { limit = value; return false; } } })(inbound, connection(sent));
assert.equal(limit, 5);
store.saveSettings({ dailyLimit: 0 });

// Daily limit against the real claim table
const claims = openAiConfig(':memory:', 'test-secret');
assert.equal(claims.claimReply('a', '2026-11-04', 1), true);
claims.finishReply('a');
assert.equal(claims.claimReply('b', '2026-11-04', 1), false, 'limit reached');
assert.equal(claims.claimReply('b', '2026-11-05', 1), true, 'limit resets the next day');
claims.deferReply('b');
assert.equal(claims.claimReply('c', '2026-11-05', 1), true, 'a deferred reply does not use up the limit');
assert.equal(claims.claimReply('d', '2026-11-05', 0), true, 'limit 0 means no cap');

// A failed send retries on a timer. This used to throw ReferenceError and kill the process.
let attempts = 0;
await build(fakeMessages(), { onError() {} })(inbound, connection(async () => { if (++attempts === 1) throw Object.assign(new Error('down'), { status: 503 }); return sent(); }));
await new Promise(resolve => setTimeout(resolve, 2300));
assert.equal(attempts, 2, 'send is retried after failure');

console.log('fixes test ok');
