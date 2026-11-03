const content = document.querySelector('#page-content');
const titleEl = document.querySelector('#page-title');
const descriptionEl = document.querySelector('#page-description');

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

async function api(path, options = {}) {
  const response = await fetch(`/api/whatsapp/${path}`, {
    cache: 'no-store',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
const post = body => ({ method: 'POST', body: JSON.stringify(body) });

function notify(element, message, kind = 'info') {
  if (!element) return;
  element.textContent = message;
  element.dataset.kind = kind;
}

function section(heading, intro, body, action = '') {
  return `<section class="section"><div class="section-head"><div><h2>${esc(heading)}</h2>${intro ? `<p class="intro">${esc(intro)}</p>` : ''}</div>${action}</div>${body}</section>`;
}

/* ---------------------------------------------------------------- Pengaturan */

function settingsPage() {
  content.innerHTML = [
    section('Nomor WhatsApp (Instance)', 'Satu nomor WhatsApp per gateway. Status di bawah dibaca langsung dari server.', '<div id="wa-pairing" class="pairing"><p class="empty">Memuat status koneksi…</p></div>'),
    section('Pengaturan Interval', 'Jeda antar pesan otomatis. Disimpan di database server.', `
      <div class="form-grid">
        <label class="field">Minimum (detik)<input id="set-min" type="number" min="1" max="600" value="2"></label>
        <label class="field">Maksimum (detik)<input id="set-max" type="number" min="1" max="600" value="5"></label>
        <label class="field">Rotasi<select id="set-rotation"><option>Round Robin (Bergantian)</option><option>Random (Acak)</option></select></label>
      </div>
      <div class="section-actions"><button class="button" data-save-settings>Simpan Pengaturan</button><p role="status" id="settings-result" class="hint"></p></div>`),
    section('Ekspedisi Cek Ongkir', 'Ekspedisi yang dipakai saat menghitung ongkir.', `
      <div class="checks">${['JNE', 'J&T Express', 'SiCepat', 'AnterAja', 'POS Indonesia', 'TIKI', 'Ninja Xpress'].map(name => `<label class="check"><input type="checkbox" name="courier" value="${esc(name)}">${esc(name)}</label>`).join('')}</div>
      <div class="section-actions"><button class="button" data-save-shipping>Simpan Ekspedisi</button><p role="status" id="shipping-result" class="hint"></p></div>`),
  ].join('');
  loadSettings();
}

async function loadSettings() {
  const result = document.querySelector('#settings-result');
  try {
    const settings = await api('settings');
    document.querySelector('#set-min').value = settings.minInterval;
    document.querySelector('#set-max').value = settings.maxInterval;
    document.querySelector('#set-rotation').value = settings.rotation;
    for (const box of document.querySelectorAll('input[name=courier]')) box.checked = (settings.couriers || []).includes(box.value);
  } catch (error) {
    notify(result, `Gagal memuat pengaturan: ${error.message}`, 'error');
  }
}

/* ----------------------------------------------------------------- Dashboard */

function dashboardPage() {
  content.innerHTML = [
    `<div class="dashboard-welcome"><div><span class="eyebrow">Ringkasan workspace</span><h2>Selamat datang kembali 👋</h2><p>Kelola pesan WhatsApp dan aktivitas pelanggan dari satu tempat.</p></div><a class="button" href="#inbox">Buka Kotak Masuk</a></div>`,
    `<section class="stats">
      <div class="stat stat-orange"><span>Total percakapan</span><strong id="stat-total">–</strong><small>Riwayat tersimpan</small></div>
      <div class="stat"><span>Pesan terkirim</span><strong id="stat-sent">–</strong><small>Dari dashboard</small></div>
      <div class="stat"><span>Status WhatsApp</span><strong id="stat-status">–</strong><small>Pembaruan langsung</small></div>
    </section>`,
    `<div class="dashboard-grid">${section('Kirim Pesan', 'Pesan dikirim lewat nomor WhatsApp yang tertaut.', `
      <label class="field">Nomor WhatsApp<input id="phone" type="tel" placeholder="08xxx atau 628xxx"></label>
      <label class="field">Pesan<textarea id="message" rows="5" maxlength="4000" placeholder="Tulis pesan untuk pelanggan…"></textarea></label>
      <div class="section-actions"><button class="button" data-send-message>Kirim Pesan</button><p role="status" id="send-result" class="hint"></p></div>`)}<section class="section recent-panel"><div class="section-head"><div><h2>Aktivitas terbaru</h2><p class="intro">Percakapan terakhir yang masuk.</p></div><a class="text-link" href="#inbox">Lihat semua</a></div><div id="recent-list" class="recent-list"><p class="empty compact">Memuat aktivitas…</p></div></section></div>`,
  ].join('');
  api('status').then(result => { document.querySelector('#stat-status').textContent = result.status; }).catch(() => {});
  api('conversations').then(items => {
    document.querySelector('#stat-total').textContent = items.length;
    document.querySelector('#stat-sent').textContent = items.filter(item => item.outgoing).length;
    document.querySelector('#recent-list').innerHTML = items.slice(0, 5).map(item => `<a class="recent-row" href="#inbox"><span class="conversation-avatar">${esc((item.name || item.jid).slice(0, 1).toUpperCase())}</span><span><strong>${esc(item.name || item.jid.split('@')[0])}</strong><small>${esc(item.text || 'Belum ada pesan')}</small></span><time>${esc(new Date(item.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }))}</time></a>`).join('') || '<p class="empty compact"><strong>Belum ada aktivitas</strong><span>Pesan terbaru akan muncul di sini.</span></p>';
  }).catch(() => {});
}

/* ------------------------------------------------------------------ AI Agent */

function aiAgentPage() {
  content.innerHTML = section('AI Agent', 'Balasan otomatis per nomor dan sumber pengetahuan.', `
    <div class="tabs">
      <button class="tab active" data-ai-tab="agent">Pengaturan per Nomor</button>
      <button class="tab" data-ai-tab="knowledge">Knowledge PDF</button>
      <button class="tab" data-ai-tab="live">Data Live</button>
    </div>
    <div id="ai-panel"><p class="empty">Memuat…</p></div>`);
  drawAgent();
}

async function drawAgent() {
  const panel = document.querySelector('#ai-panel');
  if (!panel) return;
  try {
    const agent = await api('agent?instance=default');
    panel.innerHTML = `
      <div class="form-grid">
        <label class="field">Nama asisten<input id="agent-name" value="${esc(agent.assistantName)}" maxlength="60"></label>
        <label class="field full">Instruksi<textarea id="agent-instructions" rows="6" maxlength="8000">${esc(agent.instructions)}</textarea></label>
        <label class="check"><input id="agent-enabled" type="checkbox" ${agent.enabled ? 'checked' : ''}> Aktifkan AI Agent</label>
      </div>
      <div class="section-actions"><button class="button" data-save-agent>Simpan Agent</button><p role="status" id="agent-result" class="hint"></p></div>
      <p class="hint">Catatan: konfigurasi tersimpan di server, tetapi mesin balasan AI belum dijalankan oleh gateway.</p>`;
  } catch (error) {
    panel.innerHTML = `<p class="empty">Gagal memuat agent: ${esc(error.message)}</p>`;
  }
}

async function knowledgePanel() {
  const panel = document.querySelector('#ai-panel');
  if (!panel) return;
  try {
    const items = await api('knowledge');
    panel.innerHTML = `
      <form id="knowledge-form" class="form-grid">
        <label class="field full">Upload dokumen PDF<input id="knowledge-file" type="file" accept="application/pdf,.pdf" required><span class="hint">PDF disimpan sebagai sumber pengetahuan untuk konfigurasi AI Agent. Maksimal 8 MB.</span></label>
        <label class="field">Nama dokumen<input id="knowledge-name" maxlength="160" placeholder="Otomatis dari nama file"></label>
        <div class="knowledge-dropzone" id="knowledge-dropzone"><strong>Knowledge PDF</strong><span>Pilih file PDF untuk mengajari AI tentang produk, layanan, atau SOP Anda.</span></div>
        <div class="section-actions"><button class="button" type="submit">Upload & Simpan</button><p role="status" id="knowledge-result" class="hint"></p></div>
      </form>
      <div class="list">${items.map(item => `<article class="contact-row"><strong>${esc(item.name)}</strong><span>${esc(item.status)}</span><span>${esc(item.size)} karakter</span><button class="button secondary" data-domain-delete="knowledge/${esc(item.id)}">Hapus</button></article>`).join('') || '<p class="empty">Belum ada knowledge.</p>'}</div>`;
  } catch (error) {
    panel.innerHTML = `<p class="empty">Gagal memuat knowledge: ${esc(error.message)}</p>`;
  }
}

function livePanel() {
  const panel = document.querySelector('#ai-panel');
  if (!panel) return;
  panel.innerHTML = `<p class="empty">Data live belum tersedia. Gateway belum menyimpan metrik percakapan AI.</p>`;
}

/* --------------------------------------------------------------- Data domain */

const domainConfig = {
  products: { label: 'Produk', intro: 'Katalog persisten untuk AI Agent dan pesanan.', fields: [{ key: 'name', label: 'Nama produk', required: true }, { key: 'sku', label: 'SKU' }, { key: 'price', label: 'Harga', type: 'number' }, { key: 'stock', label: 'Stok', type: 'number' }] },
  orders: { label: 'Pesanan', intro: 'Simpan dan lacak pesanan pelanggan.', fields: [{ key: 'customer', label: 'Nama pelanggan', required: true }, { key: 'phone', label: 'Nomor WhatsApp' }, { key: 'total', label: 'Total', type: 'number' }] },
  forms: { label: 'Form Builder', intro: 'Buat form dengan field dan simpan di server.', fields: [{ key: 'name', label: 'Nama form', required: true }] },
  contacts: { label: 'Kontak', intro: 'Daftar kontak pelanggan.', fields: [{ key: 'name', label: 'Nama kontak', required: true }, { key: 'phone', label: 'Nomor WhatsApp' }, { key: 'tag', label: 'Tag' }] },
  templates: { label: 'Template FU', intro: 'Template follow up yang bisa dipakai ulang.', fields: [{ key: 'name', label: 'Nama template', required: true }, { key: 'stage', label: 'Tahap' }, { key: 'body', label: 'Isi pesan', type: 'textarea' }] },
};

function domainPage(kind) {
  const config = domainConfig[kind];
  const fields = config.fields.map(field => field.type === 'textarea'
    ? `<label class="field full">${esc(field.label)}<textarea name="${field.key}" rows="3" maxlength="4000"></textarea></label>`
    : `<label class="field">${esc(field.label)}${field.required ? ' *' : ''}<input name="${field.key}" type="${field.type || 'text'}" ${field.required ? 'required' : ''}></label>`).join('');
  content.innerHTML = section(config.label, config.intro, `
    <form class="form-grid" data-domain-form="${kind}">${fields}
      <div class="section-actions"><button class="button" type="submit">Tambah ${esc(config.label)}</button><p role="status" id="domain-result" class="hint"></p></div>
    </form>
    <div id="domain-list" class="list"><p class="empty">Memuat…</p></div>`);
  loadDomain(kind);
}

async function loadDomain(kind) {
  const list = document.querySelector('#domain-list');
  if (!list) return;
  try {
    const items = await api(kind);
    list.innerHTML = items.length
      ? items.map(item => `<article class="contact-row"><strong>${esc(item.name || item.customer || item.label)}</strong><span>${esc(item.status || item.sku || item.stage || item.tag || item.phone || '')}</span><button class="button secondary" data-domain-delete="${kind}/${esc(item.id)}">Hapus</button></article>`).join('')
      : '<p class="empty">Belum ada data.</p>';
  } catch (error) {
    list.innerHTML = `<p class="empty">Gagal memuat data: ${esc(error.message)}</p>`;
  }
}

function ordersPage() {
  content.innerHTML = `<div class="orders-page"><div class="orders-intro"><div><span class="eyebrow">Operasional</span><h2>Pesanan</h2><p>Kelola pesanan pelanggan dan status pengirimannya.</p></div><button class="button" data-focus-order-form>+ Tambah Pesanan</button></div><div class="order-summary"><button class="order-status active" data-order-filter="all"><strong id="order-all">0</strong><span>Semua Pesanan</span></button><button class="order-status" data-order-filter="Menunggu Bayar"><strong id="order-waiting">0</strong><span>Menunggu Bayar</span></button><button class="order-status" data-order-filter="Diproses"><strong id="order-process">0</strong><span>Diproses</span></button><button class="order-status" data-order-filter="Selesai"><strong id="order-done">0</strong><span>Selesai</span></button></div><section class="section order-create" id="order-create"><div class="section-head"><div><h2>Tambah Pesanan</h2><p class="intro">Simpan pesanan baru dari percakapan pelanggan.</p></div></div><form class="form-grid" data-domain-form="orders"><label class="field">Nama pelanggan *<input name="customer" required></label><label class="field">Nomor WhatsApp<input name="phone" placeholder="628xxx"></label><label class="field">Total pembayaran<input name="total" type="number" min="0"></label><label class="field">Status<select name="status"><option>Menunggu Bayar</option><option>Diproses</option><option>Selesai</option></select></label><div class="section-actions"><button class="button" type="submit">Simpan Pesanan</button><p id="domain-result" class="hint" role="status"></p></div></form></section><section class="section order-list-section"><div class="section-head"><div><h2>Daftar Pesanan</h2><p class="intro">Pesanan terbaru tersimpan di server.</p></div><input class="order-search" id="order-search" placeholder="Cari pesanan…"></div><div id="order-list" class="order-list"><p class="empty">Memuat pesanan…</p></div></section></div>`;
  document.querySelector('#order-search').addEventListener('input', () => { const active = document.querySelector('[data-order-filter].active'); drawOrders(active?.dataset.orderFilter || 'all'); });
  loadOrders();
}
async function loadOrders() { const list = document.querySelector('#order-list'); try { const items = await api('orders'); window.__orders = items; for (const [id, status] of [['order-all','all'],['order-waiting','Menunggu Bayar'],['order-process','Diproses'],['order-done','Selesai']]) document.querySelector(`#${id}`).textContent = status === 'all' ? items.length : items.filter(x => x.status === status).length; drawOrders('all'); } catch (e) { list.innerHTML = `<p class="empty">Gagal memuat pesanan: ${esc(e.message)}</p>`; } }
function drawOrders(filter) { const list = document.querySelector('#order-list'); const q = (document.querySelector('#order-search')?.value || '').toLowerCase(); const items = (window.__orders || []).filter(x => (filter === 'all' || x.status === filter) && `${x.customer} ${x.phone} ${x.status}`.toLowerCase().includes(q)); list.innerHTML = items.length ? items.map(x => `<article class="order-card"><span class="order-avatar">${esc((x.customer || '?').slice(0,1).toUpperCase())}</span><div class="order-main"><strong>${esc(x.customer)}</strong><span>${esc(x.phone || 'Nomor belum diisi')} · ${esc(new Date(x.created_at).toLocaleDateString('id-ID'))}</span></div><strong class="order-total">Rp ${Number(x.total || 0).toLocaleString('id-ID')}</strong><span class="order-badge status-${esc((x.status || '').toLowerCase().replaceAll(' ','-'))}">${esc(x.status)}</span><button class="button secondary" data-domain-delete="orders/${esc(x.id)}">Hapus</button></article>`).join('') : '<p class="empty"><strong>Belum ada pesanan</strong><span>Pesanan baru akan muncul di daftar ini.</span></p>'; }
const productsPage = () => domainPage('products');
const formsPage = () => domainPage('forms');
const contactsPage = () => domainPage('contacts');
const templatesPage = () => domainPage('templates');

function accountPage() {
  content.innerHTML = section('Akun & Langganan', 'Paket, kuota, dan profil toko.', '<p class="empty">Belum tersedia. Billing dan kuota belum diimplementasikan di gateway ini.</p>');
}

/* -------------------------------------------------------------------- Router */

const pages = {
  Pengaturan: settingsPage,
  Dashboard: dashboardPage,
  'AI Agent': aiAgentPage,
  Pesanan: ordersPage,
  Produk: productsPage,
  'Form Builder': formsPage,
  Kontak: contactsPage,
  'Template FU': templatesPage,
  'Akun & Langganan': accountPage,
};

function render() {
  const hash = location.hash || '#settings';
  const link = document.querySelector(`.nav a[href="${hash}"]`) || document.querySelector('.nav a[href="#settings"]');
  document.querySelectorAll('.nav a').forEach(item => item.classList.toggle('active', item === link));
  titleEl.textContent = link.dataset.page;
  descriptionEl.textContent = link.dataset.description;
  const page = pages[link.dataset.page];
  if (page) { page(); return; }
  if (link.dataset.page === 'Kotak Masuk') {
    content.innerHTML = '<section class="section"><h2>Kotak Masuk</h2><p class="empty">Memuat percakapan…</p></section>';
    return;
  }
  content.innerHTML = section(link.dataset.page, '', '<p class="empty">Menu belum tersedia.</p>');
}

content.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.matches('[data-focus-order-form]')) { document.querySelector('#order-create')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); document.querySelector('#order-create input[name="customer"]')?.focus(); return; }
  if (button.matches('[data-order-filter]')) { document.querySelectorAll('[data-order-filter]').forEach(item => item.classList.toggle('active', item === button)); drawOrders(button.dataset.orderFilter); return; }
  const result = document.querySelector('#domain-result');
  try {
    if (button.matches('[data-save-settings]')) {
      const target = document.querySelector('#settings-result');
      button.disabled = true;
      try {
        const saved = await api('settings', post({
          minInterval: Number(document.querySelector('#set-min').value),
          maxInterval: Number(document.querySelector('#set-max').value),
          rotation: document.querySelector('#set-rotation').value,
        }));
        notify(target, `Tersimpan: interval ${saved.minInterval}–${saved.maxInterval} detik, ${saved.rotation}.`, 'ok');
      } finally { button.disabled = false; }
    }
    if (button.matches('[data-save-shipping]')) {
      const target = document.querySelector('#shipping-result');
      button.disabled = true;
      try {
        const saved = await api('settings', post({ couriers: [...document.querySelectorAll('input[name=courier]:checked')].map(box => box.value) }));
        notify(target, `Tersimpan: ${saved.couriers.length} ekspedisi.`, 'ok');
      } finally { button.disabled = false; }
    }
    if (button.matches('[data-send-message]')) {
      const target = document.querySelector('#send-result');
      button.disabled = true;
      try {
        const sent = await api('send', post({ phone: document.querySelector('#phone').value, text: document.querySelector('#message').value }));
        notify(target, `Pesan diserahkan ke WhatsApp (${sent.status}).`, 'ok');
      } finally { button.disabled = false; }
    }
    if (button.matches('[data-ai-tab]')) {
      document.querySelectorAll('[data-ai-tab]').forEach(tab => tab.classList.toggle('active', tab === button));
      const tab = button.dataset.aiTab;
      if (tab === 'knowledge') knowledgePanel();
      else if (tab === 'live') livePanel();
      else drawAgent();
    }
    if (button.matches('[data-save-agent]')) {
      const target = document.querySelector('#agent-result');
      button.disabled = true;
      try {
        const saved = await api('agent', post({
          instance: 'default',
          assistantName: document.querySelector('#agent-name').value,
          instructions: document.querySelector('#agent-instructions').value,
          enabled: document.querySelector('#agent-enabled').checked,
        }));
        notify(target, `Tersimpan: ${saved.assistantName} (${saved.enabled ? 'aktif' : 'nonaktif'}).`, 'ok');
      } finally { button.disabled = false; }
    }
    if (button.matches('[data-domain-delete]')) {
      button.disabled = true;
      const [kind, id] = button.dataset.domainDelete.split('/');
      await api(`${kind}/${id}`, { method: 'DELETE' });
      if (kind === 'knowledge') knowledgePanel(); else loadDomain(kind);
    }
  } catch (error) {
    const target = document.querySelector('#domain-result') || document.querySelector('#settings-result') || document.querySelector('#send-result') || document.querySelector('#agent-result') || document.querySelector('#knowledge-result');
    notify(target, error.message, 'error');
    if (!target) alert(error.message);
    button.disabled = false;
  }
});

content.addEventListener('submit', async event => {
  const form = event.target;
  if (form.matches('#knowledge-form')) {
    event.preventDefault();
    const target = document.querySelector('#knowledge-result');
    try {
      const file = document.querySelector('#knowledge-file').files[0];
      if (!file || file.type !== 'application/pdf') throw Error('Pilih file PDF yang valid.');
      if (file.size > 8 * 1024 * 1024) throw Error('Ukuran PDF maksimal 8 MB.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await api('knowledge', post({ name: document.querySelector('#knowledge-name').value.trim() || file.name, content: btoa(binary), mime: 'application/pdf', originalSize: file.size }));
      await knowledgePanel();
      notify(document.querySelector('#knowledge-result'), 'Knowledge tersimpan.', 'ok');
    } catch (error) { notify(target, error.message, 'error'); }
    return;
  }
  if (form.matches('[data-domain-form]')) {
    event.preventDefault();
    const kind = form.dataset.domainForm;
    const payload = {};
    for (const [key, value] of new FormData(form)) payload[key] = value;
    try {
      await api(kind, post(payload));
      form.reset();
      if (kind === 'orders') await loadOrders(); else await loadDomain(kind);
      notify(document.querySelector('#domain-result'), 'Data tersimpan di server.', 'ok');
    } catch (error) { notify(document.querySelector('#domain-result'), error.message, 'error'); }
  }
});

document.querySelectorAll('.nav a').forEach(link => link.addEventListener('click', () => setTimeout(render, 0)));
addEventListener('hashchange', render);
render();
