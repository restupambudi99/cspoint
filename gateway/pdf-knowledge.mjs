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

export function rankKnowledge(query, documents, { limit = 5, chunkSize = 900, overlap = 140 } = {}) {
  const stopWords = new Set(['yang', 'dan', 'atau', 'untuk', 'dari', 'dengan', 'pada', 'adalah', 'ini', 'itu', 'saya', 'kami', 'anda', 'kak', 'tolong', 'bisa', 'berapa', 'apakah', 'bagaimana', 'mohon', 'ongkir', 'tarif', 'biaya', 'harga', 'kirim', 'pengiriman', 'ke', 'di', 'kecamatan', 'kec', 'kabupaten', 'kab', 'kota', 'distrik']);
  const terms = [...new Set(String(query ?? '').toLocaleLowerCase('id-ID').normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[\p{L}\p{N}]{3,}/gu) || [])].filter(term => !stopWords.has(term));
  if (!terms.length) return [];

  const ranked = [];
  for (const [documentIndex, document] of documents.entries()) {
    const content = String(document.content ?? '');
    for (let start = 0; start < content.length; start += chunkSize - overlap) {
      const excerpt = content.slice(start, start + chunkSize).trim();
      if (!excerpt) continue;
      const normalized = excerpt.toLocaleLowerCase('id-ID').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const counts = new Map();
      for (const token of normalized.match(/[\p{L}\p{N}]{3,}/gu) || []) counts.set(token, (counts.get(token) || 0) + 1);
      let score = 0;
      let matchedTerms = 0;
      for (const term of terms) {
        const count = counts.get(term) || 0;
        if (count) matchedTerms++;
        score += Math.min(count, 5) * 3;
      }
      if (matchedTerms) {
        // Prefer a passage that contains the full destination name over a
        // passage that happens to repeat one common part of a multiword name.
        score += matchedTerms === terms.length ? 12 : 0;
        ranked.push({ name: document.name, content: excerpt, score, documentIndex, start });
      }
    }
  }
  return ranked.sort((a, b) => b.score - a.score || a.documentIndex - b.documentIndex || a.start - b.start).slice(0, limit).map(({ name, content }) => ({ name, content }));
}
