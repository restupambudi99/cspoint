import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export const MAX_KNOWLEDGE_PDF_BYTES = 8 * 1024 * 1024;
export const MAX_KNOWLEDGE_TEXT_CHARS = 500000;

export async function extractKnowledgePdf(base64) {
  if (typeof base64 !== 'string' || !base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw Object.assign(new Error('Isi PDF tidak valid. Pilih ulang berkas PDF.'), { status: 400 });
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_KNOWLEDGE_PDF_BYTES) {
    throw Object.assign(new Error('Ukuran PDF maksimal 8 MB.'), { status: 413 });
  }

  let document;
  let loadingTask;
  try {
    loadingTask = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, verbosity: 0 });
    document = await loadingTask.promise;
    if (document.numPages > 500) throw Object.assign(new Error('PDF maksimal 500 halaman.'), { status: 413 });
    const pages = [];
    let charCount = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .filter(item => typeof item.str === 'string')
        .map(item => `${item.str}${item.hasEOL ? '\n' : ' '}`)
        .join('');
      const normalized = pageText.replace(/-[\t ]*\n[\t ]*/g, '').replace(/[\t ]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      charCount += normalized.length + 1;
      if (charCount > MAX_KNOWLEDGE_TEXT_CHARS) {
        throw Object.assign(new Error('Teks hasil ekstraksi PDF melebihi 500.000 karakter.'), { status: 413 });
      }
      if (normalized) pages.push(normalized);
    }
    const text = pages.join('\n\n').trim();
    if (!text) throw Object.assign(new Error('PDF tidak berisi teks yang dapat dibaca. Gunakan PDF berbasis teks, bukan hasil scan gambar.'), { status: 422 });
    return text;
  } catch (error) {
    if (error?.status) throw error;
    throw Object.assign(new Error('PDF gagal dibaca. Pastikan berkas tidak rusak atau terkunci.'), { status: 422 });
  } finally {
    await loadingTask?.destroy().catch(() => {});
  }
}

export function matchShippingTariffs(query, documents) {
  const stopWords = new Set(['ongkir', 'ongkos', 'tarif', 'biaya', 'kirim', 'pengiriman', 'berapa', 'kec', 'kecamatan', 'kab', 'kabupaten', 'kota', 'distrik', 'alamat', 'lengkap', 'jalan', 'jl', 'rt', 'rw', 'kel', 'kelurahan', 'desa', 'kampung', 'negeri', 'dusun', 'kode', 'pos', 'patokan', 'rumah', 'nomor', 'telepon', 'wa', 'nama', 'penerima', 'paket', 'pcs', 'total', 'cod', 'produk', 'harga', 'mau', 'ambil', 'ya', 'kak']);
  const normalize = value => String(value ?? '').toLocaleLowerCase('id-ID').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const terms = [...new Set(normalize(query).match(/[\p{L}\p{N}]{3,}/gu) || [])].filter(term => !stopWords.has(term));
  if (!terms.length) return [];
  const editDistanceOne = (left, right) => {
    if (Math.abs(left.length - right.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < left.length && j < right.length) {
      if (left[i] === right[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (left.length > right.length) i++;
      else if (right.length > left.length) j++;
      else { i++; j++; }
    }
    return edits + Number(i < left.length || j < right.length) <= 1;
  };
  const matches = [];
  for (const [documentIndex, document] of documents.entries()) {
    for (const [lineIndex, line] of String(document.content ?? '').split(/\r?\n/).entries()) {
      const row = line.trim().match(/^(.+?)\s*(?:→|->|=>)\s*(Rp\.?\s*\d[\d.,]*)\s*$/i);
      if (!row) continue;
      const destination = row[1].trim();
      const district = normalize(destination.split('/')[0]);
      const districtTerms = district.match(/[\p{L}\p{N}]{3,}/gu) || [];
      const exact = terms.filter(term => districtTerms.includes(term));
      const fuzzy = exact.length ? [] : terms.filter(term => term.length >= 6 && districtTerms.some(token => editDistanceOne(term, token)));
      if (!exact.length && !fuzzy.length) continue;
      const destinationTerms = normalize(destination).match(/[\p{L}\p{N}]{3,}/gu) || [];
      const score = (exact.length * 4) + fuzzy.length + terms.filter(term => destinationTerms.includes(term) && !exact.includes(term)).length;
      matches.push({ type: 'shipping_tariff', name: document.name, destination, amount: row[2].replace(/\s+/g, ''), content: line.trim(), score, documentIndex, lineIndex });
    }
  }
  return matches.sort((a, b) => b.score - a.score || a.documentIndex - b.documentIndex || a.lineIndex - b.lineIndex).slice(0, 3).map(({ documentIndex, lineIndex, score, ...match }) => match);
}

export function rankKnowledge(query, documents, { limit = 5, chunkSize = 900, overlap = 140 } = {}) {
  const stopWords = new Set(['yang', 'dan', 'atau', 'untuk', 'dari', 'dengan', 'pada', 'adalah', 'ini', 'itu', 'saya', 'kami', 'anda', 'kak', 'tolong', 'bisa', 'berapa', 'apakah', 'bagaimana', 'mohon', 'ongkir', 'tarif', 'biaya', 'harga', 'kirim', 'pengiriman', 'ke', 'di', 'kecamatan', 'kec', 'kabupaten', 'kab', 'kota', 'distrik', 'nama', 'lengkap', 'penerima', 'alamat', 'alamatnya', 'jalan', 'jl', 'rt', 'rw', 'kel', 'kelurahan', 'desa', 'kampung', 'negeri', 'dusun', 'kode', 'pos', 'patokan', 'rumah', 'nomor', 'telepon', 'wa', 'produk', 'paket', 'pcs', 'total', 'cod', 'pembayaran', 'transfer', 'admin', 'cek', 'cekkan', 'info', 'informasi', 'ada', 'dalam', 'penerima', 'permisi', 'halo', 'nih', 'ya', 'dong', 'sih', 'minta', 'tolong', 'bantu', 'kasih', 'mau', 'ambil', 'berapa', 'ongkos', 'ongkirnya', 'ongkirnya']);
  const normalize = value => String(value ?? '').toLocaleLowerCase('id-ID').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const terms = [...new Set(normalize(query).match(/[\p{L}\p{N}]{3,}/gu) || [])].filter(term => !stopWords.has(term));
  if (!terms.length) return [];

  const tokenCounts = [];
  const documentCounts = new Map();
  let totalTokens = 0;
  for (const document of documents) {
    const tokens = normalize(document.content).match(/[\p{L}\p{N}]{3,}/gu) || [];
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    tokenCounts.push(counts);
    totalTokens += tokens.length;
    for (const [token, count] of counts) documentCounts.set(token, (documentCounts.get(token) || 0) + count);
  }
  const editDistanceOne = (left, right) => {
    if (Math.abs(left.length - right.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < left.length && j < right.length) {
      if (left[i] === right[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (left.length > right.length) i++;
      else if (right.length > left.length) j++;
      else { i++; j++; }
    }
    return edits + Number(i < left.length || j < right.length) <= 1;
  };
  const matches = terms.map(term => {
    if (documentCounts.has(term)) return { term, candidates: [term] };
    // Accommodate a one-letter typing error in a location, but only when the
    // result is a rare token in the uploaded reference.
    const candidate = term.length >= 6
      ? [...documentCounts.entries()].filter(([token, count]) => count <= 3 && editDistanceOne(term, token)).sort((a, b) => a[1] - b[1])[0]?.[0]
      : undefined;
    return { term, candidates: candidate ? [candidate] : [] };
  }).filter(match => match.candidates.length);
  if (!matches.length) return [];

  const ranked = [];
  for (const [documentIndex, document] of documents.entries()) {
    const content = String(document.content ?? '');
    for (let start = 0; start < content.length; start += chunkSize - overlap) {
      const excerpt = content.slice(start, start + chunkSize).trim();
      if (!excerpt) continue;
      const normalized = normalize(excerpt);
      const counts = new Map();
      for (const token of normalized.match(/[\p{L}\p{N}]{3,}/gu) || []) counts.set(token, (counts.get(token) || 0) + 1);
      let score = 0;
      let matchedTerms = 0;
      for (const { candidates } of matches) {
        const candidate = candidates.find(token => counts.has(token));
        if (!candidate) continue;
        matchedTerms++;
        const rarity = Math.log1p((totalTokens + 1) / ((documentCounts.get(candidate) || 0) + 1));
        score += rarity * Math.min(counts.get(candidate), 2);
      }
      if (matchedTerms) {
        // Ignore nonmatching address details, then prefer passages with all
        // searchable place names and exact tariff-row wording.
        score += matchedTerms === matches.length ? 20 : 0;
        if (/\b(?:rp\s*)?\d{2,3}[.]\d{3}\b|\bkonfirmasi\b/i.test(excerpt)) score += 4;
        ranked.push({ name: document.name, content: excerpt, score, documentIndex, start });
      }
    }
  }
  return ranked.sort((a, b) => b.score - a.score || a.documentIndex - b.documentIndex || a.start - b.start).slice(0, limit).map(({ name, content }) => ({ name, content }));
}
