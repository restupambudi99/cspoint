import assert from 'node:assert/strict';
import { rankKnowledge } from './pdf-knowledge.mjs';

const documents = [{
  name: 'Tarif ongkir kota tujuan.pdf',
  content: 'KABUPATEN ACEH BARAT — Rp40.000\nArongan Lambalek / Aceh Barat → Rp40.000\nBubon / Aceh Barat → Rp40.000\nJohan Pahlawan / Aceh Barat → Rp40.000\nKABUPATEN ACEH BESAR — Rp40.000\nKrueng Barona Jaya / Aceh Besar → Rp40.000',
}];

const bubon = rankKnowledge('Berapa ongkir ke Kecamatan Bubon?', documents);
assert.ok(bubon.length);
assert.match(bubon[0].content, /Bubon \/ Aceh Barat → Rp40\.000/);

const multiWord = rankKnowledge('Tarif Kecamatan Krueng Barona Jaya berapa?', documents);
assert.ok(multiWord.length);
assert.match(multiWord[0].content, /Krueng Barona Jaya \/ Aceh Besar → Rp40\.000/);

assert.deepEqual(rankKnowledge('Berapa ongkir ke kecamatan?', documents), []);
console.log('PASS: exact and multiword district tarif retrieval; generic shipping terms do not select a random tariff');
