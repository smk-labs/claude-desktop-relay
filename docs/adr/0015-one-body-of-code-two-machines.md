# 0015. One body of code, two machines

2026-08-25

## What was decided

Windows is supported by the same `src/` the Mac uses, with the handful of files
that genuinely differ dispatching on the machine inside themselves. There is no
`windows/` folder.

`linux/` stays as it is. It is a deliberately smaller thing, and folding it in
would mean either growing it to match or teaching every shared file about a third
machine that does not want the parts it is missing.

**Corrected 2026-08-28: what Linux is actually missing.** As first written this
said "no page, no tray, no service", and two thirds of that were wrong. Read
against `linux/` today:

- **It has a tray.** `linux/tray/` is seven files: a `yad --notification --listen`
  icon, the shell that drives it, and one TypeScript file that reads the same
  state the macOS menu reads.
- **It has a service, and two of them.** `linux/install-service.ts` writes
  `claude-relay.service` and `claude-relay-tray.service` as `systemd --user`
  units, both `Restart=always` and both wanted by `default.target`, plus a menu
  entry. Wanted by that target and with lingering on, the relay comes up at boot
  rather than at login, because a Code session started from a Window finds
  nothing listening otherwise.
- **It has no page.** `src/page` is imported only for three formatting helpers
  the tray reuses. Nothing on Linux serves the page.
- **It has no minting, no Stats logins, no VPN or SOCKS egress, and no
  notifications.** So a Seat's remaining room is learned from the headers on real
  replies, and a Seat that has not paid for anything yet reads "not known" rather
  than a figure that was guessed.

The decision is unchanged by any of that. The argument below is about a folder
drifting from the code it borrows, and a folder with a tray and a service in it
drifts further, not less.

## Why not a folder, which is what Linux got

The ask was that the two sides be the same program, not two programs that agree
today. A folder is the arrangement that guarantees they will not be: the Linux
port already says so out loud, listing the dashboard, the tray, the service,
notifications, minting and the Stats logins as "not here, on purpose". Every one
of those is a thing somebody would have to write twice and then remember to change
twice.

That list is itself the demonstration. Two of the things it calls absent, the tray
and the service, were written on the Linux side afterwards, twice over, and the
sentence naming them absent was still there to be corrected on 2026-08-28. A
folder does not stay smaller; it stays out of step.

What is actually different between a Mac and a Windows box is small, and it is all
at the edges:

| what | macOS | Windows |
| --- | --- | --- |
| where the Send tokens live | the Keychain | `CryptProtectData`, one file |
| how the app's own store is locked | AES-128-CBC, key from one Keychain entry | AES-256-GCM, key beside the store |
| the relay as a service | a launchd agent | a login item that supervises itself |
| where Claude Desktop keeps a profile | `~/Library/Application Support/Claude` | `%APPDATA%\Claude` |
| whether a profile is open | the process list | that profile's own lock file |
| a terminal for `claude setup-token` | `/usr/bin/expect` | a console PowerShell reads back |
| the tray | one Swift file, compiled | one PowerShell file, run |
| how a Window is started (ADR 0016) | `open -n -a`, so LaunchServices gives it an application job | the executable, from the user's own session |
| how traffic leaves | `scutil --proxy` | the registry |
| where the `claude` login lives | one Keychain entry | `.credentials.json` |

Everything else is one body of code on both: the relay, the Chooser, the Payer,
the usage memory, the verdict, the history, the journal, the page, the
conversation boundaries, the Seat store, the coverage matrix. That reuse is the
point rather than a convenience: the relay module carries the bound on how many
exchanges may be in the air, the idle bound on reused connections, and the rule
that a refused request is sent again before a byte of the refusal reaches the
caller. A Windows relay written fresh would have had to learn all of that again,
and the Linux README already says as much about the parts it did borrow.

## What this costs, stated plainly

A file that dispatches on the machine is a file with two paths through it, and
only one of them is exercised by whoever is sitting in front of it. The suite is
what stands against that: it runs whole on both machines rather than on the one
in front of you, and every rule that used to compare repo-relative paths with
forward slashes now normalises them, because those rules had quietly stopped
being enforced on Windows while still passing on the Mac. A
rule that holds on one of two machines is worse than no rule, because nobody is
watching the one it does not hold on.

Two tests are skipped on Windows and say why in their own text: the one about
delivering a signal to a child, which Windows does not do, and the one about a
Window started with no folder named, which cannot happen there.

## What was measured on the way, and matters

- The Windows app locks its environment store with Chromium's `v10` AES-256-GCM
  scheme under a key it keeps in `Local State` beside the store, wrapped for the
  logged-in account. Proved rather than believed, by decrypting a value Claude
  Desktop itself had written: a cookie in its own profile, locked with the same
  key. Nothing of that value was read or kept.
- Under `%APPDATA%` and `%LOCALAPPDATA%` on this machine, renaming a file onto a
  name that does not exist yet, in the same directory, fails `EXDEV` every time,
  while `copyFile` and `writeFile` in that same directory succeed. The app's own
  store lives under `%APPDATA%` and is not ours to move, so `src/json-file` falls
  back to a copy after the rename has had its chances.
- `schtasks /Create` and `Register-ScheduledTask` both answer "Access is denied"
  for this account, for a task as trivial as `echo`, at the root and in a folder
  of its own. So the service is a login item that supervises itself, which needs
  nothing beyond the user's own folder, the same promise the launchd side makes.
- `claude setup-token` writes to a terminal or it writes nothing, on Windows as on
  macOS: piped stdio produced zero bytes in ten seconds.
- Claude Desktop holds a profile's cookie store open exclusively while it runs, so
  a Stats login cannot be read out of a profile that is open. That is why there is
  a store of kept Stats logins on Windows and none on the Mac.
