# Production TODO — target: launch next week

Mark items with [x] when done. Items marked (USER) need Yashwant; the rest Claude can do.

## Done this week

- [x] Fix answer latency: dispatch transcription to Groq/Gemma on 1s silence instead of waiting for Gemini's discarded audio generation (gemini.js)
- [x] Throttle streaming UI updates to 80ms in all providers (Groq, Gemma, screenshot, Ollama) — was O(n^2) markdown re-render per token
- [x] Smart click-through: opt-in via Cmd+M/Ctrl+M (auto-enable on live mode was reverted — it made the window unmovable on macOS); while enabled, hovering controls re-enables interaction where the platform supports it (window.js, renderer.js)
- [x] Live mode transparency: overlay background alpha capped at 0.4 in live view so the meeting/editor behind stays visible; window movable by dragging the live top bar or Alt/Ctrl+arrows (CheatingDaddyApp.js)
- [x] Local mode hang guards: 30s speech segment cap, Whisper chunk_length_s, serialized transcription queue, 60s Ollama stall watchdog (localai.js)
- [x] Hide in-progress <think> reasoning while streaming (gemini.js)
- [x] Test infrastructure: `npm test` with node:test, 28 unit tests covering resampling, VAD, RMS, history trimming, think-tag stripping

- [x] Claude added as an answer provider (Home page key field; priority Claude > Groq > Gemma); local mode now supports LM Studio alongside Ollama with a fetched model dropdown + manual entry (MainView, localai.js, gemini.js, renderer.js, storage.js)

- [x] Hybrid mode: local Whisper transcription + cloud answers (Groq/Claude) with zero Gemini usage — "Answer Engine" selector in local mode; screenshot 404 fixed (gemini-3.1-flash)

## In progress / up next

- [ ] 1. (USER) Live smoke test of ALL fixes: BYOK session (answer ~1s after speech ends, console shows "text-only output"), local session (no hang, UI stays responsive while transcribing), click-through onto another app, Cmd+M toggle, reconnect, screenshot answer, API keys still load after restart (now encrypted)
- [x] 2. Production packaging: appBundleId + mic/audio Info.plist usage descriptions added; `npm run package` verified — SystemAudioDump in Resources, natives + whisperWorker.js unpacked from asar
- [ ] 3. (USER assist) macOS code signing + notarization — ready in forge.config.js, activates when APPLE_SIGNING_IDENTITY / APPLE_ID / APPLE_ID_PASSWORD / APPLE_TEAM_ID env vars are set
- [x] 4. Whisper moved to a worker_threads worker (src/utils/whisperWorker.js) — main process/UI never blocks; 120s per-transcription timeout; worker kept alive between sessions — VERIFY in live local session
- [x] 5. Gemini live session now requests text-only output (no more discarded audio generation); auto-falls back to the old audio config if the API rejects it — VERIFY in live BYOK session
- [x] 6. Groq stall watchdog: 30s no-token abort via AbortController (gemini.js)
- [x] 7. API keys encrypted at rest with safeStorage ('enc:v1:' format); plaintext keys from old versions migrate automatically on startup (storage.js, index.js)
- [x] 8. Dead auto-screenshot code path removed (renderer.js)
- [ ] 9. Docs: README/help text for click-through behavior, local Gemma setup, key setup

## Post-launch

- [ ] Enable contextIsolation + preload bridge (window.js TODO) — invasive, touches every renderer require; do right after launch, not before
- [ ] Auto-update story (electron-forge publisher / update server)
- [ ] Linux click-through caveat: setIgnoreMouseEvents forward:true unsupported — document or add Linux-specific fallback
