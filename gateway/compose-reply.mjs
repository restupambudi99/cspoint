import { allowedAmounts, checkReply, customerFacts, customerWords, fallbackReply, finalizeReply, orderState } from './reply-rules.mjs';

async function complete(router, prompt, { attempts, sleep, active }) {
  let error;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return { text: await router.complete(prompt) }; }
    catch (caught) {
      error = caught;
      if (caught?.status !== 502 || attempt === attempts - 1 || !active()) break;
      await sleep(1000 * (attempt + 1));
    }
  }
  return { error };
}

// One thread in, one checked reply out. Used by WhatsApp auto replies and by "Uji Balasan AI".
export async function composeReply({ store, router, buildMessages, agent, thread, memory = [], lead = null, attempts = 4, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), active = () => true }) {
  const customer = thread.filter(item => !item.outgoing && typeof item?.text === 'string' && item.text.trim());
  const shipping = store.knowledge.shipping(thread);
  const references = store.knowledge.relevant(customer.slice(-4).map(item => item.text).join('\n'));
  const products = store.products.list();
  const context = { shipping, facts: customerFacts(customer), order: orderState(thread), lead };
  const rules = {
    amounts: allowedAmounts({ instructions: agent.instructions, products, references, shipping, customerTexts: customer.map(item => item.text) }),
    shipping,
    latestCustomerText: customer.at(-1)?.text || '',
    knownWords: customerWords(customer, shipping),
  };
  const first = await complete(router, buildMessages(agent, thread, products, references, memory, context), { attempts, sleep, active });
  if (!first.text) return { text: null, error: first.error, context, guarded: false, problems: [] };
  let text = first.text;
  let problems = checkReply(text, rules);
  if (problems.length && active()) {
    const second = await complete(router, buildMessages(agent, thread, products, references, memory, { ...context, corrections: problems }), { attempts: Math.min(attempts, 2), sleep, active });
    if (second.text) { text = second.text; problems = checkReply(text, rules); }
  }
  const guarded = problems.length > 0;
  return { text: finalizeReply(guarded ? fallbackReply(context) : text, context), context, guarded, problems };
}
