// A small read-only ZIP reader for the importers (MVR files are zips, and so
// are the GDTF fixture files inside them). No dependency: the central
// directory is parsed by hand and "deflate" entries are inflated with the
// platform's DecompressionStream (Chromium/Electron and Node 18+ both have
// it). Stored (uncompressed) entries are returned as-is. No ZIP64 or
// encryption — show files don't use them.

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

/**
 * Read a zip's table of contents.
 * Returns { names: [...], has(name), bytes(name) -> Promise<Uint8Array>, text(name) -> Promise<string> }.
 * Name lookups ignore case and a leading "./" or "/".
 */
export function readZip(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // the end-of-central-directory record sits in the last 64 KB (+22 bytes)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("it isn't a zip file");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const utf8 = new TextDecoder('utf-8');
  const entries = new Map();
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== SIG_CEN) throw new Error('the zip directory is damaged');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = utf8.decode(buf.subarray(p + 46, p + 46 + nlen));
    if (!name.endsWith('/')) entries.set(norm(name), { name, method, csize, usize, local });
    p += 46 + nlen + xlen + clen;
  }

  const get = (name) => {
    const e = entries.get(norm(name));
    if (!e) throw new Error(`"${name}" is missing from the zip`);
    return e;
  };
  return {
    names: [...entries.values()].map((e) => e.name),
    has: (name) => entries.has(norm(name)),
    async bytes(name) {
      const e = get(name);
      if (dv.getUint32(e.local, true) !== SIG_LOC) throw new Error(`"${name}" is damaged`);
      const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
      const raw = buf.subarray(start, start + e.csize);
      if (e.method === 0) return raw;
      if (e.method !== 8) throw new Error(`"${name}" uses an unsupported compression (${e.method})`);
      return inflate(raw);
    },
    async text(name) { return new TextDecoder('utf-8').decode(await this.bytes(name)); },
  };
}

function norm(name) { return name.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase(); }

async function inflate(raw) {
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Is this a zip (by its first bytes)? */
export function isZip(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}
