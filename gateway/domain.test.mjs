import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDomain } from './domain.mjs';
const dir = await mkdtemp(join(tmpdir(), 'chat-wa-domain-'));
try {
  const d = await openDomain(join(dir, 'domain.json'));
  const instance = await d.instances.upsert({ label: 'CS Utama', name: 'cs-utama', status: 'idle' });
  await d.agents.upsert(instance.id, { enabled: true, instructions: 'Jawab ramah' });
  const knowledge = await d.knowledge.upsert({ name: 'FAQ.pdf', content: 'Isi FAQ', mime: 'text/plain', status: 'ready' });
  const product = await d.products.upsert({ name: 'Produk A', price: 1000, stock: 3 });
  await d.orders.upsert({ customer: 'Pelanggan', productId: product.id, status: 'Menunggu Bayar' });
  await d.forms.upsert({ name: 'Form Kontak', fields: [{ type: 'text', label: 'Nama' }] });
  const reopened = await openDomain(join(dir, 'domain.json'));
  if (reopened.instances.list().length !== 1 || reopened.knowledge.list()[0].id !== knowledge.id || reopened.products.list()[0].id !== product.id || reopened.orders.list().length !== 1 || reopened.forms.list().length !== 1) throw new Error('domain persistence failed');
  console.log('PASS: instances, agent, knowledge, products, orders and forms persist');
} finally { await rm(dir, { recursive: true, force: true }); }
