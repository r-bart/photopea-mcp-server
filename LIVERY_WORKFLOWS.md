# Livery workflows, version 0.3.0

The four follow-up blocks are implemented: explicit document/nested-layer targeting, compound import with atlas origin, coherent checkpoint/PNG bundles, and skill/installation migration. The three simulator skills and manifest consumer live in the sibling `sim-livery-tools` project.

## Scoped editing

`photopea_list_documents` returns session-bound document references; `photopea_get_layers` accepts a document, subtree selector, depth and page bounds. Layers include own/effective visibility, opacity, numeric bounds and a snapshot/path selector. `photopea_edit_layer` accepts those selectors, unique recursive names or root indices. It checks preconditions and observed properties, absolute position and sibling ordering. Photopea quantizes opacity to 8-bit precision, so verification allows half a percentage point.

The tested Photopea DOM exposes no document or layer IDs. Wrapper identity comparisons also fail, including for the active document. References therefore validate position against the complete document roster; selectors validate the complete hierarchy. A transient `Document.source` marker identifies the active index and is restored within the same script before save or inspection. The identity probe confirmed restored source and unchanged history. This is cooperative identity, not an invented native ID: manual swaps/replacements of indistinguishable objects cannot be detected. Do not alter the document roster during workflows.

`photopea_import_asset` owns capture, binary load, helper discovery, destination selection, composition, duplication, geometry verification and helper cleanup as one queued workflow. `origin:canvas` preserves transparent atlas margins; `content_bounds` aligns visible content. Width/height fit the selected basis while preserving aspect ratio. The destination is selected by checked reference even if the active document changes after load. Empty sources fail before destination edits and their owned helper is closed when execution is known. Unknown execution retains ownership and reports the helper/possible partial result rather than replaying.

The older active-document tools remain for compatibility. Use scoped tools for scoped work. A missing operation can be implemented in one guarded script with explicit checks; separate select/edit calls are not a compound transaction.

## Revision bundle

`photopea_export_bundle` returns an operation ID immediately. Poll `photopea_get_operation` until terminal; do not submit the export again. Supply a NEW absolute directory and one to eight unique PNG basenames with explicit visibility recipes.

1. Capture source hierarchy, visibility/opacity and active document.
2. Export source composition and durable `checkpoint.psd`, reopen the checkpoint in an owned helper.
3. Compare hierarchy, visibility/opacity and PNG SHA-256 of source versus reopened copy. A changed font/render fails the bundle.
4. Reset the copy to its baseline before each recipe, apply explicit visibility and verify it, then export a PNG with checked checkpoint dimensions.
5. Restore and verify copy/source visibility, close only the helper, compare the full document roster and observe the restored active index.
6. Promote `manifest.json` to `complete` only after all checks. Errors persist `incomplete` with partial artifacts and restoration state. A failed final manifest write cannot leave a successful status on a subsequent error write.

The manifest includes checkpoint and PNG paths, byte lengths, dimensions, hashes, recipe paths/names, render proof and restoration. Consumers must reject incomplete or pending restoration. The sibling Python utility decodes PNGs, rechecks all artifacts inside the revision, converts opaque RGB24 TGA without resizing, and ties each conversion role/reference back to that bundle. Its installer checks the complete selected conversion set before staging/backups/replacement.

Source/copy PNG equality is conservative: a byte difference rejects even if visually harmless. It does not prove every hidden Photoshop feature or all possible future material variants survive serialization. Original documents are never edited for recipe visibility. Humans must avoid editing during capture; the MCP queue cannot lock the editor UI. Bundles do not imply UV/3D validation, approval or publication.

## Queue and recovery

The workflow queue owns the editor across all steps; a separate wire queue correlates native IDs. Status exposes the public operation and current step. Active timeouts retain ownership; queued timeouts mean not started. Late command/load/export results reconcile to the public root ID, including a late artifact. A composite workflow with an unknown step never resumes its remaining edits; it ends with the partial failure once the native step is confirmed. Restart recovery cannot promote a workflow from one published child file alone. No automatic script replay.

Transport/file limits remain protocol 2, 512 MiB per file, 1 MiB binary chunks, 128 KiB scripts. See CHECKPOINTS.md for persistence and recovery details. Structured selectors support at most 2048 layers and 64 levels; recipes at most 256 rules. PNG validation in MCP is structural; the Python consumer decodes images.

## Validation recorded on 2026-10-13

- 79 unit/integration tests; source/tests typecheck, frontend syntax and build pass. Real WebSocket tests include >80 MiB transfer, exclusive compound ownership, late public-ID reconciliation and no replay.
- `tests/e2e/livery-workflows.ts` passed against independent Photopea sessions with two identically named 4096px documents: SVG 1600→4096 kept `(2560,1280,512,256)` bounds despite an active-document switch; empty SVG cleanup, sibling ordering, quantized opacity, self-reorder properties, nested duplicate names and stale selectors checked.
- A normal bundle and a **114,669,864-byte PSD** bundle completed with matching source/copy render and all restoration states verified. No user document was touched.
- Injected second-export failure, copy-render mismatch and final manifest-promotion failure all produced incomplete manifests and restored source/active/helper state.
- Registered MCP tools were exercised through the SDK transport: list documents/layers, start bundle and poll public operation to completion. Installed stdio package reports 0.3.0 and 42 tools without opening a browser during status/discovery.
- Python utility: nine tests including incomplete/tampered bundles, external conversion reference rejection, pixel equality, incomplete second conversion and paired-install rollback. The real 128px bundle converted to RGB24 TGA and installed only into an ignored simulated-game directory with verified hashes.

Ignored local evidence: `output/livery-5c2e52fe-c88f-4db1-b59a-69b378087f6c/evidence.json`; conversion/install evidence from `output/livery-d52a7951-6936-4040-83b7-124a1db6aa54`. These contain synthetic fixture data. Launch credentials are excluded from Git and this report.

## Local installation

The verified package is installed at a versioned path under `.codex/tools/photopea-livery/0.3.0`, registered as **photopea_livery** with a separate state directory and preferred port 4147. `PHOTOPEA_PORT` and absolute `PHOTOPEA_STATE_DIR` are configurable. The CLI configuration and all earlier values were backed up/preserved, including the legacy `photopea` entry. Skills require the new alias/version and never silently fall back to legacy tools.

The existing chat's tool catalog does not acquire the new namespace merely because config was written. Refresh/restart **only the new MCP connection** or begin a fresh chat when needed. Do not restart the app or old bridge while the unsaved legacy document may exist. Adding the alias is not proof that the old live document has migrated; open a saved checkpoint in the new session when recovery is complete. Codex configuration follows the [official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
