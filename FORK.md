# Livery workflow fork

Fork: https://github.com/r-bart/photopea-mcp-server

Upstream: https://github.com/attalla1/photopea-mcp-server, MIT license retained. Starting commit `ef544a62485dc4e9aeeebff96542389f66298524`, package version 0.1.1. Clone is independent of `sim-livery-tools`; large livery assets stay outside both repositories.

## First change: preserve the active document session

Previously, opening a second bridge tab terminated the first socket without rejecting its in-flight work or resetting readiness. Commands could subsequently target another tab's documents. Removing all listeners from the old socket also interfered with WebSocketServer cleanup during the regression test.

The fork retains the first connected session and rejects an additional tab with close code 1008 and an explicit reason. The rejected tab displays a message and stops automatic reconnect attempts. If the former connection is already closing, pending work is failed before replacement and the new client must report readiness. Messages from superseded sockets are ignored.

The regression test starts a pending operation, connects a second client, and checks that the original session completes it. It failed on upstream and passes after the fix. Frontend tests cover blocked-tab and transient-failure reconnect behavior. These tests use real local WebSockets and a simulated browser DOM; they do not manipulate live Photopea documents.

Build now applies executable permissions through Node rather than shell `chmod`, so `npm run build` works in Windows PowerShell as well as Unix environments.

## Next investigations

1. **Timeout queue ownership.** Timers start while requests are queued. When an active request expires, the server advances the queue although the iframe may still be executing it; the frontend has only one `pendingId`. Reproduce delayed responses, distinguish queue timeout from execution timeout, and prevent a late `done` from completing another operation. Do not retry relative edits automatically.
2. **Large PSD transport.** Export travels as ArrayBuffer → binary string → base64 → JSON → WebSocket. The server uses the ws default payload limit; inspect size/memory/error reporting with synthetic payloads. This is a candidate mechanism, not a proven explanation of the user's v18 disconnect.
3. **Export result contract.** `expectFiles` is sent but the server can accept a normal script result for a file request. Validate response type, nonempty data and persisted file identity before returning export success.
4. **Reconnect readiness.** Frontend currently resets `photopeaReady` on WebSocket disconnection even if the iframe stays loaded. Reconnect must confirm the same editor session without forcing a page reload that discards unsaved documents.
5. **Document targeting.** Add inspect/list/select support with unambiguous session/document identity and checks before mutating. Current tools act on the active document and layer names can repeat in groups.
6. **Livery exports.** After transport reliability, add paired albedo/region exports, visibility restoration, durable PSD verification and TGA validation. Keep simulator-specific atlas data in skills.

Upstream dependencies were installed without lifecycle scripts and audited by npm. Dependency updates require a separate compatibility review; no forced audit upgrade was applied. Production Codex configuration still points to the original installed package. Switch it only after a controlled test with a disposable document and a saved recovery copy of any live work.
