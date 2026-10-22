// Runtime-neutral room protocol. The browser never receives an opponent's
// answer before both immutable submissions are present in the same revision.
export const ROOM_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const roomPattern = /^[a-f0-9]{32}$/;
const jsonLimit = 16 * 1024;
class RoomError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new RoomError(status, message); };
export async function digestToken(token) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
const nameOf = value => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 20 || /[\u0000-\u001f\u007f]/u.test(name)) fail(400, '请填写 1—20 字的称呼。');
  return name;
};
const validToken = value => typeof value === 'string' && tokenPattern.test(value);
const uuid = () => crypto.randomUUID();
function randomIndex(length) {
  const values = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / length) * length;
  do { crypto.getRandomValues(values); } while (values[0] >= limit);
  return values[0] % length;
}
async function readBody(request) {
  if (!(request.headers.get('Content-Type') ?? '').startsWith('application/json')) fail(415, '请使用 JSON 提交。');
  const reader = request.body?.getReader();
  if (!reader) fail(400, '没有收到提交内容。');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > jsonLimit) { await reader.cancel(); fail(413, '提交内容过长。'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const input = JSON.parse(new TextDecoder().decode(bytes));
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, '提交内容格式不正确。');
    return input;
  } catch (error) {
    if (error instanceof RoomError) throw error;
    fail(400, '提交内容无法读取，请重新尝试。');
  }
}

export function createPairService({ banks, answerSchema, normalizeAnswer, now = Date.now, chooseIndex = randomIndex }) {
  const questionOf = (room, id) => banks[room.edition].questions.find(q => q.id === id);
  function newRound(room, firstId) {
    const questions = banks[room.edition].questions;
    const used = new Set(room.completed);
    let pool = questions.filter(q => q.id !== '999' && !used.has(q.id));
    if (!pool.length && room.completed.length === questions.length - 1) pool = questions.filter(q => q.id === '999' && !used.has(q.id));
    if (!pool.length) return null;
    const q = pool.find(q => q.id === firstId) ?? pool[chooseIndex(pool.length)];
    return { id: uuid(), questionId: q.id, a: null, b: null, seenA: false, seenB: false, revealedAt: null };
  }
  function publicState(row, seat) {
    const room = row.state;
    const round = room.round;
    const revealed = Boolean(round?.a && round?.b);
    const question = round ? questionOf(room, round.questionId) : null;
    return {
      roomId: row.id, revision: row.revision, edition: room.edition,
      createdAt: room.createdAt, expiresAt: row.expiresAt, me: seat,
      joined: Boolean(room.guestHash), names: { a: room.hostName, b: room.guestName },
      completedCount: room.completed.length, total: banks[room.edition].questions.length,
      finished: room.completed.length === banks[room.edition].questions.length,
      round: round ? {
        id: round.id, question, number: room.edition === 'full' ? question.id : String(banks[room.edition].questions.findIndex(q => q.id === question.id) + 1),
        schema: answerSchema(question), submitted: { a: Boolean(round.a), b: Boolean(round.b) },
        ownAnswer: round[seat], revealed,
        // Never serialize the raw room or other seat's private answer here.
        answers: revealed ? { a: round.a, b: round.b } : null,
        seen: { a: round.seenA, b: round.seenB }, revealedAt: revealed ? round.revealedAt : null
      } : null
    };
  }
  async function loadRoom(repository, id) {
    const row = await repository.load(id);
    if (!row) fail(404, '房间不存在、已结束或已过期。');
    if (row.expiresAt <= now()) {
      await repository.remove(id);
      fail(410, '这个房间已过期，回答已清理，可以重新邀请对方。');
    }
    if (!banks[row.state.edition] || row.state.bankId !== banks[row.state.edition].bankId) fail(409, '题库版本已更新，请新建房间继续。');
    return row;
  }
  async function seatFor(request, row) {
    const token = (request.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
    if (!validToken(token)) fail(403, '需要本设备的房间身份，请使用邀请链接加入。');
    const hash = await digestToken(token);
    if (hash === row.state.hostHash) return 'a';
    if (hash === row.state.guestHash) return 'b';
    fail(403, '这台设备没有这个房间的访问权限。');
  }
  async function mutate(repository, id, operation) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await loadRoom(repository, id);
      const copy = structuredClone(row.state);
      const outcome = await operation(copy, row);
      if (!outcome?.changed) return outcome?.response ?? row;
      const updated = { ...row, state: copy, revision: row.revision + 1 };
      if (await repository.save(updated, row.revision, outcome.result ?? null)) return updated;
    }
    fail(409, '双方刚刚同时操作了，请稍后重试，已提交的内容不会丢失。');
  }
  async function limited(request, repository) {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'local-preview';
    const hour = Math.floor(now() / 3600000);
    const key = await digestToken(`${hour}:${ip}`);
    if (!await repository.limit(key, now() + 3600000, 20)) fail(429, '这一小时创建或加入房间较多，请稍后再试。');
  }
  return async function handle(request, repository) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    const allowed = !origin || origin === url.origin || origin === 'https://dainty-cyber.github.io' ||
      (local && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
    const cors = {
      'Cache-Control': 'private, no-store', 'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Vary': 'Origin',
      ...(allowed && origin ? { 'Access-Control-Allow-Origin': origin } : {})
    };
    const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
    try {
      if (!allowed) fail(403, '不支持从这个网页访问房间。');
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '600' } });
      if (request.method === 'GET' && url.pathname === '/api/pair/health') return respond({ ok: true, protocol: 1 });
      if (!repository) fail(503, '双人房间暂时无法连接，请稍后再试。');
      if (url.pathname === '/api/pair/rooms' && request.method === 'POST') {
        const input = await readBody(request);
        if (!roomPattern.test(input.roomId ?? '') || !validToken(input.memberToken) || !validToken(input.inviteToken) || input.memberToken === input.inviteToken) fail(400, '房间凭证无效，请重新创建。');
        if (!Object.hasOwn(banks, input.edition)) fail(400, '请选择精简版或完整版。');
        const name = nameOf(input.name);
        const hostHash = await digestToken(input.memberToken);
        const inviteHash = await digestToken(input.inviteToken);
        let row = await repository.load(input.roomId);
        if (row) {
          if (row.state.hostHash !== hostHash || row.state.inviteHash !== inviteHash) fail(409, '房间创建冲突，请重新尝试。');
          row = await loadRoom(repository, input.roomId);
          return respond(publicState(row, 'a'));
        }
        await limited(request, repository);
        await repository.cleanup(now());
        const state = { version: 1, edition: input.edition, bankId: banks[input.edition].bankId,
          hostHash, guestHash: null, inviteHash, hostName: name, guestName: null,
          createdAt: now(), completed: [], round: null };
        // A room starts its own round. A current ordinary card can be the first
        // shared question, but prior personal confirmations are never imported.
        state.round = newRound(state, input.firstQuestionId);
        row = { id: input.roomId, revision: 0, state, expiresAt: now() + ROOM_LIFETIME_MS };
        if (!await repository.create(row)) fail(409, '房间刚刚已创建，请重试。');
        return respond(publicState(row, 'a'), 201);
      }
      const match = /^\/api\/pair\/rooms\/([a-f0-9]{32})(?:\/(join|answer|seen|next|history|close))?$/.exec(url.pathname);
      if (!match) fail(404, '这个房间操作不存在。');
      const [, id, action] = match;
      if (action === 'join' && request.method === 'POST') {
        const input = await readBody(request);
        if (!validToken(input.inviteToken) || !validToken(input.memberToken) || input.memberToken === input.inviteToken) fail(403, '邀请链接无效，请向对方索取完整链接。');
        const inviteHash = await digestToken(input.inviteToken);
        const guestHash = await digestToken(input.memberToken);
        const name = nameOf(input.name);
        await limited(request, repository);
        const row = await mutate(repository, id, (room) => {
          if (room.inviteHash !== inviteHash) fail(403, '邀请链接无效，请向对方索取完整链接。');
          if (guestHash === room.hostHash) fail(409, '你已经是房主，请把邀请链接发给对方。');
          if (room.guestHash && room.guestHash !== guestHash) fail(409, '房间已经有两个人了，请让邀请人重新创建房间。');
          if (room.guestHash === guestHash) return { changed: false };
          room.guestHash = guestHash; room.guestName = name;
          return { changed: true };
        });
        return respond(publicState(row, 'b'));
      }
      const row = await loadRoom(repository, id);
      const seat = await seatFor(request, row);
      if (!action && request.method === 'GET') return respond(publicState(row, seat));
      if (action === 'history' && request.method === 'GET') {
        const history = await repository.history(id);
        return respond({ results: history.map(result => ({ ...result, question: questionOf(row.state, result.questionId) })) });
      }
      if (request.method !== 'POST') fail(405, '这个操作需要提交。');
      const input = await readBody(request);
      if (action === 'close') {
        await repository.remove(id);
        return respond({ closed: true });
      }
      if (!['answer', 'seen', 'next'].includes(action)) fail(404, '这个房间操作不存在。');
      const updated = await mutate(repository, id, async room => {
        if ((seat === 'a' ? room.hostHash : room.guestHash) !== await digestToken((request.headers.get('Authorization') ?? '').replace(/^Bearer /, ''))) fail(403, '房间身份已失效。');
        if (!room.guestHash) fail(409, '等对方加入后，再一起回答。');
        const round = room.round;
        if (!round || round.id !== input.roundId) fail(409, '题目已更新，请刷新当前问题后操作。');
        if (action === 'answer') {
          let answer;
          try { answer = normalizeAnswer(questionOf(room, round.questionId), input.answer); }
          catch (error) { fail(400, error.message); }
          if (round[seat]) {
            if (JSON.stringify(round[seat]) !== JSON.stringify(answer)) fail(409, '答案已锁定，揭晓前后都不能修改。');
            return { changed: false };
          }
          round[seat] = answer;
          if (round.a && round.b) {
            round.revealedAt = now();
            return { changed: true, result: { roomId: id, roundId: round.id, questionId: round.questionId, a: round.a, b: round.b, revealedAt: round.revealedAt } };
          }
          return { changed: true };
        }
        if (!round.a || !round.b) fail(409, '双方都提交并揭晓后，才能继续。');
        if (action === 'seen') {
          const seenKey = seat === 'a' ? 'seenA' : 'seenB';
          if (round[seenKey]) return { changed: false };
          round[seenKey] = true;
          if (round.seenA && round.seenB && !room.completed.includes(round.questionId)) room.completed.push(round.questionId);
          return { changed: true };
        }
        if (!round.seenA || !round.seenB) fail(409, '等双方都点「看完了」后，再抽下一题。');
        if (room.completed.length === banks[room.edition].questions.length) return { changed: false };
        room.round = newRound(room);
        return { changed: true };
      });
      return respond(publicState(updated, seat));
    } catch (error) {
      if (!(error instanceof RoomError)) console.error('Pair service failed:', error?.name ?? 'Error');
      return respond({ error: error instanceof RoomError ? error.message : '暂时无法同步，请稍后重试。', code: error instanceof RoomError ? error.status : 503 }, error instanceof RoomError ? error.status : 503);
    }
  };
}
