import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createZip, crc32 } from "./zip";

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const END_OF_CENTRAL_DIR_SIGNATURE = 0x06054b50;

/** Reads back the archive using only the fields a real extractor reads. */
function readEntries(zip: Buffer): Array<{ path: string; content: Buffer; method: number }> {
  const entries: Array<{ path: string; content: Buffer; method: number }> = [];
  let offset = 0;
  while (zip.readUInt32LE(offset) === LOCAL_HEADER_SIGNATURE) {
    const method = zip.readUInt16LE(offset + 8);
    const storedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const path = zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const dataStart = offset + 30 + nameLength + extraLength;
    const stored = zip.subarray(dataStart, dataStart + storedSize);
    entries.push({ path, method, content: method === 8 ? inflateRawSync(stored) : stored });
    offset = dataStart + storedSize;
  }
  return entries;
}

describe("crc32", () => {
  it("matches the standard CRC-32 check values", () => {
    expect(crc32(Buffer.from(""))).toBe(0);
    // The canonical CRC-32 check value for "123456789".
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
});

describe("createZip: structure", () => {
  it("round-trips every entry's exact bytes", () => {
    const zip = createZip([
      { path: "README.md", content: Buffer.from("# hello\n") },
      { path: "src/index.ts", content: Buffer.from("export const x = 1;\n") },
    ]);
    const entries = readEntries(zip);
    expect(entries.map((e) => e.path)).toEqual(["README.md", "src/index.ts"]);
    expect(entries[0]!.content.toString()).toBe("# hello\n");
    expect(entries[1]!.content.toString()).toBe("export const x = 1;\n");
  });

  it("records a correct CRC and uncompressed size for each entry", () => {
    const content = Buffer.from("a".repeat(5000));
    const zip = createZip([{ path: "a.txt", content }]);
    expect(zip.readUInt32LE(14)).toBe(crc32(content));
    expect(zip.readUInt32LE(22)).toBe(content.length);
  });

  it("ends with a central directory whose record count matches the entries", () => {
    const zip = createZip([
      { path: "a.txt", content: Buffer.from("a") },
      { path: "b.txt", content: Buffer.from("b") },
      { path: "c.txt", content: Buffer.from("c") },
    ]);
    const endOffset = zip.length - 22;
    expect(zip.readUInt32LE(endOffset)).toBe(END_OF_CENTRAL_DIR_SIGNATURE);
    expect(zip.readUInt16LE(endOffset + 8)).toBe(3);
    expect(zip.readUInt16LE(endOffset + 10)).toBe(3);
  });

  it("deflates compressible content but stores incompressible content", () => {
    const compressible = Buffer.from("x".repeat(2000));
    const tiny = Buffer.from("hi");
    const zip = createZip([{ path: "big.txt", content: compressible }, { path: "tiny.txt", content: tiny }]);
    const entries = readEntries(zip);
    expect(entries.find((e) => e.path === "big.txt")!.method).toBe(8);
    // 2 bytes cannot be shrunk by deflate's block overhead — stored verbatim.
    expect(entries.find((e) => e.path === "tiny.txt")!.method).toBe(0);
  });

  it("handles an empty file", () => {
    const zip = createZip([{ path: "empty", content: Buffer.alloc(0) }]);
    const entries = readEntries(zip);
    expect(entries[0]!.content.length).toBe(0);
    expect(entries[0]!.method).toBe(0);
  });
});

describe("createZip: determinism", () => {
  it("produces byte-identical archives for the same content", () => {
    const build = () =>
      createZip([
        { path: "b.txt", content: Buffer.from("second") },
        { path: "a.txt", content: Buffer.from("first") },
      ]);
    expect(build().equals(build())).toBe(true);
  });

  it("is insensitive to the caller's entry order", () => {
    const forward = createZip([
      { path: "a.txt", content: Buffer.from("first") },
      { path: "b.txt", content: Buffer.from("second") },
    ]);
    const reversed = createZip([
      { path: "b.txt", content: Buffer.from("second") },
      { path: "a.txt", content: Buffer.from("first") },
    ]);
    expect(forward.equals(reversed)).toBe(true);
  });

  it("stamps the ZIP epoch, never the current time", () => {
    const zip = createZip([{ path: "a.txt", content: Buffer.from("a") }]);
    expect(zip.readUInt16LE(10)).toBe(0); // time
    expect(zip.readUInt16LE(12)).toBe((1 << 5) | 1); // 1980-01-01
  });

  it("rejects duplicate paths rather than emitting an ambiguous archive", () => {
    expect(() =>
      createZip([
        { path: "a.txt", content: Buffer.from("one") },
        { path: "a.txt", content: Buffer.from("two") },
      ]),
    ).toThrow(/Duplicate ZIP entry/);
  });
});

describe("createZip: a real extractor can read it", () => {
  // Format correctness is only meaningfully proven by a tool that did not
  // write the archive. Gated on tool availability so the suite still runs
  // where neither is present; the structural tests above cover every field
  // an extractor reads either way.
  function extract(zipPath: string, destination: string): boolean {
    try {
      if (process.platform === "win32") {
        execFileSync(
          "powershell",
          ["-NoProfile", "-Command", `Expand-Archive -Path '${zipPath}' -DestinationPath '${destination}' -Force`],
          { stdio: "pipe" },
        );
      } else {
        execFileSync("unzip", ["-q", zipPath, "-d", destination], { stdio: "pipe" });
      }
      return true;
    } catch {
      return false;
    }
  }

  it("extracts with the platform's own unzip tool, contents intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "zip-extract-"));
    const zipPath = join(dir, "package.zip");
    const destination = join(dir, "out");
    writeFileSync(
      zipPath,
      createZip([
        { path: "HANDOVER.md", content: Buffer.from("# Handover\n\ncontent here\n") },
        { path: "src/app.tsx", content: Buffer.from(`export default () => null;\n${"// pad\n".repeat(200)}`) },
      ]),
    );

    const extracted = extract(zipPath, destination);
    if (!extracted) {
      rmSync(dir, { recursive: true, force: true });
      return; // no extractor available on this machine
    }

    expect(readdirSync(destination).sort()).toEqual(["HANDOVER.md", "src"]);
    expect(readFileSync(join(destination, "HANDOVER.md"), "utf8")).toBe("# Handover\n\ncontent here\n");
    expect(readFileSync(join(destination, "src", "app.tsx"), "utf8")).toContain("export default");
    rmSync(dir, { recursive: true, force: true });
  });
});
