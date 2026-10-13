# Reliable PSD checkpoints (fork 0.2.0, protocol 2)

This fork replaces base64 exports with bounded binary transfer and a single editor owner. A timeout no longer dispatches another script while the previous execution may still be running.

## Use

For a large export, call `photopea_export_artifacts` with `format: "psd"` and a **new absolute output path**. It returns an operation ID immediately. Poll `photopea_get_operation` using that ID; `photopea_get_status` shows the session, active operation and queue without opening a tab.

`completed` with `result.success: true` includes the path, byte length, SHA-256, dimensions, structural layer-record count and validation level. `indeterminate` means the editor outcome is unknown: inspect the owning tab and query the same ID. Do not repeat the mutation. Late results update that record. Cancellation only removes work that has not been dispatched. `photopea_export_image` remains an awaiting adapter and also returns structured results/errors.

Keep the UI untouched during an operation. Export uses the active document when dispatched; session document references, nested layer selectors, compound imports and variants bundles are later milestones. A confirmed script termination does not prove that an arbitrary Photopea command had its intended effect; inspect postconditions.

## What is checked

The frontend hashes the actual ArrayBuffer from Photopea. It sends a manifest, then binary frames containing sequence/offset and up to 1 MiB of payload. One chunk is in flight; the next is sent only after the backend has written and acknowledged it. The receiver hashes incrementally and compares length/hash before publishing.

Files are written to an exclusive `.part` beside the destination and synced. PSD v1 validation checks header, dimensions/mode, section boundaries, layer records/channel lengths and composite data lengths. The structural validator is intentionally not a full PSD decoder. Other format checks are structural too; no result claims that every PNG/JPEG/WebP pixel was decoded. The final path is published by a hard link without replacement, then the temporary name is removed. Existing destinations, including a file created during transfer, are preserved. Filesystems without hard-link support fail rather than use a destructive fallback. Use NTFS on Windows.

Structural validation is not editability. Reopen an independent copy and compare layers, visibility and rendered composition before declaring a particular master recoverable. The real acceptance fixture contains noisy raster layers, a group, editable text, hidden content and Levels. Its 109.4 MiB PSD passed that roundtrip. Fonts must be available explicitly: a default-font fixture rendered differently only in its text after reopening; loading ArialMT preserved the exact composite PNG hash.

Photopea still produces one whole ArrayBuffer. Chunking eliminates base64 and large WS messages; it does not stream Photopea's internal serializer or promise that a 512 MiB document fits browser memory. The 512 MiB transfer/load reservation limit is a budget, not a certified editor capacity. Export serializer default: 180 s; ordinary script: 30 s; queue: 120 s; absent transfer/IO progress: 30 s. These values are configurable through `BridgeOptions`. An expired running operation retains editor ownership.

## Sessions and recovery

Only the authenticated owning page may connect. Bootstrap uses a per-server token in the launch URL fragment; the page removes the fragment from the address bar and keeps its session identity across WS reconnects. Origin/Host/path and protocol are checked. No token is sent to the iframe or logged by production startup. A different page cannot take over, even after disconnect. The iframe is never reloaded to resolve a timeout. A completed export can resend its retained buffer after reconnect; the script itself is not replayed. Interrupted incoming loads remain unknown and require inspection rather than automatic replay.

Generated scripts carry begin/end markers. Node checks JavaScript syntax before dispatch, without executing it. The observed Photopea interpreter does not implement `eval` or `try/finally` like browser JavaScript; unsupported syntax and runtime failures can omit the end marker. `done` alone cannot free a script operation. Arbitrary asynchronous scripts, URL `app.open`, dialogs and multi-file `saveToOE` scripts are unsupported. Use binary `open_file`, `load_font` and the export tools instead.

Production records metadata in `~/.photopea-mcp/operations`: operation IDs, phases, timestamps and artifact candidates/results, without scripts or echo content. A candidate is flushed before publication. On restart, a published candidate is reconciled by path/size/hash/structure; queued jobs become cancelled, running jobs remain unknown. Nothing is replayed. Finished history is retained up to 256 records; unknown outcomes are preserved up to 256 and excessive unknown history prevents new work. This covers process restart evidence, not a universal power-loss guarantee. Do not delete unknown records merely to hide a failure.

## Development and independent acceptance

Requires Node 22+. From this checkout:

```powershell
npm ci
npm run typecheck
npm run build
npm test
npm run test:e2e
```

The E2E command starts on an ephemeral localhost port and waits for a separate tab. It prints the test directory and port; `output/isolated-<id>/launch.json` contains the local launch URL. Open that URL in a **new tab**, not the current painting session. The harness creates its own PSD, loads the Windows Arial fixture (override both `PHOTOPEA_TEST_FONT` and `PHOTOPEA_TEST_FONT_NAME` on another platform), exports, closes only its synthetic document, reopens, compares tree/text/visibility and PNG hashes, disconnects the test WS during another export, and verifies recovery. Finally it injects a runtime fault to check retained ownership and stops its own server. `evidence.json`, PSDs and previews remain in ignored output. No personal template is used.

CI runs typecheck/build/unit and socket integration tests on Windows/Linux, Node 22/24. Real Photopea is a separate manual gate; network/editor/font versions can change. Current acceptance was run on Windows with Node 24.14.1. The active user's MCP configuration has not been migrated; point it to a built checkout only after preserving work in the existing session.
