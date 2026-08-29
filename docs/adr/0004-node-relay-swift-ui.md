# Node for the relay, Swift for the interface

The relay terminates TLS, chains to the machine's proxy and streams bodies
untouched; that code exists, is proven, and two of its bugs each cost a day to find
and fail silently when reintroduced. Rewriting it in Swift would mean rediscovering
them and taking a heavy networking dependency. The menu-bar interface is the
opposite case: Swift is plainly better and the cost is small.

## Consequences

More than one language in one repo. The interface between them stays narrow on
purpose (list the Seats, set the Payer, report the last verdict) so the relay can
be ported later behind the same tests.

**Counted again on 2026-08-28: four, not two.** Everything is TypeScript except
the tray, and the tray is one file per machine, because each machine has its own
notification area and nothing else: `src/tray/relay-tray.swift` compiled on macOS,
`src/tray/relay-tray.ps1` run on Windows, shell under `linux/tray/`. That is this
decision carried out rather than a departure from it. "Swift is plainly better and
the cost is small" picks PowerShell and shell for the same job on the other two.

The narrow interface is what keeps the count from mattering. Each of those files
reads state and asks for a change, and none of them knows anything about the
relay, so a fourth language would cost a file rather than a design.
