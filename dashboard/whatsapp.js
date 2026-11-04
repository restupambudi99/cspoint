(() => {
  const labels = {
    idle: 'Belum terhubung',
    connecting: 'Menghubungkan…',
    awaiting_scan: 'Menunggu scan QR',
    connected: 'WhatsApp terhubung',
    disconnected: 'Koneksi terputus, mencoba kembali…',
    logged_out: 'Sesi keluar dari HP. Hubungkan lagi untuk scan QR baru.',
  };
  let timer = null;
  let failures = 0;
  let lastGood = null;

  const request = async (route, options = {}) => {
    const response = await fetch(`/api/whatsapp/${route}`, { cache: 'no-store', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || `Gateway HTTP ${response.status}`), { status: response.status, data });
    return data;
  };
  const query = id => `number=${encodeURIComponent(id)}`;

  function mount() {
    const host = document.querySelector('#wa-pairing');
    if (!host) { clearTimeout(timer); timer = null; return; }
    if (host.dataset.mounted === 'true') return;
    host.dataset.mounted = 'true';

    host.innerHTML = `
      <p class="status-line" role="status" id="wa-status">Memeriksa koneksi…</p>
      <div class="wa-numbers" id="wa-numbers"></div>
      <div class="section-actions">
        <button type="button" class="button" id="wa-add">Tambah nomor WhatsApp</button>
        <button type="button" class="button secondary" id="wa-refresh">Perbarui status</button>
      </div>
      <p class="hint" role="status" id="wa-result"></p>
      <p class="hint">Scan lewat WhatsApp → Perangkat tertaut. QR hanya ditampilkan di dashboard ini.</p>`;

    const summary = host.querySelector('#wa-status');
    const list = host.querySelector('#wa-numbers');
    const addButton = host.querySelector('#wa-add');
    const refreshButton = host.querySelector('#wa-refresh');
    const result = host.querySelector('#wa-result');
    const busy = new Set();

    const card = number => {
      let item = list.querySelector(`[data-number="${number.id}"]`);
      if (item) return item;
      item = document.createElement('article');
      item.className = 'wa-number';
      item.dataset.number = number.id;
      item.innerHTML = `
        <h3></h3>
        <p class="status-line" role="status"></p>
        <p class="hint" data-detail></p>
        <img alt="" width="256" height="256" hidden>
        <div class="section-actions">
          <button type="button" class="button" data-connect></button>
          <button type="button" class="button secondary" data-disconnect></button>
        </div>`;
      item.querySelector('img').alt = `QR untuk menautkan ${number.label}`;
      list.append(item);
      return item;
    };

    const paintNumber = number => {
      const item = card(number);
      const status = item.querySelector('.status-line');
      const image = item.querySelector('img');
      const connect = item.querySelector('[data-connect]');
      const disconnect = item.querySelector('[data-disconnect]');
      item.querySelector('h3').textContent = number.phone ? `${number.label} · ${number.phone}` : number.label;
      status.textContent = labels[number.status] || number.status;
      status.dataset.status = number.status;
      const parts = [];
      if (number.notice) parts.push(number.notice);
      if (number.connectedAt) parts.push(`Terhubung sejak ${new Date(number.connectedAt).toLocaleString('id-ID')}`);
      if (number.lastClose) parts.push(`Penutupan terakhir: kode ${number.lastClose.code ?? 'tidak diketahui'}`);
      if (number.retryPending) parts.push('Percobaan ulang terjadwal');
      item.querySelector('[data-detail]').textContent = parts.join(' · ');
      const working = busy.has(number.id);
      connect.hidden = number.status === 'connected';
      connect.disabled = working || number.status === 'connecting';
      connect.textContent = number.status === 'awaiting_scan' ? 'Minta QR baru' : 'Hubungkan WhatsApp';
      disconnect.hidden = number.id === 'default' && !number.hasSession && number.status === 'idle';
      disconnect.disabled = working;
      disconnect.textContent = number.hasSession ? 'Putuskan nomor' : number.id === 'default' ? 'Batalkan' : 'Hapus slot';
      image.hidden = number.status !== 'awaiting_scan';
      if (number.status === 'awaiting_scan') request(`qr?${query(number.id)}`).then(qr => { image.src = qr.image; }).catch(() => { image.hidden = true; });
    };

    const paint = ({ numbers, max }) => {
      const connected = numbers.filter(number => number.status === 'connected').length;
      summary.textContent = `${connected} terhubung · ${numbers.length} dari ${max} nomor`;
      summary.dataset.status = connected ? 'connected' : 'idle';
      for (const item of list.querySelectorAll('[data-number]')) if (!numbers.some(number => number.id === item.dataset.number)) item.remove();
      numbers.forEach(paintNumber);
      addButton.disabled = numbers.length >= max;
      addButton.textContent = numbers.length >= max ? `Batas ${max} nomor tercapai` : 'Tambah nomor WhatsApp';
    };

    const refresh = async () => {
      if (!host.isConnected) { timer = null; return; }
      try {
        const data = await request('numbers');
        failures = 0;
        lastGood = data;
        paint(data);
      } catch (error) {
        failures += 1;
        // A short tunnel hiccup must not erase a valid connected state.
        if (lastGood && failures < 3) {
          result.textContent = 'Pemeriksaan sementara gagal; mencoba lagi…';
        } else {
          summary.textContent = error.status === 401 ? 'Sesi dashboard berakhir. Muat ulang dan login kembali.' : 'Gateway belum tersedia. Mencoba menghubungkan kembali…';
          summary.dataset.status = error.status === 401 ? 'session-expired' : 'unavailable';
        }
      }
      clearTimeout(timer);
      timer = setTimeout(refresh, failures ? 1500 : 3000);
    };

    const act = async (id, work) => {
      busy.add(id);
      result.textContent = '';
      if (lastGood) paint(lastGood);
      try { await work(); }
      catch (error) { result.textContent = error.message; }
      busy.delete(id);
      clearTimeout(timer);
      await refresh();
    };

    addButton.addEventListener('click', async () => {
      addButton.disabled = true;
      try { await request('numbers', { method: 'POST' }); result.textContent = 'Slot baru dibuat. Tunggu QR muncul lalu scan.'; }
      catch (error) { result.textContent = error.message; }
      clearTimeout(timer);
      await refresh();
    });

    refreshButton.addEventListener('click', async () => {
      refreshButton.disabled = true;
      clearTimeout(timer);
      try { await refresh(); } finally { refreshButton.disabled = false; }
    });

    list.addEventListener('click', event => {
      const id = event.target.closest('[data-number]')?.dataset.number;
      const number = lastGood?.numbers.find(item => item.id === id);
      if (!number) return;
      if (event.target.matches('[data-connect]')) act(id, () => request(`connect?${query(id)}`, { method: 'POST' }));
      if (event.target.matches('[data-disconnect]')) {
        const name = number.phone || number.label;
        if (number.hasSession && !confirm(`Putuskan ${name}? Bot berhenti membalas lewat nomor ini dan perangkat dilepas dari WhatsApp. Riwayat pesan tetap tersimpan. Untuk memakainya lagi perlu scan QR baru.`)) return;
        act(id, async () => {
          const done = await request(`disconnect?${query(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'PUTUSKAN' }) });
          result.textContent = !done.wasConnected ? `${number.label} dilepas.`
            : done.unlinked ? `${name} sudah diputus.`
            : `Sesi ${name} dihapus dari server, tapi WhatsApp belum mengonfirmasi. Cek Perangkat tertaut di HP dan keluarkan bila masih ada.`;
        });
      }
    });

    refresh();
  }

  new MutationObserver(mount).observe(document.querySelector('#page-content'), { childList: true });
  addEventListener('hashchange', () => setTimeout(mount, 0));
  mount();
})();
