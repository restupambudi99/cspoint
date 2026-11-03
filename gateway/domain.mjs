import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const empty = { instances: [], agents: {}, knowledge: [], products: [], orders: [], forms: [], settings: {} };
export async function openDomain(path) {
  await mkdir(dirname(path), { recursive: true });
  let data = empty;
  try { data = { ...empty, ...JSON.parse(await readFile(path, 'utf8')) }; } catch {}
  let writing = Promise.resolve();
  const save = () => { writing = writing.then(() => writeFile(path, JSON.stringify(data, null, 2), { mode: 0o600 })); return writing; };
  const collection = (name) => ({
    list: () => data[name],
    get: id => data[name].find(item => item.id === id),
    upsert: (value) => { const item = { ...value, id: value.id || randomUUID(), updatedAt: Date.now() }; const i = data[name].findIndex(x => x.id === item.id); if (i < 0) data[name].push(item); else data[name][i] = item; return save().then(() => item); },
    remove: id => { data[name] = data[name].filter(item => item.id !== id); return save(); },
  });
  return { data, save, instances: collection('instances'), products: collection('products'), orders: collection('orders'), forms: collection('forms'), knowledge: collection('knowledge'), agents: { get: id => data.agents[id] || null, upsert: (id, value) => { data.agents[id] = { ...value, id, updatedAt: Date.now() }; return save().then(() => data.agents[id]); } }, settings: { get: () => data.settings, update: value => { data.settings = { ...data.settings, ...value }; return save().then(() => data.settings); } } };
}
