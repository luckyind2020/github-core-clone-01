// Ember Forge — GraphQL v4 executor.
//
// A hand-rolled executor for exactly the 18 documents the suite sends
// (see the build spec §4.1): variables, inline enum lists, inline input
// objects, null variables, operation names, aliases, inline fragments and
// batched arrays. Mutations write to the same in-memory Store as REST.
// Unknown fields answer HTTP 200 with an errors array naming the field;
// an unknown repository answers data.repository = null with no errors.

import { Store, globalId, decodeGlobalId, type Repo } from './store.ts';
import { mergePull, computePullFiles, type Ctx } from './rest.ts';

// ---- static schema surface (also serves __type introspection) -------------

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'];
const USER_FIELDS = ['login'];
const QUERY_FIELDS = ['viewer', 'repository', 'node', '__type'];
const MUTATION_FIELDS = ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'USER', 'REPOSITORY', 'CODE', 'DISCUSSION', 'COMMIT'];

// ---- parser ---------------------------------------------------------------

type Value = string | number | boolean | null | { __enum: string } | { __var: string } | Value[] | { [k: string]: Value };

interface FieldNode {
  name: string;
  alias: string | null;
  args: Record<string, Value>;
  fields: SelectionNode[];
}

type SelectionNode = FieldNode | { __fragment: string; fields: SelectionNode[] };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, Value>;
  fields: SelectionNode[];
}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { tokens.push('...'); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(c)) { tokens.push(c); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; }
        else { out += src[j]; j++; }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z_0-9]/.test(src[j] as string)) j++;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (src[j] === '-') j++;
      while (j < src.length && /[0-9.]/.test(src[j] as string)) j++;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    i++;
  }
  return tokens;
}

class Parser {
  tokens: string[];
  pos = 0;
  constructor(src: string) {
    this.tokens = tokenize(src);
  }
  peek(): string | null {
    return this.tokens[this.pos] ?? null;
  }
  next(): string {
    return this.tokens[this.pos++] as string;
  }
  expect(tok: string): void {
    const got = this.next();
    if (got !== tok) throw new Error(`expected ${tok}, got ${got}`);
  }
  parseValue(): Value {
    const tok = this.next();
    if (tok === '[') {
      const list: Value[] = [];
      while (this.peek() !== ']') list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (tok === '{') {
      const obj: Record<string, Value> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        obj[key] = this.parseValue();
      }
      this.expect('}');
      return obj;
    }
    if (tok === '$') return { __var: this.next() };
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    if (tok.startsWith('"')) return JSON.parse(tok) as string;
    if (/^-?\d+$/.test(tok)) return parseInt(tok, 10);
    if (/^-?\d+\.\d+$/.test(tok)) return parseFloat(tok);
    return { __enum: tok };
  }
  parseArgs(): Record<string, Value> {
    const args: Record<string, Value> = {};
    if (this.peek() !== '(') return args;
    this.expect('(');
    while (this.peek() !== ')') {
      const key = this.next();
      this.expect(':');
      args[key] = this.parseValue();
    }
    this.expect(')');
    return args;
  }
  parseSelection(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        this.expect('on');
        const typeName = this.next();
        out.push({ __fragment: typeName, fields: this.parseSelection() });
        continue;
      }
      const first = this.next();
      let alias: string | null = null;
      let name = first;
      if (this.peek() === ':') {
        this.next();
        alias = first;
        name = this.next();
      }
      const args = this.parseArgs();
      let fields: SelectionNode[] = [];
      if (this.peek() === '{') fields = this.parseSelection();
      out.push({ name, alias, args, fields });
    }
    this.expect('}');
    return out;
  }
  parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const tok = this.peek();
    if (tok === 'query' || tok === 'mutation') {
      type = this.next() as 'query' | 'mutation';
      const nextTok = this.peek();
      if (nextTok !== null && nextTok !== '{' && nextTok !== '(') name = this.next();
    }
    // Variable definitions: ($x: Type!, $y: Type) — skipped, values come
    // from the request body.
    if (this.peek() === '(') {
      let depth = 0;
      while (true) {
        const t = this.next();
        if (t === '(') depth++;
        else if (t === ')') { depth--; if (depth === 0) break; }
      }
    }
    const fields = this.parseSelection();
    return { type, name, variables: {}, fields };
  }
  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }
}

// ---- executor -------------------------------------------------------------

interface ExecState {
  store: Store;
  variables: Record<string, unknown>;
  errors: { message: string }[];
}

function resolveValue(v: Value, state: ExecState): unknown {
  if (v !== null && typeof v === 'object' && '__var' in v) {
    return state.variables[(v as { __var: string }).__var] ?? null;
  }
  if (v !== null && typeof v === 'object' && '__enum' in v) {
    return (v as { __enum: string }).__enum;
  }
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, state));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = resolveValue(val, state);
    return out;
  }
  return v;
}

function argValue(field: FieldNode, name: string, state: ExecState): unknown {
  const raw = field.args[name];
  if (raw === undefined) return undefined;
  return resolveValue(raw, state);
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.id);
}

function issueGlobalId(repo: Repo, number: number): string {
  return globalId('Issue', repo.id, number);
}

function pullGlobalId(repo: Repo, number: number): string {
  return globalId('PullRequest', repo.id, number);
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(raw);
    return m ? parseInt(m[1] as string, 10) : null;
  } catch {
    return null;
  }
}

function gqlState(state: string): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

// Resolve a selection set against an object with a known type name.
// Returns the selected fields (or null when the value itself is null).
function resolveSelection(state: ExecState, typeName: string, value: Record<string, unknown> | null, fields: SelectionNode[]): Record<string, unknown> | null {
  if (value === null) return null;
  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload' || typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload' || typeName === 'AddCommentPayload') {
    const out: Record<string, unknown> = {};
    for (const sel of fields) {
      if ('__fragment' in sel) continue;
      const field = sel as FieldNode;
      const key = field.alias ?? field.name;
      const resolved = resolvePayloadField(state, value, field);
      if (resolved !== undefined) out[key] = resolved;
    }
    return out;
  }
  if (typeName === 'CommentEdge') {
    const out: Record<string, unknown> = {};
    for (const sel of fields) {
      if ('__fragment' in sel) continue;
      const field = sel as FieldNode;
      if (field.name === 'node') {
        const node = value.node as Record<string, unknown>;
        const nodeOut: Record<string, unknown> = {};
        for (const sub of field.fields) {
          if ('__fragment' in sub) continue;
          const sf = sub as FieldNode;
          if (sf.name === 'id') nodeOut[sf.alias ?? 'id'] = node.id ?? null;
          else if (sf.name === 'body') nodeOut[sf.alias ?? 'body'] = node.body ?? null;
          else unknownField(state, 'Comment', sf.name);
        }
        out[field.alias ?? 'node'] = nodeOut;
      }
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const sel of fields) {
    if ('__fragment' in sel) {
      if (sel.__fragment === typeName) {
        const sub = resolveSelection(state, typeName, value, sel.fields);
        if (sub) Object.assign(out, sub);
      }
      continue;
    }
    const field = sel as FieldNode;
    const key = field.alias ?? field.name;
    const resolved = resolveField(state, typeName, value, field);
    if (resolved !== undefined) out[key] = resolved;
  }
  return out;
}

function unknownField(state: ExecState, typeName: string, name: string): void {
  state.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
}

// Field resolvers per type. Returns undefined when the field is unknown
// (the executor records an error and omits it).
function resolveField(state: ExecState, typeName: string, value: Record<string, unknown>, field: FieldNode): unknown {
  const store = state.store;
  switch (typeName) {
    case 'Query': return resolveQueryField(state, value, field);
    case 'Mutation': return resolveMutationField(state, value, field);
    case 'Repository': return resolveRepositoryField(state, value as unknown as Repo, field);
    case 'Issue': return resolveIssueField(state, value, field);
    case 'PullRequest': return resolvePullRequestField(state, value, field);
    case 'User': {
      if (field.name === 'login') return value.login ?? null;
      unknownField(state, typeName, field.name);
      return undefined;
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') {
        const nodes = value.nodes as { repo: Repo; issue: Repo['issues'][number] }[];
        return nodes.map((n) => resolveSelection(state, 'Issue', issueValue(n.repo, n.issue), field.fields));
      }
      if (field.name === 'pageInfo') {
        return resolveSelection(state, 'PageInfo', value.pageInfo as Record<string, unknown>, field.fields);
      }
      unknownField(state, typeName, field.name);
      return undefined;
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') {
        const nodes = value.nodes as { repo: Repo; pull: Repo['pulls'][number] }[];
        return nodes.map((n) => resolveSelection(state, 'PullRequest', pullValue(n.repo, n.pull), field.fields));
      }
      unknownField(state, typeName, field.name);
      return undefined;
    }
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') {
        const nodes = value.nodes as { path: string }[];
        return nodes.map((n) => resolveSelection(state, 'PullRequestChangedFile', n as unknown as Record<string, unknown>, field.fields));
      }
      unknownField(state, typeName, field.name);
      return undefined;
    }
    case 'PullRequestChangedFile': {
      if (field.name === 'path') return value.path ?? null;
      unknownField(state, typeName, field.name);
      return undefined;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return value.hasNextPage ?? false;
      if (field.name === 'endCursor') return value.endCursor ?? null;
      unknownField(state, typeName, field.name);
      return undefined;
    }
    case 'BranchRef': {
      if (field.name === 'name') return value.name ?? null;
      unknownField(state, typeName, field.name);
      return undefined;
    }
    case '__Type': {
      if (field.name === 'fields') {
        const names = (value.fields as string[]) ?? [];
        return names.map((n) => ({ name: n }));
      }
      if (field.name === 'enumValues') {
        const names = (value.enumValues as string[]) ?? [];
        return names.map((n) => ({ name: n }));
      }
      unknownField(state, typeName, field.name);
      return undefined;
    }
    default:
      unknownField(state, typeName, field.name);
      return undefined;
  }
}

function issueValue(repo: Repo, issue: Repo['issues'][number]): Record<string, unknown> {
  return { __repo: repo, __issue: issue, id: issueGlobalId(repo, issue.number), number: issue.number, title: issue.title, state: gqlState(issue.state), body: issue.body };
}

function pullValue(repo: Repo, pull: Repo['pulls'][number]): Record<string, unknown> {
  return { __repo: repo, __pull: pull, id: pullGlobalId(repo, pull.number), number: pull.number, title: pull.title, state: pull.state === 'open' ? 'OPEN' : 'CLOSED', merged: pull.merged };
}

function resolveIssueField(state: ExecState, value: Record<string, unknown>, field: FieldNode): unknown {
  if (ISSUE_FIELDS.includes(field.name)) return value[field.name] ?? null;
  unknownField(state, 'Issue', field.name);
  return undefined;
}

function resolvePullRequestField(state: ExecState, value: Record<string, unknown>, field: FieldNode): unknown {
  const pull = value.__pull as Repo['pulls'][number];
  const repo = value.__repo as Repo;
  switch (field.name) {
    case 'id': case 'number': case 'state': case 'merged': return value[field.name] ?? null;
    case 'headRefName': return pull.headRef;
    case 'baseRefName': return pull.baseRef;
    case 'mergeable': return computeMergeable(state.store, repo, pull);
    case 'files': {
      const first = (argValue(field, 'first', state) as number | undefined) ?? 10;
      const nodes = pull.files.slice(0, first).map((f) => ({ path: f.filename }));
      return resolveSelection(state, 'PullRequestChangedFileConnection', { nodes }, field.fields);
    }
    default:
      unknownField(state, 'PullRequest', field.name);
      return undefined;
  }
}

function computeMergeable(store: Store, repo: Repo, pull: Repo['pulls'][number]): string {
  if (pull.state !== 'open') return 'MERGEABLE';
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headTip || !baseTip) return 'UNKNOWN';
  const baseTree = store.parseCommit((store.getObject(pull.baseSha) as { bytes: Buffer }).bytes).tree;
  const headTree = store.parseCommit((store.getObject(headTip) as { bytes: Buffer }).bytes).tree;
  const currentTree = store.parseCommit((store.getObject(baseTip) as { bytes: Buffer }).bytes).tree;
  const headChanges = store.diffTrees(baseTree, headTree);
  const currentMap = new Map(store.diffTrees(baseTree, currentTree).map((c) => [c.path, c.newOid]));
  for (const hc of headChanges) {
    if (currentMap.has(hc.path) && currentMap.get(hc.path) !== hc.newOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function resolveRepositoryField(state: ExecState, repo: Repo, field: FieldNode): unknown {
  const store = state.store;
  switch (field.name) {
    case 'id': return repoGlobalId(repo);
    case 'databaseId': return repo.id;
    case 'name': return repo.name;
    case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
    case 'owner': return resolveSelection(state, 'User', { login: repo.owner }, field.fields);
    case 'defaultBranchRef': {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!tip) return null;
      return resolveSelection(state, 'BranchRef', { name: repo.defaultBranch }, field.fields);
    }
    case 'viewerPermission': return 'ADMIN';
    case 'hasIssuesEnabled': return true;
    case 'issue': {
      const number = argValue(field, 'number', state) as number;
      const issue = repo.issues.find((i) => i.number === number);
      if (!issue) return null;
      return resolveSelection(state, 'Issue', issueValue(repo, issue), field.fields);
    }
    case 'issues': {
      const first = (argValue(field, 'first', state) as number | undefined) ?? 10;
      const states = (argValue(field, 'states', state) as unknown[] | undefined) ?? null;
      const orderBy = (argValue(field, 'orderBy', state) as Record<string, unknown> | undefined) ?? null;
      const after = (argValue(field, 'after', state) as string | null | undefined) ?? null;
      let list = [...repo.issues];
      if (states) {
        const wanted = new Set((states as string[]).map((s) => String(s).toLowerCase()));
        list = list.filter((i) => wanted.has(i.state));
      }
      const direction = orderBy && String(orderBy.direction ?? '') === 'DESC' ? 'desc' : 'asc';
      if (direction === 'desc') list.reverse();
      if (after !== null && after !== undefined) {
        const afterNum = numberFromCursor(after);
        if (afterNum !== null) {
          const idx = list.findIndex((i) => i.number === afterNum);
          if (idx >= 0) list = list.slice(idx + 1);
        }
      }
      const page = list.slice(0, first);
      const hasNextPage = list.length > first;
      const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number as number) : null;
      return resolveSelection(state, 'IssueConnection', {
        nodes: page.map((issue) => ({ repo, issue })),
        pageInfo: { hasNextPage, endCursor },
      }, field.fields);
    }
    case 'pullRequests': {
      const first = (argValue(field, 'first', state) as number | undefined) ?? 10;
      const page = repo.pulls.slice(0, first);
      return resolveSelection(state, 'PullRequestConnection', {
        nodes: page.map((pull) => ({ repo, pull })),
      }, field.fields);
    }
    case 'pullRequest': {
      const number = argValue(field, 'number', state) as number;
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return null;
      return resolveSelection(state, 'PullRequest', pullValue(repo, pull), field.fields);
    }
    default:
      unknownField(state, 'Repository', field.name);
      return undefined;
  }
}

function resolveQueryField(state: ExecState, _value: Record<string, unknown>, field: FieldNode): unknown {
  const store = state.store;
  switch (field.name) {
    case 'viewer': {
      return resolveSelection(state, 'User', { login: store.viewerLogin ?? '' }, field.fields);
    }
    case 'repository': {
      const owner = String(argValue(field, 'owner', state) ?? '');
      const name = String(argValue(field, 'name', state) ?? '');
      store.learnLogin(owner);
      const repo = store.getRepo(owner, name);
      if (!repo) return null;
      return resolveSelection(state, 'Repository', repo as unknown as Record<string, unknown>, field.fields);
    }
    case 'node': {
      const id = String(argValue(field, 'id', state) ?? '');
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = store.repoById.get(decoded.dbId);
        if (!repo) return null;
        return resolveSelection(state, 'Repository', repo as unknown as Record<string, unknown>, field.fields);
      }
      return null;
    }
    case '__type': {
      const name = String(argValue(field, 'name', state) ?? '');
      let typeValue: Record<string, unknown> | null = null;
      if (name === 'Issue') typeValue = { fields: ISSUE_FIELDS, enumValues: [] };
      else if (name === 'PullRequest') typeValue = { fields: PULL_REQUEST_FIELDS, enumValues: [] };
      else if (name === 'Repository') typeValue = { fields: REPOSITORY_FIELDS, enumValues: [] };
      else if (name === 'SearchType') typeValue = { fields: [], enumValues: SEARCH_TYPE_VALUES };
      if (!typeValue) return null;
      return resolveSelection(state, '__Type', typeValue, field.fields);
    }
    default:
      unknownField(state, 'Query', field.name);
      return undefined;
  }
}

function resolveMutationField(state: ExecState, _value: Record<string, unknown>, field: FieldNode): unknown {
  const store = state.store;
  const input = (argValue(field, 'input', state) as Record<string, unknown> | undefined) ?? {};
  switch (field.name) {
    case 'createIssue': {
      const repoId = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = repoId && repoId.kind === 'Repository' ? store.repoById.get(repoId.dbId) : undefined;
      if (!repo) { state.errors.push({ message: 'repository not found' }); return null; }
      const issue = {
        id: store.nextIssueId++,
        number: ++repo.issueCounter,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open' as const,
        labels: [] as { name: string; color: string }[],
        comments: [] as { id: number; body: string }[],
      };
      repo.issues.push(issue);
      return resolveSelection(state, 'CreateIssuePayload', { issue: issueValue(repo, issue) }, field.fields);
    }
    case 'closeIssue': {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (!decoded || decoded.kind !== 'Issue') { state.errors.push({ message: 'issue not found' }); return null; }
      const repo = store.repoById.get(decoded.dbId);
      const issue = repo?.issues.find((i) => i.number === decoded.extra);
      if (!issue) { state.errors.push({ message: 'issue not found' }); return null; }
      issue.state = 'closed';
      return resolveSelection(state, 'CloseIssuePayload', { issue: issueValue(repo as Repo, issue) }, field.fields);
    }
    case 'createPullRequest': {
      const repoId = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = repoId && repoId.kind === 'Repository' ? store.repoById.get(repoId.dbId) : undefined;
      if (!repo) { state.errors.push({ message: 'repository not found' }); return null; }
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (!headSha || !baseSha) { state.errors.push({ message: 'head or base branch not found' }); return null; }
      const headTree = store.parseCommit((store.getObject(headSha) as { bytes: Buffer }).bytes).tree;
      const baseTree = store.parseCommit((store.getObject(baseSha) as { bytes: Buffer }).bytes).tree;
      const files = computePullFiles(store, baseTree, headTree);
      const pull = {
        id: store.nextPullId++,
        number: ++repo.pullCounter,
        title: String(input.title ?? ''),
        body: '',
        state: 'open' as const,
        headRef, baseRef, headSha, baseSha,
        merged: false, mergedAt: '', mergeCommitSha: '',
        files,
      };
      repo.pulls.push(pull);
      return resolveSelection(state, 'CreatePullRequestPayload', { pullRequest: pullValue(repo, pull) }, field.fields);
    }
    case 'mergePullRequest': {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (!decoded || decoded.kind !== 'PullRequest') { state.errors.push({ message: 'pull request not found' }); return null; }
      const repo = store.repoById.get(decoded.dbId);
      const pull = repo?.pulls.find((p) => p.number === decoded.extra);
      if (!pull) { state.errors.push({ message: 'pull request not found' }); return null; }
      const ctx: Ctx = { store, host: '' };
      const result = mergePull(ctx, repo as Repo, pull);
      if (!result.ok) { state.errors.push({ message: result.status === 405 ? 'Merge conflict' : 'pull request not found' }); return null; }
      return resolveSelection(state, 'MergePullRequestPayload', { pullRequest: pullValue(repo as Repo, pull) }, field.fields);
    }
    case 'addComment': {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (!decoded || decoded.kind !== 'Issue') { state.errors.push({ message: 'issue not found' }); return null; }
      const repo = store.repoById.get(decoded.dbId);
      const issue = repo?.issues.find((i) => i.number === decoded.extra);
      if (!issue) { state.errors.push({ message: 'issue not found' }); return null; }
      const comment = { id: store.nextCommentId++, body: String(input.body ?? '') };
      issue.comments.push(comment);
      const node = { id: globalId('Comment', repo?.id as number, comment.id), body: comment.body };
      return resolveSelection(state, 'AddCommentPayload', { commentEdge: { node } }, field.fields);
    }
    default:
      unknownField(state, 'Mutation', field.name);
      return undefined;
  }
}

// Payload wrappers: resolve `issue` / `pullRequest` / `commentEdge` fields.
function resolvePayloadField(state: ExecState, value: Record<string, unknown>, field: FieldNode): unknown {
  if (field.name === 'issue') {
    return resolveSelection(state, 'Issue', value.issue as Record<string, unknown>, field.fields);
  }
  if (field.name === 'pullRequest') {
    return resolveSelection(state, 'PullRequest', value.pullRequest as Record<string, unknown>, field.fields);
  }
  if (field.name === 'commentEdge') {
    const edge = value.commentEdge as { node: Record<string, unknown> };
    return resolveSelection(state, 'CommentEdge', edge as unknown as Record<string, unknown>, field.fields);
  }
  unknownField(state, 'Payload', field.name);
  return undefined;
}

// ---- entry point ----------------------------------------------------------

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: { message: string }[];
}

export function executeGraphQL(store: Store, body: unknown, variables: Record<string, unknown>): GraphQLResult | GraphQLResult[] {
  // Batched body: array of operations -> array of results in order.
  if (Array.isArray(body)) {
    return body.map((item) => {
      const single = item as { query?: string; variables?: Record<string, unknown> };
      return executeOne(store, String(single.query ?? ''), (single.variables ?? {}) as Record<string, unknown>);
    });
  }
  const single = body as { query?: string; variables?: Record<string, unknown> };
  return executeOne(store, String(single.query ?? ''), ((single.variables ?? variables) as Record<string, unknown>));
}

function executeOne(store: Store, query: string, variables: Record<string, unknown>): GraphQLResult {
  const state: ExecState = { store, variables, errors: [] };
  let ops: Operation[];
  try {
    ops = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  if (ops.length === 0) return { data: null, errors: [{ message: 'empty document' }] };
  const op = ops[0] as Operation;
  // Patch resolveSelection to handle payload wrapper types.
  const data = resolveRoot(state, op);
  const result: GraphQLResult = { data };
  if (state.errors.length > 0) result.errors = state.errors;
  return result;
}

function resolveRoot(state: ExecState, op: Operation): Record<string, unknown> {
  const typeName = op.type === 'mutation' ? 'Mutation' : 'Query';
  const out: Record<string, unknown> = {};
  for (const sel of op.fields) {
    if ('__fragment' in sel) continue;
    const field = sel as FieldNode;
    const key = field.alias ?? field.name;
    const resolved = typeName === 'Mutation'
      ? resolveMutationField(state, {}, field)
      : resolveField(state, 'Query', {}, field);
    if (resolved !== undefined) out[key] = resolved;
  }
  return out;
}
