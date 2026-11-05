import { composeReply } from './compose-reply.mjs';
import { fallbackReply, finalizeReply } from './reply-rules.mjs';

const dayInJakarta = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(date);
const clockInJakarta = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function withinSchedule(settings, date) {
  if (!settings.scheduleEnabled) return true;
  const time = clockInJakarta.format(date);
  return time >= settings.scheduleStart && time < settings.scheduleEnd;
}
export function createAutoReply({ store, config, router, messages, buildMessages, onError = () => {}, onSuccess = () => {}, onGuard = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => new Date() }) {
  let chain = Promise.resolve(), lastSentAt = 0;
  const deliveryAttempts = new Map();
  const keyOf = message => (message.instance || 'default') + '\u0000' + message.id;
  const allowed = () => store.agent('default').enabled && store.settings().autoReply && config.publicConfig().hasApiKey;
  const reply = (message, connection) => {
    if (!allowed() || message.outgoing) return Promise.resolve();
    const instance = message.instance || 'default';
    const job = chain.then(async () => {
      if (!connection.isCurrent() || !allowed()) return;
      const settings = store.settings(), agent = store.agent('default'), provider = config.publicConfig();
      // Only the Waktu Operasional switch pauses AI replies; inbox replies have no daily cap.
      if (!withinSchedule(settings, now())) return;
      if (!config.claimReply(message.id, dayInJakarta(now()), 0, instance)) return;
      try {
        try { await connection.markRead?.(message); } catch {}
        const history = messages.thread(message.jid, instance);
        // With history off the incoming message is not stored, so the AI still needs it added here.
        const thread = history.some(item => item.id === message.id) ? history : [...history, message];
        const composed = await composeReply({
          store, router, buildMessages, agent, thread, sleep,
          memory: messages.memory(message.jid, instance),
          lead: messages.leadSource(message.jid, instance),
          active: () => connection.isCurrent() && allowed(),
        });
        if (!composed.text && (!connection.isCurrent() || !allowed())) { config.deferReply(message.id, instance); return; }
        const text = composed.text || finalizeReply(fallbackReply(composed.context), composed.context);
        if (composed.guarded) onGuard(composed.problems.length);
        // The interval limits closely spaced sends; it must not add a fixed delay to the first reply.
        if (lastSentAt) {
          const seconds = settings.minInterval + Math.random() * (settings.maxInterval - settings.minInterval);
          const remaining = lastSentAt + seconds * 1000 - now().getTime();
          if (remaining > 0) await sleep(remaining);
        }
        if (!connection.isCurrent() || !allowed() || store.agent('default').updatedAt !== agent.updatedAt || config.publicConfig().updatedAt !== provider.updatedAt) { config.deferReply(message.id, instance); return; }
        const result = await connection.send(message.jid, { text });
        lastSentAt = now().getTime();
        if (store.settings().saveHistory) messages.add({ id: result.key.id, jid: message.jid, name: agent.assistantName, text, outgoing: true, status: result.status, timestamp: now().getTime(), instance });
        config.finishReply(message.id, instance);
        deliveryAttempts.delete(keyOf(message));
        if (!composed.text) onError(Object.assign(new Error('AI tidak tersedia; pesan bantuan otomatis sudah dikirim.'), { status: composed.error?.status || 502, fallbackSent: true }));
        else onSuccess();
      } catch (error) {
        config.deferReply(message.id, instance);
        if (connection.isCurrent() && allowed() && (!Number.isInteger(error?.status) || error.status >= 500 || [408, 429].includes(error.status))) {
          const attempt = Math.min((deliveryAttempts.get(keyOf(message)) || 0) + 1, 6);
          deliveryAttempts.set(keyOf(message), attempt);
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
