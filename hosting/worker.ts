import handler from 'vinext/server/fetch-handler';
import { runWithConnectorBinding } from '../lib/connector-context';
import { createPairService } from '../server/pair-service.mjs';
import { createD1Repository } from '../server/d1-repository.mjs';
import { fingerprintBank } from '../web/core.mjs';
import { editionBank } from '../web/editions.mjs';
import { answerSchema, normalizeAnswer } from '../web/answer-options.mjs';
import bank from '../web/questions.json';
import { assets } from '../server/static-assets.mjs';

const prepared = Promise.all(['concise', 'full'].map(async key => {
  const selected = editionBank(bank, key);
  return [key, { questions: selected.questions, bankId: await fingerprintBank(selected) }];
})).then(entries => createPairService({ banks: Object.fromEntries(entries), answerSchema, normalizeAnswer }));

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/pair/')) {
      const service = await prepared;
      return service(request, env.DB ? createD1Repository(env.DB) : null);
    }
    if (['GET', 'HEAD'].includes(request.method)) {
      const asset = assets[url.pathname === '/' ? '/index.html' : url.pathname];
      if (asset) return new Response(request.method === 'HEAD' ? null : asset.body, { headers: {
        'Content-Type': asset.type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
      } });
    }
    return runWithConnectorBinding(undefined, () => handler.fetch(request, env, ctx));
  }
};
