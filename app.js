// Niaw dashboard (frontend statis).
// Prinsip: tombol hanya menampilkan "Tersimpan" setelah data benar-benar tersimpan.
// Fitur yang butuh server (kirim WA, instance, inbox, logout) ditandai jelas sebagai belum tersambung.

const content = document.querySelector('#page-content');
const title = document.querySelector('#page-title');
const description = document.querySelector('#page-description');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

const store = {
  get(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw === null ? fallback : JSON.parse(raw); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
};

const KEYS = { settings: 'niaw-settings', contacts: 'niaw-contacts', groups: 'niaw-groups', orderTemplate: 'niaw-order-template', forms: 'niaw-forms' };
const SHIPPING = ['JNE', 'J&T Express', 'SiCepat', 'AnterAja', 'POS Indonesia', 'TIKI', 'Ninja Xpress', 'Lion Parcel', 'ID Express', 'SAP Express', 'Wahana'];
const DEFAULT_ORDER_TEMPLATE = 'Halo Kak {nama}, pesanan {produk} ({qty}) sudah dikirim via {kurir} dengan nomor resi: {resi}. Mohon ditunggu kedatangannya ya Kak, terima kasih!';
const OFFLINE_NOTE = 'Belum tersambung ke server WhatsApp';

// ---------- Validasi ----------
function normalizePhone(raw) {
  const digits = String(raw).replace(/[\s\-().+]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  let phone = digits;
  if (phone.startsWith('08')) phone = '62' + phone.slice(1);
  if (!/^628\d{7,11}$/.test(phone)) return null;
  return phone;
}

// ---------- Umpan balik ----------
function flash(button, text, ms = 1600) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = text;
  clearTimeout(button._flash);
  button._flash = setTimeout(() => { button.textContent = original; }, ms);
}

function setStatus(el, message, type = 'info') {
  if (!el) return;
  el.textContent = message;
  el.dataset.type = type;
}

// ---------- Modal (aksesibel) ----------
function openModal({ heading, body, actions = [], className = '' }) {
  const opener = document.activeElement;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const id = 'modal-title-' + Date.now();
  backdrop.innerHTML = `<div class="modal ${className}" role="dialog" aria-modal="true" aria-labelledby="${id}"><button class="modal-close" type="button" aria-label="Tutup">×</button><h2 id="${id}">${escapeHtml(heading)}</h2><div class="modal-body">${body}</div><p class="form-status" role="status" aria-live="polite"></p>${actions.length ? `<div class="modal-actions">${actions.map((a, i) => `<button class="button ${a.variant || ''}" type="button" data-modal-action="${i}">${escapeHtml(a.label)}</button>`).join('')}</div>` : ''}</div>`;
  const modal = backdrop.querySelector('.modal');
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); if (opener && opener.isConnected) opener.focus(); };
  const focusables = () => [...modal.querySelectorAll('button:not([disabled]), input:not([disabled]):not([hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')];
  const onKey = (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const items = focusables(); if (!items.length) return;
    const first = items[0]; const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (event) => { if (event.target === backdrop) close(); });
  modal.querySelector('.modal-close').addEventListener('click', close);
  const api = { modal, close, status: (msg, type) => setStatus(modal.querySelector('.form-status'), msg, type) };
  actions.forEach((action, i) => modal.querySelector(`[data-modal-action="${i}"]`).addEventListener('click', () => (action.onClick ? action.onClick(api) : close())));
  document.body.append(backdrop);
  const firstInput = modal.querySelector('input:not([hidden]), select, textarea');
  (firstInput || modal.querySelector('[data-modal-action]') || modal.querySelector('.modal-close')).focus();
  return api;
}

function confirmDanger({ heading, message, confirmLabel, onConfirm }) {
  openModal({
    heading,
    body: `<p class="intro">${escapeHtml(message)}</p>`,
    actions: [{ label: 'Batal', variant: 'secondary' }, { label: confirmLabel, variant: 'danger', onClick: ({ close }) => { onConfirm(); close(); } }],
  });
}

// ---------- Pengaturan ----------
const defaultSettings = () => ({ minInterval: 2, maxInterval: 5, rotation: 'round-robin', schedule: false, couriers: [], cheapestOnly: false });

function settingsPage() {
  const s = { ...defaultSettings(), ...store.get(KEYS.settings, {}) };
  content.innerHTML = `
    <section class="section">
      <div class="section-head"><div><h2>Nomor WhatsApp (Instance)</h2><p class="intro">Hubungkan nomor lewat scan QR. Beberapa instance aktif dipakai bergantian.</p></div><span class="quota">0 / 10 nomor</span></div>
      <div class="section-actions"><button class="button" type="button" disabled aria-describedby="instance-note">Tambah</button></div>
      <p class="hint offline" id="instance-note">${OFFLINE_NOTE}. Scan QR membutuhkan backend instance.</p>
      <div class="empty"><strong>Belum ada instance</strong><span>Tambah instance lalu scan QR dari WhatsApp di HP</span></div>
    </section>
    <section class="section"><h2>Pengaturan Interval</h2><p class="intro">Atur rentang interval acak untuk pengiriman pesan</p>
      <div class="form-grid">
        <div class="field"><label for="min-interval">Interval Minimum <span class="range-value" id="min-value">${s.minInterval}</span> detik</label><input id="min-interval" class="range" type="range" min="1" max="60" value="${s.minInterval}"></div>
        <div class="field"><label for="max-interval">Interval Maksimum <span class="range-value" id="max-value">${s.maxInterval}</span> detik</label><input id="max-interval" class="range" type="range" min="1" max="60" value="${s.maxInterval}"></div>
        <p class="hint">Interval acak antara <span id="hint-min">${s.minInterval}</span> - <span id="hint-max">${s.maxInterval}</span> detik antar pesan untuk menghindari spam detection</p>
        <div class="field"><label for="rotation">Mode Rotasi Nomor</label><select id="rotation"><option value="round-robin">Round Robin (Bergantian)</option><option value="random">Random (Acak)</option></select><span class="hint" id="rotation-hint"></span></div>
      </div>
      <h2 class="subheading">Waktu Operasional</h2><p class="intro">Atur jam dan hari kerja untuk pengiriman pesan</p>
      <div class="switch-row"><div class="switch-copy"><strong id="schedule-label">Aktifkan Batas Waktu</strong><span>Pesan hanya dikirim dalam waktu yang ditentukan</span></div><label class="switch"><input type="checkbox" id="schedule" aria-labelledby="schedule-label" ${s.schedule ? 'checked' : ''}><span class="track"></span></label></div>
      <div class="section-actions"><span class="form-status" id="settings-status" role="status" aria-live="polite"></span><button class="button" type="button" id="save-settings">Simpan Pengaturan</button></div>
    </section>
    <section class="section"><h2>Ekspedisi Cek Ongkir</h2><p class="intro">AI hanya menghitung dan menawarkan ekspedisi yang dicentang.</p>
      <div class="checks">${SHIPPING.map((x) => `<label class="check"><input type="checkbox" name="courier" value="${escapeHtml(x)}" ${s.couriers.includes(x) ? 'checked' : ''}>${escapeHtml(x)}</label>`).join('')}</div>
      <div class="switch-row"><div class="switch-copy"><strong id="cheapest-label">Tampilkan 1 tarif termurah saja</strong><span>Pembeli tidak perlu memilih kurir. Daftar ekspedisi hanya muncul jika pembeli menanyakannya.</span></div><label class="switch"><input type="checkbox" id="cheapest" aria-labelledby="cheapest-label" ${s.cheapestOnly ? 'checked' : ''}><span class="track"></span></label></div>
      <div class="section-actions"><span class="form-status" id="shipping-status" role="status" aria-live="polite"></span><button class="button" type="button" id="save-shipping">Simpan Ekspedisi</button></div>
    </section>
    <section class="section"><h2>Pesan Masuk</h2><p class="intro">Hubungkan balasan pelanggan agar otomatis muncul di Kotak Masuk.</p>
      <div class="switch-row"><div class="switch-copy"><strong>Belum tersedia</strong><span>${OFFLINE_NOTE}. Aktif otomatis setelah instance terhubung.</span></div><button class="button" type="button" disabled>Aktifkan</button></div>
    </section>`;

  const min = content.querySelector('#min-interval');
  const max = content.querySelector('#max-interval');
  const rotation = content.querySelector('#rotation');
  rotation.value = s.rotation;
  const syncRotation = () => { content.querySelector('#rotation-hint').textContent = rotation.value === 'random' ? 'Setiap pesan dikirim dari nomor aktif yang dipilih acak' : 'Pesan akan dikirim bergantian ke setiap nomor aktif'; };
  const sync = (changed) => {
    // Minimum tidak boleh melebihi maksimum.
    if (Number(min.value) > Number(max.value)) { if (changed === min) max.value = min.value; else min.value = max.value; }
    content.querySelector('#min-value').textContent = min.value;
    content.querySelector('#max-value').textContent = max.value;
    content.querySelector('#hint-min').textContent = min.value;
    content.querySelector('#hint-max').textContent = max.value;
  };
  min.addEventListener('input', () => sync(min));
  max.addEventListener('input', () => sync(max));
  rotation.addEventListener('change', syncRotation);
  syncRotation();

  const save = (patch, statusId, button) => {
    const ok = store.set(KEYS.settings, { ...defaultSettings(), ...store.get(KEYS.settings, {}), ...patch });
    const status = content.querySelector(statusId);
    if (ok) { setStatus(status, 'Tersimpan di browser ini.', 'success'); flash(button, 'Tersimpan'); }
    else setStatus(status, 'Gagal menyimpan. Penyimpanan browser penuh atau diblokir.', 'error');
  };
  content.querySelector('#save-settings').addEventListener('click', (e) => save({ minInterval: Number(min.value), maxInterval: Number(max.value), rotation: rotation.value, schedule: content.querySelector('#schedule').checked }, '#settings-status', e.currentTarget));
  content.querySelector('#save-shipping').addEventListener('click', (e) => {
    const couriers = [...content.querySelectorAll('input[name="courier"]:checked')].map((c) => c.value);
    const status = content.querySelector('#shipping-status');
    if (!couriers.length) { setStatus(status, 'Pilih minimal satu ekspedisi.', 'error'); return; }
    save({ couriers, cheapestOnly: content.querySelector('#cheapest').checked }, '#shipping-status', e.currentTarget);
  });
}

// ---------- Dashboard ----------
function dashboardPage() {
  content.innerHTML = `
    <section class="stats" aria-label="Ringkasan pesan">
      ${[['Total', '0'], ['Terkirim', '0'], ['Gagal', '0'], ['Pending', '0']].map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`).join('')}
    </section>
    <section class="section compose"><h2>Kirim Pesan</h2><p class="intro">Kirim pesan WhatsApp ke nomor tujuan</p>
      <div class="field"><label for="phone">Nomor WhatsApp</label><input id="phone" type="tel" inputmode="numeric" placeholder="Format: 08xxx atau 628xxx (Indonesia)" aria-describedby="send-status"></div>
      <div class="field"><label for="message">Pesan</label><textarea id="message" rows="5"></textarea></div>
      <div class="section-actions"><span class="form-status" id="send-status" role="status" aria-live="polite"></span><button class="button" type="button" id="send-message">Kirim Pesan</button></div>
    </section>
    <section class="section"><div class="section-head"><div><h2>Riwayat Pesan</h2><p class="intro">0 pesan total</p></div></div><div class="empty"><strong>Belum ada pesan yang dikirim</strong></div></section>`;
  content.querySelector('#send-message').addEventListener('click', () => {
    const status = content.querySelector('#send-status');
    const phone = normalizePhone(content.querySelector('#phone').value);
    const message = content.querySelector('#message').value.trim();
    if (!phone) { setStatus(status, 'Nomor tidak valid. Gunakan 08xxx atau 628xxx, 10–13 digit.', 'error'); content.querySelector('#phone').focus(); return; }
    if (!message) { setStatus(status, 'Pesan tidak boleh kosong.', 'error'); content.querySelector('#message').focus(); return; }
    // Tidak ada backend: jangan pura-pura terkirim.
    setStatus(status, `Pesan ke ${phone} belum terkirim: ${OFFLINE_NOTE.toLowerCase()}.`, 'error');
  });
}

// ---------- AI Agent ----------
function aiAgentPage() {
  const tabs = [
    ['Pengaturan per Nomor', 'Belum ada nomor WhatsApp.', 'Tambahkan instance di Pengaturan terlebih dahulu.'],
    ['Pembayaran', 'Belum ada metode pembayaran.', 'Metode pembayaran tersedia setelah nomor WhatsApp terhubung.'],
    ['Data Live', 'Belum ada data live.', 'Data percakapan AI akan muncul setelah nomor terhubung.'],
    ['Virtual Office', 'Virtual Office belum dikonfigurasi.', 'Atur setelah minimal satu nomor terhubung.'],
  ];
  content.innerHTML = `<section class="section ai-agent"><h2>AI Agent</h2><p class="intro">Atur gaya balasan AI untuk tiap nomor WhatsApp.</p><div class="tabs" role="tablist">${tabs.map(([label], i) => `<button class="tab ${i === 0 ? 'active' : ''}" type="button" role="tab" id="ai-tab-${i}" aria-controls="ai-panel" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${label}</button>`).join('')}</div><div id="ai-panel" role="tabpanel" aria-labelledby="ai-tab-0"></div></section>`;
  const panel = content.querySelector('#ai-panel');
  const buttons = [...content.querySelectorAll('.tab')];
  const select = (i) => {
    buttons.forEach((b, j) => { b.classList.toggle('active', i === j); b.setAttribute('aria-selected', String(i === j)); b.tabIndex = i === j ? 0 : -1; });
    panel.setAttribute('aria-labelledby', `ai-tab-${i}`);
    panel.innerHTML = `<div class="empty"><strong>${tabs[i][1]}</strong><span>${tabs[i][2]}</span></div>`;
  };
  buttons.forEach((b, i) => {
    b.addEventListener('click', () => select(i));
    b.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length; select(n); buttons[n].focus(); } });
  });
  select(0);
}

// ---------- Kotak Masuk ----------
function inboxPage() {
  content.innerHTML = `<section class="inbox-layout"><div class="conversation-list"><div class="list-head"><h2>Kotak Masuk</h2><span>0 percakapan</span></div><button class="reset-link" type="button" disabled title="Tidak ada percakapan untuk dihapus">Reset semua</button><div class="empty compact"><strong>Belum ada percakapan</strong><span>Pesan WhatsApp masuk akan muncul di sini.</span></div></div><div class="conversation-empty"><strong>Pilih percakapan</strong><span>Pilih kontak di sebelah kiri untuk melihat dan membalas pesan.</span></div></section>`;
}

// ---------- Pesanan ----------
function ordersPage() {
  const template = store.get(KEYS.orderTemplate, DEFAULT_ORDER_TEMPLATE);
  content.innerHTML = `<section class="section"><h2>Pesanan</h2><p class="intro">Pesanan yang dicatat AI dari chat WhatsApp, dikelompokkan berdasarkan status pengerjaan.</p>
    <div class="status-tabs" role="group" aria-label="Status pesanan">${['Semua', 'Menunggu Bayar', 'Diproses', 'Selesai'].map((x) => `<button type="button" class="tab ${x === 'Semua' ? 'active' : ''}" aria-pressed="${x === 'Semua'}" data-status="${x}">${x} (0)</button>`).join('')}</div>
    <button class="reset-link" type="button" disabled title="Tidak ada pesanan untuk dihapus">Reset semua pesanan</button>
    <div class="order-filters" role="group" aria-label="Jenis pengiriman">${['Semua jenis', 'Ekspedisi', 'Kurir Toko', 'Kurir Instan', 'Ambil di Toko', 'Digital'].map((x, i) => `<button type="button" class="filter ${i === 0 ? 'active' : ''}" aria-pressed="${i === 0}">${x} (0)</button>`).join('')}</div>
    <div class="empty"><strong id="orders-empty">Belum ada pesanan.</strong></div></section>
    <section class="section"><h2>Template Pesan Resi</h2><p class="intro">Gunakan {nama}, {produk}, {qty}, {kurir}, {resi}, {total}, {alamat}.</p><label class="sr-only" for="order-template">Template pesan resi</label><textarea id="order-template" class="template-input" rows="4">${escapeHtml(template)}</textarea>
    <div class="section-actions"><span class="form-status" id="template-status" role="status" aria-live="polite"></span><button class="button secondary" type="button" id="reset-template">Kembalikan Default</button><button class="button" type="button" id="save-template">Simpan Template</button></div></section>`;

  const groupToggle = (selector) => {
    const items = [...content.querySelectorAll(selector)];
    items.forEach((btn) => btn.addEventListener('click', () => {
      items.forEach((b) => { b.classList.toggle('active', b === btn); b.setAttribute('aria-pressed', String(b === btn)); });
      const status = content.querySelector('.status-tabs .active').dataset.status;
      content.querySelector('#orders-empty').textContent = status === 'Semua' ? 'Belum ada pesanan.' : `Belum ada pesanan dengan status ${status}.`;
    }));
  };
  groupToggle('.status-tabs .tab');
  groupToggle('.order-filters .filter');

  const area = content.querySelector('#order-template');
  const status = content.querySelector('#template-status');
  content.querySelector('#save-template').addEventListener('click', (e) => {
    const value = area.value.trim();
    if (!value) { setStatus(status, 'Template tidak boleh kosong.', 'error'); return; }
    const unknown = [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => !['nama', 'produk', 'qty', 'kurir', 'resi', 'total', 'alamat'].includes(k));
    if (unknown.length) { setStatus(status, `Variabel tidak dikenal: ${unknown.map((k) => `{${k}}`).join(', ')}`, 'error'); return; }
    if (store.set(KEYS.orderTemplate, value)) { setStatus(status, 'Tersimpan di browser ini.', 'success'); flash(e.currentTarget, 'Tersimpan'); }
    else setStatus(status, 'Gagal menyimpan.', 'error');
  });
  content.querySelector('#reset-template').addEventListener('click', () => confirmDanger({
    heading: 'Kembalikan template default?', message: 'Template yang sudah Anda ubah akan diganti dengan template bawaan.', confirmLabel: 'Kembalikan',
    onConfirm: () => { store.set(KEYS.orderTemplate, DEFAULT_ORDER_TEMPLATE); area.value = DEFAULT_ORDER_TEMPLATE; setStatus(status, 'Template default dipulihkan.', 'success'); },
  }));
}

// ---------- Kontak ----------
const contactState = { query: '', group: 'all', perPage: 25, selected: new Set() };

function getContacts() {
  return store.get(KEYS.contacts, []).map((c, i) => ({ id: c.id || `c${i}-${c.phone}`, group: '', note: '', ...c }));
}

function contactsPage() {
  const contacts = getContacts();
  const groups = store.get(KEYS.groups, []);
  if (contactState.group !== 'all' && !groups.includes(contactState.group)) contactState.group = 'all';
  const q = contactState.query.toLowerCase();
  const filtered = contacts.filter((c) => (contactState.group === 'all' || c.group === contactState.group) && (!q || c.name.toLowerCase().includes(q) || c.phone.includes(q)));
  const visible = filtered.slice(0, contactState.perPage);
  [...contactState.selected].forEach((id) => { if (!contacts.some((c) => c.id === id)) contactState.selected.delete(id); });

  const rows = visible.map((c) => `<div class="contact-row" data-id="${escapeHtml(c.id)}"><input type="checkbox" data-select aria-label="Pilih ${escapeHtml(c.name)}" ${contactState.selected.has(c.id) ? 'checked' : ''}><span class="avatar" aria-hidden="true">${escapeHtml(c.name.charAt(0).toUpperCase())}</span><strong>${escapeHtml(c.name)}</strong><span>${escapeHtml(c.phone)}</span><span>${escapeHtml(c.group || c.note || '-')}</span><span class="follow-up-buttons">${[1, 2, 3, 4, 5].map((n) => `<button type="button" disabled title="${OFFLINE_NOTE}">FU ${n}</button>`).join('')}</span><button type="button" class="row-delete" data-delete aria-label="Hapus ${escapeHtml(c.name)}">Hapus</button></div>`).join('');

  content.innerHTML = `<section class="section contacts"><div class="section-head"><div><h2>Kontak WhatsApp</h2><p class="intro">Kelola kontak. Kirim follow up aktif setelah server WhatsApp tersambung.</p></div><div class="contact-actions"><button class="button secondary" type="button" data-contact-action="groups">Kelola Grup</button><button class="button" type="button" data-contact-action="import">Import CSV</button><button class="button" type="button" data-contact-action="add">Tambah Kontak</button></div></div>
    <div class="contact-total"><span>Total</span><strong>${contacts.length}</strong></div>
    <div class="list-head contact-list-head"><div><h2>Daftar Kontak</h2><span>${filtered.length} dari ${contacts.length} kontak</span></div><div class="contact-filters"><select aria-label="Filter grup" id="group-filter"><option value="all">Semua Grup</option>${groups.map((g) => `<option value="${escapeHtml(g)}" ${contactState.group === g ? 'selected' : ''}>${escapeHtml(g)}</option>`).join('')}</select><input type="search" id="contact-search" placeholder="Cari nama atau nomor..." aria-label="Cari nama atau nomor" value="${escapeHtml(contactState.query)}"></div></div>
    <div class="bulk-bar"><label class="select-all"><input type="checkbox" id="select-all" ${visible.length && visible.every((c) => contactState.selected.has(c.id)) ? 'checked' : ''} ${visible.length ? '' : 'disabled'}> Pilih Semua</label><button class="reset-link" type="button" id="delete-selected" ${contactState.selected.size ? '' : 'disabled'}>Hapus terpilih (${contactState.selected.size})</button><label class="per-page">Tampilkan <select aria-label="Jumlah kontak" id="per-page">${[25, 50, 100].map((n) => `<option ${n === contactState.perPage ? 'selected' : ''}>${n}</option>`).join('')}</select> kontak</label></div>
    ${contacts.length ? (filtered.length ? `<div class="contact-table"><div class="contact-table-head"><span>Nama</span><span>Nomor WA</span><span>Grup</span><span>Follow Up</span></div>${rows}</div>` : '<div class="empty"><strong>Tidak ada kontak yang cocok</strong><span>Ubah kata kunci pencarian atau filter grup.</span></div>') : '<div class="empty"><strong>Belum ada kontak</strong><span>Tambahkan kontak baru atau import dari CSV.</span></div>'}</section>`;

  content.querySelectorAll('[data-contact-action]').forEach((b) => b.addEventListener('click', () => ({ add: openAddContact, import: openImportContacts, groups: openGroups })[b.dataset.contactAction]()));
  const search = content.querySelector('#contact-search');
  search.addEventListener('input', () => { contactState.query = search.value; const pos = search.selectionStart; contactsPage(); const s = content.querySelector('#contact-search'); s.focus(); s.setSelectionRange(pos, pos); });
  content.querySelector('#group-filter').addEventListener('change', (e) => { contactState.group = e.target.value; contactsPage(); });
  content.querySelector('#per-page').addEventListener('change', (e) => { contactState.perPage = Number(e.target.value); contactsPage(); });
  content.querySelector('#select-all').addEventListener('change', (e) => { visible.forEach((c) => (e.target.checked ? contactState.selected.add(c.id) : contactState.selected.delete(c.id))); contactsPage(); });
  content.querySelectorAll('[data-select]').forEach((box) => box.addEventListener('change', () => { const id = box.closest('.contact-row').dataset.id; box.checked ? contactState.selected.add(id) : contactState.selected.delete(id); contactsPage(); }));
  content.querySelectorAll('[data-delete]').forEach((btn) => btn.addEventListener('click', () => {
    const id = btn.closest('.contact-row').dataset.id; const c = contacts.find((x) => x.id === id);
    confirmDanger({ heading: 'Hapus kontak?', message: `${c.name} (${c.phone}) akan dihapus permanen dari browser ini.`, confirmLabel: 'Hapus', onConfirm: () => { store.set(KEYS.contacts, contacts.filter((x) => x.id !== id)); contactState.selected.delete(id); contactsPage(); } });
  }));
  content.querySelector('#delete-selected').addEventListener('click', () => {
    const n = contactState.selected.size;
    confirmDanger({ heading: `Hapus ${n} kontak?`, message: 'Kontak terpilih akan dihapus permanen dari browser ini.', confirmLabel: 'Hapus', onConfirm: () => { store.set(KEYS.contacts, contacts.filter((x) => !contactState.selected.has(x.id))); contactState.selected.clear(); contactsPage(); } });
  });
}

function openAddContact() {
  const groups = store.get(KEYS.groups, []);
  openModal({
    heading: 'Tambah Kontak', className: 'contact-modal',
    body: `<label class="field"><span>Nama</span><input data-contact-name placeholder="Nama kontak" maxlength="80"></label><label class="field"><span>Nomor WhatsApp</span><input data-contact-phone type="tel" inputmode="numeric" placeholder="08xxx atau 628xxx"></label>${groups.length ? `<label class="field"><span>Grup (opsional)</span><select data-contact-group><option value="">Tanpa grup</option>${groups.map((g) => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('')}</select></label>` : ''}`,
    actions: [{ label: 'Batal', variant: 'secondary' }, {
      label: 'Simpan', onClick: ({ modal, close, status }) => {
        const name = modal.querySelector('[data-contact-name]').value.trim();
        const phone = normalizePhone(modal.querySelector('[data-contact-phone]').value);
        if (!name) { status('Nama wajib diisi.', 'error'); modal.querySelector('[data-contact-name]').focus(); return; }
        if (!phone) { status('Nomor tidak valid. Gunakan 08xxx atau 628xxx, 10–13 digit.', 'error'); modal.querySelector('[data-contact-phone]').focus(); return; }
        const contacts = getContacts();
        if (contacts.some((c) => c.phone === phone)) { status(`Nomor ${phone} sudah ada di daftar kontak.`, 'error'); return; }
        contacts.push({ id: `c${Date.now()}`, name, phone, group: modal.querySelector('[data-contact-group]')?.value || '' });
        if (!store.set(KEYS.contacts, contacts)) { status('Gagal menyimpan kontak.', 'error'); return; }
        close(); contactsPage();
      },
    }],
  });
}

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch; continue; }
    if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function openImportContacts() {
  let parsed = null;
  openModal({
    heading: 'Import CSV', className: 'contact-modal',
    body: `<label class="upload-box" tabindex="0"><input type="file" accept=".csv,text/csv" hidden data-file><span data-file-label>Pilih file CSV</span><small>Kolom: nama, nomor. File Excel: simpan dulu sebagai CSV. Data diproses di browser ini.</small></label>`,
    actions: [{ label: 'Batal', variant: 'secondary' }, {
      label: 'Import', onClick: ({ close, status }) => {
        if (!parsed) { status('Pilih file CSV terlebih dahulu.', 'error'); return; }
        const contacts = getContacts(); const existing = new Set(contacts.map((c) => c.phone));
        let added = 0; const fresh = parsed.valid.filter((c) => !existing.has(c.phone) && existing.add(c.phone));
        fresh.forEach((c, i) => { contacts.push({ id: `c${Date.now()}-${i}`, name: c.name, phone: c.phone, group: '' }); added++; });
        if (!store.set(KEYS.contacts, contacts)) { status('Gagal menyimpan kontak.', 'error'); return; }
        close(); contactsPage();
        const skipped = parsed.valid.length - added;
        setStatus(ensurePageStatus(), `${added} kontak diimport. ${parsed.invalid} baris tidak valid${skipped ? `, ${skipped} duplikat dilewati` : ''}.`, 'success');
      },
    }],
  }).modal.querySelector('[data-file]').addEventListener('change', async (e) => {
    const modal = e.target.closest('.modal'); const file = e.target.files[0]; const label = modal.querySelector('[data-file-label]');
    const statusEl = modal.querySelector('.form-status'); parsed = null;
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) { setStatus(statusEl, 'Format harus .csv', 'error'); e.target.value = ''; return; }
    const rows = parseCsv(await file.text());
    if (rows.length && /nama|name/i.test(rows[0][0] || '')) rows.shift();
    const valid = []; let invalid = 0;
    rows.forEach((r) => { const name = (r[0] || '').trim(); const phone = normalizePhone(r[1] || ''); if (name && phone) valid.push({ name, phone }); else invalid++; });
    label.textContent = file.name;
    if (!valid.length) { setStatus(statusEl, 'Tidak ada baris valid. Pastikan kolom 1 = nama, kolom 2 = nomor.', 'error'); return; }
    parsed = { valid, invalid };
    setStatus(statusEl, `${valid.length} kontak siap diimport${invalid ? `, ${invalid} baris tidak valid` : ''}.`, 'info');
  });
}

function ensurePageStatus() {
  let el = content.querySelector('.page-status');
  if (!el) { el = document.createElement('p'); el.className = 'form-status page-status'; el.setAttribute('role', 'status'); content.prepend(el); }
  return el;
}

function openGroups() {
  const render = () => store.get(KEYS.groups, []).map((g) => `<li><span>${escapeHtml(g)}</span><button type="button" class="reset-link" data-remove-group="${escapeHtml(g)}">Hapus</button></li>`).join('') || '<li class="hint">Belum ada grup.</li>';
  const api = openModal({
    heading: 'Kelola Grup', className: 'contact-modal',
    body: `<label class="field"><span>Nama Grup</span><input data-group-name placeholder="Contoh: Reseller" maxlength="40"></label><ul class="group-list">${render()}</ul>`,
    actions: [{ label: 'Tutup', variant: 'secondary', onClick: ({ close }) => { close(); contactsPage(); } }, {
      label: 'Tambah Grup', onClick: ({ modal, status }) => {
        const input = modal.querySelector('[data-group-name]'); const name = input.value.trim(); const groups = store.get(KEYS.groups, []);
        if (!name) { status('Nama grup wajib diisi.', 'error'); return; }
        if (groups.some((g) => g.toLowerCase() === name.toLowerCase())) { status('Grup sudah ada.', 'error'); return; }
        groups.push(name); store.set(KEYS.groups, groups); input.value = ''; modal.querySelector('.group-list').innerHTML = render(); status(`Grup "${name}" ditambahkan.`, 'success'); input.focus();
      },
    }],
  });
  api.modal.querySelector('.group-list').addEventListener('click', (e) => {
    const name = e.target.dataset.removeGroup; if (!name) return;
    store.set(KEYS.groups, store.get(KEYS.groups, []).filter((g) => g !== name));
    store.set(KEYS.contacts, getContacts().map((c) => (c.group === name ? { ...c, group: '' } : c)));
    api.modal.querySelector('.group-list').innerHTML = render(); api.status(`Grup "${name}" dihapus. Kontaknya tetap ada.`, 'success');
  });
}

// ---------- Form Builder ----------
const FIELD_TYPES = ['Teks Singkat', 'Teks Panjang', 'Angka', 'Email', 'Telepon', 'Dropdown', 'Pilihan Ganda', 'Checkbox'];
const slugify = (text) => text.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 48);
const getForms = () => store.get(KEYS.forms, []);
const saveForms = (forms) => store.set(KEYS.forms, forms);

function formsPage() {
  const forms = getForms();
  content.innerHTML = `<section class="section forms"><div class="section-head"><div><h2>Form Builder</h2><p class="intro">Buat dan kelola form kustom seperti Google Forms</p></div></div><div class="section-actions"><button class="button" type="button" data-open-form>Buat Form Baru</button></div><h2 class="subheading">Daftar Form</h2><p class="intro">${forms.length ? 'Klik nama form untuk mengedit.' : 'Form yang Anda buat akan muncul di sini.'}</p>
    ${forms.length ? `<ul class="form-list">${forms.map((f) => `<li><a href="#forms/${encodeURIComponent(f.id)}"><strong>${escapeHtml(f.name)}</strong><span>/f/${escapeHtml(f.slug)} · ${f.fields.length} field · ${f.template === 'order' ? 'Formulir Order' : 'Form Biasa'}</span></a><button type="button" class="reset-link" data-delete-form="${escapeHtml(f.id)}">Hapus</button></li>`).join('')}</ul>` : '<div class="empty"><strong>Belum ada form</strong><span>Klik "Buat Form Baru" untuk memulai.</span></div>'}</section>`;
  content.querySelector('[data-open-form]').addEventListener('click', openFormModal);
  content.querySelectorAll('[data-delete-form]').forEach((b) => b.addEventListener('click', () => {
    const form = forms.find((f) => f.id === b.dataset.deleteForm);
    confirmDanger({ heading: 'Hapus form?', message: `Form "${form.name}" beserta semua field-nya akan dihapus.`, confirmLabel: 'Hapus', onConfirm: () => { saveForms(getForms().filter((f) => f.id !== form.id)); formsPage(); } });
  }));
}

function openFormModal() {
  let template = 'basic';
  const api = openModal({
    heading: 'Buat Form Baru',
    body: `<p class="intro">Masukkan nama dan deskripsi untuk form baru Anda</p><div class="template-choice" role="radiogroup" aria-label="Template"><span>Template</span><button class="choice active" type="button" role="radio" aria-checked="true" data-template="basic"><strong>Form Biasa</strong><small>Pendaftaran, survei, event</small></button><button class="choice" type="button" role="radio" aria-checked="false" data-template="order"><strong>Formulir Order</strong><small>Field nama, alamat, produk & jumlah</small></button></div><div class="field"><label for="new-form-name">Nama Form</label><input id="new-form-name" placeholder="Contoh: Form Pendaftaran" maxlength="80"></div><div class="field"><label for="new-form-description">Deskripsi (opsional)</label><input id="new-form-description" placeholder="Deskripsi singkat tentang form ini" maxlength="300"></div>`,
    actions: [{ label: 'Batal', variant: 'secondary' }, {
      label: 'Buat Form', onClick: ({ modal, close, status }) => {
        const name = modal.querySelector('#new-form-name').value.trim();
        if (!name) { status('Nama form wajib diisi.', 'error'); modal.querySelector('#new-form-name').focus(); return; }
        const forms = getForms();
        let slug = slugify(name) || 'form'; const base = slug; let n = 2;
        while (forms.some((f) => f.slug === slug)) slug = `${base}-${n++}`;
        const id = `f${Date.now()}`;
        const fields = template === 'order'
          ? [['Teks Singkat', 'Nama Lengkap', true], ['Telepon', 'Nomor WhatsApp', true], ['Teks Panjang', 'Alamat Lengkap', true], ['Teks Singkat', 'Produk', true], ['Angka', 'Jumlah', true]].map(([type, label, required], i) => ({ id: `${id}-${i}`, type, label, placeholder: '', required, options: '' }))
          : [];
        forms.push({ id, template, name, slug, description: modal.querySelector('#new-form-description').value.trim(), date: '', link: '', sender: 'auto', thanks: false, reminder: false, banner: '', fields });
        if (!saveForms(forms)) { status('Gagal menyimpan form.', 'error'); return; }
        close(); location.hash = `#forms/${id}`;
      },
    }],
  });
  const choices = [...api.modal.querySelectorAll('.choice')];
  choices.forEach((c) => c.addEventListener('click', () => { template = c.dataset.template; choices.forEach((x) => { x.classList.toggle('active', x === c); x.setAttribute('aria-checked', String(x === c)); }); }));
}

const TOOLBAR = [
  ['Bold', '**', '**'], ['Italic', '_', '_'], ['Strikethrough', '~~', '~~'],
  ['Heading', '\n## ', ''], ['Bullet List', '\n- ', ''], ['Numbered List', '\n1. ', ''], ['Quote', '\n> ', ''], ['Code', '`', '`'], ['Link', '[', '](https://)'],
];

function builderPage(id) {
  const form = getForms().find((f) => f.id === id);
  if (!form) { content.innerHTML = `<section class="section"><h2>Form tidak ditemukan</h2><p class="intro">Form mungkin sudah dihapus atau dibuat di browser lain.</p><div class="section-actions"><a class="button" href="#forms">Kembali ke Daftar Form</a></div></section>`; return; }
  let fields = form.fields.map((f) => ({ ...f }));
  let banner = form.banner || '';
  let dirty = false;

  content.innerHTML = `<section class="builder-page"><div class="builder-head"><div><a class="back-link" href="#forms">← Daftar Form</a><h2>${escapeHtml(form.name)}</h2><p class="intro">Edit dan konfigurasi form Anda</p></div><div class="builder-actions"><span class="form-status" id="builder-status" role="status" aria-live="polite"></span><button class="button secondary" type="button" data-preview>Preview</button><button class="button" type="button" data-save>Simpan</button></div></div>
    <section class="section"><h2>Pengaturan Form</h2><p class="intro">Nama dan deskripsi form</p><div class="form-grid builder-grid">
      <div class="field"><label for="builder-name">Nama Form</label><input id="builder-name" value="${escapeHtml(form.name)}" maxlength="80"></div>
      <div class="field"><label for="builder-slug">Slug URL <span class="hint-inline" id="slug-hint">(/f/${escapeHtml(form.slug)})</span></label><input id="builder-slug" value="${escapeHtml(form.slug)}" maxlength="48"></div>
      <div class="field full"><label for="builder-description">Deskripsi <span class="hint-inline">(mendukung Markdown)</span></label><div class="editor-toolbar" role="toolbar" aria-label="Format deskripsi">${TOOLBAR.map(([t], i) => `<button type="button" data-format="${i}">${t}</button>`).join('')}</div><textarea id="builder-description" rows="4">${escapeHtml(form.description)}</textarea></div>
      <div class="field"><label for="event-date">Tanggal Event (Opsional)</label><input id="event-date" type="datetime-local" value="${escapeHtml(form.date)}"></div>
      <div class="field"><label for="event-link">Link Event (Opsional)</label><input id="event-link" placeholder="https://zoom.us/j/..." type="url" value="${escapeHtml(form.link)}"></div>
      <div class="field full"><span class="field-label" id="banner-label">Banner Form</span><div class="upload-box" role="button" tabindex="0" aria-labelledby="banner-label"><span data-banner-text>Klik untuk upload banner</span><small>Max 2MB (JPG, PNG, GIF). Disimpan di browser ini.</small></div><div class="banner-preview"></div></div>
      <div class="field full"><h3>Nomor WhatsApp Pengirim</h3><p class="hint">Pesan terima kasih dan reminder form ini dikirim dari nomor CS yang dipilih.</p><select id="sender" aria-label="Nomor WhatsApp pengirim"><option value="auto">Otomatis (nomor aktif pertama)</option></select></div>
      <div class="field full"><h3>Pesan Terima Kasih Otomatis</h3><p class="hint">Kirim pesan WhatsApp otomatis setelah form di-submit. Berjalan setelah server WhatsApp tersambung.</p><label class="switch-row"><span>Aktifkan pesan terima kasih via WhatsApp</span><span class="switch"><input type="checkbox" id="thanks" ${form.thanks ? 'checked' : ''}><span class="track"></span></span></label></div>
      <div class="field full"><h3>Reminder Event</h3><p class="hint">Kirim pengingat WA otomatis sebelum event dimulai</p><p class="warning" id="reminder-warning">Atur Tanggal Event terlebih dahulu untuk mengaktifkan fitur reminder.</p><label class="switch-row" id="reminder-row"><span>Aktifkan reminder otomatis</span><span class="switch"><input type="checkbox" id="reminder" ${form.reminder ? 'checked' : ''}><span class="track"></span></span></label></div>
      <div class="field full field-form"><div class="section-head"><div><h3>Field Form</h3><p class="hint">Tambah dan atur field untuk form Anda</p></div><button class="button" type="button" data-add-field>Tambah Field</button></div><div class="field-list"></div></div>
    </div></section></section>`;

  const $ = (sel) => content.querySelector(sel);
  const status = $('#builder-status');
  const markDirty = () => { dirty = true; setStatus(status, 'Ada perubahan belum disimpan.', 'info'); };
  content.querySelector('.builder-grid').addEventListener('input', markDirty);
  content.querySelector('.builder-grid').addEventListener('change', markDirty);

  // Slug
  $('#builder-slug').addEventListener('input', (e) => { $('#slug-hint').textContent = `(/f/${slugify(e.target.value) || '...'})`; });

  // Toolbar Markdown
  const desc = $('#builder-description');
  content.querySelectorAll('[data-format]').forEach((btn) => btn.addEventListener('click', () => {
    const [, before, after] = TOOLBAR[Number(btn.dataset.format)];
    const { selectionStart: s, selectionEnd: e, value } = desc;
    const selected = value.slice(s, e) || 'teks';
    const pre = s === 0 ? before.replace(/^\n/, '') : before;
    desc.setRangeText(pre + selected + after, s, e, 'end');
    desc.setSelectionRange(s + pre.length, s + pre.length + selected.length);
    desc.focus(); markDirty();
  }));

  // Reminder bergantung tanggal
  const syncReminder = () => {
    const hasDate = Boolean($('#event-date').value);
    $('#reminder').disabled = !hasDate; if (!hasDate) $('#reminder').checked = false;
    $('#reminder-row').classList.toggle('disabled', !hasDate);
    $('#reminder-warning').hidden = hasDate;
  };
  $('#event-date').addEventListener('input', syncReminder);
  syncReminder();

  // Banner
  const uploadBox = $('.upload-box'); const bannerFile = document.createElement('input');
  bannerFile.type = 'file'; bannerFile.accept = 'image/jpeg,image/png,image/gif'; bannerFile.hidden = true; uploadBox.append(bannerFile);
  const renderBanner = () => { $('.banner-preview').innerHTML = banner ? `<img src="${banner}" alt="Banner form"><button type="button" class="reset-link" data-remove-banner>Hapus banner</button>` : ''; $('[data-remove-banner]')?.addEventListener('click', () => { banner = ''; renderBanner(); markDirty(); }); };
  uploadBox.addEventListener('click', () => bannerFile.click());
  uploadBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bannerFile.click(); } });
  bannerFile.addEventListener('change', () => {
    const file = bannerFile.files[0]; if (!file) return;
    const ok = ['image/jpeg', 'image/png', 'image/gif'].includes(file.type) && file.size <= 2 * 1024 * 1024;
    uploadBox.dataset.error = ok ? '' : 'true';
    $('[data-banner-text]').textContent = ok ? file.name : 'File harus JPG, PNG, atau GIF maksimal 2MB';
    bannerFile.value = '';
    if (!ok) return;
    const reader = new FileReader();
    reader.onload = () => { banner = reader.result; renderBanner(); markDirty(); };
    reader.readAsDataURL(file);
  });
  renderBanner();

  // Field
  const list = $('.field-list');
  const renderFields = () => {
    if (!fields.length) { list.innerHTML = '<div class="empty"><span>Belum ada field. Klik tombol di atas untuk menambahkan.</span></div>'; return; }
    list.innerHTML = fields.map((f, i) => `<div class="field-row" data-index="${i}">
      <span class="field-order"><button type="button" data-move="-1" aria-label="Naikkan field ${i + 1}" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" data-move="1" aria-label="Turunkan field ${i + 1}" ${i === fields.length - 1 ? 'disabled' : ''}>↓</button></span>
      <label class="field"><span>Tipe Field</span><select data-key="type">${FIELD_TYPES.map((t) => `<option ${t === f.type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="field"><span>Label</span><input data-key="label" value="${escapeHtml(f.label)}" maxlength="120"></label>
      <label class="field"><span>Placeholder</span><input data-key="placeholder" value="${escapeHtml(f.placeholder)}" placeholder="Opsional" ${f.type === 'Checkbox' ? 'disabled' : ''}></label>
      ${['Dropdown', 'Pilihan Ganda'].includes(f.type) ? `<label class="field options-config"><span>Opsi</span><input data-key="options" value="${escapeHtml(f.options)}" placeholder="Pisahkan opsi dengan koma"></label>` : ''}
      <label class="required-toggle"><input type="checkbox" data-key="required" ${f.required ? 'checked' : ''}><span>Wajib diisi</span></label>
      <button class="delete-field" type="button" data-remove aria-label="Hapus field ${escapeHtml(f.label || i + 1)}">Hapus</button></div>`).join('');
  };
  list.addEventListener('input', (e) => { const row = e.target.closest('.field-row'); const key = e.target.dataset.key; if (!row || !key) return; fields[row.dataset.index][key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; });
  list.addEventListener('change', (e) => { if (e.target.dataset.key === 'type') renderFields(); });
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.field-row'); if (!row) return; const i = Number(row.dataset.index);
    if (e.target.dataset.remove !== undefined) { fields.splice(i, 1); renderFields(); markDirty(); }
    if (e.target.dataset.move) { const j = i + Number(e.target.dataset.move); [fields[i], fields[j]] = [fields[j], fields[i]]; renderFields(); list.querySelector(`[data-index="${j}"] [data-move="${e.target.dataset.move}"]`)?.focus(); markDirty(); }
  });
  $('[data-add-field]').addEventListener('click', () => {
    fields.push({ id: `${form.id}-${Date.now()}`, type: 'Teks Singkat', label: `Field ${fields.length + 1}`, placeholder: '', required: false, options: '' });
    renderFields(); markDirty(); list.querySelector('.field-row:last-child [data-key="label"]').focus();
  });
  renderFields();

  const collect = () => ({ ...form, name: $('#builder-name').value.trim(), slug: slugify($('#builder-slug').value), description: desc.value.trim(), date: $('#event-date').value, link: $('#event-link').value.trim(), sender: $('#sender').value, thanks: $('#thanks').checked, reminder: $('#reminder').checked, banner, fields });
  const validate = (data) => {
    if (!data.name) return 'Nama form wajib diisi.';
    if (!data.slug) return 'Slug URL wajib diisi (huruf, angka, tanda minus).';
    if (getForms().some((f) => f.slug === data.slug && f.id !== form.id)) return `Slug /f/${data.slug} sudah dipakai form lain.`;
    if (data.link && !/^https?:\/\/\S+\.\S+/.test(data.link)) return 'Link Event harus diawali http:// atau https://';
    const blank = data.fields.findIndex((f) => !f.label.trim()); if (blank >= 0) return `Label field ${blank + 1} masih kosong.`;
    const noOpts = data.fields.findIndex((f) => ['Dropdown', 'Pilihan Ganda'].includes(f.type) && f.options.split(',').filter((o) => o.trim()).length < 2);
    if (noOpts >= 0) return `Field ${noOpts + 1} (${data.fields[noOpts].type}) butuh minimal 2 opsi.`;
    return '';
  };

  $('[data-save]').addEventListener('click', (e) => {
    const data = collect(); const error = validate(data);
    if (error) { setStatus(status, error, 'error'); return; }
    const forms = getForms().map((f) => (f.id === form.id ? data : f));
    if (!saveForms(forms)) { setStatus(status, 'Gagal menyimpan. Banner mungkin terlalu besar untuk penyimpanan browser.', 'error'); return; }
    Object.assign(form, data); dirty = false;
    $('#builder-slug').value = data.slug; content.querySelector('.builder-head h2').textContent = data.name;
    setStatus(status, 'Tersimpan di browser ini.', 'success'); flash(e.currentTarget, 'Tersimpan');
  });

  $('[data-preview]').addEventListener('click', () => {
    const data = collect();
    const inputFor = (f, i) => {
      const id = `pv-${i}`; const req = f.required ? 'required' : ''; const ph = escapeHtml(f.placeholder);
      const opts = f.options.split(',').map((o) => o.trim()).filter(Boolean);
      const label = `${escapeHtml(f.label)}${f.required ? ' <span class="required-mark" aria-hidden="true">*</span>' : ''}`;
      switch (f.type) {
        case 'Teks Panjang': return `<label for="${id}">${label}</label><textarea id="${id}" rows="3" placeholder="${ph}" ${req}></textarea>`;
        case 'Angka': return `<label for="${id}">${label}</label><input id="${id}" type="number" placeholder="${ph}" ${req}>`;
        case 'Email': return `<label for="${id}">${label}</label><input id="${id}" type="email" placeholder="${ph}" ${req}>`;
        case 'Telepon': return `<label for="${id}">${label}</label><input id="${id}" type="tel" placeholder="${ph}" ${req}>`;
        case 'Dropdown': return `<label for="${id}">${label}</label><select id="${id}" ${req}><option value="">${ph || 'Pilih...'}</option>${opts.map((o) => `<option>${escapeHtml(o)}</option>`).join('')}</select>`;
        case 'Pilihan Ganda': return `<fieldset><legend>${label}</legend>${opts.map((o) => `<label class="check"><input type="radio" name="${id}" value="${escapeHtml(o)}" ${req}>${escapeHtml(o)}</label>`).join('')}</fieldset>`;
        case 'Checkbox': return `<label class="check"><input id="${id}" type="checkbox" ${req}>${label}</label>`;
        default: return `<label for="${id}">${label}</label><input id="${id}" type="text" placeholder="${ph}" ${req}>`;
      }
    };
    const api = openModal({
      heading: data.name || 'Form tanpa nama', className: 'preview-modal',
      body: `<p class="hint">Mode preview: jawaban tidak dikirim ke mana pun.</p>${data.banner ? `<img class="preview-banner" src="${data.banner}" alt="">` : ''}${data.description ? `<p class="intro preview-description">${escapeHtml(data.description)}</p>` : ''}<form class="preview-form" novalidate>${data.fields.map((f, i) => `<div class="preview-field">${inputFor(f, i)}</div>`).join('') || '<p class="hint">Belum ada field.</p>'}</form>`,
      actions: [{ label: 'Tutup', variant: 'secondary' }, {
        label: 'Uji Kirim', onClick: ({ modal, status: st }) => {
          const formEl = modal.querySelector('.preview-form');
          if (!formEl.checkValidity()) { formEl.reportValidity(); st('Ada field wajib yang belum diisi atau formatnya salah.', 'error'); return; }
          st('Validasi lolos. Di mode preview jawaban tidak dikirim.', 'success');
        },
      }],
    });
    return api;
  });

  // Peringatan saat pindah halaman dengan perubahan belum disimpan.
  builderPage.isDirty = () => dirty;
}

// ---------- Halaman lain ----------
function comingSoonPage(heading, text) {
  content.innerHTML = `<section class="section"><h2>${escapeHtml(heading)}</h2><div class="empty"><strong>Belum tersedia</strong><span>${escapeHtml(text)}</span></div></section>`;
}

// ---------- Router ----------
const ROUTES = {
  '#dashboard': dashboardPage,
  '#inbox': inboxPage,
  '#ai-agent': aiAgentPage,
  '#orders': ordersPage,
  '#products': () => comingSoonPage('Produk', 'Katalog produk & harga sedang dikembangkan.'),
  '#contacts': contactsPage,
  '#forms': formsPage,
  '#templates': () => comingSoonPage('Template FU', 'Template follow up sedang dikembangkan.'),
  '#settings': settingsPage,
  '#account': () => comingSoonPage('Akun & Langganan', 'Informasi paket, kuota, dan profil toko sedang dikembangkan.'),
};

let currentHash = null;
function renderPage() {
  // Kompatibilitas tautan lama /forms/local/builder
  if (location.pathname.includes('/forms/') && location.pathname.endsWith('/builder')) { history.replaceState(null, '', '/#forms'); }
  const hash = location.hash || '#settings';
  if (builderPage.isDirty?.() && currentHash && currentHash !== hash && !window.confirm('Perubahan form belum disimpan. Tinggalkan halaman?')) { history.replaceState(null, '', currentHash); return; }
  builderPage.isDirty = null;
  currentHash = hash;
  const builderMatch = hash.match(/^#forms\/(.+)$/);
  const navHash = builderMatch ? '#forms' : (ROUTES[hash] ? hash : '#settings');
  const active = document.querySelector(`.nav a[href="${navHash}"]`);
  document.querySelectorAll('.nav a').forEach((a) => { a.classList.toggle('active', a === active); if (a === active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  title.textContent = builderMatch ? 'Edit Form' : active.dataset.page;
  description.textContent = builderMatch ? 'Form Builder' : active.dataset.description;
  document.title = `Niaw: ${title.textContent}`;
  if (builderMatch) builderPage(decodeURIComponent(builderMatch[1]));
  else ROUTES[navHash]();
}

window.addEventListener('hashchange', renderPage);
window.addEventListener('beforeunload', (e) => { if (builderPage.isDirty?.()) { e.preventDefault(); e.returnValue = ''; } });

const logout = document.querySelector('#logout');
logout.disabled = true;
logout.title = 'Belum tersambung ke sistem login';

renderPage();
