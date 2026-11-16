// Ember Forge — REST v3 handlers.
//
// Every reply is application/json with a fresh X-GitHub-Request-Id.
// Auth: Bearer <MAKEFUN_SHOP_TOKEN> on every /api/v3 route except the API
// root and /meta (those answer 200 without a token, like api.github.com).
// A repo under any owner other than the token owner is 404, never 403.
// All data lives in the shared in-memory Store (see store.ts).

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, FORGE_EPOCH, globalId, type Repo, type PullFile } from './store.ts';

export const MERGED_AT = '2025-01-01T00:00:00.000Z';

export interface Ctx {
  store: Store;
  host: string; // request Host header, for absolute pagination links
}

export function sendJson(ctx: Ctx, res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.store.newRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

export function sendError(ctx: Ctx, res: ServerResponse, status: number, message: string): void {
  sendJson(ctx, res, status, { message });
}

export function checkAuth(ctx: Ctx, req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (ctx.store.token === '') return false;
  return header === `Bearer ${ctx.store.token}`;
}

export function parseJsonBody(body: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, error: 'request body is not a JSON object' };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'malformed JSON body' };
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

// ---- shapes ---------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  const owner = repo.owner === Store.PENDING_OWNER ? '' : repo.owner;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner },
    private: repo.privateRepo,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueJson(store: Store, repo: Repo, issue: Repo['issues'][number]): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
  };
}

function pullJson(pull: Repo['pulls'][number]): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.merged ? pull.mergedAt : null,
    merge_commit_sha: pull.merged ? pull.mergeCommitSha : null,
  };
}

// ---- line diff ------------------------------------------------------------

function countLines(buf: Buffer): string[] {
  const text = buf.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function diffFile(store: Store, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
  const oldLines = oldOid ? countLines((store.getObject(oldOid) as { bytes: Buffer }).bytes) : [];
  const newLines = newOid ? countLines((store.getObject(newOid) as { bytes: Buffer }).bytes) : [];
  const oldCount = new Map<string, number>();
  for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const c = oldCount.get(l) ?? 0;
    if (c > 0) oldCount.set(l, c - 1);
    else additions++;
  }
  let deletions = 0;
  for (const c of oldCount.values()) deletions += c;
  if (oldOid !== newOid && additions === 0 && newOid !== null) additions = 1;
  return { additions, deletions };
}

export function computePullFiles(store: Store, baseTree: string | null, headTree: string | null): PullFile[] {
  const diffs = store.diffTrees(baseTree, headTree);
  return diffs.map((d) => {
    const { additions, deletions } = diffFile(store, d.oldOid, d.newOid);
    const status: PullFile['status'] = d.oldOid === null ? 'added' : d.newOid === null ? 'removed' : 'modified';
    return { filename: d.path, status, additions, deletions, changes: additions + deletions };
  });
}

// ---- route handlers -------------------------------------------------------

// The router calls this with the path segments after /api/v3.
export function handleRest(ctx: Ctx, req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams, body: Buffer): void {
  const store = ctx.store;
  const method = req.method ?? 'GET';
  const authed = checkAuth(ctx, req);

  // API root and meta answer without a token.
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    } else {
      sendError(ctx, res, 404, 'Not Found');
    }
    return;
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method === 'GET') sendJson(ctx, res, 200, { installed_version: '1.0.0' });
    else sendError(ctx, res, 404, 'Not Found');
    return;
  }
  if (!authed) {
    sendError(ctx, res, 401, 'Bad credentials');
    return;
  }

  // GET /user — the token owner's login (learned from owner-bearing URLs).
  if (segments.length === 1 && segments[0] === 'user') {
    if (method === 'GET') {
      if (store.viewerLogin === null) {
        sendError(ctx, res, 401, 'viewer login not yet known');
      } else {
        sendJson(ctx, res, 200, { login: store.viewerLogin, id: 1000, type: 'User' });
      }
      return;
    }
    sendError(ctx, res, 404, 'Not Found');
    return;
  }

  // POST /user/repos and GET /user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) { sendError(ctx, res, 400, parsed.error); return; }
      const name = asString(parsed.value.name);
      if (name === '') { sendError(ctx, res, 422, 'name is required'); return; }
      // The owner is the token owner; before it is learned from an
      // owner-bearing URL the repo is held under a sentinel and migrated
      // on first learning (store.learnLogin).
      const owner = store.viewerLogin ?? '';
      const repo = store.createRepo(owner, name, asBool(parsed.value.private, false), asString(parsed.value.description));
      if (!repo) { sendError(ctx, res, 422, `Repository ${owner}/${name} already exists`); return; }
      sendJson(ctx, res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      const all = store.viewerRepos();
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        headers.link = `<http://${ctx.host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next"`;
      }
      sendJson(ctx, res, 200, slice.map((r) => repoJson(r)), headers);
      return;
    }
    sendError(ctx, res, 404, 'Not Found');
    return;
  }

  // /repos/{owner}/{repo}/...
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = decodeURIComponent(segments[1] as string);
    const name = decodeURIComponent(segments[2] as string);
    store.learnLogin(owner);
    const repo = store.getRepo(owner, name);
    const rest = segments.slice(3);
    if (!repo) {
      sendError(ctx, res, 404, 'Not Found');
      return;
    }
    handleRepoRoute(ctx, req, res, repo, rest, query, body);
    return;
  }

  sendError(ctx, res, 404, 'Not Found');
}

function handleRepoRoute(ctx: Ctx, req: IncomingMessage, res: ServerResponse, repo: Repo, rest: string[], query: URLSearchParams, body: Buffer): void {
  const store = ctx.store;
  const method = req.method ?? 'GET';

  // /repos/{o}/{r} itself
  if (rest.length === 0) {
    if (method === 'GET') { sendJson(ctx, res, 200, repoJson(repo)); return; }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) { sendError(ctx, res, 400, parsed.error); return; }
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      sendJson(ctx, res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      res.writeHead(204, { 'x-github-request-id': store.newRequestId() });
      res.end();
      return;
    }
    sendError(ctx, res, 404, 'Not Found');
    return;
  }

  const head = rest[0] as string;

  // git/refs
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) { sendError(ctx, res, 400, parsed.error); return; }
      const ref = asString(parsed.value.ref);
      const sha = asString(parsed.value.sha);
      if (!ref.startsWith('refs/heads/') || !/^[0-9a-f]{40}$/.test(sha)) {
        sendError(ctx, res, 422, 'invalid ref or sha');
        return;
      }
      const obj = store.getObject(sha);
      if (!obj || obj.type !== 'commit') { sendError(ctx, res, 422, 'sha is not a commit'); return; }
      if (repo.refs.has(ref)) { sendError(ctx, res, 422, 'Reference already exists'); return; }
      repo.refs.set(ref, sha);
      sendJson(ctx, res, 201, { ref, object: { sha } });
      return;
    }
    if (method === 'GET' && rest.length >= 4 && rest[2] === 'heads') {
      const branch = decodeURIComponent(rest.slice(3).join('/'));
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) { sendError(ctx, res, 404, 'Not Found'); return; }
      sendJson(ctx, res, 200, { ref: `refs/heads/${branch}`, object: { sha } });
      return;
    }
    sendError(ctx, res, 404, 'Not Found');
    return;
  }

  // branches
  if (head === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const list = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .sort()
        .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r) as string } }));
      sendJson(ctx, res, 200, list);
      return;
    }
    if (method === 'GET' && rest.length === 2) {
      const branch = decodeURIComponent(rest[1] as string);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) { sendError(ctx, res, 404, 'Not Found'); return; }
      sendJson(ctx, res, 200, { name: branch, commit: { sha } });
      return;
    }
    sendError(ctx, res, 404, 'Not Found');
    return;
  }

  // commits
  if (head === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const refName = query.get('sha');
      const ref = refName ? `refs/heads/${refName}` : `refs/heads/${repo.defaultBranch}`;
      const tip = repo.refs.get(ref);
      if (!tip) { sendJson(ctx, res, 200, []); return; }
      const ancestry = store.commitAncestry(tip);
      sendJson(ctx, res, 200, ancestry.map((sha) => {
        const obj = store.getObject(sha) as { bytes: Buffer };
        return { sha, commit: { message: store.parseCommit(obj.bytes).message } };
      }));
      return;
    }
    sendError(ctx, res, 404, 'Not Found');
    return;
  }

  // contents
  if (head === 'contents') {
    const path = rest.slice(1).map((s) => decodeURIComponent(s)).join('/');
    if (method === 'PUT') {
      handleContentsPut(ctx, res, repo, path, body, query);
      return;
    }
    if (method === 'GET') {
      const refName = query.get('ref');
      const ref = refName ? `refs/heads/${refName}` : `refs/heads/${repo.defaultBranch}`;
      const tip = repo.refs.get(ref);
      if (!tip) { sendError(ctx, res, 404, 'Not Found'); return; }
      const { tree } = store.parseCommit((store.getObject(tip) as { bytes: Buffer }).bytes);
      if (path === '') {
        const entries = store.listDir(tree, '') ?? [];
        sendJson(ctx, res, 200, entries.map((e) => ({
          type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: e.name, sha: e.oid,
        })));
        return;
      }
      const blobOid = store.readPath(tree, path);
      if (blobOid) {
        const blob = store.getObject(blobOid) as { bytes: Buffer };
        sendJson(ctx, res, 200, {
          type: 'file', encoding: 'base64',
          content: blob.bytes.toString('base64'),
          sha: blobOid, size: blob.bytes.length, name: path.split('/').pop(), path,
        });
        return;
      }
      const dir = store.listDir(tree, path);
      if (dir) {
        sendJson(ctx, res, 200, dir.map((e) => ({
          type: e.mode === '40000' ? 'dir' : 'file',
          name: e.name, path: `${path}/${e.name}`, sha: e.oid,
        })));
        return;
      }
      sendError(ctx, res, 404, 'Not Found');
      return;
    }
    if (method === 'DELETE') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) { sendError(ctx, res, 400, parsed.error); return; }
      const branchName = asString(parsed.value.branch) || repo.defaultBranch;
      const ref = `refs/heads/${branchName}`;
      const tip = repo.refs.get(ref);
      if (!tip) { sendError(ctx, res, 404, 'Not Found'); return; }
      const { tree } = store.parseCommit((store.getObject(tip) as { bytes: Buffer }).bytes);
      const current = store.readPath(tree, path);
      if (!current) { sendError(ctx, res, 404, 'Not Found'); return; }
      const sha = asString(parsed.value.sha);
      if (sha !== '' && sha !== current) { sendError(ctx, res, 409, 'sha does not match'); return; }
      const newTree = store.writePath(tree, path, null);
      const message = asString(parsed.value.message) || `Delete ${path}`;
      const commit = store.makeCommit(newTree, [tip], repo.owner, `${repo.owner}@example.invalid`, FORGE_EPOCH, message);
      repo.refs.set(ref, commit);
      sendJson(ctx, res, 200, { commit: { sha: commit } });
      return;
    }
    sendError(ctx, res, 404, 'Not Found');
    return;
  }

  // labels
  if (head === 'labels') {
    if (method === 'POST' && rest.length === 1) {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) { sendError(ctx, res, 400, parsed.error); return; }
      const name = asString(parsed.value.name);
      if (name === '') { sendError(ctx, res, 422, 'name is required'); return; }
      if (repo.labels.has(name)) { sendError(ctx, res, 422, 'Label already exists'); return; }
      const label = { name, color: asString(parsed.value.color) || 'ededed' };
      repo.labels.set(name, label);
      sendJson(ctx, res, 201, label);
      return;
    }
    sendError(ctx, res, 404, 'Not Found');
    return;
  }

  // issues
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) { sendError(ctx, res, 400, parsed.error); return; }
        const title = asString(parsed.value.title);
        if (title === '') { sendError(ctx, res, 422, 'title is required'); return; }
        const labelNames = Array.isArray(parsed.value.labels) ? (parsed.value.labels as unknown[]).map((l) => String(l)) : [];
        const labels: { name: string; color: string }[] = [];
        for (const ln of labelNames) {
          const label = repo.labels.get(ln);
          if (!label) { sendError(ctx, res, 422, `Label ${ln} does not exist`); return; }
          labels.push(label);
        }
        const issue = {
          id: store.nextIssueId++,
          number: ++repo.issueCounter,
          title,
          body: asString(parsed.value.body),
          state: 'open' as const,
          labels,
          comments: [] as { id: number; body: string }[],
        };
        repo.issues.push(issue);
        sendJson(ctx, res, 201, issueJson(store, repo, issue));
        return;
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'asc';
        const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
        let list = repo.issues.filter((i) => state === 'all' || i.state === state);
        if (sort === 'created' && direction === 'desc') list = [...list].reverse();
        sendJson(ctx, res, 200, list.slice(0, perPage).map((i) => issueJson(store, repo, i)));
        return;
      }
      sendError(ctx, res, 404, 'Not Found');
      return;
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num)) { sendError(ctx, res, 404, 'Not Found'); return; }
    const issue = repo.issues.find((i) => i.number === num);
    if (!issue) { sendError(ctx, res, 404, 'Not Found'); return; }
    if (rest.length === 2) {
      if (method === 'GET') { sendJson(ctx, res, 200, issueJson(store, repo, issue)); return; }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) { sendError(ctx, res, 400, parsed.error); return; }
        if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
        sendJson(ctx, res, 200, issueJson(store, repo, issue));
        return;
      }
      sendError(ctx, res, 404, 'Not Found');
      return;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) { sendError(ctx, res, 400, parsed.error); return; }
        const comment = { id: store.nextCommentId++, body: asString(parsed.value.body) };
        issue.comments.push(comment);
        sendJson(ctx, res, 201, comment);
        return;
      }
      if (method === 'GET') {
        sendJson(ctx, res, 200, issue.comments);
        return;
      }
      sendError(ctx, res, 404, 'Not Found');
      return;
    }
    sendError(ctx, res, 404, 'Not Found');
    return;
  }

  // pulls
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) { sendError(ctx, res, 400, parsed.error); return; }
        const headRef = asString(parsed.value.head);
        const baseRef = asString(parsed.value.base);
        const headSha = repo.refs.get(`refs/heads/${headRef}`);
        const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
        if (!headSha || !baseSha) { sendError(ctx, res, 422, 'head or base branch not found'); return; }
        const openDup = repo.pulls.find((p) => p.state === 'open' && p.headRef === headRef);
        if (openDup) { sendError(ctx, res, 422, 'A pull request already exists for this head branch'); return; }
        const headTree = store.parseCommit((store.getObject(headSha) as { bytes: Buffer }).bytes).tree;
        const baseTree = store.parseCommit((store.getObject(baseSha) as { bytes: Buffer }).bytes).tree;
        const pull = {
          id: store.nextPullId++,
          number: ++repo.pullCounter,
          title: asString(parsed.value.title),
          body: asString(parsed.value.body),
          state: 'open' as const,
          headRef, baseRef, headSha, baseSha,
          merged: false, mergedAt: '', mergeCommitSha: '',
          files: computePullFiles(store, baseTree, headTree),
        };
        repo.pulls.push(pull);
        sendJson(ctx, res, 201, pullJson(pull));
        return;
      }
      if (method === 'GET') {
        const state = query.get('state');
        const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
        let list = repo.pulls;
        if (state === 'all') list = repo.pulls;
        else if (state === 'closed') list = repo.pulls.filter((p) => p.state === 'closed');
        else list = repo.pulls.filter((p) => p.state === 'open');
        sendJson(ctx, res, 200, list.slice(0, perPage).map((p) => pullJson(p)));
        return;
      }
      sendError(ctx, res, 404, 'Not Found');
      return;
    }
    const num = Number(rest[1]);
    if (!Number.isInteger(num)) { sendError(ctx, res, 404, 'Not Found'); return; }
    const pull = repo.pulls.find((p) => p.number === num);
    if (!pull) { sendError(ctx, res, 404, 'Not Found'); return; }
    if (rest.length === 2) {
      if (method === 'GET') { sendJson(ctx, res, 200, pullJson(pull)); return; }
      sendError(ctx, res, 404, 'Not Found');
      return;
    }
    if (rest.length === 3 && rest[2] === 'files') {
      if (method === 'GET') {
        sendJson(ctx, res, 200, pull.files.map((f) => ({
          filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes,
        })));
        return;
      }
      sendError(ctx, res, 404, 'Not Found');
      return;
    }
    if (rest.length === 3 && rest[2] === 'merge') {
      if (method === 'PUT') {
        const result = mergePull(ctx, repo, pull);
        if (result.ok) {
          sendJson(ctx, res, 200, { merged: true, sha: result.sha as string, message: `Merge pull request #${pull.number}` });
        } else if (result.status === 404) {
          sendError(ctx, res, 404, 'Not Found');
        } else {
          sendError(ctx, res, 405, 'Merge conflict');
        }
        return;
      }
      sendError(ctx, res, 404, 'Not Found');
      return;
    }
    sendError(ctx, res, 404, 'Not Found');
    return;
  }

  sendError(ctx, res, 404, 'Not Found');
}

function handleContentsPut(ctx: Ctx, res: ServerResponse, repo: Repo, path: string, body: Buffer, _query: URLSearchParams): void {
  const store = ctx.store;
  const parsed = parseJsonBody(body);
  if (!parsed.ok) { sendError(ctx, res, 400, parsed.error); return; }
  const contentB64 = asString(parsed.value.content);
  if (contentB64 === '') { sendError(ctx, res, 422, 'content is required'); return; }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(contentB64, 'base64');
  } catch {
    sendError(ctx, res, 422, 'content is not valid base64');
    return;
  }
  const branchName = asString(parsed.value.branch) || repo.defaultBranch;
  const ref = `refs/heads/${branchName}`;
  let tip = repo.refs.get(ref);
  if (tip === undefined) {
    // Branch does not exist: start from the default branch tip (or unborn).
    tip = branchName === repo.defaultBranch ? undefined : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  const oldTree = tip ? store.parseCommit((store.getObject(tip) as { bytes: Buffer }).bytes).tree : null;
  const current = oldTree ? store.readPath(oldTree, path) : null;
  const sha = asString(parsed.value.sha);
  if (sha !== '') {
    if (current === null || current !== sha) { sendError(ctx, res, 409, 'sha does not match the current file'); return; }
  }
  const blobOid = store.putObject('blob', bytes);
  const newTree = store.writePath(oldTree, path, blobOid);
  const message = asString(parsed.value.message) || `Update ${path}`;
  const parents = tip ? [tip] : [];
  const commit = store.makeCommit(newTree, parents, repo.owner, `${repo.owner}@example.invalid`, FORGE_EPOCH, message);
  repo.refs.set(ref, commit);
  sendJson(ctx, res, current === null ? 201 : 200, {
    content: { sha: blobOid, encoding: 'base64' },
    commit: { sha: commit },
  });
}

// Squash-merge a pull request. Returns {ok, sha} on success,
// {ok:false, status:405} on conflict, {ok:false, status:404} when the PR
// or its branches are gone. Shared with the GraphQL executor.
export function mergePull(ctx: Ctx, repo: Repo, pull: Repo['pulls'][number]): { ok: true; sha: string } | { ok: false; status: 404 | 405 } {
  const store = ctx.store;
  if (pull.state !== 'open') return { ok: false, status: 404 };
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return { ok: false, status: 404 };
  const baseTree = store.parseCommit((store.getObject(pull.baseSha) as { bytes: Buffer }).bytes).tree;
  const headTree = store.parseCommit((store.getObject(headTip) as { bytes: Buffer }).bytes).tree;
  const currentTree = store.parseCommit((store.getObject(baseTip) as { bytes: Buffer }).bytes).tree;
  const headChanges = store.diffTrees(baseTree, headTree);
  const currentChanges = store.diffTrees(baseTree, currentTree);
  const currentMap = new Map(currentChanges.map((c) => [c.path, c.newOid]));
  for (const hc of headChanges) {
    if (currentMap.has(hc.path) && currentMap.get(hc.path) !== hc.newOid) {
      return { ok: false, status: 405 };
    }
  }
  // Apply the head's changes onto the current base tree.
  let tree: string | null = currentTree;
  for (const hc of headChanges) {
    tree = store.writePath(tree, hc.path, hc.newOid);
  }
  const mergeCommit = store.makeCommit(tree as string, [baseTip], repo.owner, `${repo.owner}@example.invalid`, FORGE_EPOCH, pull.title);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = MERGED_AT;
  pull.mergeCommitSha = mergeCommit;
  return { ok: true, sha: mergeCommit };
}
