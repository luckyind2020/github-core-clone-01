// Ember Forge — MCP (Model Context Protocol) over Streamable HTTP.
//
// Modern era only (2026-07-28, server/discover): no handshake, no session
// state. Plain JSON answers (no SSE). Every tools/call runs against the same
// in-memory Store as REST/GraphQL/git, so MCP-created objects read back over
// REST with unchanged ids. No Authorization header on tools/call is HTTP 401
// before any tool lookup; a non-JSON body is HTTP 400 with -32700.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { repoJson, mergePull, computePullFiles, type Ctx } from './rest.ts';

const SERVER_NAME = 'ember-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        body: { type: 'string', description: 'Pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// The tools list is built once so two tools/list calls answer byte-identical.
const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

function sendRpc(res: ServerResponse, id: unknown, result: unknown): void {
  const text = `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`;
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendRpcError(res: ServerResponse, id: unknown, code: number, message: string, data?: unknown): void {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  const text = `${JSON.stringify({ jsonrpc: '2.0', id, error })}\n`;
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function textResult(obj: unknown): { content: { type: 'text'; text: string }[]; structuredContent: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}

function errorResult(message: string): { content: { type: 'text'; text: string }[]; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// Pick an argument by canonical name, falling back to known synonyms.
function pick(args: Record<string, unknown>, canonical: string, synonyms: string[]): unknown {
  if (args[canonical] !== undefined) return args[canonical];
  for (const s of synonyms) {
    if (args[s] !== undefined) return args[s];
  }
  return undefined;
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function handleToolsCall(ctx: Ctx, name: string, args: Record<string, unknown>): { content: { type: 'text'; text: string }[]; structuredContent?: unknown; isError?: boolean } {
  const store = ctx.store;
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return errorResult(`Unknown tool: ${name}`);
  const missing = tool.inputSchema.required.filter((r) => pick(args, r, []) === undefined);
  if (missing.length > 0) {
    return errorResult(`Missing required argument: ${missing.join(', ')}`);
  }
  switch (name) {
    case 'create_repo': {
      const repoName = asStr(pick(args, 'name', ['repo', 'repository', 'repository_name', 'repo_name']));
      const owner = store.viewerLogin ?? '';
      const repo = store.createRepo(owner, repoName, pick(args, 'private', ['is_private']) === true, asStr(pick(args, 'description', ['about', 'summary', 'body'])));
      if (!repo) return errorResult(`Repository ${owner}/${repoName} already exists`);
      return textResult(repoJson(repo));
    }
    case 'get_repo': {
      const owner = asStr(pick(args, 'owner', ['owner_login', 'org', 'organization', 'user', 'login']));
      const repoName = asStr(pick(args, 'repo', ['repository', 'repository_name', 'repo_name']));
      store.learnLogin(owner);
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
      return textResult(repoJson(repo));
    }
    case 'create_issue': {
      const owner = asStr(pick(args, 'owner', ['owner_login', 'org', 'organization', 'user', 'login']));
      const repoName = asStr(pick(args, 'repo', ['repository', 'repository_name', 'repo_name']));
      store.learnLogin(owner);
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
      const issue = {
        id: store.nextIssueId++,
        number: ++repo.issueCounter,
        title: asStr(pick(args, 'title', ['issue_title', 'subject'])),
        body: asStr(pick(args, 'body', ['issue_body', 'description', 'content', 'text', 'comment'])),
        state: 'open' as const,
        labels: [] as { name: string; color: string }[],
        comments: [] as { id: number; body: string }[],
      };
      repo.issues.push(issue);
      return textResult({
        id: issue.id, number: issue.number, title: issue.title, body: issue.body,
        state: issue.state, labels: issue.labels,
      });
    }
    case 'list_issues': {
      const owner = asStr(pick(args, 'owner', ['owner_login', 'org', 'organization', 'user', 'login']));
      const repoName = asStr(pick(args, 'repo', ['repository', 'repository_name', 'repo_name']));
      store.learnLogin(owner);
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
      const stateFilter = asStr(pick(args, 'state', ['status'])) || 'open';
      const list = repo.issues
        .filter((i) => stateFilter === 'all' || i.state === stateFilter)
        .map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels.map((l) => ({ name: l.name })) }));
      return textResult(list);
    }
    case 'create_pull_request': {
      const owner = asStr(pick(args, 'owner', ['owner_login', 'org', 'organization', 'user', 'login']));
      const repoName = asStr(pick(args, 'repo', ['repository', 'repository_name', 'repo_name']));
      store.learnLogin(owner);
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
      const headRef = asStr(pick(args, 'head', ['head_ref', 'head_branch', 'source', 'source_branch', 'from_branch', 'branch']));
      const baseRef = asStr(pick(args, 'base', ['base_ref', 'base_branch', 'target', 'target_branch', 'into_branch']));
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (!headSha || !baseSha) return errorResult('head or base branch not found');
      const headTree = store.parseCommit((store.getObject(headSha) as { bytes: Buffer }).bytes).tree;
      const baseTree = store.parseCommit((store.getObject(baseSha) as { bytes: Buffer }).bytes).tree;
      const pull = {
        id: store.nextPullId++,
        number: ++repo.pullCounter,
        title: asStr(pick(args, 'title', ['pr_title', 'pull_request_title', 'subject'])),
        body: asStr(pick(args, 'body', ['issue_body', 'description', 'content', 'text'])),
        state: 'open' as const,
        headRef, baseRef, headSha, baseSha,
        merged: false, mergedAt: '', mergeCommitSha: '',
        files: computePullFiles(store, baseTree, headTree),
      };
      repo.pulls.push(pull);
      return textResult({
        id: pull.id, number: pull.number, pull_number: pull.number, title: pull.title,
        state: pull.state, head: { ref: headRef, sha: headSha }, base: { ref: baseRef, sha: baseSha },
      });
    }
    case 'merge_pull_request': {
      const owner = asStr(pick(args, 'owner', ['owner_login', 'org', 'organization', 'user', 'login']));
      const repoName = asStr(pick(args, 'repo', ['repository', 'repository_name', 'repo_name']));
      store.learnLogin(owner);
      const repo = store.getRepo(owner, repoName);
      if (!repo) return errorResult(`Repository ${owner}/${repoName} not found`);
      const num = Number(pick(args, 'pull_number', ['pull_request_number', 'pr_number', 'number', 'issue_number', 'index']));
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return errorResult(`Pull request #${num} not found`);
      const result = mergePull(ctx, repo, pull);
      if (!result.ok) return errorResult(result.status === 405 ? 'Merge conflict' : 'Pull request not found');
      return textResult({ merged: true, sha: result.sha, number: pull.number, state: pull.state });
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

export function handleMcp(ctx: Ctx, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  const store = ctx.store;
  // Auth is decided before any tool lookup.
  const header = req.headers.authorization ?? '';
  if (store.token === '' || header !== `Bearer ${store.token}`) {
    const text = `${JSON.stringify({ message: 'Bad credentials' })}\n`;
    res.writeHead(401, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
    return;
  }
  let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(body.toString('utf8')) as typeof msg;
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) throw new Error('not an object');
  } catch {
    const text = `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`;
    res.writeHead(400, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
    res.end(text);
    return;
  }
  const id = msg.id ?? null;
  const method = msg.method ?? '';
  // Notifications carry no id and get no answer.
  if (id === null && method.startsWith('notifications/')) {
    res.writeHead(202);
    res.end();
    return;
  }
  const params = (msg.params ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover': {
      sendRpc(res, id, {
        supportedVersions: [MODERN_REVISION],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
      return;
    }
    case 'initialize': {
      const offered = (params.protocolVersion as string | undefined) ?? '';
      const known = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      const chosen = known.includes(offered) ? offered : '2025-11-25';
      sendRpc(res, id, {
        protocolVersion: chosen,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }
    case 'tools/list': {
      const text = `${JSON.stringify({ jsonrpc: '2.0', id, result: JSON.parse(TOOLS_LIST_JSON) })}\n`;
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
      return;
    }
    case 'tools/call': {
      const toolName = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((t) => t.name === toolName);
      if (!tool) {
        sendRpcError(res, id, -32602, `Unknown tool: ${toolName}`);
        return;
      }
      const result = handleToolsCall(ctx, toolName, args);
      sendRpc(res, id, result);
      return;
    }
    case 'ping': {
      sendRpc(res, id, {});
      return;
    }
    default: {
      sendRpcError(res, id, -32601, `Method not found: ${method}`);
      return;
    }
  }
}
