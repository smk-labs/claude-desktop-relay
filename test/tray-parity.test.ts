import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { TRAY_MODES, TRAY_WORDS } from "../src/tray/index.ts";

/**
 * Three shells draw this menu: Swift on macOS, PowerShell on Windows, `yad` on
 * Linux. None of them can import the words they use, so they drifted: one said
 * "Switch to", another "PAY WITH", and the third had no Mode row for Manual at
 * all. Nobody noticed until two machines were opened side by side.
 *
 * So the shells are read here as text and checked against the one place the words
 * are written down. It is a crude test and it is the only one that can fail before
 * a person on the other machine does.
 */
const shells = {
  macOS: "src/tray/relay-tray.swift",
  Windows: "src/tray/relay-tray.ps1",
  Linux: "linux/tray/relay-tray.sh",
};

async function sourceOf(where: string): Promise<string> {
  return await readFile(new URL(`../${where}`, import.meta.url), "utf8");
}

test("every tray offers all three Modes, under the same names", async () => {
  for (const [machine, where] of Object.entries(shells)) {
    const source = await sourceOf(where);
    for (const mode of TRAY_MODES) {
      assert.equal(source.includes(mode.label), true, `${machine} has no ${mode.label} row`);
      assert.equal(source.includes(`"${mode.name}"`) || source.includes(`'${mode.name}'`) || source.includes(` ${mode.name}"`), true, `${machine} never names the ${mode.name} mode`);
    }
  }
});

test("every tray dates its figures, and offers the same way out", async () => {
  for (const [machine, where] of Object.entries(shells)) {
    const source = await sourceOf(where);
    // The date of the last reading. Every number in the menu is a reading from an
    // earlier moment, and this is the row that says which moment.
    assert.equal(/refreshed/i.test(source), true, `${machine} never says when it was refreshed`);
    assert.equal(source.includes(TRAY_WORDS.quit), true, `${machine} does not say "${TRAY_WORDS.quit}"`);
  }
});

test("the two trays with headings use the same headings", async () => {
  // Linux is left out of this one on purpose: a `yad` menu has no disabled row, and
  // a heading there is drawn selected the moment the pointer enters the menu, which
  // is why that tray carries the same facts as ticks and a tooltip instead.
  for (const machine of ["macOS", "Windows"] as const) {
    const source = await sourceOf(shells[machine]);
    for (const heading of [TRAY_WORDS.paying, TRAY_WORDS.mode, TRAY_WORDS.switch, TRAY_WORDS.desktop, TRAY_WORDS.relaying, TRAY_WORDS.open]) {
      assert.equal(source.includes(heading), true, `${machine} does not say "${heading}"`);
    }
    // Picking a Seat sets Manual, and a menu that does it without saying so is a
    // menu that changes the Mode behind the reader's back.
    assert.equal(source.includes(TRAY_WORDS.switchHint), true, `${machine} never says that switching sets Manual`);
  }
});
