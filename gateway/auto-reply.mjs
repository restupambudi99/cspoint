const dayInJakarta = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(date);
export function createAutoReply({ store, config, router, messages, buildMessages, onError = () => {}, onSuccess = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => new Date() }) {
  let chain = Promise.resolve(), lastSentAt = 0;
  const allowed = () => store.agent('default').enabled && store.settings().autoReply && config.publicConfig().hasApiKey;
  return (message, connection) => {
    if (!allowed() || message.outgoing) return Promise.resolve();
    const job = chain.then(async () => {
      if (!connection.isCurrent() || !allowed()) return;
      const settings = store.settings(), agent = store.agent('default'), provider = config.publicConfig();
      if (!config.claimReply(message.id, dayInJakarta(now()), 0)) return;
      try {
        try { await connection.markRead?.(message); } catch {}
        const knowledge = store.knowledge.relevant(message.text);
        const prompt = buildMessages(agent, messages.thread(message.jid), store.products.list(), knowledge);
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
        text ||= 'Baik kak, pesan dan detail yang kakak kirim sudah saya terima. Saya bantu pastikan harga produk dan ongkirnya agar totalnya tepat. Jika ada data yang belum tercantum, boleh kirim nama produk/varian, jumlah, serta alamat lengkapnya ya.';
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
        if (usedFallback) onError(Object.assign(new Error('AI tidak tersedia; pesan bantuan otomatis sudah dikirim.'), { status: error?.status || 502, fallbackSent: true }));
        else onSuccess();
      } catch (error) {
        config.deferReply(message.id);
        onError(error);
      }
    }).catch(error => onError(error));
    chain = job;
    return job;
  };
}
