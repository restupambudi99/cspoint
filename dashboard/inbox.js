(() => {
  const root = document.querySelector('#page-content');
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const post = body => ({ method: 'POST', body: JSON.stringify(body) });
  const api = async (route, options = {}) => {
    const response = await fetch(`/api/whatsapp/${route}`, {
      cache: 'no-store', ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Gateway HTTP ${response.status}`);
    return data;
  };
  let timer;

  function mount() {
    if (location.hash !== '#inbox' || root.querySelector('#live-inbox')) return;
    clearTimeout(timer);
    root.innerHTML = `<section id="live-inbox" class="inbox-shell">
      <aside class="inbox-sidebar">
        <div class="inbox-heading"><div><h2>Kotak Masuk</h2><span id="inbox-count">0 percakapan</span></div><button class="icon-button" type="button" aria-label="Muat ulang" data-inbox-refresh>↻</button></div>
        <div class="inbox-tabs" aria-label="Filter status baca"><button class="inbox-tab active" data-filter="all" aria-pressed="true" type="button">Semua</button><button class="inbox-tab" data-filter="unread" aria-pressed="false" type="button">Belum dibaca <span id="unread-total">0</span></button></div>
        <div class="inbox-ai-control"><div class="inbox-ai-copy"><strong>Balasan AI Agent</strong><span id="inbox-ai-status" role="status" aria-live="polite">Memeriksa konfigurasi…</span></div><label class="inbox-ai-switch"><span class="sr-only">Aktifkan balasan AI otomatis</span><input id="inbox-ai-toggle" type="checkbox" aria-describedby="inbox-ai-status"><span class="track"></span></label></div>
        <label class="inbox-search"><span>⌕</span><input id="inbox-search" type="search" placeholder="Cari percakapan…" aria-label="Cari percakapan"></label>
        <div class="inbox-label-filter"><select id="label-filter" aria-label="Filter label"><option value="">Semua label</option></select><button type="button" class="button secondary" data-manage-labels>Kelola label</button></div>
        <div id="inbox-list" class="inbox-list"><div class="inbox-loading">Memuat percakapan…</div></div>
      </aside>
      <section class="inbox-chat">
        <header class="chat-header"><div class="chat-avatar" id="chat-avatar">?</div><div class="chat-identity"><h2 id="chat-name">Pilih percakapan</h2><span id="chat-subtitle">Pilih pesan di sebelah kiri untuk mulai membalas</span><div id="chat-labels" class="label-chips"></div></div><div class="chat-actions" hidden><button type="button" class="button secondary" data-chat-labels>Label</button><button type="button" class="button secondary" data-mark-unread>Tandai belum dibaca</button></div></header>
        <div id="chat-messages" class="chat-messages"><div class="chat-empty"><div class="chat-empty-icon">⌁</div><strong>Belum ada percakapan dipilih</strong><span>Pesan WhatsApp masuk akan tampil di sini.</span></div></div>
        <form id="chat-compose" class="chat-compose" hidden><textarea id="chat-text" rows="1" maxlength="4000" placeholder="Tulis pesan…" required></textarea><button class="send-button" type="submit" aria-label="Kirim pesan">➤</button></form>
        <p id="inbox-feedback" class="inbox-feedback" role="status" aria-live="polite"></p>
      </section>
    </section>
    <dialog id="inbox-label-dialog" class="inbox-label-dialog" aria-labelledby="label-dialog-title">
      <div class="label-dialog-header"><h2 id="label-dialog-title">Label percakapan</h2><button type="button" class="icon-button" data-close-labels aria-label="Tutup label">×</button></div>
      <p id="label-dialog-help"></p><div id="label-options"></div>
      <form id="label-form"><input name="id" type="hidden"><label>Nama label<input name="name" maxlength="40" required placeholder="Contoh: Perlu follow up"></label><label>Warna<select name="color"><option value="blue">Biru</option><option value="green">Hijau</option><option value="amber">Kuning</option><option value="purple">Ungu</option><option value="rose">Merah muda</option><option value="slate">Abu-abu</option></select></label><div class="label-form-actions"><button class="button" type="submit">Simpan label</button><button class="button secondary" type="reset">Label baru</button></div></form>
      <p id="label-feedback" role="status" aria-live="polite"></p>
    </dialog>`;

    const panel = root.querySelector('#live-inbox');
    const list = panel.querySelector('#inbox-list');
    const history = panel.querySelector('#chat-messages');
    const form = panel.querySelector('#chat-compose');
    const feedback = panel.querySelector('#inbox-feedback');
    const aiToggle = panel.querySelector('#inbox-ai-toggle');
    const aiStatus = panel.querySelector('#inbox-ai-status');
    let selected = '';
    let conversations = [];
    let aiConfiguration = null;
    let lastAiCheck = 0;
    let filter = 'all';
    let labels = [];
    let labelTarget = '';
    let refreshing = false;
    let reading = null;
    const dialog = root.querySelector('#inbox-label-dialog');
    const labelForm = dialog.querySelector('#label-form');
    const labelFeedback = dialog.querySelector('#label-feedback');
    const colors = new Set(['blue', 'green', 'amber', 'purple', 'rose', 'slate']);
    const chip = label => `<span class="label-chip label-${colors.has(label.color) ? label.color : 'slate'}">${esc(label.name)}</span>`;
    const renderSelectedLabels = () => { panel.querySelector('#chat-labels').innerHTML = (conversations.find(item => item.jid === selected)?.labels || []).map(chip).join(''); };

    const drawList = () => {
      const query = panel.querySelector('#inbox-search').value.toLocaleLowerCase('id-ID');
      const labelFilter = panel.querySelector('#label-filter').value;
      const items = conversations.filter(item => (filter !== 'unread' || item.unreadCount > 0) && (!labelFilter || (item.labels || []).some(label => label.id === labelFilter)) && `${item.name} ${item.jid} ${item.text}`.toLocaleLowerCase('id-ID').includes(query));
      panel.querySelector('#inbox-count').textContent = `${conversations.length} percakapan`;
      panel.querySelector('#unread-total').textContent = conversations.filter(item => item.unreadCount > 0).length;
      list.innerHTML = items.length ? items.map(item => {
        const name = item.name || item.jid.split('@')[0];
        return `<button class="conversation-row ${item.unreadCount ? 'unread' : 'read'} ${selected === item.jid ? 'selected' : ''}" aria-pressed="${selected === item.jid}" type="button" data-jid="${esc(item.jid)}"><span class="conversation-avatar">${esc(name.slice(0, 1).toUpperCase())}</span><span class="conversation-copy"><strong>${esc(name)}</strong><small>${esc(item.text || 'Belum ada pesan')}</small><span class="label-chips">${(item.labels || []).map(chip).join('')}</span></span><span class="conversation-meta"><time>${item.timestamp ? esc(new Date(item.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })) : ''}</time><span class="read-state">${item.unreadCount ? `${item.unreadCount} baru` : 'Dibaca'}</span></span></button>`;
      }).join('') : `<div class="inbox-empty"><strong>${filter === 'unread' ? 'Tidak ada chat belum dibaca' : 'Percakapan tidak ditemukan'}</strong><span>${query || labelFilter ? 'Coba ubah pencarian atau filter label.' : 'Pesan baru akan tampil di sini.'}</span></div>`;
      renderSelectedLabels();
    };

    const drawThread = async () => {
      if (!selected) return;
      const jid = selected;
      const items = await api(`messages?jid=${encodeURIComponent(jid)}`);
      if (jid !== selected || !panel.isConnected) return;
      const nearBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 90;
      const receipts = item => {
        if (!item.outgoing) return '';
        const state = item.status >= 4 ? ['Dibaca penerima', '✓✓', 'read'] : item.status >= 3 ? ['Tersampaikan', '✓✓', 'delivered'] : item.status >= 2 ? ['Terkirim', '✓', 'sent'] : ['Menunggu konfirmasi WhatsApp', '◷', 'pending'];
        return ` <span class="message-receipt ${state[2]}" title="${state[0]}" aria-label="${state[0]}">${state[1]}</span>`;
      };
      history.innerHTML = items.length ? items.map(item => `<div class="message-row ${item.outgoing ? 'outgoing' : 'incoming'}"><div class="message-bubble">${esc(item.text)}<small>${esc(new Date(item.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }))}${receipts(item)}</small></div></div>`).join('') : '<div class="chat-empty"><strong>Belum ada pesan</strong></div>';
      if (nearBottom) history.scrollTop = history.scrollHeight;
      const ids = items.filter(item => !item.outgoing && (!item.read_at || !item.receipt_sent_at)).map(item => item.id);
      if (document.visibilityState === 'visible' && document.hasFocus() && !dialog.open && panel.querySelector('.inbox-chat').getClientRects().length && (ids.length || conversations.find(item => item.jid === jid)?.unreadCount)) {
        if (reading) return;
        reading = api('conversations/read', post({ jid, ids }));
        let result;
        try { result = await reading; } finally { reading = null; }
        if (jid !== selected || !panel.isConnected) return;
        const conversation = conversations.find(item => item.jid === jid);
        if (conversation) conversation.unreadCount = 0;
        drawList();
        if (result.receiptPending) feedback.textContent = 'Chat ditandai dibaca. Laporan baca WhatsApp menunggu koneksi.';
      }
    };

    const renderAiMode = (settings, agent, config, whatsapp) => {
      aiConfiguration = { agent, config, whatsapp };
      aiToggle.checked = Boolean(settings.autoReply);
      if (!agent.enabled) aiStatus.textContent = 'Nonaktif. Balas pesan secara manual. Aktifkan Agent di menu AI Agent untuk memakai balasan otomatis.';
      else if (!config.hasApiKey) aiStatus.textContent = 'Nonaktif. Simpan koneksi API key 9Router di menu AI Agent terlebih dahulu.';
      else if (!agent.instructions?.trim()) aiStatus.textContent = 'Instruksi Agent belum tersimpan. Simpan instruksi di menu AI Agent sebelum mengaktifkan balasan.';
      else if (settings.autoReply && whatsapp.aiReplyFailure) aiStatus.textContent = `Balasan terakhir gagal: ${whatsapp.aiReplyFailure.message}`;
      else if (settings.autoReply && whatsapp.status !== 'connected') aiStatus.textContent = 'Mode AI aktif; balasan berjalan saat WhatsApp terhubung.';
      else if (settings.autoReply) aiStatus.textContent = 'AI aktif. Balasan memakai instruksi dan Knowledge PDF; batas jadwal/kuota mengikuti Pengaturan.';
      else aiStatus.textContent = 'AI nonaktif. Anda membalas pesan secara manual.';
    };

    const loadAiMode = async () => {
      try {
        const [settings, agent, config, whatsapp] = await Promise.all([api('settings'), api('agent'), api('ai/config'), api('status')]);
        renderAiMode(settings, agent, config, whatsapp);
        lastAiCheck = Date.now();
      } catch (error) {
        aiToggle.checked = false;
        aiStatus.textContent = `Status AI gagal dimuat: ${error.message}`;
      }
    };

    aiToggle.addEventListener('change', async () => {
      const activate = aiToggle.checked;
      aiToggle.disabled = true;
      try {
        if (activate) {
          const ready = aiConfiguration?.agent.enabled && aiConfiguration?.config.hasApiKey && aiConfiguration?.agent.instructions?.trim();
          if (!ready) {
            aiToggle.checked = false;
            await loadAiMode();
            feedback.textContent = 'Simpan instruksi AI Agent dan koneksi 9Router terlebih dahulu.';
            return;
          }
        }
        const settings = await api('settings', post({ autoReply: activate }));
        if (aiConfiguration) renderAiMode(settings, aiConfiguration.agent, aiConfiguration.config, aiConfiguration.whatsapp);
        feedback.textContent = activate ? 'Balasan AI otomatis aktif.' : 'Mode AI dimatikan. Balas pesan masuk secara manual.';
      } catch (error) {
        aiToggle.checked = !activate;
        feedback.textContent = error.message;
        await loadAiMode();
      } finally {
        aiToggle.disabled = false;
      }
    });

    list.addEventListener('click', async event => {
      const row = event.target.closest('[data-jid]');
      if (!row) return;
      selected = row.dataset.jid;
      const item = conversations.find(value => value.jid === selected);
      const name = item?.name || selected.split('@')[0];
      panel.querySelector('#chat-name').textContent = name;
      panel.querySelector('#chat-subtitle').textContent = selected.split('@')[0];
      panel.querySelector('#chat-avatar').textContent = name.slice(0, 1).toUpperCase();
      form.hidden = false;
      panel.querySelector('.chat-actions').hidden = false;
      history.innerHTML = '';
      drawList();
      try { await drawThread(); } catch (error) { feedback.textContent = error.message; }
    });
    panel.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
      filter = button.dataset.filter;
      panel.querySelectorAll('[data-filter]').forEach(tab => { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-pressed', String(tab === button)); });
      drawList();
    }));
    panel.querySelector('#label-filter').addEventListener('change', drawList);
    const loadLabels = async () => {
      labels = await api('labels');
      const select = panel.querySelector('#label-filter');
      const previous = select.value;
      select.innerHTML = '<option value="">Semua label</option>' + labels.map(label => `<option value="${esc(label.id)}">${esc(label.name)}</option>`).join('');
      if (labels.some(label => label.id === previous)) select.value = previous;
    };
    const drawLabelOptions = () => {
      const assigned = new Set((conversations.find(item => item.jid === labelTarget)?.labels || []).map(label => label.id));
      dialog.querySelector('#label-dialog-help').textContent = labelTarget ? 'Centang label untuk percakapan ini. Perubahan langsung disimpan.' : 'Buat, ubah nama, atau hapus label di dashboard ini.';
      dialog.querySelector('#label-options').innerHTML = labels.map(label => `<div class="label-option"><label>${labelTarget ? `<input type="checkbox" data-assign-label="${esc(label.id)}" ${assigned.has(label.id) ? 'checked' : ''}>` : ''}${chip(label)}</label><button type="button" class="label-edit" data-edit-label="${esc(label.id)}" aria-label="Ubah label ${esc(label.name)}">Ubah</button><button type="button" class="label-delete" data-delete-label="${esc(label.id)}" aria-label="Hapus label ${esc(label.name)}">Hapus</button></div>`).join('') || '<p>Belum ada label. Buat label pertama di bawah.</p>';
    };
    const openLabels = async target => {
      labelTarget = target;
      labelForm.reset(); labelForm.elements.id.value = ''; labelFeedback.textContent = '';
      try { await loadLabels(); drawLabelOptions(); dialog.showModal(); } catch (error) { feedback.textContent = error.message; }
    };
    panel.querySelector('[data-manage-labels]').addEventListener('click', () => openLabels(''));
    panel.querySelector('[data-chat-labels]').addEventListener('click', () => openLabels(selected));
    dialog.querySelector('[data-close-labels]').addEventListener('click', () => dialog.close());
    labelForm.addEventListener('reset', () => { labelForm.elements.id.value = ''; });
    labelForm.addEventListener('submit', async event => {
      event.preventDefault();
      const button = labelForm.querySelector('[type=submit]'); button.disabled = true;
      try {
        await api('labels', post(Object.fromEntries(new FormData(labelForm))));
        labelForm.reset();
        await loadLabels(); conversations = await api('conversations'); drawList(); drawLabelOptions();
        labelFeedback.textContent = 'Label tersimpan.';
      } catch (error) { labelFeedback.textContent = error.message; }
      finally { button.disabled = false; }
    });
    dialog.addEventListener('click', async event => {
      const edit = event.target.closest('[data-edit-label]');
      if (edit) {
        const label = labels.find(item => item.id === edit.dataset.editLabel);
        if (label) { for (const name of ['id', 'name', 'color']) labelForm.elements[name].value = label[name]; labelForm.elements.name.focus(); }
      }
      const remove = event.target.closest('[data-delete-label]');
      if (!remove || !confirm('Hapus label ini dari semua percakapan?')) return;
      remove.disabled = true;
      try { await api(`labels/${remove.dataset.deleteLabel}`, { method: 'DELETE' }); await loadLabels(); conversations = await api('conversations'); drawList(); drawLabelOptions(); labelFeedback.textContent = 'Label dihapus.'; }
      catch (error) { labelFeedback.textContent = error.message; remove.disabled = false; }
    });
    dialog.addEventListener('change', async event => {
      if (!event.target.matches('[data-assign-label]') || !labelTarget) return;
      const inputs = [...dialog.querySelectorAll('[data-assign-label]')];
      const labelIds = inputs.filter(input => input.checked).map(input => input.dataset.assignLabel);
      inputs.forEach(input => { input.disabled = true; });
      try { await api('conversations/labels', post({ jid: labelTarget, labelIds })); conversations = await api('conversations'); drawList(); labelFeedback.textContent = 'Label percakapan tersimpan.'; }
      catch (error) { labelFeedback.textContent = error.message; }
      finally { drawLabelOptions(); }
    });
    panel.querySelector('[data-mark-unread]').addEventListener('click', async event => {
      if (!selected) return;
      const jid = selected; event.target.disabled = true;
      selected = '';
      try {
        await reading?.catch(() => {});
        await api('conversations/unread', post({ jid }));
        selected = ''; form.hidden = true; panel.querySelector('.chat-actions').hidden = true;
        panel.classList.remove('show-thread');
        panel.querySelector('#chat-name').textContent = 'Pilih percakapan';
        panel.querySelector('#chat-subtitle').textContent = 'Chat ditandai belum dibaca untuk ditindaklanjuti.';
        panel.querySelector('#chat-avatar').textContent = '?';
        history.innerHTML = '<div class="chat-empty">Pilih percakapan untuk membaca pesan.</div>';
        conversations = await api('conversations'); drawList();
        feedback.textContent = 'Ditandai belum dibaca di dashboard. Laporan baca yang sudah dikirim ke WhatsApp tidak dibatalkan.';
      } catch (error) { selected = jid; feedback.textContent = error.message; }
      finally { event.target.disabled = false; }
    });
    panel.querySelector('#inbox-search').addEventListener('input', drawList);
    panel.querySelector('[data-inbox-refresh]').addEventListener('click', refresh);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('button');
      button.disabled = true;
      try {
        await api('send', post({ jid: selected, text: panel.querySelector('#chat-text').value }));
        panel.querySelector('#chat-text').value = '';
        feedback.textContent = 'Pesan diserahkan ke WhatsApp.';
        await drawThread();
      } catch (error) { feedback.textContent = error.message; }
      finally { button.disabled = false; }
    });

    async function refresh() {
      if (!panel.isConnected || refreshing) return;
      clearTimeout(timer); refreshing = true;
      try {
        conversations = await api('conversations');
        drawList();
        if (selected) await drawThread();
        if (Date.now() - lastAiCheck > 30000) await loadAiMode();
      } catch (error) { feedback.textContent = error.message; }
      finally { refreshing = false; if (panel.isConnected) timer = setTimeout(refresh, 5000); }
    }

    void loadLabels().catch(error => { feedback.textContent = error.message; });
    void loadAiMode();
    void refresh();
  }

  new MutationObserver(mount).observe(root, { childList: true });
  mount();
})();
