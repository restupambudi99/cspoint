const dayInJakarta = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(date);
export function createAutoReply({ store, config, router, messages, buildMessages, onError = () => {}, onSuccess = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => new Date() }) {
  let chain = Promise.resolve(), lastSentAt = 0;
  const deliveryAttempts = new Map();
  const allowed = () => store.agent('default').enabled && store.settings().autoReply && config.publicConfig().hasApiKey;
  return (message, connection) => {
    if (!allowed() || message.outgoing) return Promise.resolve();
    const job = chain.then(async () => {
      if (!connection.isCurrent() || !allowed()) return;
      const settings = store.settings(), agent = store.agent('default'), provider = config.publicConfig();
      if (!config.claimReply(message.id, dayInJakarta(now()), 0)) return;
      try {
        try { await connection.markRead?.(message); } catch {}
        const thread = messages.thread(message.jid);
        const knowledgeQuery = thread.filter(item => !item.outgoing).slice(-4).map(item => item.text).join('\n');
        const knowledge = store.knowledge.relevant(knowledgeQuery || message.text);
        const prompt = buildMessages(agent, thread, store.products.list(), knowledge);
        let text, error;
        for (let attempt = 0; attempt < 4; attempt++) {
          try { text = await router.complete(prompt); break; }
          catch (caught) {
            error = caught;
            if (caught?.status !== 502 || attempt === 3 || !connection.isCurrent() || !allowed()) break;
            await sleep(1000 * (attempt + 1));
          }
        }
        if (!text && (!connection.isCurrent() || !allowed())) { config.deferReply(message.id); return; }
        const usedFallback = !text;
        text ||= 'Baik kak, saya bantu cek dan lanjutkan pesanan ya. Saya perlu memastikan harga produk dan ongkirnya dulu agar totalnya tepat, jadi tidak akan menebak. Detail yang sudah dikirim tetap saya jadikan acuan; jika belum menyebut nama, alamat lengkap, atau jumlah, boleh kirimkan di sini.';
        // The interval limits closely spaced sends; it must not add a fixed delay to the first reply.
        if (lastSentAt) {
          const seconds = settings.minInterval + Math.random() * (settings.maxInterval - settings.minInterval);
          const remaining = lastSentAt + seconds * 1000 - now().getTime();
          if (remaining > 0) await sleep(remaining);
        }
        if (!connection.isCurrent() || !allowed() || store.agent('default').updatedAt !== agent.updatedAt || config.publicConfig().updatedAt !== provider.updatedAt) { config.deferReply(message.id); return; }
        const result = await connection.send(message.jid, { text });
        lastSentAt = now().getTime();
        messages.add({ id: result.key.id, jid: message.jid, name: agent.assistantName, text, outgoing: true, status: result.status, timestamp: now().getTime() });
        config.finishReply(message.id);
        deliveryAttempts.delete(message.id);
        if (usedFallback) onError(Object.assign(new Error('AI tidak tersedia; pesan bantuan otomatis sudah dikirim.'), { status: error?.status || 502, fallbackSent: true }));
        else onSuccess();
      } catch (error) {
        config.deferReply(message.id);
        if (connection.isCurrent() && allowed() && (!Number.isInteger(error?.status) || error.status >= 500 || [408, 429].includes(error.status))) {
          const attempt = Math.min((deliveryAttempts.get(message.id) || 0) + 1, 6);
          deliveryAttempts.set(message.id, attempt);
          const timer = setTimeout(() => { void autoReply(message, connection); }, Math.min(60000, 1000 * 2 ** attempt));
          timer.unref?.();
        }
        onError(error);
      }
    }).catch(error => onError(error));
    chain = job;
    return job;
  };
}
