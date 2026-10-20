import { readFile } from 'node:fs/promises';
import { auditBank } from '../dist/core.mjs';
import { editionBank, CONCISE_TOPICS } from '../dist/editions.mjs';

try {
  const bank = JSON.parse(await readFile(new URL('../dist/questions.json', import.meta.url), 'utf8'));
  const issues = auditBank(bank);
  try {
    const concise = editionBank(bank, 'concise');
    issues.push(...auditBank(concise, { expectedCount: 99 }).map(issue => `精简版：${issue}`));
  } catch (error) { issues.push(error.message); }
  if (issues.length) {
    console.error('暂不能作为正式 999 问发布：\n' + issues.map(issue => `- ${issue}`).join('\n'));
    process.exitCode = 1;
  } else console.log(`两版题库检查通过：完整版 999 题，精简版 99 题（${CONCISE_TOPICS.length} 个话题，98 道原题＋最后一题）。`);
} catch (error) {
  console.error(`题库检查失败：${error.message}`);
  process.exitCode = 1;
}
