import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openAiConfig, createRouterClient, buildAiMessages } from './ai.mjs';
import { createAutoReply } from './auto-reply.mjs';
import { openMessages } from './messages.mjs';
import { openStore } from './store.mjs';

const folder = await mkdtemp(join(tmpdir(), 'cspoint-ai-test-'));
const path = join(folder, 'qa.sqlite');
const secret = 'test-only-server-encryption-secret';
const apiKey = 'qa-router-secret-not-for-production';
const legacyPath = join(folder, 'legacy.sqlite'), legacyDb = new DatabaseSync(legacyPath), legacyTime = Date.now();
legacyDb.exec('CREATE TABLE ai_reply_claims (message_id TEXT PRIMARY KEY, day TEXT NOT NULL); CREATE TABLE messages (id TEXT PRIMARY KEY, jid TEXT NOT NULL, name TEXT NOT NULL, text TEXT NOT NULL, outgoing INTEGER NOT NULL, timestamp INTEGER NOT NULL);');
legacyDb.prepare('INSERT INTO ai_reply_claims VALUES (?,?)').run('legacy-failed', '2026-11-04');
legacyDb.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run('legacy-failed', 'lead@s.whatsapp.net', '', 'berapa total?', 0, legacyTime);
legacyDb.prepare('INSERT INTO ai_reply_claims VALUES (?,?)').run('legacy-replied', '2026-11-04');
legacyDb.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run('legacy-replied', 'customer@s.whatsapp.net', '', 'halo', 0, legacyTime - 5000);
legacyDb.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run('outgoing-reply', 'customer@s.whatsapp.net', '', 'Halo kak', 1, legacyTime - 4000);
const legacyConfig = openAiConfig(legacyPath, secret);
assert.deepEqual(legacyConfig.pendingReplies(), ['legacy-failed'], 'recent messages that failed before migration are requeued');
legacyConfig.close(); legacyDb.close();
let config = openAiConfig(path, secret), calls = 0, reject = false, missingModel = false, lastPayload;
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  assert.equal(req.headers.authorization, `Bearer ${apiKey}`);
  if (missingModel) { res.writeHead(404); res.end(JSON.stringify({ error: `No active credentials: ${apiKey}` })); return; }
  if (reject) { res.writeHead(401); res.end(JSON.stringify({ error: `Secret ${apiKey}` })); return; }
  if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'Fallback' }] })); return; }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  lastPayload = JSON.parse(raw);
  calls++;
  res.end(JSON.stringify({ choices: [{ message: { content: 'Halo, saya CSPoint. Ada yang bisa dibantu?' } }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let router = createRouterClient(config, { baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
const store = openStore(':memory:'), messages = openMessages(':memory:');
store.saveSettings({ shippingPdfName: 'Tarif ongkir.pdf', shippingPdfText: 'Bubon / Aceh Barat → Rp40.000' });
assert.match(store.knowledge.relevant('Berapa ongkir ke Kecamatan Bubon?')[0].content, /Bubon \/ Aceh Barat → Rp40\.000/);
try {
  assert.equal(config.publicConfig().hasApiKey, false);
  assert.equal(config.publicConfig().model, 'Hermesollama');
  assert.throws(() => config.credentials(), /terlebih dahulu/);
  const saved = config.save({ model: 'Fallback', apiKey });
  assert.equal(saved.hasApiKey, true);
  assert.equal(JSON.stringify(saved).includes(apiKey), false);
  config.save({ model: 'Fallback', apiKey: '' });
  assert.equal(config.credentials().apiKey, apiKey, 'empty password preserves the stored key');
  config.close();
  assert.equal((await readFile(path)).includes(Buffer.from(apiKey)), false, 'database must not contain plaintext API key');
  config = openAiConfig(path, secret);
  router = createRouterClient(config, { baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
  assert.equal(config.credentials().apiKey, apiKey, 'encrypted key survives restart');
  assert.throws(() => config.save({ apiKey: 'bad\nkey' }), /tidak valid/);
  assert.throws(() => config.save({ model: '' }), /tidak valid/);
  assert.equal(config.claimReply('queued-message', '2026-11-04', 0), true);
  config.deferReply('queued-message');
  assert.deepEqual(config.pendingReplies(), ['queued-message'], 'failed replies remain queued for reconnect');
  assert.equal(config.claimReply('queued-message', '2026-11-04', 0), true, 'pending replies can be retried');
  config.finishReply('queued-message');
  assert.deepEqual(config.pendingReplies(), []);
  assert.equal(config.claimReply('queued-message', '2026-11-04', 0), false, 'completed replies are not duplicated');

  assert.deepEqual(await router.models(), ['Fallback']);
  const prompt = buildAiMessages({ assistantName: 'CSPoint', instructions: 'Jawab ramah.' }, [{ text: 'Halo', outgoing: false }]);
  assert.match(await router.complete(prompt), /CSPoint/);
  assert.equal(lastPayload.model, 'Fallback');
  assert.equal(lastPayload.max_tokens, 1200);
  assert.equal(lastPayload.messages[0].role, 'system');
  assert.equal(lastPayload.messages.at(-1).role, 'user');
  reject = true;
  await assert.rejects(router.complete(prompt), error => error.status === 502 && !error.message.includes(apiKey));
  reject = false;
  missingModel = true;
  await assert.rejects(router.complete(prompt), error => error.status === 422 && /Model\/combo/.test(error.message) && !error.message.includes(apiKey));
  missingModel = false;

  let sent = [], current = true;
  const simulatedNow = new Date('2026-11-04T10:00:00+07:00');
  const onError = error => { throw error; };
  const reads = [];
  const connection = { isCurrent: () => current, markRead: async message => { reads.push(message.id); }, send: async (jid, payload) => { sent.push({ jid, ...payload }); return { key: { id: `out-${sent.length}` } }; } };
  const inbound = { id: 'in-1', jid: '628123450000@s.whatsapp.net', text: 'Berapa ongkir ke Kecamatan Bubon?', outgoing: false, timestamp: simulatedNow.getTime() };
  assert.equal(messages.add(inbound), true);
  assert.equal(messages.byId(inbound.id).text, inbound.text);
  assert.equal(messages.add(inbound), false, 'duplicate WhatsApp delivery is recognized');
  const delays = [];
  const reply = createAutoReply({ store, config, router, messages, buildMessages: buildAiMessages, onError, sleep: async ms => { delays.push(ms); }, now: () => simulatedNow });
  await reply(inbound, connection);
  assert.equal(sent.length, 0, 'disabled agent must not send');
  store.saveAgent({ enabled: true });
  await reply(inbound, connection);
  assert.equal(sent.length, 0, 'global auto-reply switch must also be on');
  assert.equal(reads.length, 0, 'disabled AI must not mark messages as read');
  store.saveSettings({ autoReply: true, dailyLimit: 0 });
  await reply(inbound, connection);
  assert.equal(sent.length, 1);
  assert.deepEqual(reads, [inbound.id], 'enabled AI acknowledges the incoming message before replying');
  assert.equal(delays.length, 0, 'first reply has no artificial interval delay');
  assert.match(lastPayload.messages[0].content, /Bubon \/ Aceh Barat → Rp40\.000/, 'shipping PDF tariff is included in the AI context');
  assert.match(lastPayload.messages[0].content, /Arahkan percakapan sampai closing/);
  assert.equal(messages.thread(inbound.jid).at(-1).outgoing, 1);
  const afterReply = calls;
  await reply(inbound, connection);
  await reply({ ...inbound, id: 'in-2', text: 'Totalnya berapa kak?' }, connection);
  assert.equal(calls, afterReply + 1, 'limit 0 means no daily cap');
  assert.equal(sent.length, 2);
  const afterSecondReply = calls;
  store.saveSettings({ dailyLimit: 0 });
  current = false;
  await reply({ ...inbound, id: 'in-3' }, connection);
  assert.equal(calls, afterSecondReply, 'stale connection must not trigger inference');
  current = true;
  const cancellingReply = createAutoReply({ store, config, router, messages, buildMessages: buildAiMessages, onError, sleep: async () => { current = false; }, now: () => simulatedNow });
  await cancellingReply({ ...inbound, id: 'in-4a' }, connection);
  const sentBeforeCancelledReply = sent.length;
  current = true;
  await cancellingReply({ ...inbound, id: 'in-4b' }, connection);
  assert.equal(sent.length, sentBeforeCancelledReply, 'disconnect during interval wait cancels the send');
  current = true;
  store.saveSettings({ scheduleEnabled: true, scheduleStart: '08:00', scheduleEnd: '09:00' });
  const scheduledReply = createAutoReply({ store, config, router, messages, buildMessages: buildAiMessages, onError, sleep: async () => {}, now: () => new Date('2026-11-04T05:00:00Z') });
  const beforeSchedule = calls;
  await scheduledReply({ ...inbound, id: 'in-5' }, connection);
  assert.equal(calls, beforeSchedule, 'AI does not reply outside operating hours');

  store.saveSettings({ scheduleEnabled: false, dailyLimit: 0 });
  let retryCalls = 0, retrySent = 0, retryDelay = 0;
  const retryReply = createAutoReply({
    store, config, messages, buildMessages: buildAiMessages,
    router: { complete: async () => { if (++retryCalls < 3) throw Object.assign(new Error('temporary upstream error'), { status: 502 }); return 'Tarif ditemukan.'; } },
    sleep: async ms => { retryDelay = ms; },
    onError: error => { throw error; },
    now: () => simulatedNow,
  });
  await retryReply({ ...inbound, id: 'in-6' }, { isCurrent: () => true, send: async () => { retrySent++; return { key: { id: 'out-retry' } }; } });
  assert.equal(retryCalls, 3, 'temporary router failures receive multiple retries');
  assert.equal(retryDelay, 2000, 'retry backs off before the final 9Router attempt');
  assert.equal(retrySent, 1, 'retry sends only one WhatsApp reply');

  let fallbackFailure, fallbackSent = '';
  const fallbackReply = createAutoReply({
    store, config, messages, buildMessages: buildAiMessages,
    router: { complete: async () => { throw Object.assign(new Error('empty model response'), { status: 502 }); } },
    sleep: async () => {}, onError: error => { fallbackFailure = error; }, now: () => simulatedNow,
  });
  await fallbackReply({ ...inbound, id: 'in-7' }, { isCurrent: () => true, send: async (_jid, payload) => { fallbackSent = payload.text; return { key: { id: 'out-fallback' } }; } });
  assert.match(fallbackSent, /saya bantu cek dan lanjutkan pesanan/i, 'a model outage still gets a helpful WhatsApp reply');
  assert.equal(fallbackFailure.fallbackSent, true, 'fallback delivery is visible in gateway health');

  const longInstruction = `Panduan layanan pelanggan\n${'Aturan toko yang sudah disetujui.\n'.repeat(300)}\nJika pelanggan bertanya total Paket 3, jangan mengarang; pastikan harga dan jumlah.\n`;
  const contextMessages = buildAiMessages({ assistantName: 'CSPoint', instructions: longInstruction }, [{ text: 'Saya pesan Paket 3, 50 pcs. Total berapa?', outgoing: false }], Array.from({ length: 8 }, (_, index) => ({ name: index === 7 ? 'Paket 3' : `Barang ${index}`, sku: '', description: 'produk', price: 10000 + index, stock: 1 })), Array.from({ length: 5 }, (_, index) => ({ name: `Referensi ${index}`, content: 'tarif'.repeat(500) })));
  assert.ok(contextMessages[0].content.includes('Jika pelanggan bertanya total Paket 3'), 'relevant instructions are retrieved even when they are at the end');
  assert.ok(contextMessages[0].content.length < 7000, 'catalog, PDF and relevant admin context fit the model window');
  assert.match(contextMessages[0].content, /"name":"Paket 3"/, 'catalog context prioritizes the product named in the order');
  console.log('PASS: encrypted key persistence/redaction, 9Router auth/models/completions, uncapped replies, schedule independence, history, retries, reconnect cancellation and sales context');
} finally {
  config.close(); store.close(); messages.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(folder, { recursive: true, force: true });
}
