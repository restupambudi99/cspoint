export async function readConversation(messages, socket, jid, ids, instanceId = 'default') {
  const keys = messages.readKeys(jid, ids, instanceId);
  messages.markRead(jid, ids, false, instanceId);
  if (!keys.length) return { read: true, receiptPending: false };
  if (!socket) return { read: true, receiptPending: true };
  let timeout;
  try {
    await Promise.race([
      socket.readMessages(keys),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Read receipt timeout')), 5000); }),
    ]);
    messages.markRead(jid, ids, true, instanceId);
    return { read: true, receiptPending: false };
  } catch { return { read: true, receiptPending: true }; }
  finally { clearTimeout(timeout); }
}
