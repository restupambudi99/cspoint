import { normalizePlace, formatRupiah } from './shipping.mjs';

// Checks that run on every AI draft before it reaches WhatsApp. They only accept
// money amounts and customer details that exist in the sources for this one thread.
export const CLOSING_LINE = 'Terima kasih banyak ya Kak sudah order 🙏 Semoga Kakak dan keluarga sehat selalu.';

const FIELD_LINE = /^[ \t]*[-•*>]?[ \t]*\**[ \t]*(nama(?:[ \t]+lengkap)?(?:[ \t]+penerima)?|alamat(?:[ \t]+lengkap)?(?:[ \t]+(?:pengiriman|penerima|rumah))?|patokan(?:[ \t]+rumah)?)[ \t]*\**[ \t]*[:=：][ \t]*\**[ \t]*(.+)$/gim;
const PLACEHOLDER = /^(?:-+|–|—|\.{2,}|\?+|belum\b.*|menunggu\b.*|kosong|tidak ada|n\/a)$/i;
const GENERIC_WORDS = new Set(['jalan', 'jln', 'gang', 'desa', 'kelurahan', 'kel', 'kecamatan', 'kec', 'kabupaten', 'kab', 'kota', 'provinsi', 'prov', 'distrik', 'dusun', 'kampung', 'blok', 'komplek', 'kompleks', 'perumahan', 'perum', 'samping', 'depan', 'belakang', 'dekat', 'sebelah', 'seberang', 'rumah', 'warna', 'kak', 'kakak', 'bapak', 'pak', 'ibu', 'mas', 'mbak', 'sdr', 'saudara', 'dan', 'atau', 'yang', 'dari', 'sesuai', 'alamat', 'nama', 'patokan', 'lengkap', 'penerima', 'nomor', 'lantai', 'gedung', 'pos', 'kode']);
const SHIPPING_TALK = /ongkir|ongkos\s*kirim|biaya\s*(?:kirim|pengiriman)|tarif/i;
const FEE = /(?:ongkir|ongkos(?:\s+kirim)?|biaya\s+(?:kirim|pengiriman)|tarif(?:\s+dasar)?)([^\d\n]{0,40}?)((?:rp\.?\s*)?\d{1,3}(?:[.,]\d{3})+|rp\.?\s*\d+|\d+(?:[.,]\d+)?\s*(?:rb|ribu|k)\b)/gi;
const CONFIRM_REQUEST = /ya pesan|sudah benar|sudah sesuai|apakah[^?\n]{0,120}(?:benar|sesuai)|balas[ \t]*\*?[ \t]*ya\b/i;
const AFFIRMATION = /^(ya|iya+|yaa+|y|yes|ok+|oke+|okey|okay|benar|betul|bener|sesuai|siap|lanjut|lanjutkan|setuju|jadi|gas|mantap|boleh|sip|sudah|udah|sdh|yup|yap|deal)\b/;
const NEGATION = /\b(tidak|tdk|gak|ga|nggak|enggak|engga|ngga|bukan|salah|ganti|ubah|tapi|tp|batal|cancel|belum|blm|kurang|revisi|koreksi|tunggu|nanti)\b/;
const EARLY_CLOSING = /sehat selalu|saya doakan|doakan (?:kakak|kak|semoga)|terima kasih[^\n]{0,40}(?:sudah|telah) (?:order|pesan|memesan|berbelanja|belanja)/i;
const STOCK_CLAIM = /ready\s*stoc?k|stok(?:nya)?\s+(?:masih\s+|selalu\s+)?(?:ada|tersedia|ready|banyak|melimpah|terbatas|habis|menipis|tinggal|kosong)/i;

const fieldKey = label => /^nama/i.test(label) ? 'name' : /^alamat/i.test(label) ? 'address' : 'landmark';
const fieldLabel = { name: 'Nama', address: 'Alamat', landmark: 'Patokan' };
const cleanValue = value => String(value).replace(/[*_\x60]/g, '').trim();
const words = text => normalizePlace(text).split(' ').filter(Boolean);

const toRupiah = (digits, unit = '') => {
  const scale = /^(rb|ribu|k)$/i.test(unit) ? 1e3 : /^(jt|juta)$/i.test(unit) ? 1e6 : 1;
  if (scale === 1) return Number(String(digits).replace(/[.,\s]/g, ''));
  return Math.round(Number(String(digits).replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')) * scale);
};

export function moneyAmounts(text) {
  const source = String(text ?? '');
  const amounts = [];
  for (const match of source.matchAll(/rp\.?\s*(\d{1,3}(?:[.,]\d{3})+|\d+)(?:\s*(rb|ribu|k|jt|juta)\b)?/gi)) amounts.push(toRupiah(match[1], match[2]));
  for (const match of source.matchAll(/(?<![\w.,])(\d+(?:[.,]\d+)?)\s*(rb|ribu|jt|juta)\b/gi)) amounts.push(toRupiah(match[1], match[2]));
  for (const match of source.matchAll(/(?<![\w.,])(\d{1,3}(?:\.\d{3})+)(?![\d.,]|\s*(?:pcs|lembar|buah|box|pack|biji|item|gram|gr|kg|ml)\b)/gi)) amounts.push(toRupiah(match[1]));
  return [...new Set(amounts.filter(Number.isFinite))];
}

export function customerFacts(customerMessages) {
  const facts = {};
  for (const message of customerMessages) {
    for (const match of String(message.text).matchAll(FIELD_LINE)) {
      const value = cleanValue(match[2]);
      if (value && !PLACEHOLDER.test(value)) facts[fieldKey(match[1])] = value.slice(0, 300);
    }
    const choice = String(message.text).match(/\bpaket\s*[1-9]\b|\b\d{1,3}\s*pcs\b/i);
    if (choice) facts.package = choice[0];
  }
  return facts;
}

export function orderState(thread) {
  const items = (thread || []).filter(item => typeof item?.text === 'string' && item.text.trim());
  const latestIndex = items.findLastIndex(item => !item.outgoing);
  if (latestIndex < 0) return { confirmedNow: false, closedBefore: false };
  const latest = normalizePlace(items[latestIndex].text);
  const previous = items.slice(0, latestIndex).findLast(item => item.outgoing);
  const negated = NEGATION.test(latest);
  const explicit = /\bya pesan\b/.test(latest) && !negated;
  const affirmed = latest.length <= 60 && AFFIRMATION.test(latest) && !negated;
  const confirmedNow = explicit || Boolean(previous && CONFIRM_REQUEST.test(previous.text) && affirmed);
  const closedBefore = !confirmedNow && items.slice(0, latestIndex).some(item => item.outgoing && /sehat selalu/i.test(item.text));
  return { confirmedNow, closedBefore };
}

export function allowedAmounts({ instructions = '', products = [], references = [], shipping = {}, customerTexts = [] }) {
  const base = new Set([0]);
  const add = text => { for (const value of moneyAmounts(text)) base.add(value); };
  add(instructions);
  for (const product of products) {
    const price = String(product.price ?? '').trim();
    if (/^\d+$/.test(price)) base.add(Number(price)); else add(price);
    add(product.description);
  }
  for (const reference of references) add(reference.content);
  for (const text of customerTexts) add(text);
  for (const option of shipping.options || []) add(option.amount);
  const fees = shipping.status === 'found' ? [0, shipping.value] : [0];
  if (shipping.status === 'found') base.add(shipping.value);
  const prices = [...base].filter(value => value >= 1000 && value <= 10_000_000);
  const subtotals = new Set();
  for (const price of prices) for (let count = 1; count <= 10; count++) subtotals.add(price * count);
  for (let left = 0; left < prices.length; left++) for (let right = left + 1; right < prices.length; right++) subtotals.add(prices[left] + prices[right]);
  const allowed = new Set(base);
  for (const subtotal of subtotals) for (const fee of fees) allowed.add(subtotal + fee);
  return { allowed, subtotals, instructionFees: new Set([0, ...feeAmounts(instructions)]) };
}

function feeAmounts(text) {
  const amounts = [];
  for (const match of String(text ?? '').matchAll(FEE)) {
    if (/total|=|\)|\+/i.test(match[1])) continue;
    amounts.push(...moneyAmounts(/rp|rb|ribu|k\b/i.test(match[2]) ? match[2] : 'Rp' + match[2]));
  }
  return amounts;
}

export function customerWords(customerMessages, shipping = {}) {
  return new Set(words([...customerMessages.map(item => item.text), shipping.destination, shipping.province].filter(Boolean).join(' ')));
}

export function checkReply(reply, { amounts, shipping = {}, latestCustomerText = '', knownWords = new Set(), stockKnown = false }) {
  const problems = [];
  if (!stockKnown && STOCK_CLAIM.test(reply)) problems.push('Tidak ada data stok di katalog atau instruksi. Jangan menulis klaim stok seperti "ready stock", "stok tersedia", atau "stok terbatas".');
  const mentioned = moneyAmounts(reply);
  const invented = mentioned.filter(value => !amounts.allowed.has(value));
  if (invented.length) problems.push('Nominal ' + invented.map(formatRupiah).join(', ') + ' tidak ada di instruksi, katalog, Knowledge PDF, atau STATUS PERCAKAPAN. Jangan menulis nominal yang tidak tercantum; total hanya harga paket + ongkir.');
  const fees = feeAmounts(reply);
  if (shipping.status === 'found') {
    if (fees.some(value => value !== shipping.value)) problems.push('Ongkir untuk ' + shipping.destination + ' adalah ' + shipping.amount + '. Jangan menulis nominal ongkir lain.');
    if ((SHIPPING_TALK.test(latestCustomerText) || SHIPPING_TALK.test(reply)) && !mentioned.includes(shipping.value)) problems.push('Sebutkan ongkir ' + shipping.amount + ' untuk ' + shipping.destination + ' sesuai daftar tarif. Jangan bilang tarifnya tidak tersedia atau belum ada.');
    if (!shipping.final) {
      const total = String(reply).split('\n').filter(line => /total/i.test(line)).flatMap(moneyAmounts).some(value => value > shipping.value && amounts.subtotals.has(value - shipping.value));
      if (total) problems.push('Ongkir ' + shipping.destination + ' masih tarif dasar yang perlu dicek admin. Jangan tampilkan total final; sebut harga barang dan status menunggu konfirmasi ongkir.');
    }
  } else if (shipping.status !== 'java' && shipping.status !== 'unavailable') {
    const options = new Set((shipping.options || []).flatMap(option => moneyAmounts(option.amount)));
    if (fees.some(value => !amounts.instructionFees.has(value) && !options.has(value))) problems.push('Belum ada tarif ongkir yang cocok untuk alamat pelanggan ini. Jangan menyebut nominal ongkir; ikuti petunjuk Ongkir di STATUS PERCAKAPAN.');
  }
  for (const match of String(reply).matchAll(FIELD_LINE)) {
    const key = fieldKey(match[1]);
    const value = cleanValue(match[2]);
    if (!value || PLACEHOLDER.test(value) || /[[\]{}<>]/.test(value)) continue;
    const significant = words(value).filter(word => word.length >= 3 && !GENERIC_WORDS.has(word) && !/^\d+$/.test(word));
    if (!significant.length) continue;
    const known = significant.filter(word => knownWords.has(word)).length;
    const needed = key === 'name' ? significant.length : Math.ceil(significant.length * (key === 'address' ? 0.7 : 0.6));
    if (known < needed) problems.push('Data "' + fieldLabel[key] + ': ' + value.slice(0, 80) + '" tidak pernah ditulis pelanggan ini. Jangan memakai data pelanggan lain atau contoh template; tanyakan data yang belum ada.');
  }
  return problems;
}

function dropPostalCodeRequests(text) {
  return text.split('\n').map(line => {
    if (!/kode\s*pos/i.test(line)) return line;
    const edited = line
      .replace(/\s*,\s*(?:dan\s+|serta\s+)?kode\s*pos(?:nya)?/gi, '')
      .replace(/\s+(?:dan|serta|atau)\s+kode\s*pos(?:nya)?/gi, '')
      .replace(/kode\s*pos(?:nya)?\s*(?:,\s*|\s+(?:dan|serta)\s+)/gi, '')
      .replace(/kode\s*pos(?:nya)?/gi, '')
      .replace(/\s{2,}/g, ' ').replace(/\s+([,.?!])/g, '$1').replace(/,\s*,/g, ',').replace(/\(\s*\)/g, '').trim();
    return edited.split(' ').filter(Boolean).length >= 3 ? edited : null;
  }).filter(line => line !== null).join('\n');
}

export function finalizeReply(text, { order = {} } = {}) {
  let reply = String(text ?? '').trim()
    .replace(/\*\*(.+?)\*\*/gs, '*$1*')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[ \t]+$/gm, '');
  reply = dropPostalCodeRequests(reply);
  if (order.confirmedNow) {
    if (!/terima kasih/i.test(reply) || !/sehat selalu/i.test(reply)) reply += '\n\n' + CLOSING_LINE;
  } else {
    const kept = reply.split(/\n\s*\n/).filter(part => !EARLY_CLOSING.test(part));
    if (kept.length) reply = kept.join('\n\n');
  }
  return reply.replace(/\n{3,}/g, '\n\n').trim();
}

const joinList = items => items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' dan ' + items.at(-1);

export function fallbackReply({ shipping = {}, facts = {}, order = {} }) {
  if (order.confirmedNow) return 'Siap Kak, pesanannya sudah kami catat dan segera diteruskan ke admin untuk diproses.\n\n' + CLOSING_LINE;
  const parts = [];
  if (shipping.status === 'found') parts.push(shipping.final
    ? 'Ongkir ke ' + shipping.destination + ' ' + shipping.amount + ' ya Kak.'
    : 'Untuk ' + shipping.destination + ', tarif dasar yang tercantum ' + shipping.amount + '. Karena wilayah ini perlu pengecekan lanjutan, ongkir finalnya dikonfirmasi admin dulu ya Kak.');
  else if (shipping.status === 'confirm') parts.push('Untuk ' + shipping.destination + ', ongkirnya perlu dikonfirmasi admin dulu ya Kak.');
  else if (shipping.status === 'ambiguous') parts.push('Nama wilayah itu ada di beberapa kabupaten/kota. Boleh info kabupaten/kotanya, Kak?');
  else if (shipping.status === 'need_district' || shipping.status === 'not_found') parts.push('Boleh info nama kecamatan dan kabupaten/kotanya, Kak, supaya ongkirnya bisa saya cek?');
  const missing = [];
  if (!facts.package) missing.push('paket yang mau diambil');
  if (!facts.name) missing.push('nama lengkap penerima');
  if (!facts.address) missing.push('alamat lengkap');
  if (!facts.landmark) missing.push('patokan rumah');
  if (missing.length && !['ambiguous', 'need_district', 'not_found'].includes(shipping.status)) parts.push('Untuk melanjutkan pesanan, boleh dibantu ' + joinList(missing) + ', Kak?');
  if (!parts.length) parts.push('Baik Kak, pesan Kakak sudah saya terima. Saya bantu lanjutkan pesanannya ya.');
  return parts.join(' ');
}
