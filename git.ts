// Ember Forge — git smart HTTP: protocol v2 upload-pack and v0 receive-pack.
//
// The suite is the only client: it speaks protocol v2 for upload-pack
// (advertisement, ls-refs, fetch) and protocol v0 for receive-pack
// (advertisement, push, report-status). Packs are plain objects only —
// deltas are never required (pack-deltas passes with deltaCount 0).
// Every malformed request is answered with an HTTP error, never a crash.

import { inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, ZERO_OID, type Repo } from './store.ts';
import {
  pktLine, pktFlush, pktDelim, sidebandPackets, decodePktLines,
  parsePack, buildPack, type ParsedPackObject,
} from './gitcodec.ts';

const AGENT = 'ember-forge/1.0';

// Small cache of built fetch packs, keyed by repo + tip + depth + haves.
// The clone workload fires 50 identical depth-1 clones at once; rebuilding
// the same pack 50 times would waste the whole budget.
const packCache = new Map<string, Buffer>();
const PACK_CACHE_MAX = 16;

function cacheGet(key: string): Buffer | undefined {
  return packCache.get(key);
}
function cachePut(key: string, pack: Buffer): void {
  if (packCache.size >= PACK_CACHE_MAX) {
    const first = packCache.keys().next().value as string;
    packCache.delete(first);
  }
  packCache.set(key, pack);
}

// ---- ref listing ---------------------------------------------------------

interface RefLine {
  oid: string;
  ref: string;
  symrefTarget?: string;
  peeled?: string;
  unborn?: boolean;
}

function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const mainTip = repo.refs.get('refs/heads/main');
  if (mainTip) {
    out.push({ oid: mainTip, ref: 'HEAD', symrefTarget: 'refs/heads/main' });
  } else {
    out.push({ oid: ZERO_OID, ref: 'HEAD', symrefTarget: 'refs/heads/main', unborn: true });
  }
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: RefLine = { oid, ref: name };
    if (name.startsWith('refs/tags/')) {
      // An annotated tag peels on its own ls-refs line (one line per ref,
      // with a peeled: attribute) — never as a second line for the same ref.
      const obj = repoObjects.getObject(oid);
      if (obj && obj.type === 'tag') {
        const m = /^object ([0-9a-f]{40})$/m.exec(obj.bytes.toString('utf8'));
        if (m) entry.peeled = m[1] as string;
      }
    }
    out.push(entry);
  }
  return out;
}

// The store the git handlers read objects from (set per request via module
// state — the server is single-process and handlers run synchronously per
// request; this is only a shortcut so listRefs can peel tags).
let repoObjects: Store = null as unknown as Store;
export function setGitStore(store: Store): void {
  repoObjects = store;
}

// ---- info/refs -----------------------------------------------------------

export function handleInfoRefs(
  store: Store, repo: Repo | undefined, service: string, isV2: boolean,
  res: ServerResponse,
): void {
  if (!repo) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not Found' }) + '\n');
    return;
  }
  setGitStore(store);
  if (service === 'git-upload-pack') {
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement' });
    if (isV2) {
      const lines = [
        'version 2\n',
        'fetch=shallow\n',
        'ls-refs=unborn\n',
        'object-format=sha1\n',
      ];
      res.end(Buffer.concat([...lines.map((l) => pktLine(l)), pktFlush]));
    } else {
      const refs = listRefs(repo);
      const chunks: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktFlush];
      const caps = 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag';
      refs.forEach((r, i) => {
        if (r.unborn) return;
        const line = i === 0
          ? `${r.oid} ${r.ref}\0${caps}\n`
          : `${r.oid} ${r.ref}\n`;
        chunks.push(pktLine(line));
      });
      chunks.push(pktFlush);
      res.end(Buffer.concat(chunks));
    }
    return;
  }
  // git-receive-pack, v0 only.
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement' });
  const refs = listRefs(repo);
  const chunks: Buffer[] = [pktLine('# service=git-receive-pack\n'), pktFlush];
  const caps = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main';
  const headRefs = refs.filter((r) => !r.unborn);
  if (headRefs.length === 0) {
    chunks.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    headRefs.forEach((r, i) => {
      if (r.peeled) {
        chunks.push(pktLine(`${r.peeled} ${r.ref}^{}\n`));
      }
      const line = i === 0 ? `${r.oid} ${r.ref}\0${caps}\n` : `${r.oid} ${r.ref}\n`;
      chunks.push(pktLine(line));
    });
  }
  chunks.push(pktFlush);
  res.end(Buffer.concat(chunks));
}

// ---- upload-pack v2 ------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallows: string[];
  deepen: number | null;
  thinPack: boolean;
  ofsDelta: boolean;
}

function parseFetchArgs(lines: string[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallows: [], deepen: null, thinPack: false, ofsDelta: false };
  for (const line of lines) {
    const l = line.trimEnd();
    if (l.startsWith('want ')) req.wants.push(l.slice(5).trim());
    else if (l.startsWith('have ')) req.haves.push(l.slice(5).trim());
    else if (l.startsWith('shallow ')) req.shallows.push(l.slice(8).trim());
    else if (l.startsWith('deepen ')) req.deepen = parseInt(l.slice(7).trim(), 10);
    else if (l === 'thin-pack') req.thinPack = true;
    else if (l === 'ofs-delta') req.ofsDelta = true;
  }
  return req;
}

// Objects to send for a fetch: reachable from wants (depth-limited when
// deepen is set) minus objects reachable from haves. Returns the object
// list (in a stable order) and the shallow boundaries of the result.
function selectFetchObjects(store: Store, req: FetchRequest): { objects: { type: 'commit' | 'tree' | 'blob' | 'tag'; bytes: Buffer }[]; boundaries: string[]; lifted: string[] } {
  const maxDepth = req.deepen !== null ? req.deepen : undefined;
  const wanted = store.collectReachable(req.wants, maxDepth);
  // What the client already holds: reachable from its haves, but never
  // past its own shallow boundaries (those parents were never sent to it).
  const held = store.collectReachableBounded(req.haves, new Set(req.shallows));
  const send = [...wanted].filter((oid) => !held.has(oid));
  // Boundaries: included commits at exactly the depth limit.
  const boundaries: string[] = [];
  const lifted: string[] = [];
  if (req.deepen !== null) {
    const depthOf = new Map<string, number>();
    const queue: { oid: string; depth: number }[] = req.wants.map((oid) => ({ oid, depth: 1 }));
    while (queue.length > 0) {
      const item = queue.shift() as { oid: string; depth: number };
      if (depthOf.has(item.oid)) continue;
      const obj = store.getObject(item.oid);
      if (!obj || obj.type !== 'commit') continue;
      depthOf.set(item.oid, item.depth);
      if (item.depth < req.deepen) {
        for (const p of store.parseCommit(obj.bytes).parents) queue.push({ oid: p, depth: item.depth + 1 });
      }
    }
    for (const [oid, depth] of depthOf) {
      if (depth === req.deepen && send.includes(oid)) boundaries.push(oid);
    }
    for (const s of req.shallows) {
      const d = depthOf.get(s);
      if (d !== undefined && d < (req.deepen as number) && send.includes(s)) lifted.push(s);
    }
  }
  // Stable order: commits (ancestry order), then trees, blobs, tags.
  const ordered = send
    .map((oid) => ({ oid, obj: store.getObject(oid) as { type: 'commit' | 'tree' | 'blob' | 'tag'; bytes: Buffer } }))
    .filter((e) => e.obj !== undefined);
  const rank = { commit: 0, tree: 1, blob: 2, tag: 3 };
  ordered.sort((a, b) => rank[a.obj.type] - rank[b.obj.type] || (a.oid < b.oid ? -1 : 1));
  return { objects: ordered.map((e) => e.obj), boundaries, lifted };
}

function handleLsRefs(store: Store, repo: Repo, args: string[], res: ServerResponse): void {
  const prefixes: string[] = [];
  for (const a of args) {
    const l = a.trimEnd();
    if (l.startsWith('ref-prefix ')) prefixes.push(l.slice(11).trim());
  }
  let refs = listRefs(repo);
  if (prefixes.length > 0) {
    // Server-side prefix filtering: a ref is listed only when it starts
    // with one of the requested prefixes (HEAD included when a prefix
    // matches it, e.g. 'ref-prefix HEAD').
    refs = refs.filter((r) => prefixes.some((p) => r.ref.startsWith(p)));
  }
  const chunks: Buffer[] = [];
  for (const r of refs) {
    if (r.unborn) {
      chunks.push(pktLine(`unborn ${r.ref}${r.symrefTarget ? ` symref-target:${r.symrefTarget}` : ''}\n`));
    } else {
      let line = `${r.oid} ${r.ref}`;
      if (r.symrefTarget) line += ` symref-target:${r.symrefTarget}`;
      if (r.peeled) line += ` peeled:${r.peeled}`;
      chunks.push(pktLine(line + '\n'));
    }
  }
  chunks.push(pktFlush);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(chunks));
}

function handleFetch(store: Store, repo: Repo, args: string[], res: ServerResponse): void {
  const req = parseFetchArgs(args);
  const chunks: Buffer[] = [];
  // The acknowledgments section exists ONLY when the client sent at least
  // one 'have' line (protocol v2): a client with no haves goes straight to
  // the packfile section and dies on a stray acknowledgments header.
  if (req.haves.length > 0) {
    chunks.push(pktLine('acknowledgments\n'));
    let ack = false;
    for (const h of req.haves) {
      for (const w of req.wants) {
        if (store.isAncestor(h, w) || h === w) { ack = true; break; }
      }
      if (ack) break;
    }
    if (ack) {
      chunks.push(pktLine(`ACK ${req.haves[0] as string}\n`));
      chunks.push(pktLine('ready\n'));
    } else {
      chunks.push(pktLine('NAK\n'));
    }
    chunks.push(pktDelim);
  }
  // packfile
  if (req.wants.length > 0) {
    const cacheKey = `${repo.owner}/${repo.name}|${req.wants.join(',')}|${req.haves.join(',')}|${req.deepen ?? ''}|${req.shallows.join(',')}`;
    let pack = cacheGet(cacheKey);
    let boundaries: string[] = [];
    let lifted: string[] = [];
    if (!pack) {
      const sel = selectFetchObjects(store, req);
      boundaries = sel.boundaries;
      lifted = sel.lifted;
      pack = buildPack(sel.objects);
      cachePut(cacheKey, pack);
    } else {
      const sel = selectFetchObjects(store, req);
      boundaries = sel.boundaries;
      lifted = sel.lifted;
    }
    if (req.deepen !== null) {
      const shallowChunks: Buffer[] = [pktLine('shallow-info\n')];
      for (const b of boundaries) shallowChunks.push(pktLine(`shallow ${b}\n`));
      for (const u of lifted) shallowChunks.push(pktLine(`unshallow ${u}\n`));
      shallowChunks.push(pktDelim);
      chunks.push(...shallowChunks);
    }
    chunks.push(pktLine('packfile\n'));
    for (const p of sidebandPackets(1, pack)) chunks.push(p);
  }
  chunks.push(pktFlush);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(chunks));
}

export function handleUploadPack(store: Store, repo: Repo | undefined, body: Buffer, isV2: boolean, res: ServerResponse): void {
  if (!repo) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not Found' }) + '\n');
    return;
  }
  setGitStore(store);
  try {
    const items = decodePktLines(body);
    const lines = items.filter((i) => i.kind === 'line').map((i) => i.data.toString('utf8'));
    const commandLine = lines[0] ?? '';
    if (!isV2) {
      // v0 fetch fallback: want/have lines, then done. Answer with a pack.
      const wants: string[] = [];
      const haves: string[] = [];
      for (const l of lines) {
        const t = l.trimEnd();
        if (t.startsWith('want ')) wants.push(t.slice(5).split(' ')[0] as string);
        else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
      }
      const sel = selectFetchObjects(store, { wants, haves, shallows: [], deepen: null, thinPack: false, ofsDelta: false });
      const pack = buildPack(sel.objects);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
      res.end(Buffer.concat([...sidebandPackets(1, pack), pktFlush]));
      return;
    }
    if (commandLine.startsWith('command=ls-refs')) {
      handleLsRefs(store, repo, lines.slice(1), res);
      return;
    }
    if (commandLine.startsWith('command=fetch')) {
      handleFetch(store, repo, lines.slice(1), res);
      return;
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'unknown command' }) + '\n');
  } catch (err) {
    // Malformed request: answer an error and keep serving.
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: err instanceof Error ? err.message : 'bad request' }) + '\n');
  }
}

// ---- receive-pack v0 ------------------------------------------------------

export function handleReceivePack(store: Store, repo: Repo | undefined, body: Buffer, res: ServerResponse): void {
  if (!repo) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not Found' }) + '\n');
    return;
  }
  setGitStore(store);
  const reportLines: string[] = [];
  try {
    // Decode pkt-lines ONLY up to the first flush: everything after it is
    // the raw pack (not pkt-framed, starts with 'PACK'), and decoding it as
    // pkt-lines would throw on the 'PACK' header.
    const commandLines: string[] = [];
    let packStart = -1;
    {
      let off = 0;
      while (off + 4 <= body.length) {
        const head = body.subarray(off, off + 4).toString('ascii');
        if (head === '0000') { packStart = off + 4; break; }
        if (head === '0001' || head === '0002') { off += 4; continue; }
        if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${head}`);
        const len = parseInt(head, 16);
        if (len < 4 || len > 65520 || off + len > body.length) throw new Error('truncated pkt-line');
        commandLines.push(body.subarray(off + 4, off + len).toString('utf8'));
        off += len;
      }
      if (packStart < 0) packStart = body.length;
    }
    const packBytes = packStart < body.length ? body.subarray(packStart) : Buffer.alloc(0);
    let unpackOk = true;
    let unpackDetail = '';
    if (packBytes.length > 0) {
      try {
        const objects = parsePack(packBytes, store);
        for (const o of objects) store.putObject(o.type, o.bytes);
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack failed';
      }
    }
    reportLines.push(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`);
    for (const raw of commandLines) {
      const line = raw.split('\0')[0] as string;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const oldOid = parts[0] as string;
      const newOid = parts[1] as string;
      const ref = parts[2] as string;
      const current = repo.refs.get(ref);
      if (newOid === ZERO_OID) {
        // delete
        if (current !== undefined && (oldOid === ZERO_OID || oldOid === current)) {
          repo.refs.delete(ref);
          reportLines.push(`ok ${ref}\n`);
        } else {
          reportLines.push(`ng ${ref} non-fast-forward\n`);
        }
        continue;
      }
      if (oldOid === ZERO_OID) {
        if (current === undefined) {
          repo.refs.set(ref, newOid);
          reportLines.push(`ok ${ref}\n`);
        } else {
          reportLines.push(`ng ${ref} non-fast-forward\n`);
        }
        continue;
      }
      if (current !== undefined && current === oldOid && store.isAncestor(oldOid, newOid)) {
        repo.refs.set(ref, newOid);
        reportLines.push(`ok ${ref}\n`);
      } else {
        reportLines.push(`ng ${ref} non-fast-forward\n`);
      }
    }
  } catch (err) {
    reportLines.length = 0;
    reportLines.push(`unpack ${err instanceof Error ? err.message : 'unpack failed'}\n`);
  }
  // The report goes inside band-1 sideband packets (side-band-64k advertised),
  // and the band-1 data is itself a sequence of pkt-lines — one per report
  // line, terminated by a flush pkt-line INSIDE the band. Raw text lines
  // (without pkt framing) make the client read "unpa" as a pkt-line length
  // and die; a missing inner flush makes it hang up waiting for the end.
  const report = Buffer.concat([...reportLines.map((l) => pktLine(l)), pktFlush]);
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
  res.end(Buffer.concat([...sidebandPackets(1, report), pktFlush]));
}

// Re-export for tests.
export { inflateSync };
