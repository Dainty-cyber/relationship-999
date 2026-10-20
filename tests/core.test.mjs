import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { auditBank, fingerprintBank, freshProgress, restoreProgress, drawQuestion, confirmAnswer, roundStatus, secureRandomIndex, createProgressStore } from '../dist/core.mjs';
import { parseQuestions } from '../scripts/import-questions.mjs';
import { createPreviewServer } from '../scripts/serve.mjs';

// Synthetic markers exercise all 999 slots. Never copied into dist/questions.json.
const bank = { version: 1, questions: Array.from({ length: 999 }, (_, index) => ({ id: String(index + 1), text: `自动测试占位 ${index + 1}（非正式题库）` })) };
const now = () => '2026-10-20T08:00:00.000Z';

test('998 confirmed random questions unlock 999 last; no duplicates or omitted questions', () => {
  let state = freshProgress('bank');
  const original = JSON.stringify(bank);
  for (let index = 0; index < bank.questions.length; index++) {
    const result = drawQuestion(state, bank.questions, secureRandomIndex, now);
    assert.ok(result.question);
    assert.equal(result.state.history.length, index + 1);
    assert.equal(state.history.length, index);
    assert.equal(result.question.id === '999', index === 998);
    assert.equal(drawQuestion(result.state, bank.questions).question, null, 'Cannot draw before confirming the current question');
    state = confirmAnswer(result.state, result.question.id, now);
    assert.equal(roundStatus(state, bank.questions).answeredCount, index + 1);
  }
  assert.equal(new Set(state.history.map(entry => entry.id)).size, 999);
  assert.deepEqual(new Set(state.history.map(entry => entry.id)), new Set(bank.questions.map(question => question.id)));
  assert.deepEqual(drawQuestion(state, bank.questions), { state, question: null });
  assert.equal(JSON.stringify(bank), original);
});

test('restores current question and history; a new round has the full pool', () => {
  const state = drawQuestion(freshProgress('bank'), bank.questions, () => 422, now).state;
  const restored = restoreProgress(JSON.stringify(state), 'bank', bank.questions);
  assert.deepEqual(restored.state, state);
  assert.equal(restored.state.history.at(-1).id, '423');
  assert.equal(restored.reason, null);
  const reset = freshProgress('bank');
  assert.equal(reset.history.length, 0);
  assert.equal(drawQuestion(reset, bank.questions, () => 422, now).question.id, '423');
});

test('rejects corrupted, repeated, unknown, and old-bank progress', () => {
  const entry = { id: '1', drawnAt: now(), answeredAt: null };
  for (const raw of ['{broken', 'null', JSON.stringify({ version: 2, bankId: 'bank', history: [entry, entry] }),
    JSON.stringify({ version: 2, bankId: 'bank', history: [{ ...entry, id: 'unknown' }] }),
    JSON.stringify({ version: 2, bankId: 'bank', history: [{ ...entry, drawnAt: 'bad' }] }),
    JSON.stringify({ version: 2, bankId: 'bank', history: [{ ...entry, id: '999' }] }),
    JSON.stringify({ version: 2, bankId: 'bank', history: [entry, { ...entry, id: '2' }] }),
    JSON.stringify({ version: 2, bankId: 'bank', history: [{ ...entry, answeredAt: 'bad' }] }),
    JSON.stringify({ version: 2, bankId: 'bank', history: [{ ...entry, answeredAt: '2020-01-01T00:00:00Z' }] })]) {
    const result = restoreProgress(raw, 'bank', bank.questions);
    assert.equal(result.reason, 'invalid');
    assert.equal(result.state.history.length, 0);
  }
  assert.equal(restoreProgress(JSON.stringify(freshProgress('old')), 'new', bank.questions).reason, 'bank-changed');
  assert.equal(restoreProgress(null, 'bank', bank.questions).reason, null);
});

test('confirmation is explicit, idempotent and cannot act on a stale card', () => {
  const pending = drawQuestion(freshProgress('bank'), bank.questions, () => 0, now).state;
  assert.equal(roundStatus(pending, bank.questions).answeredCount, 0);
  assert.equal(confirmAnswer(pending, '2', now), pending);
  const confirmed = confirmAnswer(pending, '1', now);
  assert.equal(roundStatus(confirmed, bank.questions).answeredCount, 1);
  assert.equal(confirmAnswer(confirmed, '1', now), confirmed);
  const next = drawQuestion(confirmed, bank.questions, () => 0, now).state;
  assert.equal(confirmAnswer(next, '1', now), next);
  assert.equal(restoreProgress(JSON.stringify(next), 'bank', bank.questions).reason, null);
});

test('the 998th question must be confirmed before the final question is available', () => {
  const history = bank.questions.slice(0, 998).map(question => ({ id: question.id, drawnAt: now(), answeredAt: now() }));
  history[997].answeredAt = null;
  const pending = { version: 2, bankId: 'bank', history };
  assert.equal(roundStatus(pending, bank.questions).finalUnlocked, false);
  assert.equal(drawQuestion(pending, bank.questions).question, null);
  const unlocked = confirmAnswer(pending, '998', now);
  assert.equal(roundStatus(unlocked, bank.questions).finalNext, true);
  const finale = drawQuestion(unlocked, bank.questions, () => 0, now);
  assert.equal(finale.question.id, '999');
  assert.equal(roundStatus(finale.state, bank.questions).finished, false);
  assert.equal(restoreProgress(JSON.stringify(finale.state), 'bank', bank.questions).reason, null);
  const finished = confirmAnswer(finale.state, '999', now);
  assert.equal(roundStatus(finished, bank.questions).finished, true);
  assert.equal(drawQuestion(finished, bank.questions).question, null);
  assert.equal(roundStatus(freshProgress('bank'), bank.questions).finalUnlocked, false);
});

test('bank fingerprint follows content, preserving history for an unchanged bank', async () => {
  const id = await fingerprintBank(bank);
  assert.equal(id.length, 64);
  assert.equal(id, await fingerprintBank(JSON.parse(JSON.stringify(bank))));
  const changed = structuredClone(bank);
  changed.questions[0].text += '修改';
  assert.notEqual(id, await fingerprintBank(changed));
});

test('audit reports wrong count, empty questions, canonical duplicate IDs and duplicate text', () => {
  assert.deepEqual(auditBank(bank), []);
  const issues = auditBank({ version: 1, questions: [
    { id: '01', text: '你怎么看待未来？' },
    { id: '1', text: '你 怎么看待未来？' },
    { id: '', text: '   ' }, null
  ] });
  assert.ok(issues.some(issue => issue.includes('数量')));
  assert.ok(issues.some(issue => issue.includes('题号「1」重复')));
  assert.ok(issues.some(issue => issue.includes('内容重复')));
  assert.ok(issues.some(issue => issue.includes('题目为空')));
  assert.ok(issues.some(issue => issue.includes('不是题目对象')));
});

test('TXT importer retains original numbers, punctuation and multiline question text', () => {
  const parsed = parseQuestions('\uFEFF001、你期待什么？\r\n具体说说。\r\n\r\n002.  你在意什么？', '.txt');
  assert.deepEqual(parsed.questions, [{ id: '001', text: '你期待什么？\n具体说说。' }, { id: '002', text: ' 你在意什么？' }]);
  const unnumbered = parseQuestions('  原文首尾空白  \n\n第二题？', '.txt');
  assert.equal(unnumbered.questions[0].text, '  原文首尾空白  ');
  assert.throws(() => parseQuestions('疑似标题\n1、第一题', '.txt'), /首个题号之前/);
  assert.throws(() => parseQuestions('data', '.docx'), /Word/);
});

test('JSON importer preserves content and accepts numeric IDs', () => {
  const content = '  保留标点、空白。\n第二行 <script>  ';
  const parsed = parseQuestions(JSON.stringify([{ id: 1, text: content }]), '.json');
  assert.deepEqual(parsed.questions, [{ id: '1', text: content }]);
});

test('persistent store restores from storage without touching unrelated keys', () => {
  const data = new Map([['unrelated', 'keep']]);
  const fake = { setItem: (key, value) => data.set(key, value), getItem: key => data.get(key) ?? null, removeItem: key => data.delete(key) };
  const state = freshProgress('bank');
  createProgressStore(() => fake, 'progress').write(state);
  const reopened = createProgressStore(() => fake, 'progress');
  assert.equal(reopened.persistent, true);
  assert.equal(reopened.read(), JSON.stringify(state));
  assert.equal(data.get('unrelated'), 'keep');
});

test('private-mode and quota errors retain progress in memory', () => {
  const unavailable = createProgressStore(() => { throw new Error('denied'); }, 'progress');
  const state = freshProgress('bank');
  unavailable.write(state);
  assert.equal(unavailable.persistent, false);
  assert.equal(unavailable.read(), JSON.stringify(state));
  let writes = 0;
  const full = createProgressStore(() => ({ setItem: () => { if (++writes > 1) throw new Error('full'); }, removeItem() {}, getItem: () => null }), 'progress');
  full.write(state);
  assert.equal(full.persistent, false);
  assert.equal(full.read(), JSON.stringify(state));
});

test('random boundaries are valid and invalid pools/random results are rejected', () => {
  assert.equal(secureRandomIndex(1), 0);
  assert.throws(() => secureRandomIndex(0), RangeError);
  assert.throws(() => drawQuestion(freshProgress('bank'), bank.questions, () => 998), RangeError);
  assert.equal(drawQuestion(freshProgress('bank'), bank.questions, () => 997, now).question.id, '998');
});

test('preview serves real assets and the configured bank, with correct MIME and no traversal', async t => {
  const server = createPreviewServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/', '/styles.css', '/app.mjs', '/core.mjs', '/favicon.svg']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    if (route.endsWith('.mjs')) assert.match(response.headers.get('content-type'), /javascript/);
  }
  const data = await (await fetch(base + '/questions.json')).json();
  const source = JSON.parse(await readFile(new URL('../dist/questions.json', import.meta.url), 'utf8'));
  assert.deepEqual(data, source);
  assert.ok(!data.questions.some(question => question.text.includes('自动测试占位')), 'Do not publish test markers as the real bank');
  assert.equal((await fetch(base + '/missing.json')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e%5cpackage.json')).status, 403);
});
