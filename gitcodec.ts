// Ember Forge — git wire codecs: pkt-line framing and packfiles.
//
// pkt-line: 4 ASCII hex digits = total length incl. the header, then the
// payload. 0000 = flush, 0001 = delim, 0002 = response-end. Max 65,520 bytes.
//
// Packfile v2: 'PACK' + u32be version + u32be count + entries + 20-byte
// SHA-1 trailer. Entry headers are varints; types 1 commit, 2 tree, 3 blob,
// 4 tag, 6 ofs-delta, 7 ref-delta. Deltas resolve against a base object.

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { sha1Of, type GitObject, type ObjType, type Store } from './store.ts';

export const PKT_MAX = 65520;

// ---- pkt-line ------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const pktFlush = Buffer.from('0000', 'ascii');
export const pktDelim = Buffer.from('0001', 'ascii');
export const pktEnd = Buffer.from('0002', 'ascii');

// Sideband packet: band byte (1/2/3) + data, pkt-framed. Splits long data
// into chunks that fit the pkt-line max.
export function sidebandPackets(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const maxChunk = PKT_MAX - 4 - 1;
  if (data.length === 0) {
    out.push(pktLine(Buffer.from([band])));
    return out;
  }
  for (let i = 0; i < data.length; i += maxChunk) {
    const chunk = data.subarray(i, Math.min(data.length, i + maxChunk));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}

export interface PktItem {
  kind: 'line' | 'flush' | 'delim' | 'end';
  data: Buffer;
}

// Decode a pkt-line stream. Throws on malformed framing.
export function decodePktLines(buf: Buffer): PktItem[] {
  const items: PktItem[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(i, i + 4).toString('ascii');
    if (head === '0000') { items.push({ kind: 'flush', data: Buffer.alloc(0) }); i += 4; continue; }
    if (head === '0001') { items.push({ kind: 'delim', data: Buffer.alloc(0) }); i += 4; continue; }
    if (head === '0002') { items.push({ kind: 'end', data: Buffer.alloc(0) }); i += 4; continue; }
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${head}`);
    const len = parseInt(head, 16);
    if (len < 4 || len > PKT_MAX) throw new Error(`bad pkt-line length ${len}`);
    if (i + len > buf.length) throw new Error('truncated pkt-line');
    items.push({ kind: 'line', data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return items;
}

// ---- packfile ------------------------------------------------------------

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  const first = buf[offset] as number;
  let value = first & 0x0f;
  let shift = 4;
  let i = offset + 1;
  let byte = first;
  while (byte & 0x80) {
    if (i >= buf.length) throw new Error('pack varint overrun');
    byte = buf[i] as number;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    i++;
  }
  return { value, next: i };
}

// Delta op application: base bytes + delta data -> target bytes.
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVar = (): number => {
    let v = 0;
    let shift = 0;
    while (true) {
      const b = delta[i++] as number;
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVar();
  const tgtSize = readVar();
  if (srcSize !== base.length) throw new Error('delta source size mismatch');
  const out: Buffer[] = [];
  let produced = 0;
  while (i < delta.length) {
    const op = delta[i++] as number;
    if (op === 0) throw new Error('delta opcode 0');
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      if (op & 0x01) off = delta[i++] as number;
      if (op & 0x02) off |= (delta[i++] as number) << 8;
      if (op & 0x04) off |= (delta[i++] as number) << 16;
      if (op & 0x08) off |= (delta[i++] as number) << 24;
      if (op & 0x10) size = delta[i++] as number;
      if (op & 0x20) size |= (delta[i++] as number) << 8;
      if (op & 0x40) size |= (delta[i++] as number) << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(off, off + size));
      produced += size;
    } else {
      out.push(delta.subarray(i, i + op));
      i += op;
      produced += op;
    }
  }
  const result = Buffer.concat(out);
  if (produced !== tgtSize || result.length !== tgtSize) throw new Error('delta target size mismatch');
  return result;
}

export interface ParsedPackObject {
  type: ObjType;
  bytes: Buffer;
  oid: string;
}

// Parse a packfile, resolving deltas. Returns objects in pack order.
export function parsePack(buf: Buffer, store: Store): ParsedPackObject[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  let offset = 12;
  const out: ParsedPackObject[] = [];
  const byOffset = new Map<number, ParsedPackObject>();
  const typeName: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  for (let n = 0; n < count; n++) {
    const entryStart = offset;
    const first = buf[offset] as number;
    const typeCode = (first >> 4) & 0x07;
    const { value: size, next } = readVarint(buf, offset);
    offset = next;
    let baseObj: ParsedPackObject | null = null;
    if (typeCode === 6) {
      // OFS_DELTA: offset encoding, base = entryStart - decoded.
      let b = buf[offset++] as number;
      let decoded = b & 0x7f;
      while (b & 0x80) {
        b = buf[offset++] as number;
        decoded = ((decoded + 1) << 7) | (b & 0x7f);
      }
      const baseOffset = entryStart - decoded;
      baseObj = byOffset.get(baseOffset) ?? null;
      if (!baseObj) throw new Error('ofs-delta base not found');
    } else if (typeCode === 7) {
      const baseOid = buf.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const stored = store.getObject(baseOid);
      if (stored) {
        baseObj = { type: stored.type, bytes: stored.bytes, oid: baseOid };
      } else {
        const inPack = out.find((o) => o.oid === baseOid);
        if (!inPack) throw new Error('ref-delta base not found');
        baseObj = inPack;
      }
    }
    // The rest of this entry is one zlib stream; inflateSync stops at the
    // stream end, so find the consumed length by growing the slice.
    let inflated: Buffer;
    let consumed = 0;
    // Binary-search the stream end: try increasing windows until inflate
    // succeeds without "unexpected end" — cheaper: inflate the remainder and
    // measure via the zlib stream's bytesRead using a manual approach.
    // Simplest robust approach: try inflateSync on progressively larger
    // slices is O(n^2); instead use the fact that deflate streams end with
    // a final block — use zlib's inflate with a window and catch errors.
    // We use a small incremental probe: start at a guess and double.
    let probe = Math.max(16, size + 16);
    for (;;) {
      try {
        inflated = inflateSync(buf.subarray(offset, Math.min(buf.length, offset + probe)));
        consumed = probe;
        // Verify exact consumption: re-inflate with the exact end by
        // shrinking probe until it fails, then the last good value is it.
        // Instead, compute consumed from the deflate stream: use the
        // decompressed length + a second inflate of the same slice with
        // a strict end check via zlib's unused_data — not exposed.
        // Fallback: accept probe as consumed only when the next entry
        // parses; to keep this simple we binary-search the minimal probe.
        let lo = 1;
        let hi = probe;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          try {
            inflateSync(buf.subarray(offset, offset + mid));
            hi = mid;
          } catch {
            lo = mid + 1;
          }
        }
        consumed = lo;
        inflated = inflateSync(buf.subarray(offset, offset + consumed));
        break;
      } catch (e) {
        if (probe >= buf.length - offset) throw e;
        probe = Math.min(buf.length - offset, probe * 2);
      }
    }
    offset += consumed;
    if (inflated.length !== size) throw new Error('pack object size mismatch');
    let type: ObjType;
    let bytes: Buffer;
    if (typeCode === 6 || typeCode === 7) {
      if (!baseObj) throw new Error('delta without base');
      bytes = applyDelta(baseObj.bytes, inflated);
      type = baseObj.type;
    } else {
      type = typeName[typeCode] as ObjType;
      if (!type) throw new Error(`unknown pack type ${typeCode}`);
      bytes = inflated;
    }
    const oid = sha1Of(type, bytes);
    const parsed: ParsedPackObject = { type, bytes, oid };
    out.push(parsed);
    byOffset.set(entryStart, parsed);
  }
  // Trailer: SHA-1 of everything before it.
  const trailer = buf.subarray(buf.length - 20);
  const expect = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(expect)) throw new Error('pack trailer checksum mismatch');
  return out;
}

// Build a packfile v2 with plain (undelted) objects, in the given order.
export function buildPack(objects: { type: ObjType; bytes: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  const typeCode: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const obj of objects) {
    const deflated = deflateSync(obj.bytes);
    const size = obj.bytes.length;
    const code = typeCode[obj.type];
    // Varint header: first byte (type<<4)|(size&0x0f), continuation 0x80.
    const headerBytes: number[] = [];
    let remaining = size >> 4;
    headerBytes.push(((code << 4) | (size & 0x0f)) | (remaining > 0 ? 0x80 : 0));
    while (remaining > 0) {
      const next = remaining >> 7;
      headerBytes.push((remaining & 0x7f) | (next > 0 ? 0x80 : 0));
      remaining = next;
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflated);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
