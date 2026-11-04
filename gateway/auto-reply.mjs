const dayInJakarta = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(date);
const inSchedule = (settings, date) => {
  if (!settings.scheduleEnabled) return true;
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  const start = settings.scheduleStart, end = settings.scheduleEnd;
  return start === end || (start < end ? time >= start && time < end : time >= start || time < end);
};

export function createAutoReply({ store, config, router, messages, buildMessages, onError = () => {}, onSuccess = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => new Date() }) {
  let chain = Promise.resolve(), pending = 0, lastSentAt = 0;
  const allowed = () => store.agent('default').enabled && store.settings().autoReply && config.publicConfig().hasApiKey && inSchedule(store.settings(), now());
  return (message, connection) => {
    if (!allowed() || pending >= 20 || message.outgoing) return Promise.resolve();
    pending++;
    const job = chain.then(async () => {
      if (!connection.isCurrent() || !allowed()) return;
      const settings = store.settings(), agent = store.agent('default'), provider = config.publicConfig();
      if (!config.claimReply(message.id, dayInJakarta(now()), settings.dailyLimit)) return;
      const knowledge = store.knowledge.relevant(message.text);
      const prompt = buildMessages(agent, messages.thread(message.jid), store.products.list(), knowledge);
      let text;
      try {
        text = await router.complete(prompt);
      } catch (error) {
        // A temporary 9Router failure must not permanently consume this reply.
        if (error?.status !== 502 || !connection.isCurrent() || !allowed()) throw error;
        await sleep(1000);
        if (!connection.isCurrent() || !allowed()) return;
        text = await router.complete(prompt);
      }
      // The interval limits closely spaced sends; it must not add a fixed
      // delay to the first reply or when AI inference already took longer.
      if (lastSentAt) {
        const seconds = settings.minInterval + Math.random() * (settings.maxInterval - settings.minInterval);
        const remaining = lastSentAt + seconds * 1000 - now().getTime();
        if (remaining > 0) await sleep(remaining);
      }
      // A setting change or reconnect while inference ran must cancel the stale send.
      if (!connection.isCurrent() || !allowed() || store.agent('default').updatedAt !== agent.updatedAt || config.publicConfig().updatedAt !== provider.updatedAt) return;
      const result = await connection.send(message.jid, { text });
      lastSentAt = now().getTime();
      messages.add({ id: result.key.id, jid: message.jid, name: agent.assistantName, text, outgoing: true, timestamp: now().getTime() });
      onSuccess();
    }).catch(error => onError(error)).finally(() => { pending--; });
    chain = job;
    return job;
  };
}
