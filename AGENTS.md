# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project Overview

This is a browser-only TypeScript/Webpack app for upscaling MP4 video locally with WebGPU/WebCodecs and the WebSR Anime4K networks. The UI runs in `src/index.ts` and `src/index.html`; the expensive video work runs in `src/worker.ts` and the processor modules under `src/processors/`.

Key browser requirements are WebGPU, WebCodecs (`VideoEncoder`/`VideoDecoder`), OffscreenCanvas, and the File System Access API. Expect manual verification to require a current Chromium-based desktop browser.

## Commands

- Install dependencies: `npm install`
- Start local dev server: `npm run serve`
- Build: `npm run build`
- Type-check: `npm run type-check`

The Webpack dev server uses port `8080` by default. There is no dedicated automated test suite in this repo at the moment, so run `npm run type-check` and `npm run build` for code changes, then do a browser smoke test for user-facing or media-processing changes.

## Repository Map

- `src/index.ts`: main-thread app bootstrapping, Alpine state, file picker flow, preview setup, worker messages, network selection, and output size estimation.
- `src/worker.ts`: worker message router, WebSR initialization, pause/resume state, and processor selection.
- `src/types/worker-messages.ts`: typed request/response protocol between main thread and worker.
- `src/processors/pipeline-processor.ts`: primary streaming video pipeline using `web-demuxer`, WebCodecs, MediaBunny muxing, and WebSR rendering.
- `src/processors/mediabunny-processor.ts`: alternative processor kept as a fallback/reference path.
- `src/processors/in-memory-storage.ts`: chunked in-memory output storage used when the result is small enough to return as a Blob.
- `src/weights/*.json`: Anime4K network weights. Treat these as large data assets; avoid formatting churn or unrelated edits.
- `src/img/`: static icons and screenshots copied into `dist`.
- `src/lib/`: vendored image compare viewer assets.

## Implementation Notes

- Keep main-thread and worker responsibilities separate. UI state and file-picking belong in `src/index.ts`; decode/upscale/encode work belongs in the worker/processor layer.
- Update `src/types/worker-messages.ts` whenever worker message shapes change.
- Preserve transfer semantics for `ImageBitmap`, `OffscreenCanvas`, and other transferable objects. Accidentally cloning large media objects can make the app unusable.
- Close `VideoFrame` and related frame/sample objects after use to avoid GPU or memory leaks.
- Respect backpressure in stream transforms. The current processor deliberately waits on queue sizes and downstream `desiredSize`.
- Keep large-file behavior in mind. Small outputs are returned as Blobs; larger outputs are written through a `FileSystemFileHandle`.
- The primary processor fetches `web-demuxer.wasm` from jsDelivr at runtime. Browser smoke tests need network access for that path unless the implementation changes.
- Browser support checks should fail gracefully through `showUnsupported` or worker `error` messages.

## Style

- TypeScript is intentionally loose right now (`strict: false`, `allowJs: true`). Do not tighten global compiler settings as part of unrelated changes.
- Existing code uses two-space indentation in worker/processor files and mixed historical formatting in `src/index.ts`; keep edits localized and consistent with nearby code.
- The UI combines Alpine, Bootstrap, Tailwind utility classes, and a vendored compare viewer. Prefer extending the existing pattern over introducing another UI framework.
- Keep static copy in `src/index.html` and stateful behavior in `src/index.ts`.

## Verification Checklist

For code changes, run:

1. `npm run type-check`
2. `npm run build`

For UI, browser capability, or processing changes, additionally run `npm run serve` and smoke test in Chrome or Edge:

1. Load the app.
2. Choose a small MP4 file.
3. Confirm the preview renders before/after canvases.
4. Switch network size/style if touched by the change.
5. Start processing, try pause/resume if touched, and confirm an output is saved or downloadable.

## Git Hygiene

- Do not commit generated `dist/` output unless the user specifically asks for it.
- Do not rewrite `package-lock.json` or `yarn.lock` unless dependency changes require it.
- Do not revert unrelated user changes in the working tree.
