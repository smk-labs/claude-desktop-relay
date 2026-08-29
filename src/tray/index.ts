/**
 * The menu bar item as an application bundle, so it survives a restart.
 *
 * The built binary on its own is enough to run the tray from a terminal, but a
 * thing the user expects to still be there tomorrow has to be a bundle in a folder
 * macOS looks in. That is all this is: a layout and two small files, no build
 * system and no dependency.
 *
 * Pure on purpose. It returns the bytes and never writes them, so the layout can be
 * asserted in a test without a folder anywhere near /Applications.
 */

export {
  AT_MOST_SEATS,
  TRAY_MODES,
  TRAY_WORDS,
  sayRefreshed,
} from "./internal/menu.ts";

/** The one identifier, so two installs are the same app rather than two apps. */
export const TRAY_BUNDLE_ID = "dev.smk-labs.claude-desktop-relay.tray";

/** What the bundle is called, in the folder and in the menu. */
export const TRAY_APP_NAME = "Relay";

/**
 * The bundle's executable is the compiled binary itself, never a script that execs
 * it.
 *
 * A shell script as `CFBundleExecutable` is what the first attempt used, to get the
 * port in as an argument, and the status item never appeared. The working reference
 * on this machine, another signed status-item app, names its own Mach-O binary and
 * is signed, so this does both. The port comes from `Info.plist` instead.
 */
export const TRAY_BINARY = "relay-tray";

/** Where the port is written, read back by the tray through its own bundle. */
export const TRAY_PORT_KEY = "RelayPort";

export type TrayBundle = {
  /** Where each file goes, relative to the `.app` folder. */
  readonly infoPlistAt: string;
  readonly binaryAt: string;
  /** Where the icon goes. Without it the Finder draws the blank sheet of paper. */
  readonly iconAt: string;
  readonly infoPlist: string;
};

export function trayBundle(options: { port: number; version: string }): TrayBundle {
  const { port, version } = options;
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
    throw new Error(`the tray needs the port its relay answers on, and ${port} is not a port.`);
  }

  return {
    infoPlistAt: "Contents/Info.plist",
    iconAt: `Contents/Resources/${TRAY_APP_NAME}.icns`,
    binaryAt: `Contents/MacOS/${TRAY_BINARY}`,
    /**
     * `LSUIElement` is the whole reason this is a bundle and not a folder of files:
     * without it macOS gives a menu bar item a Dock icon and a menu bar of its own,
     * which is not what a status item is.
     */
    infoPlist:
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
      `<plist version="1.0">\n` +
      `<dict>\n` +
      `  <key>CFBundleName</key><string>${TRAY_APP_NAME}</string>\n` +
      `  <key>CFBundleDisplayName</key><string>${TRAY_APP_NAME}</string>\n` +
      `  <key>CFBundleIdentifier</key><string>${TRAY_BUNDLE_ID}</string>\n` +
      `  <key>CFBundleExecutable</key><string>${TRAY_BINARY}</string>\n` +
      `  <key>CFBundlePackageType</key><string>APPL</string>\n` +
      `  <key>CFBundleIconFile</key><string>${TRAY_APP_NAME}</string>\n` +
      `  <key>CFBundleShortVersionString</key><string>${version}</string>\n` +
      `  <key>CFBundleVersion</key><string>${version}</string>\n` +
      `  <key>LSMinimumSystemVersion</key><string>13.0</string>\n` +
      `  <key>LSUIElement</key><true/>\n` +
      `  <key>NSHighResolutionCapable</key><true/>\n` +
      // The port, because a bundle opened from the Finder is given no arguments and
      // the port is a fact about one relay rather than a constant in the source.
      `  <key>${TRAY_PORT_KEY}</key><string>${port}</string>\n` +
      `</dict>\n` +
      `</plist>\n`,
  };
}
