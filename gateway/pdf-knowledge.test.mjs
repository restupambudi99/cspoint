import assert from 'node:assert/strict';
import { rankKnowledge } from './pdf-knowledge.mjs';

const documents = [{
  name: 'Tarif ongkir kota tujuan.pdf',
  content: 'KABUPATEN ACEH BARAT — Rp40.000\nArongan Lambalek / Aceh Barat → Rp40.000\nBubon / Aceh Barat → Rp40.000\nJohan Pahlawan / Aceh Barat → Rp40.000\nKABUPATEN ACEH BESAR — Rp40.000\nKrueng Barona Jaya / Aceh Besar → Rp40.000\nTEMPLATE CUSTOMER: Nama lengkap penerima, alamat lengkap, RT RW, negeri kecil, dan patokan alamat. Template jawaban tarif Rp150.000 untuk kecamatan di kota lain.\nKOTA AMBON — Rp65.000\nBaguala / Ambon → Rp65.000\nSirimau / Ambon → Rp65.000\nTeluk Ambon / Ambon → Rp65.000',
}];

const bubon = rankKnowledge('Berapa ongkir ke Kecamatan Bubon?', documents);
assert.ok(bubon.length);
assert.match(bubon[0].content, /Bubon \/ Aceh Barat → Rp40\.000/);

const multiWord = rankKnowledge('Tarif Kecamatan Krueng Barona Jaya berapa?', documents);
assert.ok(multiWord.length);
assert.match(multiWord[0].content, /Krueng Barona Jaya \/ Aceh Besar → Rp40\.000/);

const fullAddress = rankKnowledge('Nama lengkap penerima: Anus. Alamat lengkap RT 6 RW 3 Negeri Hative Kecil, Kecamatan Sirimau, Kota Ambon', documents);
assert.ok(fullAddress.length);
assert.match(fullAddress[0].content, /Sirimau \/ Ambon → Rp65\.000/);

const typo = rankKnowledge('Ongkir ke Kecamatan Sirimuau, Kota Ambon', documents);
assert.ok(typo.length);
assert.match(typo[0].content, /Sirimau \/ Ambon → Rp65\.000/);

assert.deepEqual(rankKnowledge('Berapa ongkir ke kecamatan?', documents), []);
console.log('PASS: exact/multiword district retrieval survives long addresses, similar prices and one-letter place-name typos');
