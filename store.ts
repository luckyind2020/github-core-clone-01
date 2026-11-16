// Ember Forge — the in-memory store for the github-core-clone-01 entry.
//
// One process, one trial: everything lives in memory. The store is shared by
// the REST v3, GraphQL v4, MCP and git smart-HTTP surfaces, so an object created
// on one surface is visible on the others with the same ids. Nothing here
// touches the wall clock for behavior the suite asserts: commit timestamps
// come from the client (git pushes) or a fixed forge epoch (REST-created
// commits); ordering comes from insertion counters, never from Date.now().

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
// Fixed timestamp (2023-11-14T22:13:20Z) for commits the forge itself writes
// (REST contents commits, squash merges). Deterministic across live/replay.
export const FORGE_EPOCH = 1700000000;

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  bytes: Buffer;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  privateRepo: boolean;
  description: string;
  defaultBranch: string;
  // refs/heads/<branch> -> tip oid; refs/tags/<tag> -> oid
  refs: Map<string, string>;
  // issues and PRs, insertion-ordered; numbers start at 1 per repo
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  issueCounter: number;
  pullCounter: number;
  commentCounter: number;
}

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
}

export interface Comment {
  id: number;
  body: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string;
  // snapshot of the file diff base->head at creation time
  files: PullFile[];
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export function sha1Of(type: ObjType, bytes: Buffer): string {
  const head = Buffer.from(`${type} ${bytes.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(bytes).digest('hex');
}

export function globalId(kind: string, dbId: number, extra?: number): string {
  const raw = extra === undefined ? `${kind}:${dbId}` : `${kind}:${dbId}:${extra}`;
  return Buffer.from(raw, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; dbId: number; extra: number | null } | null {
  try {
    const raw = Buffer.from(id, 'base64').toString('utf8');
    const parts = raw.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0] as string;
    const dbId = Number(parts[1]);
    if (!Number.isInteger(dbId) || dbId < 1) return null;
    const extra = parts.length > 2 ? Number(parts[2]) : null;
    return { kind, dbId, extra: extra !== null && Number.isInteger(extra) ? extra : null };
  } catch {
    return null;
  }
}

export class Store {
  objects = new Map<string, GitObject>();
  repos = new Map<string, Repo>();
  repoById = new Map<number, Repo>();
  nextRepoId = 1;
  nextIssueId = 1;
  nextPullId = 1;
  nextCommentId = 1;
  requestCounter = 1;
  // The token owner's login, learned from the first owner-bearing URL the
  // suite uses (all fixture repos live under it). Unknown until then.
  // Repos created before it is learned are held under a sentinel owner and
  // migrated on first learning (see learnLogin).
  viewerLogin: string | null = null;
  static readonly PENDING_OWNER = '\u0000pending';
  // The bearer token every API call must carry (from MAKEFUN_SHOP_TOKEN).
  token: string;

  constructor(token: string) {
    this.token = token;
  }

  learnLogin(owner: string): void {
    if (owner === '' || owner === Store.PENDING_OWNER) return;
    if (this.viewerLogin !== null) return;
    this.viewerLogin = owner;
    // Migrate repos created under the sentinel owner to the real login.
    for (const repo of [...this.repos.values()]) {
      if (repo.owner === Store.PENDING_OWNER) {
        this.repos.delete(this.repoKey(repo.owner, repo.name));
        repo.owner = owner;
        this.repos.set(this.repoKey(owner, repo.name), repo);
      }
    }
  }

  // Repos belonging to the token owner (sentinel ones included while the
  // login is still unknown).
  viewerRepos(): Repo[] {
    const owner = this.viewerLogin ?? Store.PENDING_OWNER;
    return [...this.repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.id - b.id);
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo | null {
    const realOwner = owner === '' ? Store.PENDING_OWNER : owner;
    if (this.repos.has(this.repoKey(realOwner, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: realOwner,
      privateRepo: isPrivate,
      description,
      defaultBranch: 'main',
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      issueCounter: 0,
      pullCounter: 0,
      commentCounter: 0,
    };
    this.repos.set(this.repoKey(realOwner, name), repo);
    this.repoById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.getRepo(owner, name);
    if (!repo) return false;
    this.repos.delete(this.repoKey(owner, name));
    this.repoById.delete(repo.id);
    return true;
  }

  newRequestId(): string {
    return `req-${this.requestCounter++}`;
  }

  // ---- git objects -------------------------------------------------------

  putObject(type: ObjType, bytes: Buffer): string {
    const oid = sha1Of(type, bytes);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, bytes });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  // ---- commits / trees ---------------------------------------------------

  // Build a commit object. Parents in order. The message is stored exactly
  // as given (no forced trailing newline — REST checks echo it back verbatim).
  makeCommit(treeOid: string, parents: string[], authorName: string, authorEmail: string, ts: number, message: string): string {
    let text = `tree ${treeOid}\n`;
    for (const p of parents) text += `parent ${p}\n`;
    text += `author ${authorName} <${authorEmail}> ${ts} +0000\n`;
    text += `committer ${authorName} <${authorEmail}> ${ts} +0000\n`;
    text += `\n${message}`;
    return this.putObject('commit', Buffer.from(text, 'utf8'));
  }

  // Parse a commit's header lines. Returns tree, parents, message.
  parseCommit(bytes: Buffer): { tree: string; parents: string[]; message: string } {
    const text = bytes.toString('utf8');
    const splitAt = text.indexOf('\n\n');
    const header = splitAt >= 0 ? text.slice(0, splitAt) : text;
    const message = splitAt >= 0 ? text.slice(splitAt + 2) : '';
    let tree = '';
    const parents: string[] = [];
    for (const line of header.split('\n')) {
      if (line.startsWith('tree ')) tree = line.slice(5).trim();
      else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    }
    return { tree, parents, message };
  }

  // Parse a tree object into entries: {mode, name, oid}. Sorted as stored.
  parseTree(bytes: Buffer): { mode: string; name: string; oid: string }[] {
    const entries: { mode: string; name: string; oid: string }[] = [];
    let i = 0;
    while (i < bytes.length) {
      const sp = bytes.indexOf(0x20, i);
      if (sp < 0) break;
      const mode = bytes.subarray(i, sp).toString('utf8');
      const nul = bytes.indexOf(0x00, sp + 1);
      if (nul < 0) break;
      const name = bytes.subarray(sp + 1, nul).toString('utf8');
      const oid = bytes.subarray(nul + 1, nul + 21).toString('hex');
      entries.push({ mode, name, oid });
      i = nul + 21;
    }
    return entries;
  }

  // Build a tree object from entries (sorted git-style: names compared with
  // directories as if suffixed by '/').
  makeTree(entries: { mode: string; name: string; oid: string }[]): string {
    const sorted = [...entries].sort((a, b) => {
      const an = a.mode === '40000' ? a.name + '/' : a.name;
      const bn = b.mode === '40000' ? b.name + '/' : b.name;
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const parts: Buffer[] = [];
    for (const e of sorted) {
      parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
      parts.push(Buffer.from(e.oid, 'hex'));
    }
    return this.putObject('tree', Buffer.concat(parts));
  }

  // Read a file's blob oid at `path` in the tree rooted at `treeOid`.
  // Returns the blob oid, or null when absent.
  readPath(treeOid: string, path: string): string | null {
    const segments = path.split('/').filter((s) => s !== '');
    let current = treeOid;
    for (let i = 0; i < segments.length; i++) {
      const obj = this.getObject(current);
      if (!obj || obj.type !== 'tree') return null;
      const entries = this.parseTree(obj.bytes);
      const seg = segments[i] as string;
      const hit = entries.find((e) => e.name === seg);
      if (!hit) return null;
      if (i === segments.length - 1) return hit.mode === '100644' ? hit.oid : null;
      if (hit.mode !== '40000') return null;
      current = hit.oid;
    }
    return null;
  }

  // List the entries of the directory at `path` in the tree rooted at `treeOid`
  // ('' = root). Returns null when the path is not a directory.
  listDir(treeOid: string, path: string): { mode: string; name: string; oid: string }[] | null {
    if (path === '' || path === '/') {
      const obj = this.getObject(treeOid);
      if (!obj || obj.type !== 'tree') return null;
      return this.parseTree(obj.bytes);
    }
    const segments = path.split('/').filter((s) => s !== '');
    let current = treeOid;
    for (const seg of segments) {
      const obj = this.getObject(current);
      if (!obj || obj.type !== 'tree') return null;
      const hit = this.parseTree(obj.bytes).find((e) => e.name === seg);
      if (!hit || hit.mode !== '40000') return null;
      current = hit.oid;
    }
    const obj = this.getObject(current);
    if (!obj || obj.type !== 'tree') return null;
    return this.parseTree(obj.bytes);
  }

  // Return a new tree oid with `path` set to `blobOid` (or removed when
  // blobOid is null), starting from `treeOid` (or an empty tree when null).
  // Creates intermediate directory trees as needed.
  writePath(treeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((s) => s !== '');
    const rec = (oid: string | null, depth: number): string | null => {
      const entries: { mode: string; name: string; oid: string }[] =
        oid === null ? [] : this.parseTree((this.getObject(oid) as GitObject).bytes);
      const seg = segments[depth] as string;
      if (depth === segments.length - 1) {
        const next = entries.filter((e) => e.name !== seg);
        if (blobOid !== null) next.push({ mode: '100644', name: seg, oid: blobOid });
        if (next.length === 0) return null;
        return this.makeTree(next);
      }
      const child = entries.find((e) => e.name === seg);
      const childOid = child && child.mode === '40000' ? child.oid : null;
      const newChild = rec(childOid, depth + 1);
      const next = entries.filter((e) => e.name !== seg);
      if (newChild !== null) next.push({ mode: '40000', name: seg, oid: newChild });
      if (next.length === 0) return null;
      return this.makeTree(next);
    };
    return rec(treeOid, 0) ?? this.makeTree([]);
  }

  // ---- reachability ------------------------------------------------------

  // All object ids reachable from `tips` (commits, trees, blobs, tags).
  // When `maxCommitDepth` is set, commits are followed only that many levels
  // deep from the tips (1 = tips only); trees/blobs of included commits are
  // always fully included.
  collectReachable(tips: string[], maxCommitDepth?: number): Set<string> {
    const out = new Set<string>();
    const queue: { oid: string; depth: number }[] = tips.map((oid) => ({ oid, depth: 0 }));
    const seenCommit = new Set<string>();
    while (queue.length > 0) {
      const item = queue.shift() as { oid: string; depth: number };
      const { oid, depth } = item;
      if (out.has(oid)) continue;
      const obj = this.getObject(oid);
      if (!obj) continue;
      if (obj.type === 'commit') {
        // Depth limit: a commit at depth >= maxCommitDepth is not sent at
        // all (not even its own bytes) — deepen 1 sends the tip only.
        if (maxCommitDepth !== undefined && depth >= maxCommitDepth) continue;
        if (seenCommit.has(oid)) continue;
        seenCommit.add(oid);
        out.add(oid);
        const { tree, parents } = this.parseCommit(obj.bytes);
        queue.push({ oid: tree, depth });
        for (const p of parents) queue.push({ oid: p, depth: depth + 1 });
        continue;
      }
      out.add(oid);
      if (obj.type === 'tree') {
        for (const e of this.parseTree(obj.bytes)) queue.push({ oid: e.oid, depth });
      } else if (obj.type === 'tag') {
        const text = obj.bytes.toString('utf8');
        const m = /^object ([0-9a-f]{40})$/m.exec(text);
        if (m) queue.push({ oid: m[1] as string, depth });
      }
    }
    return out;
  }

  // Reachability from `tips` that stops descending at shallow boundaries:
  // a boundary commit is held, but its parents are NOT (the client that
  // reported the boundary never received them). Used for the `haves` side
  // of a fetch, where the client's shallow lines bound what it holds.
  collectReachableBounded(tips: string[], shallowBoundaries: Set<string>): Set<string> {
    const out = new Set<string>();
    const queue = [...tips];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (out.has(oid)) continue;
      const obj = this.getObject(oid);
      if (!obj) continue;
      out.add(oid);
      if (obj.type === 'commit') {
        const { tree, parents } = this.parseCommit(obj.bytes);
        queue.push(tree);
        if (!shallowBoundaries.has(oid)) {
          for (const p of parents) queue.push(p);
        }
      } else if (obj.type === 'tree') {
        for (const e of this.parseTree(obj.bytes)) queue.push(e.oid);
      } else if (obj.type === 'tag') {
        const m = /^object ([0-9a-f]{40})$/m.exec(obj.bytes.toString('utf8'));
        if (m) queue.push(m[1] as string);
      }
    }
    return out;
  }
  commitAncestry(tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.getObject(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      const { parents } = this.parseCommit(obj.bytes);
      for (let i = parents.length - 1; i >= 0; i--) stack.push(parents[i] as string);
    }
    return out;
  }

  // Is `ancestor` an ancestor of (or equal to) `tip`?
  isAncestor(ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.getObject(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of this.parseCommit(obj.bytes).parents) stack.push(p);
    }
    return false;
  }

  // Diff two trees (by oid, null = empty): returns changed paths with
  // old/new blob oids (null when absent on that side).
  diffTrees(oldTree: string | null, newTree: string | null): { path: string; oldOid: string | null; newOid: string | null }[] {
    const flat = (treeOid: string | null, prefix: string, out: Map<string, string>): void => {
      if (treeOid === null) return;
      const obj = this.getObject(treeOid);
      if (!obj || obj.type !== 'tree') return;
      for (const e of this.parseTree(obj.bytes)) {
        const p = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') flat(e.oid, p, out);
        else out.set(p, e.oid);
      }
    };
    const oldMap = new Map<string, string>();
    const newMap = new Map<string, string>();
    flat(oldTree, '', oldMap);
    flat(newTree, '', newMap);
    const paths = new Set<string>([...oldMap.keys(), ...newMap.keys()]);
    const out: { path: string; oldOid: string | null; newOid: string | null }[] = [];
    for (const p of [...paths].sort()) {
      const o = oldMap.get(p) ?? null;
      const n = newMap.get(p) ?? null;
      if (o !== n) out.push({ path: p, oldOid: o, newOid: n });
    }
    return out;
  }
}
