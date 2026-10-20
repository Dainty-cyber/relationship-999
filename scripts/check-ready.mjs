import { readFile } from 'node:fs/promises';
import { auditBank } from '../dist/core.mjs';

try {
  const bank = JSON.parse(await readFile(new URL('../dist/questions.json', import.meta.url), 'utf8'));
  const issues = auditBank(bank);
  if (issues.length) {
    console.error('暂不能作为正式 999 问发布：\n' + issues.map(issue => `- ${issue}`).join('\n'));
    process.exitCode = 1;
  } else console.log('正式题库检查通过：999 题，题号与内容无重复，可以进入发布流程。');
} catch (error) {
  console.error(`题库检查失败：${error.message}`);
  process.exitCode = 1;
}
