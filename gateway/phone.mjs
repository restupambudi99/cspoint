// Same rule as normalizePhone in dashboard/app.js. Returns '' for anything that is not an Indonesian mobile number.
export function normalizeWaPhone(value) {
  const digits = String(value ?? '').replace(/\D/g, '').replace(/^0/, '62').replace(/^8/, '628');
  return /^628\d{7,11}$/.test(digits) ? digits : '';
}

// Returns the JID WhatsApp reports for the number, or null when it is not registered.
export async function resolveWaJid(socket, phone) {
  const [found] = await socket.onWhatsApp(phone);
  return found?.exists ? found.jid : null;
}
