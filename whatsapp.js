(() => {
  const labels = { idle: 'Belum terhubung', connecting: 'Menghubungkan…', awaiting_scan: 'Menunggu scan QR', connected: 'WhatsApp terhubung', disconnected: 'Koneksi terputus, mencoba kembali…', logged_out: 'Sesi keluar. Hubungkan ulang dengan QR.' };
  let timer = null;
  let working = false;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const request = async (route, method = 'GET', body) => {
    const response = await fetch(`/api/whatsapp/${route}`, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Gateway HTTP ${response.status}`);
    return data;
  };
  const path = (action, id) => `${action}?instance=${encodeURIComponent(id)}`;

  function mount() {
    const host = document.querySelector('#wa-pairing');
    if (!host) { clearTimeout(timer); timer = null; return; }
    if (host.dataset.mounted === 'true') return;
    host.dataset.mounted = 'true';
    host.innerHTML = `<div class="instance-toolbar"><span id="wa-instance-count" class="hint">Memuat nomor…</span><button type="button" class="button" id="wa-add">+ Tambah nomor WhatsApp</button><button type="button" class="button secondary" id="wa-refresh">Perbarui status</button></div><form id="wa-add-form" class="instance-add-form" hidden><label class="field">Nama label nomor<input name="label" maxlength="60" required placeholder="Contoh: CS Utama"></label><div class="section-actions"><button class="button" type="submit">Simpan & tampilkan QR</button><button class="button secondary" id="wa-cancel-add" type="button">Batal</button><span id="wa-add-result" class="hint" role="status"></span></div></form><div id="wa-instances" class="wa-instances"><p class="empty">Memuat status koneksi…</p></div><p class="hint">Scan QR melalui WhatsApp → Perangkat tertaut. Putuskan akan mengeluarkan perangkat dan perlu scan QR lagi untuk menghubungkan kembali.</p>`;
    const list = host.querySelector('#wa-instances');
    const addForm = host.querySelector('#wa-add-form');
    const addButton = host.querySelector('#wa-add');
    const refreshButton = host.querySelector('#wa-refresh');

    function draw(items) {
      host.querySelector('#wa-instance-count').textContent = `${items.length}/10 nomor digunakan`;
      addButton.disabled = items.length >= 10;
      if (!items.length) { list.innerHTML = '<p class="empty">Belum ada nomor WhatsApp.</p>'; return; }
      list.innerHTML = items.map(item => {
        const status = item.status || 'idle';
        const info = [item.connectedAt ? `Terhubung sejak ${new Date(item.connectedAt).toLocaleString('id-ID')}` : '', item.lastClose ? `Putus terakhir: ${item.lastClose.code ?? 'tidak diketahui'}` : '', item.retryPending ? 'Percobaan ulang terjadwal' : ''].filter(Boolean).join(' · ');
        const qr = status === 'awaiting_scan' ? `<img class="wa-qr" data-qr="${esc(item.id)}" alt="QR WhatsApp ${esc(item.label)}" width="240" height="240">` : '';
        const connectLabel = status === 'awaiting_scan' ? 'Minta QR baru' : status === 'logged_out' && item.id === 'default' ? 'Pairing ulang' : status === 'connected' ? 'Terhubung' : 'Hubungkan';
        const connectDisabled = ['connected', 'connecting'].includes(status);
        const canDisconnect = item.enabled && status !== 'idle';
        return `<article class="wa-instance" data-wa-instance="${esc(item.id)}"><div class="wa-instance-head"><div><h3>${esc(item.label)}</h3><p class="status-line" data-status="${esc(status)}">${esc(labels[status] || status)}</p></div><span class="instance-index">${item.id === 'default' ? 'Utama' : 'Nomor tambahan'}</span></div><p class="hint">${esc(info)}</p>${qr}<div class="section-actions"><button class="button" data-instance-connect="${esc(item.id)}" ${connectDisabled ? 'disabled' : ''}>${connectLabel}</button>${canDisconnect ? `<button class="button secondary" data-instance-disconnect="${esc(item.id)}">Putuskan</button>` : ''}${item.id !== 'default' && status === 'idle' && !item.enabled ? `<button class="button secondary danger" data-instance-delete="${esc(item.id)}">Hapus nomor</button>` : ''}</div></article>`;
      }).join('');
      for (const image of list.querySelectorAll('[data-qr]')) {
        request(path('qr', image.dataset.qr)).then(result => { if (image.isConnected) image.src = result.image; }).catch(() => { if (image.isConnected) image.alt = 'QR sedang disiapkan, status akan diperbarui otomatis.'; });
      }
    }

    const refresh = async () => {
      if (!host.isConnected || working) return;
      try { draw(await request('instances')); }
      catch (error) { list.innerHTML = `<p class="empty">Gagal memuat nomor: ${esc(error.message)}</p>`; }
      clearTimeout(timer);
      timer = setTimeout(refresh, 5000);
    };

    addButton.addEventListener('click', () => { addForm.hidden = !addForm.hidden; if (!addForm.hidden) addForm.querySelector('input').focus(); });
    host.querySelector('#wa-cancel-add').addEventListener('click', () => { addForm.reset(); addForm.hidden = true; });
    refreshButton.addEventListener('click', async () => { refreshButton.disabled = true; try { await refresh(); } finally { refreshButton.disabled = false; } });
    addForm.addEventListener('submit', async event => {
      event.preventDefault();
      const submit = addForm.querySelector('[type=submit]');
      const result = host.querySelector('#wa-add-result');
      submit.disabled = true; result.textContent = 'Menyiapkan sesi WhatsApp…';
      try { await request('instances', 'POST', { label: addForm.elements.label.value.trim() }); addForm.reset(); addForm.hidden = true; await refresh(); }
      catch (error) { result.textContent = error.message; }
      finally { submit.disabled = false; }
    });
    list.addEventListener('click', async event => {
      const button = event.target.closest('button'); if (!button || working) return;
      const id = button.dataset.instanceConnect || button.dataset.instanceDisconnect || button.dataset.instanceDelete;
      if (!id) return;
      working = true; button.disabled = true;
      try {
        if (button.dataset.instanceDisconnect) {
          if (!confirm('Nomor ini akan dikeluarkan dari WhatsApp dan sesi lokalnya diarsipkan. Untuk menyambungkan lagi, scan QR baru. Lanjutkan?')) return;
          await request(path('disconnect', id), 'POST');
        } else if (button.dataset.instanceDelete) {
          if (!confirm('Hapus nomor tambahan ini dari daftar? Sesi lama sudah diputuskan dan diarsipkan.')) return;
          await request(`instances/${encodeURIComponent(id)}`, 'DELETE');
        } else if (button.textContent.trim() === 'Pairing ulang') {
          const response = await fetch('/api/whatsapp/re-pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'PAIRING-ULANG' }) });
          const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || `Gateway HTTP ${response.status}`);
        } else await request(path('connect', id), 'POST');
      } catch (error) { alert(error.message); }
      finally { working = false; await refresh(); }
    });
    refresh();
  }

  new MutationObserver(mount).observe(document.querySelector('#page-content'), { childList: true });
  addEventListener('hashchange', () => setTimeout(mount, 0));
  mount();
})();
