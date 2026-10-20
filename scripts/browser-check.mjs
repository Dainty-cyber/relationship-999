// Optional visual/integration QA. Uses an existing Playwright installation and
// local Edge/Chromium; it never installs packages or changes the real question bank.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPreviewServer } from './serve.mjs';
import { fingerprintBank } from '../dist/core.mjs';

const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
if (!args.includes('--playwright') || !args.includes('--browser')) throw new Error('Provide --playwright <index.mjs> --browser <browser executable>');
const { chromium } = await import(pathToFileURL(path.resolve(value('--playwright'))).href);
const outputs = fileURLToPath(new URL('../outputs/', import.meta.url));
await mkdir(outputs, { recursive: true });
const server = createPreviewServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
const reports = [];
const errors = [];
const key = 'before-we-become-us:progress:v2';
const bank = { version: 1, questions: Array.from({ length: 999 }, (_, index) => ({ id: String(index + 1).padStart(3, '0'), text: `自动测试占位 ${index + 1}（不属于用户题库）` })) };
bank.questions[997].text = '自动测试长文本：' + '验证手机上长题目能够完整换行和滚动阅读。'.repeat(22) + '\n<script>window.__unsafe = true</script>';
const bankId = await fingerprintBank(bank);

const waitReady = page => page.waitForFunction(() => !document.getElementById('draw-button').disabled);
const count = page => page.locator('#history-count').textContent();
async function confirmCurrent(page) {
  await page.locator('#draw-button').click();
  await page.waitForFunction(() => document.getElementById('draw-button').dataset.action === 'draw');
}
async function drawOnce(page) {
  if (await page.locator('#draw-button').getAttribute('data-action') === 'confirm') await confirmCurrent(page);
  await page.locator('#draw-button').click();
  await page.waitForFunction(() => document.getElementById('draw-button').dataset.action === 'confirm' && !document.getElementById('draw-button').disabled);
}
async function trackedContext(options = {}, fixture = true) {
  const context = await browser.newContext(options);
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  if (fixture) await context.route('**/questions.json', route => route.fulfill({ json: bank }));
  return context;
}
async function seed(page, n) {
  await page.evaluate(({ key, bankId, questions, n }) => localStorage.setItem(key, JSON.stringify({ version: 2, bankId, history: questions.slice(0, n).map(question => ({ id: question.id, drawnAt: '2026-10-20T08:00:00.000Z', answeredAt: '2026-10-20T08:00:00.000Z' })) })), { key, bankId, questions: bank.questions, n });
  await page.reload();
}

try {
  browser = await chromium.launch({ executablePath: value('--browser'), headless: true, args: ['--disable-gpu', '--no-first-run'] });
  const blank = await trackedContext({ viewport: { width: 1440, height: 1080 }, deviceScaleFactor: 1 }, false);
  // Keep this pending-state scenario valid even after the owner imports a bank.
  await blank.route('**/questions.json', route => route.fulfill({ json: { version: 1, questions: [] } }));
  const pending = await blank.newPage();
  await pending.goto(base);
  await pending.locator('#question-label').filter({ hasText: '题库待导入' }).waitFor();
  assert.equal(await pending.locator('#draw-button').isDisabled(), true);
  await pending.screenshot({ path: path.join(outputs, 'pending-desktop.png'), fullPage: true, animations: 'disabled' });
  await pending.locator('#history-button').click();
  assert.match(await pending.locator('#history-list').textContent(), /还没有/);
  await pending.keyboard.press('Escape');
  await pending.locator('#about-button').click();
  assert.equal(await pending.locator('#about-dialog').evaluate(el => el.open), true);
  await pending.keyboard.press('Escape');
  await pending.locator('#share-button').click();
  assert.match(await pending.locator('#share-description').textContent(), /本机预览/);
  await pending.keyboard.press('Escape');
  await pending.setViewportSize({ width: 390, height: 1000 });
  await pending.screenshot({ path: path.join(outputs, 'pending-mobile.png'), fullPage: true, animations: 'disabled' });
  assert.equal(await pending.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  reports.push('空题库：等待状态、桌面/手机截图、历史空态、介绍与本地分享提示通过');
  await blank.close();

  const context = await trackedContext();
  const page = await context.newPage();
  await page.goto(base); await waitReady(page);
  // Multiple event deliveries in the same tick must still reserve only one.
  await page.evaluate(() => { for (let index = 0; index < 25; index++) document.getElementById('draw-button').click(); });
  await waitReady(page);
  assert.equal(await count(page), '1');
  assert.match(await page.locator('#draw-label').textContent(), /已聊完/);
  assert.match(await page.locator('#progress-text').textContent(), /已聊完 0/);
  assert.equal(await page.locator('#jar-button').isDisabled(), true);
  const text = await page.locator('#question-text').textContent();
  await page.reload(); await waitReady(page);
  assert.equal(await count(page), '1');
  assert.equal(await page.locator('#question-text').textContent(), text);
  await page.locator('#history-button').click();
  assert.equal(await page.locator('.history-item').count(), 1);
  assert.equal(await page.locator('.history-item p').textContent(), text);
  await page.keyboard.press('Escape');
  await page.locator('#reset-button').click();
  await page.locator('#reset-dialog [data-close]').first().click();
  assert.equal(await count(page), '1');
  await page.locator('#reset-button').click();
  await page.keyboard.press('Escape');
  assert.equal(await count(page), '1');
  await page.locator('#reset-button').click();
  await page.locator('#confirm-reset').click();
  await page.waitForFunction(() => document.getElementById('history-count').textContent === '0');
  assert.equal(await page.locator('#reset-button').isDisabled(), true);
  reports.push('连续点击保护、刷新恢复、历史原文、取消/确认重置通过');

  const page2 = await context.newPage(); await page2.goto(base); await waitReady(page2);
  await Promise.all([page.evaluate(() => document.getElementById('jar-button').click()), page2.evaluate(() => document.getElementById('jar-button').click())]);
  await Promise.all([waitReady(page), waitReady(page2)]);
  assert.equal(await count(page), '1'); assert.equal(await count(page2), '1');
  await confirmCurrent(page);
  await page2.waitForFunction(() => document.getElementById('draw-button').dataset.action === 'draw');
  await drawOnce(page2);
  await page.waitForFunction(() => document.getElementById('history-count').textContent === '2');
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
  assert.equal(new Set(saved.history.map(entry => entry.id)).size, 2);
  reports.push('两个标签页同时抽签只保留同一待聊题，确认后可继续，记录同步且不重复通过');
  await page2.close();

  await page.evaluate(key => localStorage.setItem(key, '{broken'), key);
  await page.reload(); await waitReady(page);
  assert.equal(await count(page), '0');
  assert.match(await page.locator('#toast').textContent(), /无法读取/);
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ version: 2, bankId: 'old', history: [] })), key);
  await page.reload(); await waitReady(page);
  assert.match(await page.locator('#toast').textContent(), /题库已更新/);
  reports.push('损坏记录与题库版本变更的恢复提示通过');

  await page.locator('#draw-button').click();
  await page.waitForFunction(key => JSON.parse(localStorage.getItem(key)).history.length === 1, key);
  await page.reload(); await waitReady(page);
  assert.equal(await count(page), '1');
  reports.push('抽签动画中刷新：已保留的同一题正确恢复');

  await seed(page, 997); await waitReady(page);
  await drawOnce(page);
  assert.equal(await count(page), '998');
  assert.match(await page.locator('#progress-text').textContent(), /已聊完 997/);
  assert.equal(await page.locator('#question-text').textContent(), bank.questions[997].text);
  assert.equal(await page.locator('#jar-button').isDisabled(), true);
  assert.doesNotMatch(await page.locator('#draw-label').textContent(), /揭开/);
  assert.equal(await page.evaluate(() => window.__unsafe), undefined);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const longTextBox = await page.locator('#question-text').evaluate(el => ({ content: el.scrollHeight, box: el.clientHeight }));
  assert.ok(longTextBox.content <= longTextBox.box + 1);
  await page.screenshot({ path: path.join(outputs, 'long-question-test.png'), fullPage: true, animations: 'disabled' });
  await confirmCurrent(page);
  assert.match(await page.locator('#draw-label').textContent(), /揭开第 999 题/);
  assert.match(await page.locator('#progress-text').textContent(), /已聊完 998/);
  await page.reload(); await waitReady(page);
  assert.match(await page.locator('#draw-label').textContent(), /揭开第 999 题/);
  await drawOnce(page);
  assert.equal(await count(page), '999');
  assert.equal(await page.locator('#draw-button').isEnabled(), true);
  assert.equal(await page.locator('#reset-button').isEnabled(), true);
  assert.equal(await page.locator('#question-text').textContent(), bank.questions[998].text);
  await page.reload(); await waitReady(page);
  assert.equal(await page.locator('#question-text').textContent(), bank.questions[998].text);
  await confirmCurrent(page);
  assert.match(await page.locator('#draw-label').textContent(), /圆满/);
  assert.equal(await page.locator('#draw-button').isDisabled(), true);
  await page.locator('#history-button').click();
  assert.equal(await page.locator('.history-item').count(), 999);
  await page.keyboard.press('Escape');
  await page.locator('#reset-button').click(); await page.locator('#confirm-reset').click(); await waitReady(page);
  assert.equal(await count(page), '0');
  assert.match(await page.locator('#finale-note').textContent(), /解锁/);
  assert.doesNotMatch(await page.locator('#finale-note').textContent(), /已解锁/);
  reports.push('998 题必须确认后解锁最后一题；解锁/最后一题刷新恢复、999 条历史、结束与重置重新锁定通过');
  await context.close();

  const memoryContext = await trackedContext({ reducedMotion: 'reduce', viewport: { width: 320, height: 800 } });
  await memoryContext.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage denied'); } }));
  const memoryPage = await memoryContext.newPage(); await memoryPage.goto(base); await waitReady(memoryPage);
  assert.match(await memoryPage.locator('#storage-note').textContent(), /本次打开期间/);
  await drawOnce(memoryPage); await drawOnce(memoryPage);
  assert.equal(await count(memoryPage), '2');
  assert.equal(await memoryPage.locator('#question-stage').evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.equal(await memoryPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await memoryPage.reload(); await waitReady(memoryPage);
  assert.equal(await count(memoryPage), '0');
  reports.push('存储不可用时内存抽签、清晰提示、320px 布局与减少动画通过');
  await memoryContext.close();

  const quotaContext = await trackedContext({ reducedMotion: 'reduce' });
  const quotaPage = await quotaContext.newPage(); await quotaPage.goto(base); await waitReady(quotaPage);
  await quotaPage.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('quota exceeded'); }; });
  await drawOnce(quotaPage); await drawOnce(quotaPage);
  assert.equal(await count(quotaPage), '2');
  assert.match(await quotaPage.locator('#storage-note').textContent(), /本次打开期间/);
  reports.push('运行中存储配额不足：不丢失当前记录，改用内存并提示通过');
  await quotaContext.close();

  const shareContext = await trackedContext({}, false);
  // Mock an HTTPS public origin entirely through the local server, no internet.
  await shareContext.route('https://questions.test/**', async route => {
    const url = new URL(route.request().url());
    const response = await fetch(base + url.pathname);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  await shareContext.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.__copied = text; } }, configurable: true }));
  const sharePage = await shareContext.newPage(); await sharePage.goto('https://questions.test/?from=chat#section');
  await sharePage.locator('#share-button').click();
  assert.equal(await sharePage.evaluate(() => window.__copied), 'https://questions.test/');
  await sharePage.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('blocked'); } } }));
  await sharePage.locator('#share-button').click();
  assert.equal(await sharePage.locator('#share-dialog').evaluate(el => el.open), true);
  assert.equal(await sharePage.locator('#share-url').inputValue(), 'https://questions.test/');
  reports.push('公开地址复制、去掉参数、剪贴板拒绝时显示可手动复制链接通过');
  await shareContext.close();

  // Final visual QA uses the actual imported bank, without interception.
  const real = await trackedContext({ viewport: { width: 1440, height: 1080 } }, false);
  const actual = await real.newPage(); await actual.goto(base); await waitReady(actual);
  await actual.screenshot({ path: path.join(outputs, 'desktop.png'), fullPage: true, animations: 'disabled' });
  await actual.setViewportSize({ width: 390, height: 1000 });
  await drawOnce(actual);
  await actual.screenshot({ path: path.join(outputs, 'mobile.png'), fullPage: true, animations: 'disabled' });
  const realBank = JSON.parse(await readFile(new URL('../dist/questions.json', import.meta.url), 'utf8'));
  const realId = await fingerprintBank(realBank);
  await actual.evaluate(({ key, realId, qs }) => localStorage.setItem(key, JSON.stringify({ version: 2, bankId: realId, history: qs.slice(0, 998).map(q => ({ id: q.id, drawnAt: '2026-10-20T08:00:00.000Z', answeredAt: '2026-10-20T08:00:00.000Z' })) })), { key, realId, qs: realBank.questions });
  await actual.reload(); await waitReady(actual); await drawOnce(actual);
  assert.equal(await actual.locator('#question-text').textContent(), realBank.questions.find(q => q.id === '999').text);
  await actual.screenshot({ path: path.join(outputs, 'finale.png'), fullPage: true, animations: 'disabled' });
  await real.close();
  reports.push('正式 999 题加载与桌面/手机/最后一签视觉截图完成');

  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log(reports.map(report => `✓ ${report}`).join('\n'));
  console.log(`✓ 无浏览器运行时错误。截图：${outputs}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
