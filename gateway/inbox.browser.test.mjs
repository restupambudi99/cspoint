import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openMessages } from './messages.mjs';
import { createServer } from 'node:net';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const folder = await mkdtemp(join(tmpdir(), 'cspoint-browser-'));
const project = fileURLToPath(new URL('../', import.meta.url));
const token = 'test-only-inbox-token-0000000000000000';
const dbPath = join(folder, 'messages.sqlite');
const reservation = createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
const store = openMessages(dbPath);
store.add({ id: 'alice-in', jid: '123@lid', name: 'Alya', text: 'Berapa ongkir ke Bubon?', outgoing: false, timestamp: Date.now() - 20000 });
store.add({ id: 'bob-in', jid: '456@lid', name: 'Bima', text: 'Terima kasih', outgoing: false, timestamp: Date.now() - 15000 });
store.markRead('456@lid', ['bob-in'], true);
store.add({ id: 'bob-out', jid: '456@lid', name: 'CS Irawati', text: 'Sama-sama kak.', outgoing: true, status: 4, timestamp: Date.now() - 10000 });
store.close();
const child = spawn(process.execPath, ['server.mjs'], { cwd: fileURLToPath(new URL('.', import.meta.url)), env: { ...process.env, GATEWAY_TOKEN: token, DASHBOARD_DIR: project, MESSAGE_DB: dbPath, SESSION_DIR: join(folder, 'session'), PORT: String(port) }, stdio: 'pipe' });
let browser, errors = '';
child.stderr.on('data', chunk => { errors += chunk; });
try {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(errors);
    try { await fetch(`${baseUrl}/status`); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ extraHTTPHeaders: { Authorization: `Bearer ${token}` }, viewport: { width: 1365, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/#inbox`);
  await page.locator('[data-jid]').first().waitFor();
  assert.equal(await page.locator('[data-jid]').count(), 2);
  assert.ok((await page.locator('[data-jid="456@lid"]').innerText()).includes('Bima'));
  await page.locator('[data-filter=unread]').click();
  assert.equal(await page.locator('[data-jid]').count(), 1);
  await page.locator('[data-jid="123@lid"]').click();
  await page.waitForFunction(() => document.querySelector('#unread-total').textContent === '0');
  await page.locator('[data-chat-labels]').click();
  await page.locator('#label-form [name=name]').fill('Perlu follow up');
  await page.locator('#label-form [name=color]').selectOption('rose');
  await page.locator('#label-form [type=submit]').click();
  await page.locator('.label-option').filter({ hasText: 'Perlu follow up' }).locator('input').check();
  await page.waitForFunction(() => document.querySelector('#chat-labels').textContent.includes('Perlu follow up'));
  await page.locator('.label-option').filter({ hasText: 'Perlu follow up' }).getByRole('button', { name: 'Ubah label', exact: false }).click();
  await page.locator('#label-form [name=name]').fill('Follow up besok');
  await page.locator('#label-form [type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#chat-labels').textContent.includes('Follow up besok'));
  await page.locator('[data-close-labels]').click();
  await page.locator('[data-mark-unread]').click();
  await page.waitForFunction(() => document.querySelector('#unread-total').textContent === '1');
  await page.reload();
  await page.locator('[data-jid]').first().waitFor();
  assert.ok((await page.locator('[data-jid="123@lid"]').innerText()).includes('Follow up besok'));
  await page.locator('#label-filter').selectOption({ label: 'Follow up besok' });
  assert.equal(await page.locator('[data-jid]').count(), 1);
  await page.locator('#label-filter').selectOption('');
  await page.locator('[data-jid="456@lid"]').click();
  await page.locator('.message-receipt.read').waitFor();
  await mkdir(join(project, 'tmp'), { recursive: true });
  await page.screenshot({ path: join(project, 'tmp/inbox-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-back-to-inbox]').click();
  await page.locator('[data-jid="123@lid"]').click();
  await page.locator('[data-chat-labels]').click();
  await page.locator('#inbox-label-dialog').waitFor({ state: 'visible' });
  await page.screenshot({ path: join(project, 'tmp/inbox-mobile-labels.png') });
  assert.ok(await page.locator('#inbox-label-dialog').isVisible());
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile page must not overflow horizontally');
  await page.locator('.label-option').filter({ hasText: 'Follow up besok' }).locator('input').uncheck();
  await page.waitForFunction(() => !document.querySelector('#chat-labels').textContent.includes('Follow up besok'));
  page.once('dialog', dialog => dialog.accept());
  await page.locator('.label-option').filter({ hasText: 'Follow up besok' }).getByRole('button', { name: 'Hapus label', exact: false }).click();
  await page.waitForFunction(() => !document.querySelector('#label-options').textContent.includes('Follow up besok'));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#inbox-label-dialog').isVisible(), false);
  assert.deepEqual(pageErrors, []);
  console.log('PASS: desktop/mobile inbox, unread filters, persisted labels CRUD/assignment, blue receipt rendering, keyboard dialog and mobile overflow');
} catch (error) {
  console.error(errors);
  throw error;
} finally {
  await browser?.close();
  if (child.exitCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; }
  await rm(folder, { recursive: true, force: true });
}
