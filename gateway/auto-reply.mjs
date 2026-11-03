const dayInJakarta = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(date);
const inSchedule = (settings, date) => {
  if (!settings.scheduleEnabled) return true;
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  const start = settings.scheduleStart, end = settings.scheduleEnd;
  return start === end || (start < end ? time >= start && time < end : time >= start || time < end);
};

export function createAutoReply({ store, config, router, messages, buildMessages, onError = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => new Date() }) {
  let chain = Promise.resolve(), pending = 0;
  const allowed = () => store.agent('default').enabled && store.settings().autoReply && config.publicConfig().hasApiKey && inSchedule(store.settings(), now());
  return (message, connection) => {
    if (!allowed() || pending >= 20 || message.outgoing) return Promise.resolve();
    pending++;
    const job = chain.then(async () => {
      if (!connection.isCurrent() || !allowed()) return;
      const settings = store.settings(), agent = store.agent('default'), provider = config.publicConfig();
      if (!config.claimReply(message.id, dayInJakarta(now()), settings.dailyLimit)) return;
      const text = await router.complete(buildMessages(agent, messages.thread(message.jid), store.products.list()));
      const seconds = settings.minInterval + Math.random() * (settings.maxInterval - settings.minInterval);
      await sleep(seconds * 1000);
      // A setting change or reconnect while inference ran must cancel the stale send.
      if (!connection.isCurrent() || !allowed() || store.agent('default').updatedAt !== agent.updatedAt || config.publicConfig().updatedAt !== provider.updatedAt) return;
      const result = await connection.send(message.jid, { text });
      messages.add({ id: result.key.id, jid: message.jid, name: agent.assistantName, text, outgoing: true, timestamp: now().getTime() });
    }).catch(onError).finally(() => { pending--; });
    chain = job;
    return job;
  };
}
