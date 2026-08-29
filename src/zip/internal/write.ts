import { crc32 } from "node:zlib";

const LOCAL_ENTRY = 0x04034b50;
const CENTRAL_ENTRY = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const STORED = 0;

/**
 * The version and flags a reader will expect, and the one thing deliberately left
 * out of them.
 *
 * No timestamp and no owner, so two archives of the same Seats are the same
 * bytes. That is what `zip -X` was for, and it matters here: a backup is taken
 * after every Seat in a sitting, and a file that differs only by the second it
 * was written is a file that looks changed when nothing changed.
 */
const MADE_BY = 20;
const NO_FLAGS = 0;
const NO_DATE = 0;
const NO_TIME = 0;

/**
 * One file in a zip archive, stored rather than compressed.
 *
 * Compression is left out because the content is a few kilobytes of JSON that is
 * about to be encrypted anyway, and because a stored entry is the half of the
 * format with no second implementation to get wrong.
 */
export function zipOneFile(name: string, contents: Buffer): Buffer {
  const named = Buffer.from(name, "utf8");
  const sum = crc32(contents);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(LOCAL_ENTRY, 0);
  local.writeUInt16LE(MADE_BY, 4);
  local.writeUInt16LE(NO_FLAGS, 6);
  local.writeUInt16LE(STORED, 8);
  local.writeUInt16LE(NO_TIME, 10);
  local.writeUInt16LE(NO_DATE, 12);
  local.writeUInt32LE(sum, 14);
  local.writeUInt32LE(contents.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(named.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(CENTRAL_ENTRY, 0);
  central.writeUInt16LE(MADE_BY, 4);
  central.writeUInt16LE(MADE_BY, 6);
  central.writeUInt16LE(NO_FLAGS, 8);
  central.writeUInt16LE(STORED, 10);
  central.writeUInt16LE(NO_TIME, 12);
  central.writeUInt16LE(NO_DATE, 14);
  central.writeUInt32LE(sum, 16);
  central.writeUInt32LE(contents.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(named.length, 28);
  central.writeUInt32LE(0, 42);

  const start = local.length + named.length + contents.length;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + named.length, 12);
  end.writeUInt32LE(start, 16);

  return Buffer.concat([local, named, contents, central, named, end]);
}
