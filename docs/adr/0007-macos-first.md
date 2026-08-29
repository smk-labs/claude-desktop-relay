# macOS first, Windows second

The mechanism is proven end to end on macOS and half-proven on Windows. Building
both at once means proving every decision twice and halving the pace, while the
Windows half is a translation once the design is settled, not a design of its own.

## Consequences

Windows lands in phase three. Until then the repo carries no Windows code, so a
Windows user gets nothing rather than something half-working.

## Superseded on 2026-08-28 by ADR 0015

The last sentence is no longer true. Windows is supported by the same `src/` the
Mac uses, not by a folder of its own, so a Windows user gets the same program:
the Send tokens in a `CryptProtectData` vault (`src/seats/internal/windows-vault.ts`),
the app's own store read and written under `%APPDATA%` (`src/dpapi/`), a Window
started from the user's own session (`src/window/internal/windows-proxy.ts`), a
console for `claude setup-token` (`src/minting/internal/windows-terminal.ts`), a
tray (`src/tray/relay-tray.ps1`) and a login item that supervises itself
(`src/service/internal/startup-item.ts`). `test/windows.test.ts` is what holds
those to the same rules as the Mac.

The ordering decision this ADR records was right and is what happened: macOS was
proven first, on 2026-08-21, and Windows followed on 2026-08-25 as a translation
of a settled design rather than a design of its own. Only the consequence went
stale. See [0015](0015-one-body-of-code-two-machines.md).
