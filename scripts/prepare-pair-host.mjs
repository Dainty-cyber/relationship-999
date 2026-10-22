// Port the current website into the already-open Sites checkout, keeping its
// Git history and ID. The official Vinext template supplies the build pipeline.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = realpathSync(process.argv[2]);
const template = realpathSync(process.argv[3]);
const expected = path.resolve(root, 'outputs/sites-pair-source');
if (target !== realpathSync(expected)) throw new Error('Use the selected Sites checkout under outputs/sites-pair-source.');
const identity = JSON.parse(readFileSync(path.join(target, '.openai/hosting.json'), 'utf8'));
const sourceIdentity = JSON.parse(readFileSync(path.join(root, '.openai/hosting.json'), 'utf8'));
if (identity.project_id !== sourceIdentity.project_id || !existsSync(path.join(target, '.git'))) throw new Error('Keep the existing Site identity and Git repository.');
for (const entry of readdirSync(template)) {
  if (['node_modules', '.git', 'dist', 'drizzle', '.sites-runtime', '.wrangler', '.openai', 'outputs'].includes(entry)) continue;
  cpSync(path.join(template, entry), path.join(target, entry), { recursive: true });
}
// Verify every recursive removal stays within the selected disposable output
// directories of this exact checkout; the workspace and Git metadata are retained.
for (const relative of ['dist', 'web']) {
  const destination = path.resolve(target, relative);
  if (path.dirname(destination) !== target || !['dist', 'web'].includes(path.basename(destination))) throw new Error('Invalid output target');
  if (existsSync(destination)) rmSync(destination, { recursive: true });
}
cpSync(path.join(root, 'dist'), path.join(target, 'web'), { recursive: true });
mkdirSync(path.join(target, 'server'), { recursive: true });
for (const name of ['pair-service.mjs', 'd1-repository.mjs']) cpSync(path.join(root, 'server', name), path.join(target, 'server', name));
cpSync(path.join(root, 'hosting/worker.ts'), path.join(target, 'worker/index.ts'));
cpSync(path.join(root, 'hosting/schema.ts'), path.join(target, 'db/schema.ts'));
cpSync(path.join(root, 'hosting/page.tsx'), path.join(target, 'app/page.tsx'));
cpSync(path.join(root, 'hosting/layout.tsx'), path.join(target, 'app/layout.tsx'));
const types = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };
const assets = {};
for (const name of readdirSync(path.join(root, 'dist'))) {
  if (!types[path.extname(name)]) continue;
  assets[`/${name}`] = { body: readFileSync(path.join(root, 'dist', name), 'utf8'), type: `${types[path.extname(name)]}; charset=utf-8` };
}
writeFileSync(path.join(target, 'server/static-assets.mjs'), `// Generated from the web/ source assets; contains no runtime data.\nexport const assets = ${JSON.stringify(assets)};\n`);
writeFileSync(path.join(target, '.openai/hosting.json'), JSON.stringify({ project_id: identity.project_id, d1: 'DB', r2: null }, null, 2) + '\n');
if (existsSync(path.join(root, 'hosting/drizzle'))) cpSync(path.join(root, 'hosting/drizzle'), path.join(target, 'drizzle'), { recursive: true });
if (!existsSync(path.join(target, 'node_modules'))) symlinkSync(path.join(template, 'node_modules'), path.join(target, 'node_modules'), 'junction');
writeFileSync(path.join(target, 'README.md'), '# 遇见彼此 · 双人问答服务\n\n保留原有 Sites 项目与历史，使用官方 Vinext / Cloudflare D1 模板。web/ 为网页原文，worker/index.ts 提供静态页面与匿名双人 API。\n\n完整源码与测试：https://github.com/Dainty-cyber/relationship-999\n\n数据库结构位于 db/schema.ts；迁移由 drizzle-kit 生成。令牌只保存哈希，双方提交前的回答不会返回给对方。房间 7 天过期，可由任一方主动删除。\n');
console.log(JSON.stringify({ target, project_id: identity.project_id, embeddedAssets: Object.keys(assets).length }));
