import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createPairPreview } from '../server/preview.mjs';

const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
if (!args.includes('--playwright') || !args.includes('--browser')) throw new Error('Provide --playwright <index.mjs> --browser <executable>');
const { chromium } = await import(pathToFileURL(path.resolve(value('--playwright'))).href);
const outputs = fileURLToPath(new URL('../outputs/', import.meta.url));
await mkdir(outputs, { recursive: true });
const server = args.includes('--url') ? null : await createPairPreview();
if (server) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = server ? `http://127.0.0.1:${server.address().port}/` : value('--url');
const apiOrigin = args.includes('--api') ? value('--api') : new URL(base).origin;
const errors = [];
let browser;
let cleanupCredential;
let apiContext;
const expectVisible = (page, selector) => page.locator(selector).waitFor({ state: 'visible', timeout: 20000 });
async function roomState(page) {
  return page.evaluate(async api => {
    const record = JSON.parse(localStorage.getItem('before-we-become-us:pair:members:v1')).at(-1);
    const response = await fetch(`${api}/api/pair/rooms/${record.roomId}`, { headers: { Authorization: `Bearer ${record.memberToken}` }, cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  }, apiOrigin);
}
try {
  browser = await chromium.launch({ executablePath: value('--browser'), headless: true, args: ['--disable-gpu', '--no-first-run'] });
  const contexts = await Promise.all([browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' }), browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' }), browser.newContext()]);
  for (const context of contexts) context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  apiContext = contexts[0];
  const [a, b, stranger] = await Promise.all(contexts.map(context => context.newPage()));
  await a.goto(base, { waitUntil: 'networkidle', timeout: 45000 });
  await a.waitForFunction(() => !document.getElementById('draw-button').disabled);
  await a.locator('#draw-button').click();
  await a.waitForFunction(() => document.getElementById('draw-button').dataset.action === 'confirm');
  const personal = await a.evaluate(() => localStorage.getItem('before-we-become-us:progress:concise:v1'));
  const question = await a.locator('#question-text').textContent();
  await a.locator('#pair-link').click();
  await a.locator('#pair-name').fill('测试甲');
  await a.locator('#pair-enter').click();
  await expectVisible(a, '#pair-room');
  cleanupCredential = await a.evaluate(() => JSON.parse(localStorage.getItem('before-we-become-us:pair:members:v1')).at(-1));
  assert.equal(await a.locator('#pair-question').textContent(), question);
  assert.equal(await a.locator('#pair-submit').isDisabled(), true, 'Wait for the second participant');
  const invite = await a.locator('#pair-invite-url').inputValue();
  assert.ok(new URL(invite).hash.includes('invite='));
  assert.ok(!invite.includes(cleanupCredential.memberToken), 'Invite must not contain host identity');
  await b.goto(invite, { waitUntil: 'networkidle' });
  assert.equal(new URL(b.url()).hash, '', 'Remove invitation secret from visible URL');
  await b.locator('#pair-name').fill('测试乙'); await b.locator('#pair-enter').click();
  await expectVisible(b, '#pair-room');
  await a.waitForFunction(() => !document.querySelector('#pair-choices input').disabled);
  assert.equal((await roomState(a)).body.joined, true);
  assert.equal((await roomState(b)).body.me, 'b');
  console.log('✓ 从当前卡片创建双人房间，独立浏览器通过邀请加入；个人记录完整保留');

  await b.locator('input[name=answer][value=c1]').check(); await b.locator('#pair-answer-text').fill('PRIVATE_BOB_独立想法');
  await a.locator('input[name=answer][value=c0]').check(); await a.locator('#pair-answer-text').fill('PRIVATE_ALICE_独立想法');
  // The write succeeds but its response is lost: resynchronization must find
  // the locked answer, without allowing a different second submission.
  await a.route('**/api/pair/rooms/*/answer', async route => { await route.fetch(); await route.abort('failed'); });
  await a.locator('#pair-submit').click();
  await expectVisible(a, '#pair-waiting');
  await a.unroute('**/api/pair/rooms/*/answer');
  const hidden = await roomState(b);
  assert.equal(hidden.body.round.answers, null); assert.equal(hidden.body.round.ownAnswer, null);
  assert.ok(!JSON.stringify(hidden.body).includes('PRIVATE_ALICE'));
  await b.waitForFunction(() => document.getElementById('pair-status-a').textContent.includes('锁定'));
  assert.equal(await b.locator('input[name=answer][value=c1]').isChecked(), true);
  assert.equal(await b.locator('#pair-answer-text').inputValue(), 'PRIVATE_BOB_独立想法');
  const historyBefore = await b.evaluate(async api => {
    const record = JSON.parse(localStorage.getItem('before-we-become-us:pair:members:v1')).at(-1);
    return (await fetch(`${api}/api/pair/rooms/${record.roomId}/history`, { headers: { Authorization: `Bearer ${record.memberToken}` } })).json();
  }, apiOrigin);
  assert.deepEqual(historyBefore.results, []);
  await a.screenshot({ path: path.join(outputs, 'pair-waiting-mobile.png'), fullPage: true, animations: 'disabled' });
  await b.reload(); await expectVisible(b, '#pair-room');
  assert.equal(await b.locator('input[name=answer][value=c1]').isChecked(), true);
  assert.equal(await b.locator('#pair-answer-text').inputValue(), 'PRIVATE_BOB_独立想法');
  console.log('✓ 首方提交后，另一方收到的数据和历史均不含答案；丢失响应恢复锁定，草稿与刷新恢复正常');

  await b.locator('#pair-submit').click();
  await Promise.all([expectVisible(a, '#pair-results'), expectVisible(b, '#pair-results')]);
  for (const page of [a, b]) {
    assert.match(await page.locator('#pair-result-text-a').textContent(), /PRIVATE_ALICE/);
    assert.match(await page.locator('#pair-result-text-b').textContent(), /PRIVATE_BOB/);
    assert.equal(await page.locator('#pair-next').isVisible(), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await b.screenshot({ path: path.join(outputs, 'pair-revealed-mobile.png'), fullPage: true, animations: 'disabled' });
  await a.locator('#pair-seen').click();
  assert.equal(await a.locator('#pair-next').isVisible(), false);
  await b.locator('#pair-seen').click();
  await Promise.all([expectVisible(a, '#pair-next'), expectVisible(b, '#pair-next')]);
  const oldRound = (await roomState(a)).body.round.id;
  await a.locator('#pair-next').click();
  await b.waitForFunction(text => document.getElementById('pair-question').textContent !== text, question);
  assert.notEqual((await roomState(a)).body.round.id, oldRound);
  assert.equal((await roomState(a)).body.completedCount, 1);
  assert.notEqual((await roomState(a)).body.round.question.id, '999');
  await a.reload(); await expectVisible(a, '#pair-room');
  assert.equal(await a.evaluate(() => localStorage.getItem('before-we-become-us:progress:concise:v1')), personal);
  await a.locator('#pair-history-button').click(); await expectVisible(a, '#pair-history-dialog');
  assert.match(await a.locator('#pair-history-list').textContent(), /PRIVATE_ALICE/);
  await a.locator('#pair-history-close').click();
  console.log('✓ 双方提交后共同揭晓，双方看完才可继续；刷新、答案历史和个人进度隔离通过');

  await stranger.goto(invite); await stranger.locator('#pair-name').fill('第三人测试'); await stranger.locator('#pair-enter').click();
  await expectVisible(stranger, '#pair-entry-error'); assert.match(await stranger.locator('#pair-entry-error').textContent(), /两个人/);
  const denied = await contexts[2].request.get(`${apiOrigin}/api/pair/rooms/${cleanupCredential.roomId}`);
  assert.equal(denied.status(), 403);
  await b.locator('#pair-close-button').click(); await b.locator('#pair-keep-room').click();
  assert.equal((await roomState(b)).status, 200);
  await b.locator('#pair-close-button').click(); await b.locator('#pair-confirm-close').click();
  await Promise.all([expectVisible(a, '#pair-unavailable'), expectVisible(b, '#pair-unavailable')]);
  assert.equal((await contexts[0].request.get(`${apiOrigin}/api/pair/rooms/${cleanupCredential.roomId}`, { headers: { Authorization: `Bearer ${cleanupCredential.memberToken}` } })).status(), 404);
  cleanupCredential = null;
  assert.deepEqual(errors, []);
  const localCheck = server || ['127.0.0.1', 'localhost'].includes(new URL(base).hostname);
  console.log(`✓ 第三人不能入房或偷看；取消结束保留记录，确认结束对双方生效；无运行时错误。${localCheck ? '本地' : '线上匿名'}验收通过。`);
  for (const context of contexts) await context.close();
} finally {
  if (cleanupCredential && apiContext) {
    await apiContext.request.post(`${apiOrigin}/api/pair/rooms/${cleanupCredential.roomId}/close`, { headers: { Authorization: `Bearer ${cleanupCredential.memberToken}` }, data: {} }).catch(() => {});
  }
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
