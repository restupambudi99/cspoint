const dayInJakarta = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(date);
const clockInJakarta = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function withinSchedule(settings, date) {
  if (!settings.scheduleEnabled) return true;
  const time = clockInJakarta.format(date);
  return time >= settings.scheduleStart && time < settings.scheduleEnd;
}
export function createAutoReply({ store, config, router, messages, buildMessages, onError = () => {}, onSuccess = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => new Date() }) {
  let chain = Promise.resolve(), lastSentAt = 0;
  const deliveryAttempts = new Map();
  const replyKeyFor = message => `${message.instance || 'default'}\u0000${message.id}`;
  const allowed = () => store.agent('default').enabled && store.settings().autoReply && config.publicConfig().hasApiKey;
  const reply = (message, connection) => {
    if (!allowed() || message.outgoing) return Promise.resolve();
    const job = chain.then(async () => {
      if (!connection.isCurrent() || !allowed()) return;
      const settings = store.settings(), agent = store.agent('default'), provider = config.publicConfig();
      // Outside operating hours or over the daily limit the message waits in the inbox for a person.
      if (!withinSchedule(settings, now())) return;
      const replyKey = replyKeyFor(message);
      if (!config.claimReply(message.id, dayInJakarta(now()), settings.dailyLimit, message.instance || 'default')) return;
      try {
        try { await connection.markRead?.(message); } catch {}
        const instance = message.instance || 'default';
        const history = messages.thread(message.jid, instance);
        // With history off the incoming message is not stored, so the AI still needs it added here.
        const thread = history.some(item => item.id === message.id) ? history : [...history, message];
        const memory = messages.memory(message.jid, instance);
        const asksShipping = /ongkir|ongkos(?:\s+kirim)?|tarif(?:\s+pengiriman)?|biaya(?:\s+kirim)?/i.test(message.text);
        const hasLatestDestination = /\b(?:ke\s+\S+|kecamatan\s+[\p{L}]+|kabupaten\s+[\p{L}]+|kota\s+[\p{L}]+|distrik\s+[\p{L}]+)/iu.test(message.text);
        const knowledgeQuery = hasLatestDestination
          ? message.text
          : [...memory.map(item => item.text), ...thread.filter(item => !item.outgoing).slice(-4).map(item => item.text)].join('\n');
        let knowledge = store.knowledge.relevant(knowledgeQuery || message.text);
        if (asksShipping && !hasLatestDestination) {
          const customerMessages = [...thread, ...memory].filter(item => !item.outgoing && typeof item.text === 'string').reverse();
          for (const customerMessage of customerMessages) {
            const candidate = store.knowledge.relevant(customerMessage.text);
            if (candidate.some(item => item.type === 'shipping_tariff')) { knowledge = candidate; break; }
          }
        }
        const prompt = buildMessages(agent, thread, store.products.list(), knowledge, memory);
        let modelText, error;
        for (let attempt = 0; attempt < 4; attempt++) {
          try { modelText = await router.complete(prompt); break; }
          catch (caught) {
            error = caught;
            if (caught?.status !== 502 || attempt === 3 || !connection.isCurrent() || !allowed()) break;
            await sleep(1000 * (attempt + 1));
          }
        }
        if (!modelText && (!connection.isCurrent() || !allowed())) { config.deferReply(message.id, instance); return; }
        let text = modelText;
        const usedFallback = !modelText && !asksShipping;
        if (asksShipping) {
          const tariffs = knowledge.filter(item => item.type === 'shipping_tariff');
          const best = tariffs[0];
          const normalize = value => String(value || '').toLocaleLowerCase('id-ID').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
          const ambiguous = best && tariffs.some(item => item.matchScore === best.matchScore && normalize(item.destination) !== normalize(best.destination));
          text = best && !ambiguous
            ? `Ongkir ke ${best.destination} adalah ${best.amount} sesuai daftar tarif ya, Kak. Saya lanjutkan dengan detail pesanan yang sudah Kakak kirim.`
            : 'Saya belum menemukan satu tarif kecamatan yang cocok persis di daftar, jadi saya tidak akan menebak. Boleh kirim nama kecamatan serta kabupaten/kotanya agar ongkirnya bisa dipastikan?';
        }
        text ||= 'Baik kak, saya bantu lanjutkan pesanan sesuai instruksi dan data yang tersedia. Saya tidak akan mengarang harga atau ongkir; kirim detail yang masih kurang di percakapan ini ya.';
        // The interval limits closely spaced sends; it must not add a fixed delay to the first reply.
        if (lastSentAt) {
          const seconds = settings.minInterval + Math.random() * (settings.maxInterval - settings.minInterval);
          const remaining = lastSentAt + seconds * 1000 - now().getTime();
          if (remaining > 0) await sleep(remaining);
        }
        if (!connection.isCurrent() || !allowed() || store.agent('default').updatedAt !== agent.updatedAt || config.publicConfig().updatedAt !== provider.updatedAt) { config.deferReply(message.id, instance); return; }
        const result = await connection.send(message.jid, { text });
        lastSentAt = now().getTime();
        if (store.settings().saveHistory) messages.add({ id: result.key.id, jid: message.jid, name: agent.assistantName, text, outgoing: true, status: result.status, timestamp: now().getTime(), instance: message.instance });
        config.finishReply(message.id, instance);
        deliveryAttempts.delete(replyKey);
        if (usedFallback) onError(Object.assign(new Error('AI tidak tersedia; pesan bantuan otomatis sudah dikirim.'), { status: error?.status || 502, fallbackSent: true }));
        else onSuccess();
      } catch (error) {
        config.deferReply(message.id, message.instance || 'default');
        if (connection.isCurrent() && allowed() && (!Number.isInteger(error?.status) || error.status >= 500 || [408, 429].includes(error.status))) {
          const replyKey = replyKeyFor(message);
          const attempt = Math.min((deliveryAttempts.get(replyKey) || 0) + 1, 6);
          deliveryAttempts.set(replyKey, attempt);
          const timer = setTimeout(() => { void reply(message, connection); }, Math.min(60000, 1000 * 2 ** attempt));
          timer.unref?.();
        }
        onError(error);
      }
    }).catch(error => onError(error));
    chain = job;
    return job;
  };
  return reply;
}
