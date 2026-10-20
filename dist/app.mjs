import { FINAL_QUESTION_ID, auditBank, fingerprintBank, freshProgress, restoreProgress, drawQuestion, confirmAnswer, roundStatus, createProgressStore } from './core.mjs';
import { EDITIONS, EDITION_PREFERENCE_KEY, initialEdition, editionBank, questionNumber, questionTopic } from './editions.mjs';

const $ = id => document.getElementById(id);
let remembered;
let hasLegacyProgress = false;
try {
  remembered = localStorage.getItem(EDITION_PREFERENCE_KEY);
  hasLegacyProgress = Boolean(JSON.parse(localStorage.getItem(EDITIONS.full.storageKey))?.history?.length);
} catch { /* Selection and progress still work for this visit without storage. */ }
let edition = initialEdition({ requested: new URL(location.href).searchParams.get('edition'), remembered, hasLegacyProgress });
const editionStores = new Map();
function editionStore(key) {
  if (!editionStores.has(key)) editionStores.set(key, createProgressStore(() => window.localStorage, EDITIONS[key].storageKey));
  return editionStores.get(key);
}
let store = editionStore(edition);
let fullBank = null;
let questions = [];
let byId = new Map();
let bankId = '';
let state = null;
let busy = false;
let switching = false;
let toastTimer;

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500);
}

function updateStorageNote() {
  $('storage-note').classList.toggle('is-warning', !store.persistent);
  $('storage-note').textContent = store.persistent
    ? `${EDITIONS[edition].label}进度保存在当前浏览器，两版记录互不影响。`
    : '当前浏览器无法保存进度，仅在本次打开期间保留。';
}

function updateEditionControls() {
  document.querySelectorAll('[data-edition]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.edition === edition));
    button.disabled = busy || switching || !state;
  });
}

function updateEditionHeading() {
  const config = EDITIONS[edition];
  $('question-total').textContent = String(config.count);
  $('edition-description').textContent = config.description;
  document.title = `确定关系前的 ${config.count} 问 · ${config.label} · 遇见彼此`;
  $('about-rules').textContent = `你可以在一个问题上停留很久，等彼此都愿意聊时再继续。${config.label}每题聊完后点「已聊完」，前 ${config.count - 1} 题都确认后，最后一签就会解锁。两版记录独立保存。`;
  $('reset-description').textContent = `这会清空${config.label}的抽签记录和「已聊完」进度，第 ${config.count} 题会重新锁定。另一个版本的进度会保留。`;
  $('history-title').textContent = `${config.label} · 聊过的问题`;
  updateEditionControls();
}

function disableInteraction() {
  for (const id of ['draw-button', 'jar-button', 'reset-button', 'history-button']) $(id).disabled = true;
  updateEditionControls();
}

async function installEdition(key) {
  const selected = editionBank(fullBank, key);
  const issues = auditBank(selected, { expectedCount: EDITIONS[key].count });
  if (issues.length) throw new Error(issues.join('\n'));
  const selectedId = await fingerprintBank(selected);
  edition = key;
  questions = selected.questions;
  byId = new Map(questions.map(question => [question.id, question]));
  bankId = selectedId;
  store = editionStore(key);
  state = readState({ notify: true });
  try { localStorage.setItem(EDITION_PREFERENCE_KEY, key); } catch { /* Optional preference. */ }
  const url = new URL(location.href);
  url.searchParams.set('edition', key);
  try { history.replaceState(null, '', url.href); } catch { /* Sharing still carries the selected edition. */ }
}

async function switchEdition(key) {
  if (busy || switching || !fullBank || edition === key) return;
  switching = true;
  disableInteraction();
  try {
    await installEdition(key);
    $('question-stage').classList.remove('is-revealing');
  } catch (error) {
    console.error('切换版本失败：', error);
    toast('暂时无法切换版本，请稍后再试，原来的记录还在。');
  } finally {
    switching = false;
    render();
  }
}

function readState({ notify = false } = {}) {
  const result = restoreProgress(store.read(), bankId, questions);
  if (notify && result.reason) toast(result.reason === 'bank-changed'
    ? '题库已更新，这一轮从新的签筒开始。'
    : '上次的记录无法读取，已为你准备好新一轮。');
  return result.state;
}

function render() {
  if (!state) return;
  updateEditionHeading();
  const count = state.history.length;
  const last = state.history.at(-1);
  const question = last ? byId.get(last.id) : null;
  const status = roundStatus(state, questions);
  const complete = status.finished;
  const finale = question?.id === FINAL_QUESTION_ID;
  const hasDrawn = count > 0;
  const number = question ? questionNumber(questions, edition, question) : '';
  $('question-label').textContent = finale ? `第 ${questions.length} 题 · 最后一签` : (question ? `第 ${number} 题 · ${status.pending ? '等待聊完' : '已聊完'}` : '给彼此一点好奇');
  $('question-text').textContent = question ? question.text : '每一个问题，\n都是走近你的起点。';
  $('question-text').classList.toggle('is-welcome', !question);
  $('question-text').classList.toggle('is-long', Boolean(question && question.text.length > 65));
  $('question-source').hidden = edition !== 'concise' || !question;
  $('question-source').textContent = question && edition === 'concise' ? `${questionTopic(question.id)} · 原题号 ${question.id}` : '';
  $('question-note').textContent = finale ? (complete ? '愿每一次认真倾听，都有温柔的回应。' : `${status.ordinaryTotal} 次认真倾听，走到了这一句。`)
    : (status.finalNext ? `前 ${status.ordinaryTotal} 题都已聊完，最后一签留给此刻的你们。`
      : (hasDrawn ? (status.pending ? '聊完后点「已聊完」，再抽下一签。' : '这一题已记好，下一次好奇还在签筒里。') : `先聊完前 ${status.ordinaryTotal} 题，最后一签留到最后。`));
  document.querySelector('.lottery').classList.toggle('is-finale', Boolean(finale));
  $('draw-button').disabled = busy || switching || complete;
  $('jar-button').disabled = busy || switching || complete || status.pending;
  $('reset-button').disabled = busy || switching || !hasDrawn;
  $('history-button').disabled = busy || switching;
  $('draw-label').textContent = complete ? '这一轮，圆满了' : (status.pending ? '已聊完 · 记下这一刻'
    : (status.finalNext ? `揭开第 ${questions.length} 题` : (hasDrawn ? '再抽一题 · 再近一点' : '抽一签 · 靠近一点')));
  $('draw-button').dataset.action = status.pending ? 'confirm' : 'draw';
  $('draw-button').setAttribute('aria-label', $('draw-label').textContent);
  $('draw-icon').setAttribute('href', status.pending ? '#i-check' : '#i-spark');
  $('reset-label').textContent = complete ? '开启新一轮' : '重新开始';
  $('progress-text').textContent = `已聊完 ${status.answeredCount} / ${questions.length}`;
  $('progress-bar').setAttribute('aria-valuemax', String(questions.length));
  $('progress-bar').setAttribute('aria-valuenow', String(status.answeredCount));
  $('progress-fill').style.width = `${status.answeredCount / questions.length * 100}%`;
  $('history-count').textContent = String(count);
  $('jar-hint').textContent = finale ? '把这份心意，留给你' : (status.pending ? '先认真听听彼此' : '一支小签，一点靠近');
  $('draw-caption').textContent = complete ? '所有问题都已聊完，可以开启新一轮。' : (status.pending ? '无需填写答案，确认后保存在当前浏览器。' : `前 ${status.ordinaryTotal} 题随机 · 本轮不重复 · 最后一签待解锁`);
  $('finale-note').textContent = status.finalUnlocked ? '最后一签已解锁，留给认真走到这里的你们。' : `最后一签 · 聊完前 ${status.ordinaryTotal} 题后解锁`;
  updateStorageNote();
}

function renderUnavailable(kind) {
  updateEditionHeading();
  const empty = kind === 'empty';
  $('question-label').textContent = empty ? '题库待导入' : '签筒暂时没有准备好';
  $('question-text').textContent = empty ? '每一个问题，\n都是走近你的起点。' : '心意先到，\n问题稍后见。';
  $('question-text').classList.add('is-welcome');
  $('question-source').hidden = true;
  $('question-note').textContent = empty ? '导入你的题库后，就可以开始抽签。' : '题库暂时无法使用，请稍后重新加载。';
  $('draw-label').textContent = empty ? '等待题库，心意先到' : '暂时无法抽签';
  $('draw-caption').textContent = '每次一问 · 本轮不重复 · 认真听彼此说';
  $('draw-button').disabled = true;
  $('jar-button').disabled = true;
  $('reset-button').disabled = true;
  $('retry-button').hidden = empty;
  $('history-button').disabled = false;
  $('progress-text').textContent = empty ? '题库待导入' : '题库暂不可用';
  updateStorageNote();
}

async function loadBank() {
  if (switching || busy) return;
  switching = true;
  disableInteraction();
  $('retry-button').hidden = true;
  try {
    const response = await fetch('./questions.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Question bank HTTP ${response.status}`);
    const bank = await response.json();
    if (bank?.version === 1 && Array.isArray(bank.questions) && bank.questions.length === 0) {
      renderUnavailable('empty');
      return;
    }
    const issues = auditBank(bank);
    if (issues.length) throw new Error(issues.join('\n'));
    fullBank = bank;
    await installEdition(edition);
  } catch (error) {
    console.error('题库加载失败：', error);
    renderUnavailable('error');
  } finally {
    switching = false;
    if (state) render();
    else updateEditionControls();
  }
}

// Reserve and persist a question before animation. A reload mid-animation will
// restore that exact question. Web Locks serializes updates across browser tabs.
function withProgressLock(action) {
  if (navigator.locks?.request) return navigator.locks.request(EDITIONS[edition].storageKey, action);
  return Promise.resolve().then(action);
}

async function draw() {
  if (busy || switching || !state || roundStatus(state, questions).pending || roundStatus(state, questions).finished) return;
  busy = true;
  updateEditionControls();
  $('draw-button').disabled = true;
  $('jar-button').disabled = true;
  $('reset-button').disabled = true;
  $('history-button').disabled = true;
  $('question-stage').classList.remove('is-revealing');
  try {
    const result = await withProgressLock(() => {
      const result = drawQuestion(readState(), questions);
      state = result.state;
      if (result.question) store.write(state);
      return result;
    });
    if (result.question) {
      $('illustration-panel').classList.add('is-drawing');
      document.querySelector('.question-panel').classList.add('is-busy');
      $('draw-label').textContent = '让这一签，慢慢靠近你…';
      $('jar-hint').textContent = '你的问题，正在路上';
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        await new Promise(resolve => setTimeout(resolve, 850));
      }
      state = readState();
      $('question-stage').classList.add('is-revealing');
    }
  } catch (error) {
    console.error('抽签失败：', error);
    toast('这一签暂时没抽出来，请再试一次。');
  } finally {
    busy = false;
    $('illustration-panel').classList.remove('is-drawing');
    document.querySelector('.question-panel').classList.remove('is-busy');
    render();
  }
}

async function acknowledge() {
  if (busy || switching || !state || !roundStatus(state, questions).pending) return;
  const expectedId = state.history.at(-1).id;
  busy = true;
  updateEditionControls();
  $('draw-button').disabled = true;
  $('jar-button').disabled = true;
  $('reset-button').disabled = true;
  try {
    await withProgressLock(() => {
      state = confirmAnswer(readState(), expectedId);
      store.write(state);
    });
    const status = roundStatus(state, questions);
    if (status.finalNext) toast(`${status.ordinaryTotal} 题都聊完了，最后一签为你们解锁。`);
    else if (status.finished) toast('这一轮的心意，已经好好收下。');
  } catch (error) {
    console.error('确认失败：', error);
    toast('暂时没有记好，请再点一次「已聊完」。');
  } finally {
    busy = false;
    render();
  }
}

function renderHistory() {
  const list = $('history-list');
  list.replaceChildren();
  if (!state?.history.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-history';
    empty.textContent = '还没有抽签记录。\n把时间留给彼此，故事慢慢开始。';
    empty.style.whiteSpace = 'pre-line';
    list.append(empty);
    $('history-summary').textContent = '每一支签，都是了解彼此的一小步。';
    return;
  }
  $('history-summary').textContent = `已抽 ${state.history.length} 题，已聊完 ${roundStatus(state, questions).answeredCount} 题，最新的排在最前面。`;
  const fragment = document.createDocumentFragment();
  const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  [...state.history].reverse().forEach((entry, index) => {
    const article = document.createElement('article');
    article.className = 'history-item';
    const head = document.createElement('div');
    head.className = 'history-item-head';
    const label = document.createElement('span');
    label.textContent = edition === 'concise'
      ? `精选第 ${questionNumber(questions, edition, byId.get(entry.id))} 题 · 原题号 ${entry.id} · ${entry.answeredAt ? '已聊完' : '待聊完'}`
      : `原题号 ${entry.id} · ${entry.answeredAt ? '已聊完' : '待聊完'}`;
    const time = document.createElement('time');
    time.dateTime = entry.drawnAt;
    time.textContent = dateFormat.format(new Date(entry.drawnAt));
    head.append(label, time);
    const text = document.createElement('p');
    text.textContent = byId.get(entry.id).text;
    article.append(head, text);
    fragment.append(article);
  });
  list.append(fragment);
}

function showDialog(id) { $(id).showModal(); }
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const box = dialog.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
}));
$('about-button').addEventListener('click', () => showDialog('about-dialog'));
$('history-button').addEventListener('click', () => { renderHistory(); showDialog('history-dialog'); });
$('reset-button').addEventListener('click', () => { if (!busy && !switching && state?.history.length) showDialog('reset-dialog'); });
$('confirm-reset').addEventListener('click', async () => {
  if (busy || switching || !state) return;
  busy = true;
  disableInteraction();
  $('confirm-reset').disabled = true;
  try {
    await withProgressLock(() => {
      state = freshProgress(bankId);
      store.write(state);
    });
    $('reset-dialog').close();
    toast('所有问题都回到签筒里了，重新认识彼此吧。');
  } catch (error) {
    console.error('重置失败：', error);
    toast('暂时无法重新开始，请关闭窗口后重试。');
  } finally {
    busy = false;
    $('confirm-reset').disabled = false;
    render();
  }
});
$('draw-button').addEventListener('click', () => {
  if (state && roundStatus(state, questions).pending) acknowledge();
  else draw();
});
$('jar-button').addEventListener('click', draw);
$('retry-button').addEventListener('click', loadBank);
document.querySelectorAll('[data-edition]').forEach(button => button.addEventListener('click', () => switchEdition(button.dataset.edition)));
$('share-button').addEventListener('click', async () => {
  const url = new URL(location.href);
  url.hash = '';
  url.search = '';
  url.searchParams.set('edition', edition);
  $('share-url').value = url.href;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol === 'file:';
  if (!local) {
    try {
      await navigator.clipboard.writeText(url.href);
      toast('链接已复制，发给那个想认真了解的人吧。');
      return;
    } catch { /* Show a selectable link when clipboard access is blocked. */ }
  }
  $('share-description').textContent = local
    ? '这是本机预览地址。网页发布后，就可以把公开链接发送给 TA。'
    : '长按或选中下方链接，复制后发送给对方。';
  showDialog('share-dialog');
  $('share-url').focus();
  $('share-url').select();
});
window.addEventListener('storage', event => {
  if ((event.key !== EDITIONS[edition].storageKey && event.key !== null) || !state || busy || switching || !store.persistent) return;
  state = readState();
  render();
  if ($('history-dialog').open) renderHistory();
});
// Returning from a suspended tab also picks up the latest saved round.
window.addEventListener('pageshow', () => { if (state && !busy && !switching) { state = readState(); render(); } });
updateEditionHeading();
loadBank();
