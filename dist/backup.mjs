import { restoreProgress } from './core.mjs';
import { isEdition, EDITIONS } from './editions.mjs';

export const MAX_BACKUP_BYTES = 1024 * 1024;
export const BACKUP_FORMAT = 'yujian-bici-progress';

export function makeBackup(edition, progress, questions, now = () => new Date().toISOString()) {
  if (!isEdition(edition)) throw new Error('无法识别备份中的版本。');
  const restored = restoreProgress(progress, progress.bankId, questions);
  if (restored.reason) throw new Error('当前进度无法读取，请先检查记录。');
  return { format: BACKUP_FORMAT, version: 1, edition, exportedAt: now(), progress: restored.state };
}

export function parseBackup(text, banks) {
  if (typeof text !== 'string' || text.length > MAX_BACKUP_BYTES) throw new Error('备份文件过大，请选择本网页导出的进度文件。');
  let backup;
  try { backup = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('文件内容无法读取，请选择正确的 JSON 进度备份。'); }
  if (!backup || backup.format !== BACKUP_FORMAT || backup.version !== 1 || !isEdition(backup.edition) ||
      typeof backup.exportedAt !== 'string' || !Number.isFinite(Date.parse(backup.exportedAt))) {
    throw new Error('这不是本网页支持的进度备份。');
  }
  const bank = banks[backup.edition];
  if (!bank) throw new Error('对应版本的题库尚未准备好，请稍后重试。');
  const result = restoreProgress(backup.progress, bank.bankId, bank.questions);
  if (result.reason === 'bank-changed') throw new Error(`${EDITIONS[backup.edition].label}备份与当前题库不匹配，现有记录没有改动。`);
  if (result.reason || !backup.progress) throw new Error('备份中的记录不完整或顺序异常，现有记录没有改动。');
  return { edition: backup.edition, exportedAt: backup.exportedAt, progress: result.state };
}
