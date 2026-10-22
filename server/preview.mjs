import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { fingerprintBank } from '../dist/core.mjs';
import { editionBank } from '../dist/editions.mjs';
import { answerSchema, normalizeAnswer } from '../dist/answer-options.mjs';
import { createPairService } from './pair-service.mjs';
import { createD1Repository } from './d1-repository.mjs';
import { createPreviewDatabase } from './sqlite-preview-db.mjs';

export async function createPairPreview() {
  const bank = JSON.parse(await readFile(new URL('../dist/questions.json', import.meta.url), 'utf8'));
  const banks = {};
  for (const key of ['concise', 'full']) {
    const selected = editionBank(bank, key);
    banks[key] = { questions: selected.questions, bankId: await fingerprintBank(selected) };
  }
  const service = createPairService({ banks, answerSchema, normalizeAnswer });
  const database = createPreviewDatabase();
  const root = path.resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
  const mime = { '.html': 'text/html', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
  const server = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url, `http://${incoming.headers.host}`);
      if (url.pathname.startsWith('/api/pair/')) {
        const chunks = []; let size = 0;
        for await (const chunk of incoming) { size += chunk.length; if (size > 20000) { outgoing.writeHead(413).end(); return; } chunks.push(chunk); }
        const request = new Request(url, { method: incoming.method, headers: incoming.headers, ...(['GET', 'HEAD'].includes(incoming.method) ? {} : { body: Buffer.concat(chunks) }) });
        const response = await service(request, createD1Repository(database));
        outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
        return;
      }
      if (!['GET', 'HEAD'].includes(incoming.method)) { outgoing.writeHead(405).end(); return; }
      const filename = path.resolve(root, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1));
      if (!filename.startsWith(root + path.sep)) { outgoing.writeHead(403).end(); return; }
      const content = await readFile(filename);
      outgoing.writeHead(200, { 'Content-Type': `${mime[path.extname(filename)] ?? 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store' });
      outgoing.end(incoming.method === 'HEAD' ? undefined : content);
    } catch { outgoing.writeHead(404).end('Not found'); }
  });
  server.on('close', () => database.close());
  return server;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const server = await createPairPreview();
  server.listen(4173, '127.0.0.1', () => console.log('Local: http://127.0.0.1:4173/pair.html (temporary local test rooms)'));
}
