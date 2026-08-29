/**
 * Read one file out of a zip archive, using nothing but Node.
 *
 * This exists so that opening a backup archive needs no `unzip` on any machine.
 * macOS ships one and Windows ships none, so `src/backup` calls `fileFromZip`
 * below rather than shelling out, and the same code opens an archive on both.
 * Installing a package to read a file format whose reader is thirty lines of a
 * module Node already ships is the more expensive of the two.
 *
 * Only what a backup archive actually is, deliberately: no encryption, no spanned
 * archives, no zip64. Anything else is refused by name rather than half-read.
 */
import { inflateRawSync } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

/** Where the central directory says each entry begins, by name. */
function entries(archive: Buffer): Map<string, { at: number; method: number; compressed: number }> {
  // Scanned backwards, because the end record sits after a comment of any length.
  let end = -1;
  for (let at = archive.length - 22; at >= 0; at--) {
    if (archive.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end === -1) throw new Error("that is not a zip archive: it has no end-of-central-directory record");

  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);

  const found = new Map<string, { at: number; method: number; compressed: number }>();
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(at) !== CENTRAL_ENTRY) throw new Error("the archive's index is damaged");
    const method = archive.readUInt16LE(at + 10);
    const compressed = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    found.set(name, { at: archive.readUInt32LE(at + 42), method, compressed });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return found;
}

/** One named file's contents, or an error saying which of the two things is wrong. */
export function fileFromZip(archive: Buffer, name: string): Buffer {
  const found = entries(archive);
  const entry = found.get(name);
  if (entry === undefined) {
    throw new Error(`the archive holds no "${name}", only: ${[...found.keys()].join(", ") || "nothing"}`);
  }

  if (archive.readUInt32LE(entry.at) !== LOCAL_ENTRY) throw new Error(`the entry for "${name}" is damaged`);
  const nameLength = archive.readUInt16LE(entry.at + 26);
  const extraLength = archive.readUInt16LE(entry.at + 28);
  const from = entry.at + 30 + nameLength + extraLength;
  const bytes = archive.subarray(from, from + entry.compressed);

  if (entry.method === STORED) return Buffer.from(bytes);
  if (entry.method === DEFLATED) return inflateRawSync(bytes);
  throw new Error(`"${name}" is compressed in a way this does not read (method ${entry.method})`);
}
