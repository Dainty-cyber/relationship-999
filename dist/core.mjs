// Shared by the browser, importer, and tests. The last question is deliberately
// excluded from the random pool until every ordinary question is confirmed.
export const FINAL_QUESTION_ID = '999';
export function auditBank(bank, { expectedCount = 999 } = {}) {
  const issues = [];
  if (!bank || bank.version !== 1 || !Array.isArray(bank.questions)) {
    return ['题库格式应为 { version: 1, questions: [{ id, text }] }。'];
  }
  const questions = bank.questions;
  if (questions.length !== expectedCount) issues.push(`题目数量为 ${questions.length}，应为 ${expectedCount}。`);
  const ids = new Map();
  const texts = new Map();
  questions.forEach((question, index) => {
    const position = index + 1;
    if (!question || typeof question !== 'object') {
      issues.push(`第 ${position} 项不是题目对象。`);
      return;
    }
    const id = question.id;
    if (typeof id !== 'string' || !id.trim()) {
      issues.push(`第 ${position} 项缺少字符串格式的原始题号。`);
    } else {
      const trimmed = id.trim();
      const canonical = /^\d+$/.test(trimmed) ? BigInt(trimmed).toString() : trimmed;
      if (ids.has(canonical)) issues.push(`题号「${id}」重复：第 ${ids.get(canonical)}、${position} 项。`);
      else ids.set(canonical, position);
    }
    if (typeof question.text !== 'string' || !question.text.trim()) {
      issues.push(`第 ${position} 项（题号 ${id ?? '缺失'}）题目为空。`);
    } else {
      const canonical = question.text.replace(/\s+/gu, '');
      if (texts.has(canonical)) issues.push(`题目内容重复：第 ${texts.get(canonical)}、${position} 项（忽略空白）。`);
      else texts.set(canonical, position);
    }
  });
  if (expectedCount === 999 && !questions.some(question => question?.id === FINAL_QUESTION_ID)) {
    issues.push('缺少原题号为 999 的最后一题。');
  }
  return issues;
}

export async function fingerprintBank(bank) {
  const input = new TextEncoder().encode(JSON.stringify(bank.questions));
  const hash = await globalThis.crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function freshProgress(bankId) {
  return { version: 2, bankId, history: [] };
}

export function restoreProgress(raw, bankId, questions) {
  const fresh = reason => ({ state: freshProgress(bankId), reason });
  if (raw == null) return fresh(null);
  let parsed;
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return fresh('invalid'); }
  if (!parsed || parsed.version !== 2) return fresh('invalid');
  if (parsed.bankId !== bankId) return fresh('bank-changed');
  if (!Array.isArray(parsed.history) || parsed.history.length > questions.length) return fresh('invalid');
  const validIds = new Set(questions.map(question => question.id));
  const seen = new Set();
  for (const [index, entry] of parsed.history.entries()) {
    if (!entry || !validIds.has(entry.id) || seen.has(entry.id) ||
        typeof entry.drawnAt !== 'string' || !Number.isFinite(Date.parse(entry.drawnAt))) return fresh('invalid');
    seen.add(entry.id);
    if (entry.answeredAt !== null && (typeof entry.answeredAt !== 'string' ||
        !Number.isFinite(Date.parse(entry.answeredAt)) || Date.parse(entry.answeredAt) < Date.parse(entry.drawnAt))) return fresh('invalid');
    // At most the current (last) card may await confirmation. Earlier questions
    // and all prerequisites for the final card must have been confirmed.
    if (entry.answeredAt === null && index !== parsed.history.length - 1) return fresh('invalid');
    if (entry.id === FINAL_QUESTION_ID && (index !== questions.length - 1 ||
        parsed.history.slice(0, index).some(previous => !previous.answeredAt || previous.id === FINAL_QUESTION_ID))) return fresh('invalid');
  }
  return {
    state: { version: 2, bankId, history: parsed.history.map(({ id, drawnAt, answeredAt }) => ({ id, drawnAt, answeredAt })) },
    reason: null
  };
}

export function secureRandomIndex(length) {
  if (!Number.isSafeInteger(length) || length < 1 || length > 0x100000000) throw new RangeError('Invalid pool size');
  const limit = Math.floor(0x100000000 / length) * length;
  const buffer = new Uint32Array(1);
  do { globalThis.crypto.getRandomValues(buffer); } while (buffer[0] >= limit);
  return buffer[0] % length;
}

export function drawQuestion(state, questions, randomIndex = secureRandomIndex, now = () => new Date().toISOString()) {
  if (state.history.at(-1)?.answeredAt === null) return { state, question: null };
  const used = new Set(state.history.map(entry => entry.id));
  let remaining = questions.filter(question => question.id !== FINAL_QUESTION_ID && !used.has(question.id));
  if (!remaining.length) {
    const ordinary = questions.filter(question => question.id !== FINAL_QUESTION_ID);
    const answered = new Set(state.history.filter(entry => entry.answeredAt).map(entry => entry.id));
    if (ordinary.every(question => answered.has(question.id))) {
      remaining = questions.filter(question => question.id === FINAL_QUESTION_ID && !used.has(question.id));
    }
  }
  if (!remaining.length) return { state, question: null };
  const index = randomIndex(remaining.length);
  if (!Number.isInteger(index) || index < 0 || index >= remaining.length) throw new RangeError('Invalid random index');
  const question = remaining[index];
  return {
    question,
    state: { ...state, history: [...state.history, { id: question.id, drawnAt: now(), answeredAt: null }] }
  };
}

export function confirmAnswer(state, expectedId, now = () => new Date().toISOString()) {
  const current = state.history.at(-1);
  // A stale click from another tab cannot confirm a newly drawn question.
  if (!current || current.id !== expectedId || current.answeredAt !== null) return state;
  const answeredAt = new Date(Math.max(Date.parse(now()), Date.parse(current.drawnAt))).toISOString();
  return { ...state, history: [...state.history.slice(0, -1), { ...current, answeredAt }] };
}

export function roundStatus(state, questions) {
  const current = state.history.at(-1) ?? null;
  const answered = state.history.filter(entry => entry.answeredAt !== null);
  const ordinary = questions.filter(question => question.id !== FINAL_QUESTION_ID);
  const ordinaryAnswered = answered.filter(entry => entry.id !== FINAL_QUESTION_ID).length;
  const finalUnlocked = ordinaryAnswered === ordinary.length;
  return {
    current,
    pending: current?.answeredAt === null,
    answeredCount: answered.length,
    ordinaryAnswered,
    ordinaryTotal: ordinary.length,
    finalUnlocked,
    finalNext: finalUnlocked && !state.history.some(entry => entry.id === FINAL_QUESTION_ID),
    finished: answered.length === questions.length
  };
}

// localStorage can throw even on property access (private/embedded browsers).
// Keep an in-memory copy if persistent storage is unavailable or full.
export function createProgressStore(storageFactory, key) {
  let memory = null;
  let persistent = true;
  let storage;
  try {
    storage = storageFactory();
    const probe = `${key}:probe`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
  } catch { persistent = false; }
  return {
    get persistent() { return persistent; },
    read() {
      if (persistent) {
        try { memory = storage.getItem(key); }
        catch { persistent = false; }
      }
      return memory;
    },
    write(state) {
      memory = JSON.stringify(state);
      if (persistent) {
        try { storage.setItem(key, memory); }
        catch { persistent = false; }
      }
    }
  };
}
