import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { auditBank, fingerprintBank, freshProgress, restoreProgress, drawQuestion, confirmAnswer, roundStatus, createProgressStore } from '../dist/core.mjs';
import { EDITIONS, CONCISE_TOPICS, CONCISE_QUESTION_IDS, initialEdition, editionBank, questionNumber } from '../dist/editions.mjs';

const source = JSON.parse(await readFile(new URL('../dist/questions.json', import.meta.url), 'utf8'));
const now = () => '2026-10-20T08:00:00.000Z';

test('concise edition contains exactly 98 unique original questions and the unchanged finale', () => {
  const original = JSON.stringify(source);
  const concise = editionBank(source, 'concise');
  assert.equal(CONCISE_TOPICS.length, 8);
  assert.equal(CONCISE_TOPICS.flatMap(topic => topic.ids).length, 98);
  assert.equal(new Set(CONCISE_QUESTION_IDS).size, 99);
  assert.deepEqual(auditBank(concise, { expectedCount: 99 }), []);
  for (const question of concise.questions) assert.equal(question, source.questions.find(item => item.id === question.id));
  assert.equal(concise.questions.at(-1).id, '999');
  assert.equal(concise.questions.at(-1).text, source.questions.at(-1).text);
  assert.equal(questionNumber(concise.questions, 'concise', concise.questions.at(-1)), '99');
  assert.equal(JSON.stringify(source), original);
});

test('concise round never draws finale early and stops at exactly 99 confirmed questions', () => {
  const questions = editionBank(source, 'concise').questions;
  let state = freshProgress('concise-bank');
  for (let index = 0; index < 99; index++) {
    const result = drawQuestion(state, questions, length => length - 1, now);
    assert.equal(result.question.id === '999', index === 98);
    assert.equal(drawQuestion(result.state, questions).question, null);
    assert.equal(roundStatus(result.state, questions).finalUnlocked, index === 98);
    if (index === 97) {
      assert.equal(roundStatus(result.state, questions).finalNext, false);
      assert.equal(roundStatus(result.state, questions).answeredCount, 97);
    }
    state = confirmAnswer(result.state, result.question.id, now);
    assert.equal(restoreProgress(JSON.stringify(state), 'concise-bank', questions).reason, null);
    if (index === 97) assert.equal(roundStatus(state, questions).finalNext, true);
  }
  assert.equal(new Set(state.history.map(entry => entry.id)).size, 99);
  assert.equal(roundStatus(state, questions).finished, true);
  assert.equal(drawQuestion(state, questions).question, null);
  assert.equal(roundStatus(freshProgress('concise-bank'), questions).finalUnlocked, false);
});

test('full edition preserves deployed storage key, fingerprint and saved progress exactly', async () => {
  const full = editionBank(source, 'full');
  assert.equal(full, source);
  assert.equal(EDITIONS.full.storageKey, 'before-we-become-us:progress:v2');
  const before = await fingerprintBank(source);
  assert.equal(await fingerprintBank(full), before);
  const existing = drawQuestion(freshProgress(before), source.questions, () => 40, now).state;
  assert.deepEqual(restoreProgress(JSON.stringify(existing), await fingerprintBank(full), full.questions).state, existing);
  assert.equal(questionNumber(full.questions, 'full', full.questions[40]), '41');
});

test('two editions restore and reset their own independent records', async () => {
  const data = new Map();
  const storage = { setItem: (key, value) => data.set(key, value), getItem: key => data.get(key) ?? null, removeItem: key => data.delete(key) };
  const full = editionBank(source, 'full');
  const short = editionBank(source, 'concise');
  const fullId = await fingerprintBank(full);
  const shortId = await fingerprintBank(short);
  assert.notEqual(fullId, shortId);
  const fullStore = createProgressStore(() => storage, EDITIONS.full.storageKey);
  const shortStore = createProgressStore(() => storage, EDITIONS.concise.storageKey);
  const fullProgress = drawQuestion(freshProgress(fullId), full.questions, () => 0, now).state;
  const shortProgress = drawQuestion(freshProgress(shortId), short.questions, () => 1, now).state;
  fullStore.write(fullProgress);
  shortStore.write(shortProgress);
  assert.deepEqual(restoreProgress(shortStore.read(), shortId, short.questions).state, shortProgress);
  shortStore.write(freshProgress(shortId));
  assert.deepEqual(restoreProgress(fullStore.read(), fullId, full.questions).state, fullProgress);
  assert.equal(restoreProgress(shortStore.read(), shortId, short.questions).state.history.length, 0);
  assert.equal(restoreProgress(fullStore.read(), shortId, short.questions).reason, 'bank-changed');
});

test('new visitors default to concise, old full progress resumes, links and explicit preferences take precedence', () => {
  assert.equal(initialEdition(), 'concise');
  assert.equal(initialEdition({ hasLegacyProgress: true }), 'full');
  assert.equal(initialEdition({ remembered: 'concise', hasLegacyProgress: true }), 'concise');
  assert.equal(initialEdition({ requested: 'full', remembered: 'concise' }), 'full');
  assert.equal(initialEdition({ requested: 'concise', remembered: 'full', hasLegacyProgress: true }), 'concise');
  for (const requested of ['garbage', '__proto__', 'constructor', 'toString', '']) assert.equal(initialEdition({ requested }), 'concise');
  assert.throws(() => editionBank(source, '__proto__'), RangeError);
});

test('missing curated questions and missing finale fail validation before publication', () => {
  const missing = { ...source, questions: source.questions.filter(question => question.id !== CONCISE_QUESTION_IDS[0]) };
  assert.throws(() => editionBank(missing, 'concise'), /不在题库中/);
  const short = editionBank(source, 'concise');
  const noFinale = { ...short, questions: [...short.questions.slice(0, 98), { id: 'not-final', text: 'test only' }] };
  assert.ok(auditBank(noFinale, { expectedCount: 99 }).some(issue => issue.includes('最后一题')));
});
