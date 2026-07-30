/**
 * Minimal deterministic ZIP writer (build prompt 6.2: "double export =
 * identical zips").
 *
 * Hand-rolled rather than pulling a dependency because determinism is the
 * whole point: every field that a general-purpose archiver would fill from
 * ambient state (file mtimes, creation order, host OS attributes) is pinned
 * here. Entries are sorted by path and stamped with the ZIP epoch
 * (1980-01-01 00:00:00, the canonical "no timestamp" value used by
 * reproducible-build tooling), so exporting the same project twice yields
 * byte-identical archives — a stronger guarantee than the build prompt's
 * "modulo timestamps", and one a test can assert with a buffer comparison.
 *
 * Compression is raw deflate at a fixed level, which is deterministic for a
 * given zlib build. Two exports from the same machine/CI image are therefore
 * byte-identical; archives produced by different zlib versions may differ in
 * compressed bytes while still extracting identically.
 *
 * Only the subset of the format this needs: stored-or-deflated file entries,
 * no ZIP64, no encryption, no directory entries (extractors create parent
 * directories implicitly from entry paths).
 */

import { deflateRawSync } from "node:zlib";

export interface ZipEntry {
  /** Archive-relative path, forward slashes. */
  path: string;
  content: Buffer;
}

/** ZIP epoch: 1980-01-01 00:00:00 in DOS date/time encoding. */
const DOS_EPOCH_TIME = 0;
const DOS_EPOCH_DATE = (1 << 5) | 1; // year 1980 (0), month 1, day 1

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIR_SIGNATURE = 0x06054b50;
const VERSION_2_0 = 20;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
}

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Builds a ZIP archive. Entries are sorted by path, so the caller's
 * enumeration order (readdir order, which varies by filesystem) cannot leak
 * into the output.
 */
export function createZip(entries: ZipEntry[]): Buffer {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`ZIP archive would hold ${String(entries.length)} entries; this writer has no ZIP64 support (max ${String(MAX_ENTRIES)}).`);
  }

  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set<string>();
  for (const entry of sorted) {
    if (seen.has(entry.path)) {
      throw new Error(`Duplicate ZIP entry path "${entry.path}".`);
    }
    seen.add(entry.path);
  }

  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const entry of sorted) {
    const nameBytes = Buffer.from(entry.path, "utf8");
    const uncompressed = entry.content;
    if (uncompressed.length > MAX_SIZE) {
      throw new Error(`ZIP entry "${entry.path}" exceeds 4 GiB; this writer has no ZIP64 support.`);
    }

    // Deflate only when it actually wins — keeps tiny files (and already
    // incompressible ones) from growing, and makes empty files exactly 0
    // bytes rather than a 2-byte empty deflate block.
    const deflated = uncompressed.length === 0 ? Buffer.alloc(0) : deflateRawSync(uncompressed, { level: 9 });
    const useDeflate = deflated.length < uncompressed.length;
    const stored = useDeflate ? deflated : uncompressed;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const checksum = crc32(uncompressed);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    localHeader.writeUInt16LE(VERSION_2_0, 4);
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(DOS_EPOCH_TIME, 10);
    localHeader.writeUInt16LE(DOS_EPOCH_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(stored.length, 18);
    localHeader.writeUInt32LE(uncompressed.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    localChunks.push(localHeader, nameBytes, stored);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
    centralHeader.writeUInt16LE(VERSION_2_0, 4); // version made by
    centralHeader.writeUInt16LE(VERSION_2_0, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(DOS_EPOCH_TIME, 12);
    centralHeader.writeUInt16LE(DOS_EPOCH_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(stored.length, 20);
    centralHeader.writeUInt32LE(uncompressed.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attributes
    // External attributes: 0 keeps the archive host-neutral (no unix mode
    // bits), so the same content zips identically regardless of platform.
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralChunks.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + stored.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(END_OF_CENTRAL_DIR_SIGNATURE, 0);
  endRecord.writeUInt16LE(0, 4); // this disk
  endRecord.writeUInt16LE(0, 6); // disk with central directory
  endRecord.writeUInt16LE(sorted.length, 8);
  endRecord.writeUInt16LE(sorted.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20); // archive comment length

  return Buffer.concat([...localChunks, centralDirectory, endRecord]);
}
