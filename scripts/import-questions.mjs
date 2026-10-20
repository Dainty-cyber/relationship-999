import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { auditBank } from '../dist/core.mjs';

export function parseQuestions(input, extension) {
  input = input.replace(/^\uFEFF/, '');
  if (extension === '.json') {
    const parsed = JSON.parse(input);
    const bank = Array.isArray(parsed) ? { version: 1, title: '确定关系前的 999 问', questions: parsed } : parsed;
    // Numeric JSON IDs have a deterministic textual display. Do not edit text.
    if (Array.isArray(bank?.questions)) bank.questions = bank.questions.map(question =>
      question && typeof question === 'object' && typeof question.id === 'number'
        ? { ...question, id: String(question.id) } : question);
    return bank;
  }
  if (extension !== '.txt') throw new Error('此脚本接收 UTF-8 TXT 或 JSON。Word / Excel 请提供原文件，由导入流程先提取并核对。');
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const numbered = /^\s*(\d+)[.、．)）]\s?(.*)$/u;
  const questions = [];
  if (lines.some(line => numbered.test(line))) {
    let current = null;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const match = line.match(numbered);
      if (match) {
        if (current) questions.push(current);
        current = { id: match[1], text: match[2] };
      } else if (line.trim()) {
        if (!current) throw new Error(`第 ${index + 1} 行出现在首个题号之前，请先确认它是标题还是题目。`);
        current.text += `\n${line}`;
      }
    }
    if (current) questions.push(current);
  } else {
    for (const line of lines) {
      if (line.trim()) questions.push({ id: String(questions.length + 1), text: line });
    }
  }
  return { version: 1, title: '确定关系前的 999 问', questions };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const source = args.find(arg => !arg.startsWith('--'));
  if (!source) {
    console.error('用法：node scripts/import-questions.mjs "题库.txt" [--write]\n默认只检查；仅在恰好 999 题且无问题时，--write 才写入正式题库。');
    process.exitCode = 1;
  } else {
    try {
      const input = await readFile(path.resolve(source), 'utf8');
      const bank = parseQuestions(input, path.extname(source).toLowerCase());
      const issues = auditBank(bank);
      if (issues.length) {
        console.error(`题库未导入，需核对 ${issues.length} 项：\n${issues.map(issue => `- ${issue}`).join('\n')}`);
        process.exitCode = 1;
      } else if (args.includes('--write')) {
        await writeFile(fileURLToPath(new URL('../dist/questions.json', import.meta.url)), JSON.stringify(bank, null, 2) + '\n', 'utf8');
        console.log('已导入 999 题，保留原始题号和题目文字。');
      } else {
        console.log('检查通过：999 题，无空题、重复题号或重复内容。尚未写入；添加 --write 执行导入。');
      }
    } catch (error) {
      console.error(`题库未导入：${error.message}`);
      process.exitCode = 1;
    }
  }
}
