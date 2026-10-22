import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPairService, ROOM_LIFETIME_MS } from '../server/pair-service.mjs';
import { createD1Repository } from '../server/d1-repository.mjs';
import { createPreviewDatabase } from '../server/sqlite-preview-db.mjs';
import { editionBank } from '../dist/editions.mjs';
import { fingerprintBank } from '../dist/core.mjs';
import { answerSchema, normalizeAnswer } from '../dist/answer-options.mjs';

const bank = JSON.parse(await readFile(new URL('../dist/questions.json', import.meta.url), 'utf8'));
const banks = {};
for (const key of ['concise', 'full']) { const selected = editionBank(bank, key); banks[key] = { questions: selected.questions, bankId: await fingerprintBank(selected) }; }
const token = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
function fixture(selectedBanks = banks) {
  const database = createPreviewDatabase();
  const repository = createD1Repository(database);
  let time = Date.parse('2026-10-22T04:00:00.000Z');
  const service = createPairService({ banks: selectedBanks, answerSchema, normalizeAnswer, now: () => time, chooseIndex: () => 0 });
  const id = crypto.randomUUID().replace(/-/g, '');
  const a = token(), b = token(), invite = token();
  const call = async (action = '', { who = a, body, headers = {}, raw, path, method = (body || raw) ? 'POST' : 'GET' } = {}) => {
    const response = await service(new Request(`https://room.test/api/pair${path ?? `/rooms/${id}${action ? `/${action}` : ''}`}`, {
      method, headers: { ...(who ? { Authorization: `Bearer ${who}` } : {}), ...(body || raw ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body || raw ? { body: raw ?? JSON.stringify(body) } : {})
    }), repository);
    return { status: response.status, value: await response.json(), response };
  };
  const create = (extra = {}) => call('', { path: '/rooms', who: null, body: { roomId: id, memberToken: a, inviteToken: invite, name: '小云', edition: 'concise', firstQuestionId: '2', ...extra } });
  const join = () => call('join', { who: null, body: { memberToken: b, inviteToken: invite, name: '小林' } });
  return { database, repository, id, a, b, invite, call, create, join, advanceTime: n => { time += n; } };
}

test('all 99 concise questions have useful options plus custom writing without changing original text', () => {
  for (const question of banks.concise.questions) {
    const before = JSON.stringify(question);
    const schema = answerSchema(question);
    assert.ok(schema.options.length >= 3, question.id);
    assert.equal(schema.options.at(-1).id, 'custom');
    assert.equal(new Set(schema.options.map(o => o.id)).size, schema.options.length);
    assert.equal(JSON.stringify(question), before);
    assert.throws(() => normalizeAnswer(question, { choiceId: 'not-an-option' }));
    assert.throws(() => normalizeAnswer(question, { choiceId: 'custom', text: '   ' }));
    assert.throws(() => normalizeAnswer(question, { choiceId: 'custom', text: '字'.repeat(501) }));
    assert.equal(normalizeAnswer(question, { choiceId: 'custom', text: '  我的想法  ' }).text, '我的想法');
  }
});

test('first submission never reaches the other participant, history or unauthenticated visitors', async t => {
  const f = fixture(); t.after(() => f.database.close());
  const created = await f.create(); assert.equal(created.status, 201); assert.equal(created.value.joined, false);
  const again = await f.create(); assert.equal(again.value.roomId, created.value.roomId);
  assert.equal((await f.call('answer', { body: { roundId: created.value.round.id, answer: { choiceId: 'c0' } } })).status, 409);
  await f.join();
  const roundId = created.value.round.id;
  const first = await f.call('answer', { body: { roundId, answer: { choiceId: 'custom', text: 'ONLY_ALICE_SECRET' } } });
  assert.equal(first.status, 200); assert.equal(first.value.round.revealed, false);
  assert.equal(first.value.round.ownAnswer.text, 'ONLY_ALICE_SECRET');
  const hidden = await f.call('', { who: f.b });
  assert.equal(hidden.value.round.ownAnswer, null); assert.equal(hidden.value.round.answers, null);
  assert.ok(!JSON.stringify(hidden.value).includes('ONLY_ALICE_SECRET'));
  assert.deepEqual((await f.call('history', { who: f.b })).value.results, []);
  assert.equal((await f.call('', { who: null })).status, 403);
  assert.equal((await f.call('history', { who: f.invite })).status, 403);
  assert.equal((await f.call('', { who: token() })).status, 403);
  assert.ok(!JSON.stringify(first.value).includes(f.a));
  assert.ok(!JSON.stringify(first.value).includes('hostHash'));
  const second = await f.call('answer', { who: f.b, body: { roundId, answer: { choiceId: 'c1', text: 'ONLY_BOB_SECRET' } } });
  assert.equal(second.value.round.revealed, true);
  assert.equal(second.value.round.answers.a.text, 'ONLY_ALICE_SECRET');
  assert.equal((await f.call()).value.round.answers.b.text, 'ONLY_BOB_SECRET');
  assert.equal((await f.call('history')).value.results.length, 1);
  assert.equal(hidden.response.headers.get('Cache-Control'), 'private, no-store');
});

test('simultaneous immutable submissions survive CAS retries, and stale next cannot skip a question', async t => {
  const f = fixture(); t.after(() => f.database.close());
  const c = await f.create(); await f.join(); const roundId = c.value.round.id;
  const payload = { roundId, answer: { choiceId: 'c0' } };
  const [a, b] = await Promise.all([f.call('answer', { body: payload }), f.call('answer', { who: f.b, body: { roundId, answer: { choiceId: 'c1' } } })]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const state = (await f.call()).value;
  assert.equal(state.round.answers.a.choiceId, 'c0'); assert.equal(state.round.answers.b.choiceId, 'c1');
  assert.equal((await f.call('answer', { body: payload })).status, 200, 'Same retry is idempotent');
  assert.equal((await f.call('answer', { body: { roundId, answer: { choiceId: 'c1' } } })).status, 409, 'Answer cannot be changed');
  assert.equal((await f.call('next', { body: { roundId } })).status, 409);
  await f.call('seen', { body: { roundId } });
  assert.equal((await f.call('next', { body: { roundId } })).status, 409);
  assert.equal((await f.call()).value.completedCount, 0);
  await f.call('seen', { who: f.b, body: { roundId } });
  const results = await Promise.all([f.call('next', { body: { roundId } }), f.call('next', { who: f.b, body: { roundId } })]);
  assert.ok(results.some(r => r.status === 200));
  const after = (await f.call()).value;
  assert.equal(after.completedCount, 1); assert.notEqual(after.round.id, roundId); assert.notEqual(after.round.question.id, '2');
  assert.equal((await f.call('history')).value.results.length, 1);
});

test('only one guest can claim an invite, including simultaneous joins and lost-response retries', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.create();
  const third = token();
  const responses = await Promise.all([f.join(), f.call('join', { who: null, body: { memberToken: third, inviteToken: f.invite, name: '第三个人' } })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const winner = responses[0].status === 200 ? f.b : third;
  assert.equal((await f.call('join', { who: null, body: { memberToken: winner, inviteToken: f.invite, name: '原参与者' } })).status, 200);
  assert.equal((await f.call('join', { who: null, body: { memberToken: token(), inviteToken: token(), name: '无效邀请' } })).status, 403);
});

test('entire concise room completes exactly 98 ordinary questions before the original finale', async t => {
  const f = fixture(); t.after(() => f.database.close());
  let result = (await f.create({ firstQuestionId: '999' })).value; await f.join();
  const drawn = [];
  for (let index = 0; index < 99; index++) {
    const round = result.round; drawn.push(round.question.id);
    if (index < 98) assert.notEqual(round.question.id, '999'); else assert.equal(round.question.id, '999');
    const answer = { choiceId: 'custom', text: `独立回答第 ${index + 1} 题` };
    await f.call('answer', { body: { roundId: round.id, answer } });
    result = (await f.call('answer', { who: f.b, body: { roundId: round.id, answer } })).value;
    await f.call('seen', { body: { roundId: round.id } });
    result = (await f.call('seen', { who: f.b, body: { roundId: round.id } })).value;
    assert.equal(result.completedCount, index + 1);
    result = (await f.call('next', { body: { roundId: round.id } })).value;
  }
  assert.equal(new Set(drawn).size, 99);
  assert.equal(result.finished, true);
  assert.equal((await f.call('history')).value.results.length, 99);
});

test('room expiry and explicit deletion remove both answers and deny old credentials', async t => {
  const f = fixture(); t.after(() => f.database.close());
  const c = await f.create(); await f.join();
  for (const who of [f.a, f.b]) await f.call('answer', { who, body: { roundId: c.value.round.id, answer: { choiceId: 'c0' } } });
  assert.equal((await f.call('history')).value.results.length, 1);
  assert.equal((await f.call('close', { who: f.b, body: {} })).status, 200);
  assert.equal(await f.repository.load(f.id), null); assert.deepEqual(await f.repository.history(f.id), []);
  assert.equal((await f.call()).status, 404);
  await f.create(); f.advanceTime(ROOM_LIFETIME_MS + 1);
  assert.equal((await f.call()).status, 410);
  assert.equal(await f.repository.load(f.id), null);
});

test('full room keeps question 999 locked until both confirm the 998th ordinary question', async t => {
  const f = fixture(); t.after(() => f.database.close());
  await f.create({ edition: 'full' }); await f.join();
  const row = await f.repository.load(f.id);
  row.state.completed = banks.full.questions.filter(q => q.id !== '999').slice(0, 997).map(q => q.id);
  row.state.round.questionId = '998';
  row.revision++;
  assert.equal(await f.repository.save(row, row.revision - 1), true);
  const roundId = row.state.round.id;
  for (const who of [f.a, f.b]) await f.call('answer', { who, body: { roundId, answer: { choiceId: 'custom', text: '自己的独立回答' } } });
  await f.call('seen', { body: { roundId } });
  assert.equal((await f.call()).value.completedCount, 997);
  assert.equal((await f.call('next', { body: { roundId } })).status, 409);
  await f.call('seen', { who: f.b, body: { roundId } });
  const final = (await f.call('next', { body: { roundId } })).value;
  assert.equal(final.completedCount, 998);
  assert.equal(final.round.question.id, '999');
});

test('bad payloads, unapproved origins and forged choices fail before writes', async t => {
  const f = fixture(); t.after(() => f.database.close());
  assert.equal((await f.call('', { path: '/rooms', who: null, raw: '{invalid' })).status, 400);
  assert.equal((await f.call('', { path: '/rooms', who: null, raw: JSON.stringify({ data: 'x'.repeat(17000) }) })).status, 413);
  const c = await f.create(); await f.join();
  const blocked = await f.call('', { headers: { Origin: 'https://stranger.test' } });
  assert.equal(blocked.status, 403); assert.equal(blocked.response.headers.get('Access-Control-Allow-Origin'), null);
  const permitted = await f.call('', { headers: { Origin: 'https://dainty-cyber.github.io' } });
  assert.equal(permitted.response.headers.get('Access-Control-Allow-Origin'), 'https://dainty-cyber.github.io');
  const before = (await f.call()).value.revision;
  for (const answer of [{ choiceId: 'fake' }, { choiceId: 'custom', text: '' }, { choiceId: 'c0', text: 'x'.repeat(501) }]) assert.equal((await f.call('answer', { body: { roundId: c.value.round.id, answer } })).status, 400);
  assert.equal((await f.call()).value.revision, before);
});
