const content = document.querySelector('#page-content');
const title = document.querySelector('#page-title');
const description = document.querySelector('#page-description');

function settingsPage() {
  content.innerHTML = `
    <section class="section">
      <div class="section-head"><div><h2>Nomor WhatsApp (Instance)</h2><p class="intro">Hubungkan nomor lewat scan QR. Beberapa instance aktif dipakai bergantian.</p></div><span class="quota">0 / 10 nomor</span></div>
      <div class="section-actions"><button class="button" type="button" data-action="add-instance">Tambah</button></div>
      <div class="empty"><strong>Belum ada instance</strong><span>Tambah instance lalu scan QR dari WhatsApp di HP</span></div>
    </section>
    <section class="section"><h2>Pengaturan Interval</h2><p class="intro">Atur rentang interval acak untuk pengiriman pesan</p>
      <div class="form-grid"><div class="field"><label for="min-interval">Interval Minimum <span class="range-value" id="min-value">2</span> detik</label><input id="min-interval" class="range" type="range" min="1" max="60" value="2"></div><div class="field"><label for="max-interval">Interval Maksimum <span class="range-value" id="max-value">5</span> detik</label><input id="max-interval" class="range" type="range" min="1" max="60" value="5"></div><p class="hint">Interval acak antara <span id="hint-min">2</span> - <span id="hint-max">5</span> detik antar pesan untuk menghindari spam detection</p><div class="field"><label for="rotation">Mode Rotasi Nomor</label><select id="rotation"><option>Round Robin (Bergantian)</option><option>Random (Acak)</option></select><span class="hint">Pesan akan dikirim bergantian ke setiap nomor aktif</span></div></div>
      <h2 class="subheading">Waktu Operasional</h2><p class="intro">Atur jam dan hari kerja untuk pengiriman pesan</p><div class="switch-row"><div class="switch-copy"><strong>Aktifkan Batas Waktu</strong><span>Pesan hanya dikirim dalam waktu yang ditentukan</span></div><label class="switch"><input type="checkbox" id="schedule"><span class="track"></span></label></div><div class="section-actions"><button class="button" type="button" data-action="save-settings">Simpan Pengaturan</button></div>
    </section>
    <section class="section"><h2>Ekspedisi Cek Ongkir</h2><p class="intro">AI hanya menghitung dan menawarkan ekspedisi yang dicentang.</p><div class="checks">${['JNE','J&T Express','SiCepat','AnterAja','POS Indonesia','TIKI','Ninja Xpress','Lion Parcel','ID Express','SAP Express','Wahana'].map((x) => `<label class="check"><input type="checkbox">${x}</label>`).join('')}</div><div class="switch-row"><div class="switch-copy"><strong>Tampilkan 1 tarif termurah saja</strong><span>Pembeli tidak perlu memilih kurir. Daftar ekspedisi hanya muncul jika pembeli menanyakannya.</span></div><label class="switch"><input type="checkbox"><span class="track"></span></label></div><div class="section-actions"><button class="button" type="button" data-action="save-shipping">Simpan Ekspedisi</button></div></section>
    <section class="section"><h2>Pesan Masuk</h2><p class="intro">Hubungkan balasan pelanggan agar otomatis muncul di Kotak Masuk.</p><div class="switch-row"><div class="switch-copy"><strong>Siap diaktifkan</strong><span>Otomatis aktif saat Scan QR. Klik lagi jika pesan masuk tidak muncul.</span></div><button class="button" type="button" data-action="activate-inbox">Aktifkan</button></div></section>`;
  bindSettings();
}

function bindSettings() {
  const min = document.querySelector('#min-interval'); const max = document.querySelector('#max-interval');
  const sync = () => { document.querySelector('#min-value').textContent = min.value; document.querySelector('#max-value').textContent = max.value; document.querySelector('#hint-min').textContent = min.value; document.querySelector('#hint-max').textContent = max.value; };
  min.addEventListener('input', sync); max.addEventListener('input', sync);
  content.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => { button.textContent = 'Tersimpan'; setTimeout(() => { button.textContent = button.dataset.action === 'activate-inbox' ? 'Aktifkan' : button.dataset.action === 'add-instance' ? 'Tambah' : button.dataset.action === 'save-shipping' ? 'Simpan Ekspedisi' : 'Simpan Pengaturan'; }, 1200); }));
}

function renderPage() { const active = document.querySelector(`.nav a[href="${location.hash || '#settings'}"]`) || document.querySelector('.nav a[href="#settings"]'); document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a === active)); title.textContent = active.dataset.page; description.textContent = active.dataset.description; if (active.dataset.page === 'Pengaturan') settingsPage(); else content.innerHTML = `<section class="section"><h2>${active.dataset.page}</h2><p class="placeholder">${active.dataset.description}</p></section>`; }
document.querySelectorAll('.nav a, .brand, .enterprise').forEach((link) => link.addEventListener('click', () => setTimeout(renderPage, 0)));
document.querySelector('#logout').addEventListener('click', () => { document.querySelector('#logout').textContent = 'Logout'; });
renderPage();
