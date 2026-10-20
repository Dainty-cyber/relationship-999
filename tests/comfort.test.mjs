import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { freshProgress, restoreProgress, drawQuestion, confirmAnswer, deferQuestion, resumeQuestion, roundStatus, fingerprintBank } from '../dist/core.mjs';
import { editionBank } from '../dist/editions.mjs';
import { makeBackup, parseBackup, MAX_BACKUP_BYTES } from '../dist/backup.mjs';

const source = JSON.parse(await readFile(new URL('../dist/questions.json', import.meta.url), 'utf8'));
const concise = editionBank(source, 'concise');
const shortId = await fingerprintBank(concise);
const fullId = await fingerprintBank(source);
const banks = { concise: { bankId: shortId, questions: concise.questions }, full: { bankId: fullId, questions: source.questions } };
const now = () => '2026-10-20T08:00:00.000Z';
const first = () => drawQuestion(freshProgress(shortId), concise.questions, () => 0, now).state;

test('deferring leaves a question unanswered, reserves it once and allows a new question', () => {
  const initial = first();
  const id = initial.currentId;
  const held = deferQuestion(initial, id, now);
  assert.equal(held.currentId, null);
  assert.equal(held.history[0].answeredAt, null);
  assert.equal(roundStatus(held, concise.questions).answeredCount, 0);
  assert.equal(roundStatus(held, concise.questions).deferredCount, 1);
  assert.deepEqual(restoreProgress(JSON.stringify(held), shortId, concise.questions).state, held);
  const next = drawQuestion(held, concise.questions, () => 0, now);
  assert.notEqual(next.question.id, id);
  assert.equal(next.state.history.length, 2);
  assert.equal(initial.history[0].deferredAt, null, 'Original state is immutable');
});

test('resuming an older deferred question puts the current one aside without losing either', () => {
  const initial = first();
  const oldId = initial.currentId;
  const next = drawQuestion(deferQuestion(initial, oldId, now), concise.questions, () => 0, now).state;
  const newId = next.currentId;
  const resumed = resumeQuestion(next, oldId, now);
  assert.equal(resumed.currentId, oldId);
  assert.equal(resumed.history.length, 2);
  assert.equal(resumed.history.find(entry => entry.id === oldId).deferredAt, null);
  assert.ok(resumed.history.find(entry => entry.id === newId).deferredAt);
  const confirmed = confirmAnswer(resumed, oldId, now);
  assert.ok(confirmed.history[0].answeredAt);
  assert.equal(confirmed.history[1].answeredAt, null);
  assert.equal(roundStatus(confirmed, concise.questions).deferredCount, 1);
  assert.equal(restoreProgress(JSON.stringify(confirmed), shortId, concise.questions).reason, null);
  assert.equal(confirmAnswer(resumed, newId, now), resumed, 'A stale click cannot confirm another card');
});

test('all 98 deferred questions block the finale until each is explicitly resumed and confirmed', () => {
  let state = freshProgress(shortId);
  for (let index = 0; index < 98; index++) {
    const result = drawQuestion(state, concise.questions, () => 0, now);
    assert.notEqual(result.question.id, '999');
    state = deferQuestion(result.state, result.question.id, now);
  }
  const status = roundStatus(state, concise.questions);
  assert.equal(state.history.length, 98);
  assert.equal(new Set(state.history.map(entry => entry.id)).size, 98);
  assert.equal(status.needsReview, true);
  assert.equal(status.answeredCount, 0);
  assert.equal(status.deferredCount, 98);
  assert.equal(status.finalUnlocked, false);
  assert.equal(drawQuestion(state, concise.questions).question, null);
  for (const id of state.history.map(entry => entry.id)) {
    state = confirmAnswer(resumeQuestion(state, id, now), id, now);
    assert.equal(restoreProgress(state, shortId, concise.questions).reason, null);
  }
  assert.equal(roundStatus(state, concise.questions).finalNext, true);
  const finale = drawQuestion(state, concise.questions, () => 0, now);
  assert.equal(finale.question.id, '999');
  assert.equal(deferQuestion(finale.state, '999', now), finale.state);
  assert.equal(roundStatus(confirmAnswer(finale.state, '999', now), concise.questions).finished, true);
});

test('legacy v2 records retain every original ID, date and confirmation state on upgrade', () => {
  const old = { version: 2, bankId: shortId, history: [
    { id: concise.questions[0].id, drawnAt: now(), answeredAt: now() },
    { id: concise.questions[1].id, drawnAt: now(), answeredAt: null }
  ] };
  const snapshot = JSON.stringify(old);
  const restored = restoreProgress(snapshot, shortId, concise.questions);
  assert.equal(restored.reason, null);
  assert.equal(restored.state.version, 3);
  assert.equal(restored.state.currentId, concise.questions[1].id);
  assert.deepEqual(restored.state.history.map(({ deferredAt, ...entry }) => entry), old.history);
  assert.ok(restored.state.history.every(entry => entry.deferredAt === null));
  assert.equal(JSON.stringify(old), snapshot);
});

test('invalid active/deferred combinations cannot be restored or used to unlock the finale', () => {
  const valid = first();
  const invalids = [
    { ...valid, currentId: 'missing' },
    { ...valid, currentId: null },
    { ...valid, history: [{ ...valid.history[0], deferredAt: now() }] },
    { ...valid, currentId: null, history: [{ ...valid.history[0], answeredAt: now(), deferredAt: now() }] },
    { ...valid, currentId: null, history: [{ ...valid.history[0], deferredAt: 'invalid' }] }
  ];
  for (const candidate of invalids) assert.equal(restoreProgress(candidate, shortId, concise.questions).reason, 'invalid');
});

test('backup roundtrip preserves active question, deferred queue and confirmations', () => {
  const a = first();
  const b = drawQuestion(deferQuestion(a, a.currentId, now), concise.questions, () => 0, now).state;
  const backup = makeBackup('concise', b, concise.questions, now);
  const restored = parseBackup(JSON.stringify(backup), banks);
  assert.equal(restored.edition, 'concise');
  assert.deepEqual(restored.progress, b);
  assert.equal(roundStatus(restored.progress, concise.questions).deferredCount, 1);
  assert.ok(!JSON.stringify(backup).includes(concise.questions[0].text), 'Backups contain progress, not question texts');
});

test('backup format accepts valid legacy state while keeping edition identity', () => {
  const current = first();
  const legacy = { version: 2, bankId: shortId, history: current.history.map(({ deferredAt, ...entry }) => entry) };
  const backup = makeBackup('concise', legacy, concise.questions, now);
  assert.equal(backup.progress.version, 3);
  assert.equal(parseBackup('\uFEFF' + JSON.stringify(backup), banks).progress.currentId, current.currentId);
  const full = drawQuestion(freshProgress(fullId), source.questions, () => 10, now).state;
  const fullBackup = parseBackup(JSON.stringify(makeBackup('full', full, source.questions, now)), banks);
  assert.equal(fullBackup.edition, 'full');
  assert.deepEqual(fullBackup.progress, full);
});

test('corrupt, oversized, mismatched and tampered backups are rejected before writes', () => {
  const progress = first();
  const valid = makeBackup('concise', progress, concise.questions, now);
  const snapshot = JSON.stringify(progress);
  for (const value of [null, {}, { ...valid, edition: '__proto__' }, { ...valid, version: 9 },
    { ...valid, progress: null }, { ...valid, exportedAt: 'bad' },
    { ...valid, progress: { ...progress, bankId: 'another-bank' } },
    { ...valid, progress: { ...progress, history: [...progress.history, progress.history[0]] } }]) {
    assert.throws(() => parseBackup(JSON.stringify(value), banks));
  }
  assert.throws(() => parseBackup('{broken', banks), /无法读取/);
  assert.throws(() => parseBackup('x'.repeat(MAX_BACKUP_BYTES + 1), banks), /过大/);
  assert.equal(JSON.stringify(progress), snapshot);
});
