// Optional browser QA for deferred questions, portable progress and mobile layout.
// Uses an existing Playwright/browser installation. No external services are written.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createPreviewServer } from './serve.mjs';
import { fingerprintBank } from '../dist/core.mjs';
import { editionBank, EDITIONS } from '../dist/editions.mjs';

const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
if (!args.includes('--playwright') || !args.includes('--browser')) throw new Error('Provide --playwright <index.mjs> --browser <executable>');
const { chromium } = await import(pathToFileURL(path.resolve(value('--playwright'))).href);
const outputs = fileURLToPath(new URL('../outputs/', import.meta.url));
await mkdir(outputs, { recursive: true });
const server = args.includes('--url') ? null : createPreviewServer();
if (server) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = server ? `http://127.0.0.1:${server.address().port}/` : value('--url');
const bank = JSON.parse(await readFile(new URL('../dist/questions.json', import.meta.url), 'utf8'));
const concise = editionBank(bank, 'concise');
const conciseId = await fingerprintBank(concise);
const key = EDITIONS.concise.storageKey;
const fullKey = EDITIONS.full.storageKey;
const ready = page => page.waitForFunction(() => !document.getElementById('draw-button').disabled);
const saved = (page, storageKey = key) => page.evaluate(key => localStorage.getItem(key), storageKey);
const state = async page => JSON.parse(await saved(page));
const errors = [];
let browser;
async function context(options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', acceptDownloads: true, ...options });
  ctx.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  return ctx;
}
async function draw(page) {
  await page.locator('#draw-button').click();
  await page.waitForFunction(() => document.getElementById('draw-button').dataset.action === 'confirm' && !document.getElementById('draw-button').disabled);
}
async function confirm(page) {
  await page.locator('#draw-button').click();
  await page.waitForFunction(() => document.getElementById('draw-button').dataset.action !== 'confirm');
}
async function select(page, edition) {
  await page.locator(`#edition-${edition}`).click();
  await page.waitForFunction(key => document.getElementById(`edition-${key}`).getAttribute('aria-pressed') === 'true' && !document.getElementById(`edition-${key}`).disabled, edition);
}
async function choose(page, file) {
  await page.locator('#backup-file').setInputFiles(file);
  await page.locator('#import-dialog').waitFor({ state: 'visible' });
}

try {
  browser = await chromium.launch({ executablePath: value('--browser'), headless: true, args: ['--disable-gpu', '--no-first-run'] });
  const ctx = await context();
  const page = await ctx.newPage();
  const response = await page.goto(base, { waitUntil: 'networkidle', timeout: 45000 });
  assert.equal(response.status(), 200);
  assert.deepEqual(await ctx.cookies(), []);
  await ready(page);
  const remoteBank = await ctx.request.get(new URL('questions.json', base).href);
  assert.equal(await fingerprintBank(await remoteBank.json()), await fingerprintBank(bank));
  // First draw action is fully visible on normal and small phone viewports.
  for (const viewport of [{ width: 390, height: 844 }, { width: 375, height: 667 }, { width: 320, height: 640 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => scrollTo(0, 0));
    const box = await page.locator('#draw-button').boundingBox();
    if (box.y + box.height > viewport.height) await page.screenshot({ path: path.join(outputs, 'comfort-small-layout-check.png'), fullPage: true, animations: 'disabled' });
    assert.ok(box.y >= 0 && box.y + box.height <= viewport.height, `Draw button below first fold: ${JSON.stringify({ viewport, box })}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(outputs, 'comfort-mobile-first-fold.png'), fullPage: true, animations: 'disabled' });
  console.log('✓ 390 / 375 / 320px 手机首屏显示完整抽签按钮，无横向溢出');

  await draw(page);
  const first = (await state(page)).currentId;
  const firstText = await page.locator('#question-text').textContent();
  await page.waitForFunction(() => scrollY > 0 && document.querySelector('.question-panel').getBoundingClientRect().top < 250);
  await page.evaluate(() => { for (let n = 0; n < 25; n++) document.getElementById('defer-button').click(); });
  await ready(page);
  let progress = await state(page);
  assert.equal(progress.history.length, 2);
  assert.equal(progress.history[0].answeredAt, null);
  assert.ok(progress.history[0].deferredAt);
  const second = progress.currentId;
  assert.notEqual(second, first);
  assert.match(await page.locator('#progress-text').textContent(), /已聊完 0/);
  await page.reload(); await ready(page);
  assert.equal(await page.locator('#pending-count').textContent(), '1');
  await page.locator('#pending-button').click();
  await page.screenshot({ path: path.join(outputs, 'comfort-mobile-pending.png'), fullPage: true, animations: 'disabled' });
  await page.locator(`[data-resume-id="${first}"]`).click(); await ready(page);
  assert.equal(await page.locator('#question-text').textContent(), firstText);
  progress = await state(page);
  assert.equal(progress.currentId, first);
  assert.ok(progress.history.find(e => e.id === second).deferredAt);
  assert.equal(progress.history.length, 2);
  await confirm(page); await draw(page);
  progress = await state(page);
  assert.equal(progress.history.length, 3);
  assert.ok(progress.history.find(e => e.id === first).answeredAt);
  assert.equal(progress.history.find(e => e.id === second).answeredAt, null);
  console.log('✓ 连点暂放仅抽一题；刷新恢复待聊；继续旧题自动暂放当前题，并确认正确题号');

  await page.locator('#backup-button').click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-button').click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /精简版.*\.json$/);
  const backupPath = path.join(outputs, 'browser-progress-backup.json');
  await download.saveAs(backupPath);
  const backup = JSON.parse(await readFile(backupPath, 'utf8'));
  assert.equal(backup.edition, 'concise');
  assert.deepEqual(backup.progress, progress);
  assert.ok(!JSON.stringify(backup).includes(firstText));
  await page.keyboard.press('Escape');
  await select(page, 'full'); await draw(page); await confirm(page);
  const untouchedFull = await saved(page, fullKey);
  await select(page, 'concise');
  await page.locator('#reset-button').click(); await page.locator('#confirm-reset').click();
  await ready(page);
  const resetState = await saved(page);
  await page.locator('#backup-button').click();
  await choose(page, backupPath);
  assert.match(await page.locator('#import-summary').textContent(), /已抽 3 题 · 已聊完 1 题 · 暂放 1 题/);
  await page.screenshot({ path: path.join(outputs, 'comfort-mobile-import.png'), fullPage: true, animations: 'disabled' });
  assert.equal(await saved(page), resetState, 'Choosing a file must not import it');
  await page.locator('#import-dialog .secondary-button').click();
  assert.equal(await saved(page), resetState, 'Cancel must preserve progress');
  await choose(page, backupPath); await page.locator('#confirm-import').click();
  await page.locator('#import-dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(await state(page), backup.progress);
  assert.equal(await saved(page, fullKey), untouchedFull);
  await page.reload(); await ready(page);
  assert.deepEqual(await state(page), backup.progress);
  await page.locator('#backup-button').click();
  for (const file of [
    { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{bad json') },
    { name: 'wrong-bank.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...backup, progress: { ...backup.progress, bankId: 'wrong' } })) },
    { name: 'oversized.json', mimeType: 'application/json', buffer: Buffer.alloc(1024 * 1024 + 1) }
  ]) {
    await page.locator('#backup-file').setInputFiles(file);
    await page.locator('#backup-error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#import-dialog').evaluate(el => el.open), false);
    assert.deepEqual(await state(page), backup.progress);
    assert.equal(await saved(page, fullKey), untouchedFull);
  }
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(outputs, 'comfort-mobile-progress.png'), fullPage: true, animations: 'disabled' });
  console.log('✓ 真实下载备份；预览、取消与确认导入；错误/不匹配/超大文件拒绝，另一个版本完整保留');

  const other = await context();
  const otherPage = await other.newPage();
  await otherPage.goto(base); await ready(otherPage);
  assert.equal(await saved(otherPage), null);
  await select(otherPage, 'full'); await draw(otherPage);
  const otherFull = await saved(otherPage, fullKey);
  await otherPage.locator('#backup-button').click();
  await choose(otherPage, backupPath); await otherPage.locator('#confirm-import').click();
  await otherPage.locator('#import-dialog').waitFor({ state: 'hidden' });
  assert.equal(await otherPage.locator('#question-total').textContent(), '99');
  assert.deepEqual(await state(otherPage), backup.progress);
  assert.equal(await saved(otherPage, fullKey), otherFull);
  console.log('✓ 新浏览器从完整版导入精简版备份，自动切换且保留原完整版记录');

  const timestamp = '2026-10-20T08:00:00.000Z';
  const ordinary = concise.questions.filter(q => q.id !== '999');
  const almostDone = {
    version: 3, bankId: conciseId, currentId: ordinary.at(-1).id,
    history: ordinary.map((q, i) => ({ id: q.id, drawnAt: timestamp, answeredAt: i === 0 ? null : timestamp, deferredAt: i === 0 ? timestamp : null }))
  };
  await otherPage.evaluate(({ key, progress }) => localStorage.setItem(key, JSON.stringify(progress)), { key, progress: almostDone });
  await otherPage.reload(); await ready(otherPage);
  assert.equal(await otherPage.locator('#draw-button').getAttribute('data-action'), 'review');
  assert.equal(await otherPage.locator('#jar-button').isDisabled(), true);
  assert.match(await otherPage.locator('#finale-note').textContent(), /1/);
  await otherPage.locator('#draw-button').click();
  await otherPage.locator(`[data-resume-id="${ordinary[0].id}"]`).click(); await ready(otherPage);
  await confirm(otherPage);
  assert.equal(await otherPage.locator('#draw-label').textContent(), '揭开第 99 题');
  await draw(otherPage);
  assert.equal((await state(otherPage)).currentId, '999');
  assert.equal(await otherPage.locator('#defer-button').isVisible(), false);
  await confirm(otherPage);
  assert.equal((await state(otherPage)).history.filter(e => e.answeredAt).length, 99);
  console.log('✓ 抽过全部普通题但仍有待聊时，最后一题继续锁定；补聊确认后才解锁');

  // v2 progress is migrated only when a real action saves it.
  const legacy = { version: 2, bankId: conciseId, history: ordinary.slice(0, 2).map((q, i) => ({ id: q.id, drawnAt: timestamp, answeredAt: i === 0 ? timestamp : null })) };
  await otherPage.evaluate(({ key, progress }) => localStorage.setItem(key, JSON.stringify(progress)), { key, progress: legacy });
  await otherPage.reload(); await ready(otherPage);
  assert.match(await otherPage.locator('#progress-text').textContent(), /已聊完 1/);
  await otherPage.locator('#defer-button').click(); await ready(otherPage);
  const upgraded = await state(otherPage);
  assert.equal(upgraded.version, 3);
  assert.equal(upgraded.history[0].answeredAt, timestamp);
  assert.ok(upgraded.history[1].deferredAt);
  assert.equal(upgraded.history.length, 3);
  console.log('✓ 旧v2记录升级后可暂放，已聊完状态、题号和时间完整保留');

  assert.deepEqual(errors, []);
  await ctx.close(); await other.close();
  console.log(`✓ 无浏览器运行错误；${server ? '本地' : '公开网页匿名'}验收通过：${base}`);
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
