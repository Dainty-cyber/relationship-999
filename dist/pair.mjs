import { PAIR_API_ORIGIN } from './pair-config.mjs';
import { EDITIONS, isEdition } from './editions.mjs';

const $ = id => document.getElementById(id);
const roomKey = 'before-we-become-us:pair:members:v1';
const inviteKey = 'before-we-become-us:pair:invitation:v1';
const local = ['localhost', '127.0.0.1'].includes(location.hostname);
const apiOrigin = local || location.origin === PAIR_API_ORIGIN ? location.origin : PAIR_API_ORIGIN;
let records = [];
let persistent = true;
let invitation = null;
let membership = null;
let room = null;
let busy = false;
let syncing = false;
let uncertain = false;
let closed = false;
let renderedRound = null;
let draft = { choiceId: '', text: '' };
let draftCreate = null;
let timer;
let toastTimer;
const url = new URL(location.href);
const fragment = new URLSearchParams(url.hash.slice(1));
const roomPattern = /^[a-f0-9]{32}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
try {
  const saved = JSON.parse(localStorage.getItem(roomKey) ?? '[]');
  if (Array.isArray(saved)) records = saved.filter(x => roomPattern.test(x?.roomId ?? '') && tokenPattern.test(x?.memberToken ?? '')).slice(-10);
  localStorage.setItem(`${roomKey}:probe`, '1'); localStorage.removeItem(`${roomKey}:probe`);
} catch { persistent = false; }
function storageWarning() { $('pair-storage-warning').hidden = persistent; }
function saveRecord(record) {
  records = [...records.filter(x => x.roomId !== record.roomId), record].slice(-10);
  try { localStorage.setItem(roomKey, JSON.stringify(records)); } catch { persistent = false; storageWarning(); }
}
function forgetRecord(id) {
  records = records.filter(x => x.roomId !== id);
  try { localStorage.setItem(roomKey, JSON.stringify(records)); } catch { /* In-memory use remains possible. */ }
}
function toast(message) {
  clearTimeout(toastTimer); $('pair-toast').textContent = message; $('pair-toast').hidden = false;
  toastTimer = setTimeout(() => { $('pair-toast').hidden = true; }, 4500);
}
function errorAt(id, message) { $(id).textContent = message; $(id).hidden = !message; }
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function api(path, { method = 'GET', body, credentials = membership } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${apiOrigin}/api/pair${path}`, {
      method, credentials: 'omit', cache: 'no-store', signal: controller.signal,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(credentials ? { Authorization: `Bearer ${credentials.memberToken}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    let value;
    try { value = await response.json(); } catch { throw new Error('双人服务暂时没有响应，请稍后重新同步。'); }
    if (!response.ok) { const error = new Error(value.error ?? '暂时无法同步。'); error.status = response.status; throw error; }
    return value;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('连接超时，请重新同步后继续。');
    if (error instanceof TypeError) throw new Error('暂时连不上双人房间，请检查网络后重新同步。');
    throw error;
  } finally { clearTimeout(timeout); }
}
function formatAnswer(answer) {
  return `${answer.choiceId === 'custom' ? '' : answer.label}${answer.text ? `${answer.choiceId === 'custom' ? '' : '\n'}${answer.text}` : ''}`;
}
function connection(message, offline = false) {
  $('pair-connection').textContent = message;
  $('pair-connection').classList.toggle('is-offline', offline);
}
function showUnavailable(message) {
  closed = true; clearTimeout(timer);
  $('pair-room').hidden = true; $('pair-lobby').hidden = true;
  $('pair-unavailable').hidden = false; $('pair-unavailable-note').textContent = message;
  if (membership) forgetRecord(membership.roomId);
  if ($('pair-close-dialog').open) $('pair-close-dialog').close();
}
function saveDraft() {
  if (!room?.round) return;
  try { sessionStorage.setItem(`pair:draft:${room.roomId}:${room.round.id}`, JSON.stringify(draft)); } catch { /* Draft still stays on screen. */ }
}
function buildChoices(round) {
  renderedRound = round.id;
  draft = { choiceId: round.schema.customOnly ? 'custom' : '', text: '' };
  try {
    const saved = JSON.parse(sessionStorage.getItem(`pair:draft:${room.roomId}:${round.id}`));
    if (saved && round.schema.options.some(o => o.id === saved.choiceId) && typeof saved.text === 'string') draft = { choiceId: saved.choiceId, text: saved.text.slice(0, 500) };
  } catch { /* Empty draft. */ }
  $('pair-choices').replaceChildren();
  const legend = document.createElement('legend'); legend.textContent = '我的选择'; $('pair-choices').append(legend);
  for (const option of round.schema.options) {
    const label = document.createElement('label'); label.className = 'pair-option';
    const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'answer'; radio.value = option.id; radio.checked = draft.choiceId === option.id;
    const text = document.createElement('span'); text.textContent = option.label;
    radio.addEventListener('change', () => { draft.choiceId = option.id; saveDraft(); updateDraftControls(); });
    label.append(radio, text); $('pair-choices').append(label);
  }
  $('pair-answer-text').value = draft.text;
  updateDraftControls();
}
function updateDraftControls() {
  const selected = room?.round?.schema.options.find(o => o.id === draft.choiceId);
  $('pair-text-label').textContent = selected?.requiresText ? '写下你的具体想法（此选项需要填写）' : '也可以补充一句自己的想法';
  $('pair-text-count').textContent = `${draft.text.length} / 500`;
  $('pair-submit').disabled = busy || uncertain || !room?.joined || !selected || (selected.requiresText && !draft.text.trim());
  $('pair-answer-text').disabled = busy || uncertain || !room?.joined;
  $('pair-choices').querySelectorAll('input').forEach(input => { input.disabled = busy || uncertain || !room?.joined; });
}
function renderRoom(next) {
  if (closed) return;
  // An older response from an in-flight poll cannot overwrite a mutation.
  if (room && room.roomId === next.roomId && next.revision < room.revision) return;
  room = next;
  document.body.classList.add('is-in-room');
  $('pair-lobby').hidden = true; $('pair-room').hidden = false; $('pair-unavailable').hidden = true;
  $('pair-enter').disabled = false;
  const other = room.me === 'a' ? 'b' : 'a';
  const round = room.round;
  const shownName = seat => `${room.names[seat] ?? '等待 TA 加入'}${seat === room.me ? '（我）' : ''}`;
  $('pair-room-label').textContent = `${EDITIONS[room.edition].label} · 两个人的小房间`;
  $('pair-invite').hidden = room.me !== 'a' || !membership?.inviteToken || room.joined;
  if (room.joined) $('pair-link-fallback').hidden = true;
  for (const seat of ['a', 'b']) {
    $(`pair-name-${seat}`).textContent = shownName(seat);
    $(`pair-status-${seat}`).textContent = !room.names[seat] ? '邀请链接已为 TA 留好' : (round?.submitted[seat] ? (round.revealed ? '答案已揭晓' : '答案已锁定') : '正在独立作答');
  }
  $('pair-question-number').textContent = `第 ${round.number} 题${room.edition === 'concise' ? ` · 原题号 ${round.question.id}` : ''}`;
  $('pair-question').textContent = round.question.text;
  $('pair-phase').textContent = !room.joined ? '等待对方加入' : (round.revealed ? '一起揭晓' : (round.submitted[room.me] ? '已锁定，等 TA 准备好' : '先独立想一想'));
  $('pair-answer-hint').textContent = !room.joined ? '把邀请链接发给 TA。两人到齐后，就能各自选择自己的答案。'
    : (round.revealed ? '这是两个人各自的想法，可以在这里慢慢读完。'
      : (round.schema.customOnly ? '这题适合用自己的话回答。提交前，内容只保存在本标签页。' : '选最接近你想法的一项，也可以自己写。选项没有对错。'));
  const submitted = round.submitted[room.me];
  $('pair-answer-form').hidden = submitted || round.revealed;
  $('pair-waiting').hidden = !submitted || round.revealed;
  $('pair-results').hidden = !round.revealed;
  if (renderedRound !== round.id) buildChoices(round);
  updateDraftControls();
  if (submitted) {
    $('pair-own-answer').textContent = `只有你能先看见自己的答案：\n${formatAnswer(round.ownAnswer)}`;
    try { sessionStorage.removeItem(`pair:draft:${room.roomId}:${round.id}`); } catch { /* Optional. */ }
  }
  if (round.revealed) {
    for (const seat of ['a', 'b']) {
      $(`pair-result-name-${seat}`).textContent = shownName(seat);
      const answer = round.answers[seat];
      $(`pair-result-choice-${seat}`).textContent = answer.choiceId === 'custom' ? '想对你说' : answer.label;
      $(`pair-result-text-${seat}`).textContent = answer.text;
      $(`pair-result-text-${seat}`).hidden = !answer.text;
    }
    $('pair-seen').hidden = round.seen[room.me];
    $('pair-seen').disabled = busy || uncertain;
    $('pair-seen-note').textContent = room.finished ? '这一轮，每一个问题都有了两个人的回应。谢谢彼此的认真。'
      : (round.seen[room.me] && !round.seen[other] ? '你已看完，等 TA 也点「看完了」，再一起继续。' : (round.seen.a && round.seen.b ? '两个人都已看完，可以一起抽下一签。' : '双方都看完，才会计入进度并开启下一题。'));
    $('pair-next').hidden = room.finished || !round.seen.a || !round.seen.b;
    $('pair-next').disabled = busy || uncertain;
    $('pair-next').textContent = room.completedCount === room.total - 1 ? `一起揭开第 ${room.total} 题` : '一起抽下一题 →';
  }
  $('pair-progress').textContent = `共同聊完 ${room.completedCount} / ${room.total} 题${room.finished ? ' · 这一轮，圆满了' : (room.completedCount < room.total - 1 ? ` · 前 ${room.total - 1} 题都完成后，解锁最后一签` : ' · 最后一签已解锁')}`;
  $('pair-expiry').textContent = `房间有效至 ${new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(room.expiresAt))}。结束并删除后，双方记录都会清空。`;
  connection('已同步 · 双方提交前，彼此的答案都不会传给对方');
  errorAt('pair-action-error', '');
  storageWarning();
}
function schedulePoll() {
  clearTimeout(timer);
  if (membership && !closed) timer = setTimeout(sync, document.hidden ? 12000 : 2500);
}
async function sync() {
  if (!membership || busy || syncing || closed) { schedulePoll(); return; }
  syncing = true;
  try {
    const state = await api(`/rooms/${membership.roomId}`);
    uncertain = false; renderRoom(state);
  } catch (error) {
    if ([404, 410, 403].includes(error.status)) showUnavailable(error.message);
    else connection(`${error.message} 已提交的答案会继续保留。`, true);
  } finally { syncing = false; schedulePoll(); }
}
async function action(type, body = {}) {
  if (busy || uncertain || !membership || !room) return;
  busy = true; renderRoom(room);
  try {
    const result = await api(`/rooms/${membership.roomId}/${type}`, { method: 'POST', body: { roundId: room.round.id, ...body } });
    if (type === 'close') { showUnavailable('房间已经结束，双方的回答与邀请链接都已删除。'); return; }
    renderRoom(result);
  } catch (error) {
    if ([404, 410, 403].includes(error.status)) { showUnavailable(error.message); return; }
    // A failed response might follow a successful write. Freeze the draft
    // until an authoritative read establishes whether the answer was locked.
    uncertain = !error.status;
    errorAt('pair-action-error', `${error.message}${uncertain ? ' 请先重新同步，确认答案状态后再操作。' : ''}`);
    connection('同步尚未完成，请重新同步确认状态。', true);
  } finally {
    busy = false;
    if (room && !closed) {
      updateDraftControls(); $('pair-seen').disabled = uncertain; $('pair-next').disabled = uncertain;
    }
    schedulePoll();
  }
}
function enterRoom(result, record) {
  membership = { ...record, pending: false, edition: result.edition, expiresAt: result.expiresAt };
  saveRecord(membership); closed = false; uncertain = false; room = null; renderedRound = null;
  const nextUrl = new URL(location.href); nextUrl.hash = ''; nextUrl.search = ''; nextUrl.searchParams.set('room', result.roomId);
  history.replaceState(null, '', nextUrl.href);
  try { sessionStorage.removeItem(inviteKey); } catch { /* Optional. */ }
  invitation = null;
  renderRoom(result); schedulePoll();
}
async function enter(event) {
  event.preventDefault();
  if (busy) return;
  busy = true; $('pair-enter').disabled = true; errorAt('pair-entry-error', '');
  const name = $('pair-name').value.trim();
  try {
    if (invitation) {
      const old = records.find(x => x.roomId === invitation.roomId);
      const record = old ?? { roomId: invitation.roomId, memberToken: randomToken(), name, pending: true };
      saveRecord(record);
      const result = await api(`/rooms/${record.roomId}/join`, { method: 'POST', credentials: null, body: { name, memberToken: record.memberToken, inviteToken: invitation.inviteToken } });
      enterRoom(result, record);
    } else {
      const edition = new FormData($('pair-entry-form')).get('edition');
      draftCreate ??= { roomId: crypto.randomUUID().replace(/-/g, ''), memberToken: randomToken(), inviteToken: randomToken(), edition, name, pending: true, firstQuestionId: url.searchParams.get('question') };
      saveRecord(draftCreate);
      const result = await api('/rooms', { method: 'POST', credentials: null, body: draftCreate });
      enterRoom(result, draftCreate); draftCreate = null;
      $('pair-link-fallback').hidden = false;
      $('pair-invite-url').value = inviteUrl();
    }
  } catch (error) { errorAt('pair-entry-error', error.message); }
  finally { busy = false; $('pair-enter').disabled = false; if (room) renderRoom(room); }
}
function inviteUrl() {
  const link = new URL('./pair.html', location.href); link.search = '';
  link.hash = new URLSearchParams({ room: membership.roomId, invite: membership.inviteToken }).toString();
  return link.href;
}
function renderSavedRooms() {
  $('pair-saved-list').replaceChildren();
  const saved = records.filter(x => !x.pending && x.expiresAt > Date.now());
  $('pair-saved-rooms').hidden = !saved.length || Boolean(invitation);
  for (const record of saved.reverse()) {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = `${record.name}的${EDITIONS[record.edition]?.label ?? ''}房间 · 继续上次的进度 →`;
    button.addEventListener('click', () => restoreRoom(record));
    $('pair-saved-list').append(button);
  }
}
async function restoreRoom(record) {
  if (busy) return;
  busy = true; errorAt('pair-entry-error', '');
  try { enterRoom(await api(`/rooms/${record.roomId}`, { credentials: record }), record); }
  catch (error) {
    if ([404, 410, 403].includes(error.status)) { forgetRecord(record.roomId); renderSavedRooms(); }
    errorAt('pair-entry-error', error.message);
  } finally { busy = false; if (room) renderRoom(room); }
}
function showLobby() {
  document.body.classList.remove('is-in-room');
  membership = null; room = null; closed = false; uncertain = false; renderedRound = null;
  invitation = null; clearTimeout(timer);
  try { sessionStorage.removeItem(inviteKey); } catch { /* Optional. */ }
  history.replaceState(null, '', new URL('./pair.html', location.href).href);
  $('pair-unavailable').hidden = true; $('pair-room').hidden = true; $('pair-lobby').hidden = false;
  $('pair-lobby-title').textContent = '留一个位置，给想了解的人';
  $('pair-lobby-note').textContent = '创建一个只容纳两人的房间，把邀请链接发给 TA。双人进度独立，不影响原来的抽签记录。';
  $('pair-editions').hidden = false; $('pair-enter').textContent = '创建房间，邀请 TA →';
  errorAt('pair-entry-error', ''); renderSavedRooms();
}

$('pair-entry-form').addEventListener('submit', enter);
$('pair-answer-text').addEventListener('input', () => { draft.text = $('pair-answer-text').value; saveDraft(); updateDraftControls(); });
$('pair-answer-form').addEventListener('submit', event => { event.preventDefault(); action('answer', { answer: { ...draft } }); });
$('pair-seen').addEventListener('click', () => action('seen'));
$('pair-next').addEventListener('click', () => action('next'));
$('pair-sync').addEventListener('click', sync);
$('pair-back-lobby').addEventListener('click', showLobby);
$('pair-invite').addEventListener('click', async () => {
  const link = inviteUrl();
  try { await navigator.clipboard.writeText(link); toast('邀请链接已复制，只发给想一起回答的 TA。'); }
  catch { $('pair-invite-url').value = link; $('pair-link-fallback').hidden = false; $('pair-invite-url').focus(); $('pair-invite-url').select(); }
});
$('pair-close-button').addEventListener('click', () => { if (!busy && !uncertain) $('pair-close-dialog').showModal(); });
for (const id of ['pair-cancel-close', 'pair-keep-room']) $(id).addEventListener('click', () => $('pair-close-dialog').close());
$('pair-confirm-close').addEventListener('click', async () => {
  $('pair-confirm-close').disabled = true;
  await action('close');
  $('pair-confirm-close').disabled = false;
  if ($('pair-close-dialog').open) $('pair-close-dialog').close();
});
$('pair-history-close').addEventListener('click', () => $('pair-history-dialog').close());
$('pair-history-button').addEventListener('click', async () => {
  if (busy || !membership) return;
  $('pair-history-button').disabled = true;
  try {
    const data = await api(`/rooms/${membership.roomId}/history`);
    $('pair-history-list').replaceChildren();
    if (!data.results.length) { const note = document.createElement('p'); note.className = 'empty-history'; note.textContent = '还没有共同揭晓的答案。等双方都提交，再来这里看看。'; $('pair-history-list').append(note); }
    for (const result of data.results) {
      const article = document.createElement('article'); article.className = 'history-item';
      const question = document.createElement('p'); question.textContent = result.question.text; article.append(question);
      for (const seat of ['a', 'b']) { const answer = document.createElement('div'); answer.className = 'pair-history-result'; answer.textContent = `${room.names[seat]}：\n${formatAnswer(result[seat])}`; article.append(answer); }
      $('pair-history-list').append(article);
    }
    $('pair-history-dialog').showModal();
  } catch (error) { errorAt('pair-action-error', error.message); }
  finally { $('pair-history-button').disabled = false; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
window.addEventListener('online', sync);
window.addEventListener('pageshow', () => { if (membership) sync(); });

if (roomPattern.test(fragment.get('room') ?? '') && tokenPattern.test(fragment.get('invite') ?? '')) {
  invitation = { roomId: fragment.get('room'), inviteToken: fragment.get('invite') };
  try { sessionStorage.setItem(inviteKey, JSON.stringify(invitation)); } catch { persistent = false; }
  history.replaceState(null, '', `${url.pathname}${url.search}`);
} else {
  try { const stored = JSON.parse(sessionStorage.getItem(inviteKey)); if (roomPattern.test(stored?.roomId ?? '') && tokenPattern.test(stored?.inviteToken ?? '')) invitation = stored; } catch { /* No pending invitation. */ }
}
storageWarning();
const selectedEdition = url.searchParams.get('edition');
if (isEdition(selectedEdition)) document.querySelector(`input[name=edition][value=${selectedEdition}]`).checked = true;
if (invitation) {
  const existing = records.find(x => x.roomId === invitation.roomId && !x.pending);
  if (existing) restoreRoom(existing);
  else {
    $('pair-lobby-title').textContent = '有个人，想认真了解你';
    $('pair-lobby-note').textContent = '加入后，你们会回答同一道问题。只提交自己的想法，双方提交后才会一起揭晓。';
    $('pair-editions').hidden = true; $('pair-enter').textContent = '加入房间，一起回答 →';
  }
} else {
  renderSavedRooms();
  const requested = records.find(x => x.roomId === url.searchParams.get('room') && !x.pending);
  if (requested) restoreRoom(requested);
  else if (url.searchParams.has('room')) errorAt('pair-entry-error', '这个链接没有本设备的房间身份。请让对方发完整邀请链接；原参与者请用之前的浏览器打开。');
}
