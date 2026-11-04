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
        <div class="inbox-tabs"><button class="inbox-tab active" type="button">Semua</button><button class="inbox-tab" type="button">Belum dibaca</button></div>
        <div class="inbox-ai-control"><div class="inbox-ai-copy"><strong>Balasan AI Agent</strong><span id="inbox-ai-status" role="status" aria-live="polite">Memeriksa konfigurasi…</span></div><label class="inbox-ai-switch"><span class="sr-only">Aktifkan balasan AI otomatis</span><input id="inbox-ai-toggle" type="checkbox" aria-describedby="inbox-ai-status"><span class="track"></span></label></div>
        <label class="inbox-search"><span>⌕</span><input id="inbox-search" type="search" placeholder="Cari percakapan…" aria-label="Cari percakapan"></label>
        <div id="inbox-list" class="inbox-list"><div class="inbox-loading">Memuat percakapan…</div></div>
      </aside>
      <section class="inbox-chat">
        <header class="chat-header"><div class="chat-avatar" id="chat-avatar">?</div><div><h2 id="chat-name">Pilih percakapan</h2><span id="chat-subtitle">Pilih pesan di sebelah kiri untuk mulai membalas</span></div><button class="icon-button" type="button" aria-label="Menu percakapan">⋮</button></header>
        <div id="chat-messages" class="chat-messages"><div class="chat-empty"><div class="chat-empty-icon">⌁</div><strong>Belum ada percakapan dipilih</strong><span>Pesan WhatsApp masuk akan tampil di sini.</span></div></div>
        <form id="chat-compose" class="chat-compose" hidden><textarea id="chat-text" rows="1" maxlength="4000" placeholder="Tulis pesan…" required></textarea><button class="send-button" type="submit" aria-label="Kirim pesan">➤</button></form>
        <p id="inbox-feedback" class="inbox-feedback" role="status" aria-live="polite"></p>
      </section>
    </section>`;

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

    const drawList = () => {
      const query = panel.querySelector('#inbox-search').value.toLocaleLowerCase('id-ID');
      const items = conversations.filter(item => `${item.name} ${item.jid} ${item.text}`.toLocaleLowerCase('id-ID').includes(query));
      panel.querySelector('#inbox-count').textContent = `${conversations.length} percakapan`;
      list.innerHTML = items.length ? items.map(item => {
        const name = item.name || item.jid.split('@')[0];
        return `<button class="conversation-row ${selected === item.jid ? 'selected' : ''}" type="button" data-jid="${esc(item.jid)}"><span class="conversation-avatar">${esc(name.slice(0, 1).toUpperCase())}</span><span class="conversation-copy"><strong>${esc(name)}</strong><small>${esc(item.text || 'Belum ada pesan')}</small></span><time>${item.timestamp ? esc(new Date(item.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })) : ''}</time></button>`;
      }).join('') : `<div class="inbox-empty"><span class="empty-icon">⌁</span><strong>${query ? 'Percakapan tidak ditemukan' : 'Belum ada percakapan'}</strong><span>${query ? 'Coba kata kunci lain.' : 'Pesan WhatsApp masuk akan muncul di sini.'}</span></div>`;
    };

    const drawThread = async () => {
      if (!selected) return;
      const jid = selected;
      const items = await api(`messages?jid=${encodeURIComponent(jid)}`);
      if (jid !== selected) return;
      history.innerHTML = items.length ? items.map(item => `<div class="message-row ${item.outgoing ? 'outgoing' : 'incoming'}"><div class="message-bubble">${esc(item.text)}<small>${esc(new Date(item.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }))}</small></div></div>`).join('') : '<div class="chat-empty"><strong>Belum ada pesan</strong></div>';
      history.scrollTop = history.scrollHeight;
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
      drawList();
      try { await drawThread(); } catch (error) { feedback.textContent = error.message; }
    });
    panel.querySelector('#inbox-search').addEventListener('input', drawList);
    panel.querySelector('[data-inbox-refresh]').addEventListener('click', refresh);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('button');
      button.disabled = true;
      try {
        await api('send', post({ phone: selected.split('@')[0], text: panel.querySelector('#chat-text').value }));
        panel.querySelector('#chat-text').value = '';
        feedback.textContent = 'Pesan diserahkan ke WhatsApp.';
        await drawThread();
      } catch (error) { feedback.textContent = error.message; }
      finally { button.disabled = false; }
    });

    async function refresh() {
      if (!panel.isConnected) return;
      try {
        conversations = await api('conversations');
        drawList();
        if (selected) await drawThread();
        if (Date.now() - lastAiCheck > 30000) await loadAiMode();
      } catch (error) { feedback.textContent = error.message; }
      timer = setTimeout(refresh, 5000);
    }

    void loadAiMode();
    void refresh();
  }

  new MutationObserver(mount).observe(root, { childList: true });
  mount();
})();
