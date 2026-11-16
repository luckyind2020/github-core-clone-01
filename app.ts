// Ember Forge — the HTTP shell.
//
// One Node http server, one in-memory Store, four surfaces:
//   GET  /healthz                         (no auth; the env's liveness probe)
//   /{owner}/{repo}.git/info/refs        git smart HTTP advertisements
//   /{owner}/{repo}.git/git-upload-pack   protocol v2 (or v0 fallback)
//   /{owner}/{repo}.git/git-receive-pack  protocol v0 push
//   /api/v3/*                             REST v3 (see rest.ts)
//   POST /api/graphql                     GraphQL v4 (see graphql.ts)
//   POST /mcp                             MCP, modern era (see mcp.ts)
//
// The git routes carry no Authorization header; the REST/GraphQL/MCP routes
// require Bearer <MAKEFUN_SHOP_TOKEN>. A malformed request of any kind is
// answered with an HTTP error status — the process never crashes on input.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, type Ctx } from './rest.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function notFoundJson(ctx: Ctx, res: ServerResponse): void {
  const text = `${JSON.stringify({ message: 'Not Found' })}\n`;
  res.writeHead(404, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.store.newRequestId(),
  });
  res.end(text);
}

export function createApp(): ReturnType<typeof createServer> {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const store = new Store(token);

  const server = createServer(async (req, res) => {
    const ctx: Ctx = { store, host: req.headers.host ?? 'localhost' };
    try {
      const url = new URL(req.url ?? '/', `http://${ctx.host}`);
      const path = url.pathname;
      const method = req.method ?? 'GET';

      // Liveness probe — no auth, no body.
      if (path === '/healthz' && method === 'GET') {
        const text = '{"ok":true}\n';
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': text.length });
        res.end(text);
        return;
      }

      // GraphQL — auth first, exactly 401 without a token.
      if (path === '/api/graphql' && method === 'POST') {
        const header = req.headers.authorization ?? '';
        if (token === '' || header !== `Bearer ${token}`) {
          const text = `${JSON.stringify({ message: 'Bad credentials' })}\n`;
          res.writeHead(401, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
          res.end(text);
          return;
        }
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          const text = `${JSON.stringify({ message: 'malformed JSON body' })}\n`;
          res.writeHead(400, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
          res.end(text);
          return;
        }
        const variables = (parsed as { variables?: Record<string, unknown> }).variables ?? {};
        const result = executeGraphQL(store, parsed, variables);
        const text = `${JSON.stringify(result)}\n`;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
        res.end(text);
        return;
      }

      // MCP — auth and parse errors are handled inside (401 before lookup,
      // 400 + -32700 for a non-JSON body).
      if (path === '/mcp' && (method === 'POST' || method === 'DELETE')) {
        if (method === 'DELETE') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{}\n');
          return;
        }
        const body = await readBody(req);
        handleMcp(ctx, req, res, body);
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const rest = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
        const segments = rest === '' ? [] : rest.split('/').filter((s) => s !== '');
        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
        handleRest(ctx, req, res, segments, url.searchParams, body);
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/<service>
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1] as string);
        const repoName = decodeURIComponent(gitMatch[2] as string);
        const service = gitMatch[3] as string;
        store.learnLogin(owner);
        const repo = store.getRepo(owner, repoName);
        const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        if (service === 'info/refs') {
          const svc = url.searchParams.get('service') ?? '';
          if (svc === 'git-upload-pack') {
            handleInfoRefs(store, repo, 'git-upload-pack', isV2, res);
          } else if (svc === 'git-receive-pack') {
            handleInfoRefs(store, repo, 'git-receive-pack', false, res);
          } else {
            notFoundJson(ctx, res);
          }
          return;
        }
        const body = await readBody(req);
        if (service === 'git-upload-pack') {
          handleUploadPack(store, repo, body, isV2, res);
        } else {
          handleReceivePack(store, repo, body, res);
        }
        return;
      }

      notFoundJson(ctx, res);
    } catch (err) {
      const text = `${JSON.stringify({ message: err instanceof Error ? err.message : 'internal error' })}\n`;
      try {
        res.writeHead(500, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
        res.end(text);
      } catch {
        // The socket is already gone; nothing more to do.
      }
    }
  });

  return server;
}
