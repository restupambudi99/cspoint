import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { once } from 'node:events';
const token = 'test-only-token-00000000000000000000';
function pdfWithText(text) {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const stream = `BT /F1 12 Tf 20 50 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf).toString('base64');
}
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: { ...process.env, GATEWAY_TOKEN: token, PORT: '18182', MESSAGE_DB: ':memory:', SESSION_DIR: 'test-session' },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let errors = '';
child.stderr.on('data', chunk => { errors += chunk; });
try {
  let response;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) throw new Error(errors);
    try { response = await fetch('http://127.0.0.1:18182/status'); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.equal(response?.status, 401);
  const headers = { Authorization: `Bearer ${token}` };
  const json = async (path, init = {}) => {
    const result = await fetch(`http://127.0.0.1:18182${path}`, { ...init, headers: { ...headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
    return { code: result.status, body: await result.json() };
  };

  let result = await json('/status');
  assert.equal(result.code, 200);
  assert.equal(result.body.status, 'idle');
  assert.equal(result.body.hasSession, false);

  result = await json('/qr');
  assert.equal(result.code, 409);

  result = await json('/unknown');
  assert.equal(result.code, 404);

  result = await json('/send', { method: 'POST', body: JSON.stringify({ phone: '628123456789', text: 'not sent' }) });
  assert.equal(result.code, 409);
  assert.match(result.body.error, /belum terhubung/);

  // Settings round-trip must be persisted, not echoed.
  result = await json('/settings', { method: 'POST', body: JSON.stringify({ minInterval: 3, maxInterval: 9, rotation: 'Random (Acak)', couriers: ['JNE', 'SiCepat'] }) });
  assert.equal(result.code, 200);
  assert.equal(result.body.maxInterval, 9);
  result = await json('/settings');
  assert.deepEqual(result.body.couriers, ['JNE', 'SiCepat']);

  result = await json('/settings', { method: 'POST', body: JSON.stringify({ shippingPdfName: 'tarif-ongkir.pdf', shippingPdfContent: pdfWithText('Bubon / Aceh Barat -> Rp40.000'), shippingPdfMime: 'application/pdf', shippingPdfSize: 42, manualShippingPriority: true }) });
  assert.equal(result.body.shippingPdfName, 'tarif-ongkir.pdf');
  assert.equal(result.body.shippingPdfSize, 42);
  assert.equal(result.body.manualShippingPriority, true);
  result = await json('/settings');
  assert.equal(result.body.shippingPdfName, 'tarif-ongkir.pdf');
  assert.equal(result.body.shippingPdfSize, 42);
  assert.equal(result.body.shippingPdfContent, undefined, 'settings response must not expose PDF content');
  assert.equal(result.body.rotation, 'Random (Acak)');
  result = await json('/settings', { method: 'POST', body: JSON.stringify({ shippingPdfContent: 'x'.repeat(12000001) }) });
  assert.equal(result.code, 413);
  result = await json('/settings', { method: 'POST', body: JSON.stringify({ minInterval: 5, maxInterval: 1 }) });
  assert.equal(result.code, 400, 'maxInterval below minInterval is rejected');

  // Product create/list/delete against the real store.
  result = await json('/products', { method: 'POST', body: JSON.stringify({ name: 'Kaos Polos', sku: 'KP-01', price: 50000, stock: 7 }) });
  assert.equal(result.code, 200);
  const productId = result.body.id;
  assert.equal(result.body.price, 50000);
  result = await json('/products');
  assert.equal(result.body.length, 1);
  assert.equal(result.body[0].sku, 'KP-01');
  result = await json(`/products/${productId}`, { method: 'DELETE' });
  assert.equal(result.code, 200);
  result = await json('/products');
  assert.equal(result.body.length, 0);

  // Validation must reject empty payloads instead of silently reporting success.
  result = await json('/orders', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(result.code, 400);

  result = await json('/orders', { method: 'POST', body: JSON.stringify({ customer: 'Budi', phone: '081234567890', total: 90000 }) });
  assert.equal(result.code, 200);
  assert.equal(result.body.status, 'Menunggu Bayar');

  result = await json('/forms', { method: 'POST', body: JSON.stringify({ name: 'Form Order', fields: [{ type: 'text', label: 'Nama', required: true }] }) });
  assert.equal(result.code, 200);
  assert.equal(result.body.fields.length, 1);

  result = await json('/knowledge', { method: 'POST', body: JSON.stringify({ name: 'Katalog', content: 'Kaos polos harga 50.000' }) });
  assert.equal(result.code, 200);
  assert.equal(result.body.status, 'siap');
  result = await json('/knowledge');
  assert.equal(result.body.length, 1);
  assert.equal(result.body[0].content, undefined, 'knowledge list must not embed full document bodies');
  result = await json('/knowledge', { method: 'POST', body: JSON.stringify({ name: 'Terlalu besar', content: 'x'.repeat(500001) }) });
  assert.equal(result.code, 413);

  result = await json('/agent?instance=default');
  assert.equal(result.body.assistantName, 'Kak');
  result = await json('/agent', { method: 'POST', body: JSON.stringify({ instance: 'default', assistantName: 'Rina', instructions: 'Ramah', enabled: true }) });
  assert.equal(result.body.enabled, true);
  result = await json('/agent?instance=default');
  assert.equal(result.body.assistantName, 'Rina');

  result = await json('/settings', { method: 'POST', body: '{bad json' });
  assert.equal(result.code, 400);

  // Disconnecting a number must never run without the explicit confirmation word.
  result = await json('/disconnect', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(result.code, 400);
  assert.match(result.body.error, /PUTUSKAN/);

  console.log('PASS: auth, idle status, unavailable QR, unknown route, send guard, settings/product/order/form/knowledge/agent persistence, validation');
} finally {
  const exited = once(child, 'exit');
  child.kill();
  await exited;
}
