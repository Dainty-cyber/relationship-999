import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const defaultRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const mime = { '.html': 'text/html', '.css': 'text/css', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

export function createPreviewServer({ root = defaultRoot, overrides = new Map() } = {}) {
  const resolvedRoot = path.resolve(root);
  return createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) {
        response.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
      }
      const url = new URL(request.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      const target = path.resolve(resolvedRoot, relative);
      if (!target.startsWith(resolvedRoot + path.sep)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      let content;
      if (overrides.has(pathname)) content = Buffer.from(overrides.get(pathname));
      else {
        const info = await stat(target);
        if (!info.isFile()) throw new Error('Not a file');
        content = await readFile(target);
      }
      response.writeHead(200, {
        'Content-Type': `${mime[path.extname(target)] || 'application/octet-stream'}; charset=utf-8`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    }
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const portArg = process.argv.indexOf('--port');
  const port = portArg < 0 ? 4173 : Number(process.argv[portArg + 1]);
  const server = createPreviewServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${server.address().port}`));
}
