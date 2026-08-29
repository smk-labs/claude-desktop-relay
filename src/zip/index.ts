/**
 * The one zip archive this program makes, and reading one back, using nothing but
 * Node.
 *
 * A Send-token backup is one JSON file in a zip inside a cipher. The zip half
 * used to be `/usr/bin/zip` and `/usr/bin/unzip`, which macOS ships and neither
 * of the other two machines does. Shelling out to a tool that is not there is how
 * a backup command works on one machine and fails on another, and the format this
 * needs is one stored entry: forty lines of a module Node already ships.
 *
 * Only what a backup archive actually is, deliberately. No encryption, no spanned
 * archives, no zip64, no directories. Anything else is refused by name rather
 * than half-read.
 */
export { fileFromZip } from "./internal/read.ts";
export { zipOneFile } from "./internal/write.ts";
