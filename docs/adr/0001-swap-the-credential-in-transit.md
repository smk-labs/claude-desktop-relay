# Swap the credential in transit, never modify the app

The Window hands each Code session a token in its environment and routes that
session through the machine's proxy, so a local proxy can replace the token on the
way out. We take that path instead of the two alternatives: patching `app.asar`
(brings back code signing, entitlements and a launch-time policy gate that has
bricked the app before, and buys nothing here) and the app's own third-party
backend mode (works, but serves an offline UI snapshot with an empty feature-flag
payload, so tool widgets and thinking blocks never render).

## Consequences

All Code traffic passes through local code that sees every request and response in
the clear. If the app ever adds the proxy variable names to the list it strips, or
pins its certificate, this closes with no way around it.
