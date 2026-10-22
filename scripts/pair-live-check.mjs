// Public-service acceptance check. All identities/answers belong to this check;
// credentials stay in memory, and its room is deleted even after a failure.
import assert from 'node:assert/strict';

const base = process.argv[2];
if (!base) throw new Error('Provide the deployed HTTPS service origin.');
const origin = new URL(base);
if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname))) throw new Error('Use HTTPS for the deployed service.');
const id = crypto.randomUUID().replace(/-/g, '');
const token = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const a = token(), b = token(), invite = token();
let created = false;
const secretA = `独立回答A-${crypto.randomUUID()}`;
const secretB = `独立回答B-${crypto.randomUUID()}`;
async function request(suffix = '', { method = 'GET', who = a, body, path, headers = {} } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${new URL(base).origin}/api/pair${path ?? `/rooms/${id}${suffix ? `/${suffix}` : ''}`}`, {
      method, signal: controller.signal, headers: {
        Origin: 'https://dainty-cyber.github.io',
        ...(who ? { Authorization: `Bearer ${who}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers
      }, ...(body ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text();
    let value;
    try { value = response.status === 204 ? null : JSON.parse(text); } catch { throw new Error(`Public room service returned HTTP ${response.status} instead of JSON.`); }
    return { status: response.status, value, response };
  } finally { clearTimeout(timeout); }
}
try {
  for (const path of ['/rooms', `/rooms/${id}/answer`]) {
    const preflight = await request('', { path, method: 'OPTIONS', who: null, headers: {
      'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type'
    } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.response.headers.get('Access-Control-Allow-Origin'), 'https://dainty-cyber.github.io');
    assert.match(preflight.response.headers.get('Access-Control-Allow-Methods'), /POST/);
    assert.match(preflight.response.headers.get('Access-Control-Allow-Headers').toLowerCase(), /authorization/);
    assert.match(preflight.response.headers.get('Access-Control-Allow-Headers').toLowerCase(), /content-type/);
  }
  const health = await request('', { path: '/health', who: null });
  assert.equal(health.status, 200);
  assert.equal(health.value.protocol, 1);
  const create = await request('', { method: 'POST', path: '/rooms', who: null, body: { roomId: id, memberToken: a, inviteToken: invite, name: '发布检查A', edition: 'concise', firstQuestionId: '2' } });
  assert.equal(create.status, 201); created = true;
  const roundId = create.value.round.id;
  assert.equal(create.value.round.question.id, '2');
  assert.equal(create.response.headers.get('Access-Control-Allow-Origin'), 'https://dainty-cyber.github.io');
  assert.equal((await request('join', { method: 'POST', who: null, body: { memberToken: b, inviteToken: invite, name: '发布检查B' } })).status, 200);
  const first = await request('answer', { method: 'POST', body: { roundId, answer: { choiceId: 'c0', text: secretA } } });
  assert.equal(first.status, 200); assert.equal(first.value.round.answers, null);
  const hidden = await request('', { who: b });
  assert.equal(hidden.value.round.answers, null); assert.equal(hidden.value.round.ownAnswer, null);
  assert.ok(!JSON.stringify(hidden.value).includes(secretA));
  assert.equal(hidden.response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal((await request('history', { who: b })).value.results.length, 0);
  assert.equal((await request('', { who: null })).status, 403);
  assert.equal((await request('', { who: invite })).status, 403);
  const revealed = await request('answer', { method: 'POST', who: b, body: { roundId, answer: { choiceId: 'c1', text: secretB } } });
  assert.equal(revealed.status, 200); assert.equal(revealed.value.round.revealed, true);
  assert.equal(revealed.value.round.answers.a.text, secretA); assert.equal(revealed.value.round.answers.b.text, secretB);
  assert.equal((await request()).value.round.answers.b.text, secretB);
  assert.equal((await request('answer', { method: 'POST', body: { roundId, answer: { choiceId: 'c2' } } })).status, 409);
  assert.equal((await request('next', { method: 'POST', body: { roundId } })).status, 409);
  await request('seen', { method: 'POST', body: { roundId } });
  assert.equal((await request('next', { method: 'POST', body: { roundId } })).status, 409);
  await request('seen', { method: 'POST', who: b, body: { roundId } });
  const next = await request('next', { method: 'POST', body: { roundId } });
  assert.equal(next.status, 200); assert.equal(next.value.completedCount, 1);
  assert.notEqual(next.value.round.question.id, '999'); assert.notEqual(next.value.round.question.id, '2');
  assert.equal((await request('history')).value.results.length, 1);
  assert.equal((await request('close', { method: 'POST', who: b, body: {} })).status, 200);
  assert.equal((await request()).status, 404); created = false;
  console.log('Public paired service verified: anonymous create/join, GitHub CORS and browser preflight, hidden first answer, mutual reveal, immutable submissions, mutual confirmation, next question, history and deletion.');
} finally {
  if (created) await request('close', { method: 'POST', body: {} }).catch(() => {});
}
