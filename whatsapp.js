(() => {
  const labels = {
    idle: 'Belum terhubung',
    connecting: 'Menghubungkan…',
    awaiting_scan: 'Menunggu scan QR',
    connected: 'WhatsApp terhubung',
    disconnected: 'Koneksi terputus, mencoba kembali…',
    logged_out: 'Sesi keluar. Pairing ulang terkontrol diperlukan.',
  };
  let timer = null;
  let failures = 0;
  let lastGood = null;

  const request = async (route, method = 'GET') => {
    const response = await fetch(`/api/whatsapp/${route}`, { method, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || `Gateway HTTP ${response.status}`), { status: response.status, data });
    return data;
  };

  function mount() {
    const host = document.querySelector('#wa-pairing');
    if (!host) { clearTimeout(timer); timer = null; return; }
    if (host.dataset.mounted === 'true') return;
    host.dataset.mounted = 'true';

    host.innerHTML = `
      <p class="status-line" role="status" id="wa-status">Memeriksa koneksi…</p>
      <p class="hint" id="wa-detail"></p>
      <img id="wa-qr" alt="QR untuk menautkan WhatsApp" width="256" height="256" hidden>
      <div class="section-actions">
        <button type="button" class="button" id="wa-connect">Hubungkan WhatsApp</button>
        <button type="button" class="button secondary" id="wa-refresh">Perbarui status</button>
        <button type="button" class="button secondary" id="wa-repair" hidden>Pairing ulang</button>
      </div>
      <p class="hint">Scan lewat WhatsApp → Perangkat tertaut. QR hanya ditampilkan di dashboard ini.</p>`;

    const statusLine = host.querySelector('#wa-status');
    const detail = host.querySelector('#wa-detail');
    const image = host.querySelector('#wa-qr');
    const connectButton = host.querySelector('#wa-connect');
    const refreshButton = host.querySelector('#wa-refresh');
    const repairButton = host.querySelector('#wa-repair');

    const paint = result => {
      statusLine.textContent = labels[result.status] || result.status;
      statusLine.dataset.status = result.status;
      const parts = [];
      if (result.connectedAt) parts.push(`Terhubung sejak ${new Date(result.connectedAt).toLocaleString('id-ID')}`);
      if (result.lastClose) parts.push(`Penutupan terakhir: kode ${result.lastClose.code ?? 'tidak diketahui'}`);
      if (result.retryPending) parts.push('Percobaan ulang terjadwal');
      detail.textContent = parts.join(' · ');
      connectButton.disabled = ['connecting', 'connected', 'logged_out'].includes(result.status);
      connectButton.textContent = result.status === 'awaiting_scan' ? 'Minta QR baru'
        : result.status === 'connected' ? 'Sudah terhubung'
        : result.status === 'logged_out' ? 'Sesi keluar'
        : 'Hubungkan WhatsApp';
      image.hidden = result.status !== 'awaiting_scan';
      repairButton.hidden = result.status !== 'logged_out';
    };

    const refresh = async () => {
      if (!host.isConnected) { timer = null; return; }
      try {
        const result = await request('status');
        failures = 0;
        lastGood = result;
        paint(result);
        if (result.status === 'awaiting_scan') {
          try { image.src = (await request('qr')).image; }
          catch { image.hidden = true; }
        }
      } catch (error) {
        failures += 1;
        // A short tunnel hiccup must not erase a valid connected state.
        if (lastGood && failures < 3) {
          detail.textContent = 'Pemeriksaan sementara gagal; mencoba lagi…';
        } else {
          statusLine.textContent = error.status === 401 ? 'Sesi dashboard berakhir. Muat ulang dan login kembali.' : 'Gateway belum tersedia. Mencoba menghubungkan kembali…';
          statusLine.dataset.status = error.status === 401 ? 'session-expired' : 'unavailable';
        }
      }
      clearTimeout(timer);
      timer = setTimeout(refresh, failures ? 1500 : 5000);
    };

    connectButton.addEventListener('click', async () => {
      connectButton.disabled = true;
      try { await request('connect', 'POST'); }
      catch (error) { statusLine.textContent = error.message; }
      clearTimeout(timer);
      await refresh();
    });

    refreshButton.addEventListener('click', async () => {
      refreshButton.disabled = true;
      clearTimeout(timer);
      try { await refresh(); } finally { refreshButton.disabled = false; }
    });

    repairButton.addEventListener('click', async () => {
      if (!confirm('Pairing ulang akan mengarsipkan sesi lama lalu membuat QR baru. Lanjutkan?')) return;
      repairButton.disabled = true;
      try {
        const response = await fetch('/api/whatsapp/re-pair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: 'PAIRING-ULANG' }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `Gateway HTTP ${response.status}`);
        detail.textContent = 'Sesi lama diarsipkan. Menunggu QR baru…';
      } catch (error) {
        statusLine.textContent = error.message;
      } finally {
        repairButton.disabled = false;
        clearTimeout(timer);
        await refresh();
      }
    });

    refresh();
  }

  new MutationObserver(mount).observe(document.querySelector('#page-content'), { childList: true });
  addEventListener('hashchange', () => setTimeout(mount, 0));
  mount();
})();
