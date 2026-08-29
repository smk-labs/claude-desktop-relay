import { strict as assert } from "node:assert";
import { test } from "node:test";

import { trayBundle, TRAY_APP_NAME, TRAY_BINARY, TRAY_BUNDLE_ID, TRAY_PORT_KEY } from "../src/tray/index.ts";

/**
 * The bundle is what makes the menu bar item survive a restart, and two of its
 * fields are the difference between a status item and a stray application with a
 * Dock icon and a menu bar of its own. Asserted here rather than looked at, because
 * looking at it means installing it.
 */
test("the bundle is a menu bar item, not an application with a Dock icon", () => {
  const bundle = trayBundle({ port: 8980, version: "0.1.0" });

  // Without this macOS gives it a Dock icon and its own menu bar.
  assert.match(bundle.infoPlist, /<key>LSUIElement<\/key><true\/>/);
  // The executable is the compiled binary, never a script that execs it: a shim
  // there was why the first attempt never appeared in the menu bar.
  assert.match(bundle.infoPlist, new RegExp(`<key>CFBundleExecutable</key><string>${TRAY_BINARY}</string>`));
  assert.equal(bundle.binaryAt, `Contents/MacOS/${TRAY_BINARY}`);
  assert.equal(/<string>[^<]*\.sh<\/string>/.test(bundle.infoPlist), false, "no script may be the executable");
  assert.match(bundle.infoPlist, new RegExp(`<key>CFBundleIdentifier</key><string>${TRAY_BUNDLE_ID}</string>`));
  // One identifier, so installing twice is one app rather than two.
  assert.equal(TRAY_BUNDLE_ID.split(".").length >= 3, true, "a bundle id is reverse-dns");
});

test("the port is written into the plist, because a bundle opened from the Finder gets no arguments", () => {
  assert.match(trayBundle({ port: 8980, version: "0.1.0" }).infoPlist, new RegExp(`<key>${TRAY_PORT_KEY}</key><string>8980</string>`));
  // A second relay on a second port gets a second bundle that reads its own relay,
  // which is the whole of ADR 0012 as far as the tray is concerned.
  assert.match(trayBundle({ port: 8979, version: "0.1.0" }).infoPlist, new RegExp(`<key>${TRAY_PORT_KEY}</key><string>8979</string>`));
});

test("the name in the plist is the file that is actually there", () => {
  const bundle = trayBundle({ port: 8980, version: "0.1.0" });
  assert.equal(bundle.infoPlistAt, "Contents/Info.plist");
  assert.equal(bundle.iconAt, `Contents/Resources/${TRAY_APP_NAME}.icns`);
  // macOS refuses to open a bundle whose CFBundleExecutable is not on disk.
  assert.match(bundle.infoPlist, new RegExp(`<string>${bundle.binaryAt.split("/").pop()}</string>`));
  assert.match(bundle.infoPlist, new RegExp(`<key>CFBundleIconFile</key><string>${TRAY_APP_NAME}</string>`));
});

test("a port that is not a port is refused rather than written into a shim", () => {
  for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
    assert.throws(() => trayBundle({ port, version: "0.1.0" }), /not a port/, `${port} must be refused`);
  }
});
