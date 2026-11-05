import assert from 'node:assert/strict';
import { matchLocation, parseTariffText, resolveShipping } from './shipping.mjs';

// Mirrors the extracted text of the real tariff PDF: rows wrap across lines and share lines.
const doc = parseTariffText([
  'REKAP SELURUH KECAMATAN NON-JAWA DAN TARIF ONGKIR ATURAN PENGGUNAAN 2. Kalimantan menggunakan tarif dasar terbaru Rp55.000 .',
  'PROVINSI ACEH Jumlah kecamatan/distrik: 290 Tarif dasar provinsi: Rp40.000',
  'KABUPATEN ACEH BARAT — Rp40.000',
  'Arongan Lambalek / Aceh Barat → Rp40.000 Bubon / Aceh Barat →',
  'Rp40.000 Johan Pahlawan / Aceh Barat → Rp40.000',
  'PROVINSI BALI Jumlah kecamatan/distrik: 57 Tarif dasar provinsi: Rp30.000',
  'KABUPATEN TABANAN — Rp30.000 Kediri / Tabanan → Rp30.000',
  'PROVINSI NUSA TENGGARA BARAT Jumlah kecamatan/distrik: 117 Tarif dasar provinsi: Rp40.000',
  'KABUPATEN LOMBOK BARAT — Rp40.000 Kediri / Lombok Barat → Rp40.000',
  'PROVINSI SULAWESI SELATAN Jumlah kecamatan/distrik: 307 Tarif dasar provinsi: Rp60.000',
  'KABUPATEN LUWU UTARA — Rp60.000 Sukamaju / Luwu Utara → Rp60.000',
  'PROVINSI MALUKU Jumlah kecamatan/distrik: 118 Tarif dasar provinsi: Rp65.000',
  'KOTA AMBON — Rp65.000',
  'Nusaniwe / Ambon → Rp65.000 Sirimau / Ambon → Rp65.000 Teluk',
  'Ambon / Ambon → Rp65.000 Baguala / Ambon → Rp65.000',
  'PROVINSI PAPUA Jumlah kecamatan/distrik: 10 Tarif dasar provinsi: Rp110.000',
  'KABUPATEN MAMBERAMO RAYA — Konfirmasi Benuki / Mamberamo Raya → Konfirmasi',
  'KOTA JAYAPURA — Rp110.000 Abepura / Jayapura → Rp110.000',
  'PROVINSI PAPUA BARAT Jumlah kecamatan/distrik: 2 Tarif dasar provinsi: Rp150.000',
  'KABUPATEN MANOKWARI SELATAN — Konfirmasi Manokwari Selatan → Konfirmasi',
  'PROVINSI SUMATERA UTARA Jumlah kecamatan/distrik: 455 Tarif dasar provinsi: Rp30.000',
  'KABUPATEN SIMALUNGUN — Rp30.000 Raya / Simalungun → Rp30.000',
  'CATATAN PENTING UNTUK ASISTEN TOKO Jangan langsung menjanjikan tarif dasar sebagai ongkir final untuk wilayah berikut:',
  '• Maluku, Maluku Utara, dan pulau-pulau terluar • Papua pegunungan, pedalaman Tarif dasar bukan jaminan tarif sampai desa',
].join('\n'));
const docs = [doc];
const match = text => matchLocation(text, docs);

assert.equal(doc.entries.length, 14, 'wrapped rows, shared lines and rows without a regency are all read');
assert.deepEqual(match('Berapa ongkir ke Kecamatan Bubon?'), { status: 'found', destination: 'Bubon, Kabupaten Aceh Barat', province: 'Aceh', amount: 'Rp40.000', value: 40000, final: true, level: 'district' });
assert.equal(match('kirim ke Teluk Ambon').destination, 'Teluk Ambon, Kota Ambon', 'a row split across two lines keeps its full name');
const ambon = match('Alamat: Kompleks Lantamal IX, Kel. Halong, Kec. Baguala, Kota Ambon, Maluku');
assert.equal(ambon.destination, 'Baguala, Kota Ambon');
assert.equal(ambon.final, false, 'the PDF note marks Maluku tariffs as base tariffs');
assert.equal(match('Jl. Raya Bogor, Kecamatan Sirimau, Kota Ambon').destination, 'Sirimau, Kota Ambon', 'street names are not destinations');
assert.equal(match('Kecamatan Sirimuau, Kota Ambon').destination, 'Kota Ambon', 'a misspelt district falls back to a uniform city tariff');
assert.equal(match('Kabupaten Mamberamo Raya').status, 'confirm', 'Raya inside a regency name is not the Simalungun district');
assert.equal(match('ongkir ke Manokwari Selatan').status, 'confirm');
assert.equal(match('ongkir ke kediri').status, 'ambiguous', 'Kediri exists in Java, Bali and NTB');
assert.equal(match('Kec. Kediri, Kab. Tabanan').amount, 'Rp30.000');
assert.equal(match('Desa Sukamaju, Kec. Cibungbulang, Kab. Bogor').status, 'java', 'a village name is not matched as a district elsewhere');
assert.equal(match('Kec. Sukamaju, Luwu Utara').amount, 'Rp60.000');
assert.equal(match('Distrik Abepura, Kota Jayapura').amount, 'Rp110.000');
assert.equal(match('Kecamatan Antahberantah, Kabupaten Entah').status, 'not_found');
assert.equal(match('Halo kak harga koyo berapa ya').status, 'none');

const thread = [
  { text: 'Nama: Anus\nAlamat: RT 6 RW 3 negeri hative kecil, kecamatan Sirimau, kota Ambon', outgoing: false },
  { text: 'Siap kak, saya catat.', outgoing: true },
  { text: 'Jadi berapa ongkirnya', outgoing: false },
];
assert.equal(resolveShipping(thread, docs).destination, 'Sirimau, Kota Ambon', 'a later shipping question uses the address given earlier in the same chat');
assert.equal(resolveShipping([{ text: 'Kakak tinggal di kecamatan dan kabupaten/kota mana?', outgoing: true }, { text: 'Bubon, Aceh Barat', outgoing: false }], docs).amount, 'Rp40.000', 'a bare place name answers the location question');
assert.equal(resolveShipping([{ text: 'Nama: Raya Siregar\nmau tanya dulu kak', outgoing: false }], docs).status, 'none', 'contact names are never treated as places');
assert.equal(resolveShipping(thread, []).status, 'unavailable');
assert.equal(resolveShipping([{ text: 'Alamat: Kec. Cibinong, Kab. Bogor', outgoing: false }], []).status, 'java');
console.log('PASS: flowing PDF rows, wrapped names, cautions, Konfirmasi, ambiguity, Java, street and village names, thread lookup');
