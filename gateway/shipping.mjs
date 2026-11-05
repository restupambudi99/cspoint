// Shipping tariffs are resolved in code. The model only receives the verified
// result, so it never has to pick a row out of a 5,000-line tariff table.
const AMOUNT = /Rp\.?\s?\d{1,3}(?:[.,]\d{3})+|Rp\.?\s?\d+|Konfirmasi/giu;
const ROW_END = /\s*(?:→|->|=>)\s*$/u;
const REGION_HEADER = /(KABUPATEN|KOTA ADMINISTRASI|KOTA|KAB\.?)\s+([^—–→/]+?)\s*[—–]\s*$/u;
const PROVINCE_HEADER = /PROVINSI\s+(.+?)\s+Jumlah\b/gu;
const STREET_WORDS = new Set(['jl', 'jln', 'jalan', 'gg', 'gang', 'lorong', 'lr', 'komplek', 'kompleks', 'komp', 'perum', 'perumahan', 'blok', 'ruko']);
const VILLAGE_WORDS = new Set(['desa', 'ds', 'kelurahan', 'kel', 'dusun', 'dsn', 'kampung', 'kp', 'lingkungan', 'nagari', 'gampong', 'negeri']);
const DISTRICT_WORDS = new Set(['kec', 'kecamatan', 'distrik']);
const REGENCY_WORDS = new Set(['kab', 'kabupaten']);
const CITY_WORDS = new Set(['kota', 'kotamadya']);
const DIRECTIONS = new Set(['barat', 'timur', 'utara', 'selatan', 'tengah', 'daya']);
// Single words that are also district/regency names but usually mean something else in a chat.
const COMMON_WORDS = new Set(['raya', 'jaya', 'baru', 'lama', 'tengah', 'barat', 'timur', 'utara', 'selatan', 'pusat', 'kota', 'pasar', 'tanjung', 'sungai', 'pulau', 'teluk', 'bukit', 'gunung', 'pantai', 'lembah', 'air', 'batu', 'indah', 'makmur', 'sari', 'mulia', 'damai', 'harapan', 'merdeka', 'sejahtera', 'maju', 'mandiri', 'permai', 'agung', 'kembang', 'tani', 'laut', 'darat', 'hulu', 'hilir', 'ilir', 'ulu', 'seberang', 'simpang', 'muara', 'kuala', 'danau', 'rawa', 'padang', 'lubuk', 'koto', 'buru', 'puncak', 'bone', 'palu', 'kampung', 'sentral', 'induk', 'utama']);
const ADDRESS_MARKERS = /\b(kec|kecamatan|distrik|kab|kabupaten|kota|desa|kelurahan|kel|dusun|kampung|provinsi|prov|alamat|jl|jln|jalan|rt|rw)\b/;
const SHIPPING_WORDS = /\b(ongkir|ongkirnya|ongkos|tarif|kirim|dikirim|kiriman|pengiriman|ekspedisi|tujuan|lokasi|tinggal|domisili)\b/;
const LOCATION_QUESTION = /kecamatan|kabupaten|kota|alamat|lokasi|tinggal|domisili|dikirim ke|tujuan/i;

export const normalizePlace = value => String(value ?? '').toLocaleLowerCase('id-ID').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const titleCase = value => normalizePlace(value).replace(/(^| )(\p{L})/gu, (_, space, letter) => space + letter.toLocaleUpperCase('id-ID'));
export const formatRupiah = value => 'Rp' + String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const stripRegionWord = value => normalizePlace(value).replace(/^(kabupaten|kab|kota administrasi|kota) /, '');

// Java is outside the non-Java tariff PDF. Bare names that also exist in the PDF
// (for example Kediri in Bali) need a qualifier such as "Kota Kediri".
const JAVA_PROVINCES = ['banten', 'dki jakarta', 'jakarta', 'jawa barat', 'jabar', 'jawa tengah', 'jateng', 'jawa timur', 'jatim', 'di yogyakarta', 'diy', 'daerah istimewa yogyakarta', 'yogyakarta', 'jogja', 'jogjakarta', 'yogya'];
const JAVA_REGENCIES = ['lebak', 'pandeglang', 'serang', 'tangerang', 'bandung', 'bandung barat', 'bekasi', 'bogor', 'ciamis', 'cianjur', 'cirebon', 'garut', 'indramayu', 'karawang', 'kuningan', 'majalengka', 'pangandaran', 'purwakarta', 'subang', 'sukabumi', 'sumedang', 'tasikmalaya', 'banjarnegara', 'banyumas', 'batang', 'blora', 'boyolali', 'brebes', 'cilacap', 'demak', 'grobogan', 'jepara', 'karanganyar', 'kebumen', 'kendal', 'klaten', 'kudus', 'magelang', 'pati', 'pekalongan', 'pemalang', 'purbalingga', 'purworejo', 'rembang', 'semarang', 'sragen', 'sukoharjo', 'tegal', 'temanggung', 'wonogiri', 'wonosobo', 'bantul', 'gunungkidul', 'gunung kidul', 'kulon progo', 'kulonprogo', 'sleman', 'banyuwangi', 'blitar', 'bojonegoro', 'bondowoso', 'gresik', 'jember', 'jombang', 'kediri', 'lamongan', 'lumajang', 'madiun', 'magetan', 'malang', 'mojokerto', 'nganjuk', 'ngawi', 'pacitan', 'pasuruan', 'ponorogo', 'probolinggo', 'sidoarjo', 'situbondo', 'trenggalek', 'tuban', 'tulungagung'];
const JAVA_CITIES = ['cilegon', 'serang', 'tangerang', 'tangerang selatan', 'tangsel', 'jakarta barat', 'jakarta pusat', 'jakarta selatan', 'jakarta timur', 'jakarta utara', 'bandung', 'banjar', 'bekasi', 'bogor', 'cimahi', 'cirebon', 'depok', 'sukabumi', 'tasikmalaya', 'magelang', 'pekalongan', 'salatiga', 'semarang', 'surakarta', 'solo', 'tegal', 'yogyakarta', 'batu', 'blitar', 'kediri', 'madiun', 'malang', 'mojokerto', 'pasuruan', 'probolinggo', 'surabaya'];
const JAVA_ISLANDS = ['madura', 'bangkalan', 'sampang', 'pamekasan', 'sumenep', 'kepulauan seribu', 'pulau seribu', 'karimunjawa', 'karimun jawa', 'bawean', 'kangean', 'masalembu', 'sapudi', 'pulau tidung', 'pulau pramuka', 'pulau panggang', 'pulau harapan', 'pulau kelapa'];
const QUALIFIER_ONLY = new Set(['batu', 'batang', 'banjar']);
const JAVA_PLACES = [
  ...JAVA_PROVINCES.map(name => ({ name, type: 'Provinsi' })),
  ...JAVA_REGENCIES.map(name => ({ name, type: 'Kabupaten' })),
  ...JAVA_CITIES.map(name => ({ name, type: 'Kota' })),
  ...JAVA_ISLANDS.map(name => ({ name, type: 'Pulau', island: true })),
];

function cautionAreas(flat) {
  const notes = flat.match(/wilayah berikut\s*:\s*(.+?)(?:Tarif dasar bukan jaminan|$)/iu)?.[1] || '';
  return notes.split('•').map(normalizePlace).filter(Boolean);
}

export function parseTariffText(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ');
  const entries = [], regions = [];
  let province = '', region = null, cursor = 0;
  for (const match of flat.matchAll(AMOUNT)) {
    const segment = flat.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    for (const found of segment.matchAll(PROVINCE_HEADER)) province = titleCase(found[1]);
    const confirm = /^konfirmasi$/i.test(match[0]) || /^\s*\(?\s*konfirmasi\b/i.test(flat.slice(cursor, cursor + 20));
    const value = confirm ? null : Number(match[0].replace(/\D/g, ''));
    if (ROW_END.test(segment)) {
      const body = segment.replace(ROW_END, '');
      const slash = body.lastIndexOf('/');
      // A few rows omit "/ Kabupaten"; their section header names the regency.
      const district = (slash < 0 ? body : body.slice(0, slash)).split(/→|->|=>/).at(-1).trim();
      const regency = slash < 0 ? region?.name || '' : body.slice(slash + 1).trim();
      if (district && regency && !/\d/.test(district)) entries.push({ district, regency, region, province, value, confirm });
      continue;
    }
    const header = segment.match(REGION_HEADER);
    if (header) {
      region = { type: /^kota/i.test(header[1]) ? 'Kota' : 'Kabupaten', name: titleCase(header[2]), province, value, confirm, entries: [] };
      regions.push(region);
    }
  }
  for (const entry of entries) entry.region?.entries.push(entry);
  return { entries, regions, cautions: cautionAreas(flat) };
}

const occurrences = (haystack, phrase) => {
  const spans = [];
  if (!phrase) return spans;
  for (let index = haystack.indexOf(' ' + phrase + ' '); index >= 0; index = haystack.indexOf(' ' + phrase + ' ', index + 1)) spans.push([index + 1, index + 1 + phrase.length]);
  return spans;
};
const previousWords = (haystack, start) => haystack.slice(0, start).trim().split(' ').slice(-2);
const overlaps = (left, right) => left[0] < right[1] && right[0] < left[1];
const streetName = before => before.some(word => STREET_WORDS.has(word)) && !DISTRICT_WORDS.has(before.at(-1));

function indexed(doc) {
  if (doc.index) return doc.index;
  const districts = doc.entries.map(entry => ({ entry, phrase: normalizePlace(entry.district), regency: stripRegionWord(entry.regency), regionName: entry.region ? normalizePlace(entry.region.name) : '', province: normalizePlace(entry.province) })).filter(item => item.phrase.length >= 3);
  const regions = doc.regions.map(region => ({ region, phrase: normalizePlace(region.name) })).filter(item => item.phrase.length >= 3);
  doc.index = { districts, regions, names: new Set([...districts.map(item => item.phrase), ...regions.map(item => item.phrase)]) };
  return doc.index;
}

function cautioned(item, cautions) {
  if (!cautions?.length) return false;
  const listed = phrase => phrase.length >= 4 && cautions.some(note => (' ' + note + ' ').includes(' ' + phrase + ' '));
  if (listed(normalizePlace(item.province))) return true;
  return [item.district, item.region?.name ?? item.name, item.regency].filter(Boolean).some(name => {
    const words = stripRegionWord(name).split(' ');
    return [words.join(' '), words[0] === 'kepulauan' ? words.slice(1).join(' ') : '', DIRECTIONS.has(words.at(-1)) ? words.slice(0, -1).join(' ') : ''].some(listed);
  });
}

const label = entry => entry.district + ', ' + (entry.region ? entry.region.type + ' ' + entry.region.name : entry.regency);

function decide(hits, describe) {
  const top = Math.max(...hits.map(hit => hit.score));
  const best = hits.filter(hit => hit.score === top);
  const groups = new Set(best.map(hit => hit.target.confirm ? 'confirm' : hit.target.value));
  if (groups.size > 1) return { status: 'ambiguous', options: best.slice(0, 4).map(hit => ({ destination: describe(hit.target), amount: hit.target.confirm ? 'Konfirmasi' : formatRupiah(hit.target.value) })) };
  const target = best[0].target;
  const destinations = new Set(best.map(hit => describe(hit.target)));
  return { target, best, destination: destinations.size === 1 ? describe(target) : target.district || target.name };
}

function districtHits(query, docs) {
  const hits = [];
  for (const doc of docs) {
    for (const item of indexed(doc).districts) {
      for (const span of occurrences(query, item.phrase)) {
        const before = previousWords(query, span[0]);
        const last = before.at(-1);
        if (streetName(before) || VILLAGE_WORDS.has(last) || REGENCY_WORDS.has(last) || CITY_WORDS.has(last)) continue;
        const elsewhere = phrase => occurrences(query, phrase).some(other => !overlaps(other, span));
        const regencyMatch = elsewhere(item.regency) || elsewhere(item.regionName);
        const explicit = DISTRICT_WORDS.has(last);
        if (!explicit && !regencyMatch && COMMON_WORDS.has(item.phrase)) continue;
        const score = item.phrase.split(' ').length * 10 + (explicit ? 6 : 0) + (regencyMatch ? 8 : 0) + (elsewhere(item.province) ? 2 : 0);
        hits.push({ target: item.entry, doc, span, explicit, regencyMatch, score });
      }
    }
  }
  // "Mimika Barat" inside "Mimika Barat Jauh" is not a separate destination.
  return hits.filter(hit => !hits.some(other => other !== hit && other.span[0] <= hit.span[0] && other.span[1] >= hit.span[1] && other.span[1] - other.span[0] > hit.span[1] - hit.span[0]));
}

function regionHits(query, docs) {
  const hits = [];
  for (const doc of docs) {
    for (const item of indexed(doc).regions) {
      for (const span of occurrences(query, item.phrase)) {
        const before = previousWords(query, span[0]);
        const last = before.at(-1);
        if (streetName(before) || VILLAGE_WORDS.has(last)) continue;
        const qualifier = REGENCY_WORDS.has(last) ? 'Kabupaten' : CITY_WORDS.has(last) ? 'Kota' : '';
        if (qualifier && qualifier !== item.region.type) continue;
        if (!qualifier && COMMON_WORDS.has(item.phrase)) continue;
        hits.push({ target: item.region, doc, span, score: item.phrase.split(' ').length * 10 + (qualifier ? 5 : 0) });
      }
    }
  }
  return hits;
}

function javaHits(query, conflicts) {
  const hits = [];
  for (const place of JAVA_PLACES) {
    for (const span of occurrences(query, place.name)) {
      const before = previousWords(query, span[0]);
      const last = before.at(-1);
      if (streetName(before) || VILLAGE_WORDS.has(last)) continue;
      const qualifier = REGENCY_WORDS.has(last) ? 'Kabupaten' : CITY_WORDS.has(last) ? 'Kota' : '';
      if (qualifier && place.type !== qualifier) continue;
      const strong = place.type === 'Provinsi' || place.island || Boolean(qualifier);
      const bare = !strong && !QUALIFIER_ONLY.has(place.name);
      const conflict = bare && conflicts.has(place.name);
      if (strong || bare) hits.push({ place, span, strong, conflict, qualifier });
    }
  }
  return hits;
}

const javaResult = hit => ({ status: 'java', island: Boolean(hit.place.island), destination: (hit.qualifier ? hit.qualifier + ' ' : '') + titleCase(hit.place.name) });

export function matchLocation(text, docs) {
  const query = ' ' + normalizePlace(text) + ' ';
  const conflicts = new Set(docs.flatMap(doc => [...indexed(doc).names]));
  const regions = regionHits(query, docs);
  // A bare district name inside a matched regency name ("Raya" in "Mamberamo Raya", or "Jayapura")
  // refers to the regency, unless the customer marked it as a kecamatan or gave its regency.
  const districts = districtHits(query, docs).filter(hit => hit.explicit || hit.regencyMatch || !regions.some(region => region.span[0] <= hit.span[0] && region.span[1] >= hit.span[1]));
  const java = javaHits(query, conflicts).filter(hit => !districts.some(district => district.regencyMatch && overlaps(district.span, hit.span)));
  const javaStrong = java.find(hit => hit.strong && !hit.place.island) || java.find(hit => hit.strong);
  const strongDistricts = districts.filter(hit => hit.regencyMatch);
  const districtResult = hits => {
    const decision = decide(hits, label);
    if (decision.status) return decision;
    const entry = decision.target;
    if (entry.confirm) return { status: 'confirm', destination: decision.destination, level: 'district' };
    return { status: 'found', destination: decision.destination, province: entry.province, amount: formatRupiah(entry.value), value: entry.value, final: !decision.best.some(hit => cautioned(hit.target, hit.doc.cautions)), level: 'district' };
  };
  if (strongDistricts.length) return districtResult(strongDistricts);
  if (javaStrong) return javaResult(javaStrong);
  if (districts.length) {
    const conflict = java.find(hit => hit.conflict && districts.some(district => overlaps(district.span, hit.span)));
    if (conflict && districts.every(hit => !hit.explicit)) {
      return { status: 'ambiguous', options: [{ destination: titleCase(conflict.place.name) + ' (Pulau Jawa)', amount: 'aturan Pulau Jawa' }, ...districts.slice(0, 3).map(hit => ({ destination: label(hit.target), amount: hit.target.confirm ? 'Konfirmasi' : formatRupiah(hit.target.value) }))] };
    }
    return districtResult(districts);
  }
  const javaBare = java.find(hit => !hit.conflict);
  if (javaBare) return javaResult(javaBare);
  if (regions.length) {
    const decision = decide(regions, region => region.type + ' ' + region.name);
    if (decision.status) return decision;
    const region = decision.target;
    if (region.confirm) return { status: 'confirm', destination: decision.destination, level: 'region' };
    const uniform = region.entries.every(entry => !entry.confirm && entry.value === region.value);
    if (!uniform) return { status: 'need_district', destination: decision.destination };
    return { status: 'found', destination: decision.destination, province: region.province, amount: formatRupiah(region.value), value: region.value, final: !decision.best.some(hit => cautioned(hit.target, hit.doc.cautions)), level: 'region' };
  }
  return ADDRESS_MARKERS.test(query) ? { status: 'not_found' } : { status: 'none' };
}

// Contact lines never contain the destination and customer names can equal regency names (for example Bima).
const withoutContactLines = text => String(text).split(/\r?\n/).filter(line => !/^\s*[-•*]?\s*(nama|no\.?\s*(hp|wa|telp|telepon)|nomor|hp|wa|telp|telepon)\b/i.test(line)).join('\n');

export function resolveShipping(thread, docs) {
  const items = (thread || []).filter(item => typeof item?.text === 'string' && item.text.trim());
  const finish = result => !docs.length && result.status !== 'java' ? { status: 'unavailable' } : result;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.outgoing) continue;
    const text = withoutContactLines(item.text);
    const normalized = normalizePlace(text);
    const previous = items.slice(0, index).findLast(other => other.outgoing);
    if (!ADDRESS_MARKERS.test(normalized) && !SHIPPING_WORDS.test(normalized) && !(previous && LOCATION_QUESTION.test(previous.text))) continue;
    const result = matchLocation(text, docs);
    if (result.status !== 'none') return finish(result);
  }
  return finish({ status: 'none' });
}

export const isTariffDocument = parsed => parsed.entries.length >= 20;
