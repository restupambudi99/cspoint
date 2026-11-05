import assert from 'node:assert/strict';
import { CLOSING_LINE, allowedAmounts, checkReply, customerFacts, customerWords, fallbackReply, finalizeReply, moneyAmounts, orderState } from './reply-rules.mjs';

assert.deepEqual(moneyAmounts('Paket 2 Rp149.000 + ongkir 65rb = Rp 214.000, isi 40 pcs, 1.000 pcs'), [149000, 214000, 65000]);

const instructions = 'Paket 1: 20 pcs - Rp99.000.\nPaket 2: 40 pcs - Rp149.000.\nPaket 3: 50 pcs - Rp199.000.\nTujuan di DARATAN PULAU JAWA: GRATIS ONGKIR (Rp0).';
const customer = [{ text: 'Nama: Anus\nAlamat: RT 6 RW 3 negeri hative kecil, kecamatan Sirimau, kota Ambon', outgoing: false }, { text: 'paket 2 ya', outgoing: false }];
const shipping = { status: 'found', destination: 'Sirimau, Kota Ambon', province: 'Maluku', amount: 'Rp65.000', value: 65000, final: false };
const rules = latestCustomerText => ({
  amounts: allowedAmounts({ instructions, products: [{ price: '99000', description: '' }], shipping, customerTexts: customer.map(item => item.text) }),
  shipping, latestCustomerText, knownWords: customerWords(customer, shipping),
});

assert.deepEqual(checkReply('Untuk Sirimau, Kota Ambon tarif dasarnya Rp65.000, ongkir finalnya dikonfirmasi admin ya Kak. Harga Paket 2 Rp149.000.', rules('jadi berapa ongkirnya')), []);
assert.equal(checkReply('Total COD Rp175.000 ya Kak.', rules('total berapa')).length, 1, 'an amount absent from every source is rejected');
assert.ok(checkReply('Ongkir ke Ambon Rp40.000 ya Kak.', rules('ongkirnya berapa')).some(problem => problem.includes('Rp65.000')), 'a tariff from another area is rejected');
assert.ok(checkReply('Maaf Kak, ongkir belum tersedia, admin cek dulu ya.', rules('ongkirnya berapa')).length, 'claiming the tariff is missing is rejected');
assert.ok(checkReply('Ongkir Rp65.000.\nTotal bayar COD Rp214.000.', rules('total')).some(problem => problem.includes('total final')), 'no final total while the PDF marks the area for admin review');
const foreign = checkReply('Saya rangkum ya Kak:\nNama: Fenkris\nAlamat: Desa Binaus, Mollo Tengah', rules('ya'));
assert.equal(foreign.length, 2, 'a name and address from another lead are rejected');
assert.deepEqual(checkReply('Nama penerima: Anus\nAlamat: RT 6 RW 3 Negeri Hative Kecil, Kec. Sirimau, Kota Ambon, Maluku\nNama lengkap: [nama lengkap]', rules('ya')), []);

const confirmation = { text: 'Apakah paket, alamat, dan total bayarnya sudah benar, kak? Kalau sudah, boleh balas YA PESAN.', outgoing: true };
assert.equal(orderState([confirmation, { text: 'Ya kak', outgoing: false }]).confirmedNow, true);
assert.equal(orderState([confirmation, { text: 'Ya tapi alamatnya ganti', outgoing: false }]).confirmedNow, false);
assert.equal(orderState([{ text: 'Kakak mau ambil paket berapa?', outgoing: true }, { text: 'ya', outgoing: false }]).confirmedNow, false);
assert.equal(orderState([{ text: 'YA PESAN', outgoing: false }]).confirmedNow, true);
assert.equal(orderState([{ text: CLOSING_LINE, outgoing: true }, { text: 'kapan sampai kak?', outgoing: false }]).closedBefore, true);

assert.equal(finalizeReply('Siap Kak, pesanan diteruskan ke admin.', { order: { confirmedNow: true } }), 'Siap Kak, pesanan diteruskan ke admin.\n\n' + CLOSING_LINE);
assert.equal(finalizeReply('Ringkasan pesanan:\n*Paket:* 2\n\nTerima kasih ya kak sudah order, saya doakan lancar rejekinya.', { order: {} }), 'Ringkasan pesanan:\n*Paket:* 2', 'the closing greeting waits for the customer confirmation');
assert.equal(finalizeReply('Boleh info desa/kelurahan atau kampung, kode pos, dan patokan rumahnya?', {}), 'Boleh info desa/kelurahan atau kampung, dan patokan rumahnya?');
assert.equal(finalizeReply('Boleh dikirimkan alamat lengkap dan kode posnya ya kak?', {}), 'Boleh dikirimkan alamat lengkap ya kak?');
assert.equal(finalizeReply('**Paket:** Paket 2', {}), '*Paket:* Paket 2');

const facts = customerFacts([{ text: 'Nama : Fenkris WT Bokimnasi\nAlamat: Jalan Jurusan Kapan, Kecamatan Mollo Tengah' }, { text: 'paket 3 ya' }]);
assert.deepEqual(facts, { name: 'Fenkris WT Bokimnasi', address: 'Jalan Jurusan Kapan, Kecamatan Mollo Tengah', package: 'paket 3' });
assert.match(fallbackReply({ shipping: { ...shipping, final: true, destination: 'Bubon, Kabupaten Aceh Barat', amount: 'Rp40.000' }, facts, order: {} }), /Ongkir ke Bubon, Kabupaten Aceh Barat Rp40\.000 ya Kak\. Untuk melanjutkan pesanan, boleh dibantu patokan rumah, Kak\?/);
assert.ok(fallbackReply({ order: { confirmedNow: true } }).endsWith(CLOSING_LINE));
console.log('PASS: invented amounts, wrong or missing tariffs, foreign customer data, confirmation, closing greeting, postal code and fallback');
