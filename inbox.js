(() => {
  const logout = document.querySelector('#logout');
  if (logout) {
    const button = logout.cloneNode(true); logout.replaceWith(button);
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const response = await fetch('/api/whatsapp/logout', { method: 'POST' });
        if (!response.ok) throw new Error();
        location.replace('/login');
      } catch { button.disabled = false; alert('Logout gagal. Coba kembali.'); }
    });
  }
  const root = document.querySelector('#page-content');
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  async function api(route, body) {
    const response = await fetch(`/api/whatsapp/${route}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }
  let timer;
  function mount() {
    if (location.hash !== '#inbox' || root.querySelector('#live-inbox')) return;
    clearTimeout(timer);
    root.innerHTML = '<section id="live-inbox" class="inbox-layout"><div class="conversation-list"><h2>Kotak Masuk</h2><label>Cari percakapan<input type="search" id="inbox-search"></label><div id="inbox-list"></div></div><div class="section"><h2 id="chat-name">Pilih percakapan</h2><p id="inbox-feedback" role="status"></p><div id="chat-messages" aria-live="polite"></div><form id="chat-compose" hidden><label>Pesan<textarea id="chat-text" maxlength="4000" required></textarea></label><button class="button" type="submit">Kirim pesan</button></form></div></section>';
    const panel = root.querySelector('#live-inbox');
    const list = panel.querySelector('#inbox-list'), history = panel.querySelector('#chat-messages');
    const feedback = panel.querySelector('#inbox-feedback'), form = panel.querySelector('form');
    let selected = '', conversations = [];
    const drawList = () => {
      const query = panel.querySelector('#inbox-search').value.toLowerCase();
      list.innerHTML = '';
      for (const item of conversations.filter(item => `${item.name} ${item.jid} ${item.text}`.toLowerCase().includes(query))) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'button secondary';
        button.textContent = `${item.name || item.jid.split('@')[0]}: ${item.text.slice(0, 80)}`;
        button.addEventListener('click', async () => { selected = item.jid; panel.querySelector('#chat-name').textContent = item.name || item.jid.split('@')[0]; form.hidden = false; try { await drawThread(); } catch (error) { feedback.textContent = error.message; } });
        list.append(button);
      }
      if (!conversations.length) list.textContent = 'Belum ada pesan. Hubungkan WhatsApp lalu kirim pesan ke nomor tertaut.';
    };
    const drawThread = async () => {
      const jid = selected, items = await api(`messages?jid=${encodeURIComponent(jid)}`);
      if (selected !== jid) return;
      history.innerHTML = items.map(item => `<p><strong>${item.outgoing ? 'Anda' : escape(item.name || 'Kontak')}</strong><br>${escape(item.text)}<br><small>${escape(new Date(item.timestamp).toLocaleString('id-ID'))}</small></p>`).join('');
    };
    panel.querySelector('#inbox-search').addEventListener('input', drawList);
    form.addEventListener('submit', async event => {
      event.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
      try { await api('send', { phone: selected.split('@')[0], text: panel.querySelector('#chat-text').value }); panel.querySelector('#chat-text').value = ''; feedback.textContent = 'Pesan diserahkan ke WhatsApp.'; await drawThread(); }
      catch (error) { feedback.textContent = error.message; }
      finally { button.disabled = false; }
    });
    const refresh = async () => {
      if (!panel.isConnected) return;
      try { conversations = await api('conversations'); drawList(); if (selected) await drawThread(); }
      catch (error) { feedback.textContent = error.message; }
      timer = setTimeout(refresh, 5000);
    };
    refresh();
  }
  new MutationObserver(mount).observe(root, { childList: true }); mount();
})();
