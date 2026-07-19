# Next-Phase Backlog

Post-launch improvement ideas, tracked separately from [TODO.md](TODO.md) (the
launch-critical punch list). Nothing here blocks shipping — pick items up
whenever there's time. Mark `[x]` when done; add new ideas as they come up.

## Answer quality

- [x] Extend the question-type-aware system prompt (Coding/DSA, System design,
      Behavioral, Conceptual, About-you) to sales, meeting, presentation, and
      negotiation profiles — each got its own domain-appropriate question types
      (e.g. sales: Objection/Product/Pricing/Competitive/Closing).
- [x] Bring the screenshot-answer prompt (`MANUAL_SCREENSHOT_PROMPT` in
      `renderer.js`) up to the same format-routing system as the live voice
      prompt (Coding/DSA, MCQ, general, debugging).
- [ ] (USER) Live-test the new prompts across a real coding question, a
      behavioral question, and a system-design question in one session —
      confirm formatting lands as specified.
- [x] Retired `trimConversationHistoryForGemma`'s oversized 42,000-char default
      down to 16,000 (a safety net, not the primary limit — history is capped
      upstream by `MAX_ANSWER_HISTORY_MESSAGES` before this ever runs).

## Reliability & performance

- [x] Consolidated the duplicated SSE-parsing + stall-watchdog logic across
      `sendToGroq` / `sendToOpenAI` / `sendToLmStudio` into one shared
      `streamChatCompletion()` helper (`src/utils/streamingClient.js`). Also
      moved `stripThinkingTags` there so it has one home instead of two
      copies. Verified with a mocked-fetch smoke test (success + error paths).
- [x] Auto-fallback on rate limit / failure: if the active answer provider
      fails with **no output ever shown to the user**, `dispatchToAnswerProvider`
      silently retries the next configured+enabled provider instead of just
      erroring out. Once any text has streamed to the UI, fallback is disabled
      for that turn (never stacks a second unrelated answer under a partial
      one). Verified end-to-end with mocked network calls: (1) Groq 429 →
      OpenAI succeeds, exactly one clean history entry, no duplicates; (2)
      Groq streams partial text then drops → fallback correctly suppressed.
- [x] Fixed a real Windows crash: a corrupted/incomplete Whisper model
      download (`Protobuf parsing failed` — a truncated `.onnx` file, common on
      unstable/proxied networks or AV interference) was being "recovered" by
      clearing the cache and retrying **another local model over the same
      broken connection** — an effective crash loop. Recovery now switches to
      Groq's cloud Whisper automatically when a Groq key is configured,
      sidestepping local model downloads entirely. Also fixed the `exit`
      handler to always clear the "loading" UI state — previously a worker
      that died before sending any message (e.g. a native-level crash) left
      the UI stuck on "Loading Whisper model..." forever, which read as a hang
      even when the app hadn't technically frozen.
- [ ] Investigate GPU/acceleration options for the local Whisper worker on
      Windows/Linux (currently forced `dtype: 'q8', device: 'cpu'` for
      stability — see `whisperWorker.js`). macOS users get by fine on CPU;
      worth revisiting once there's a Windows/Linux tester.

## Security & platform

- [ ] Enable `contextIsolation` + a preload bridge (`window.js` TODO) — touches
      every `require('electron')` call in the renderer, deliberately deferred
      from launch given the size of the change.
- [ ] Auto-update story (electron-forge publisher / update server). Repo has a
      real GitHub remote (`yashwantdhakad/cheating-daddy-app`) so a GitHub
      Releases-based publisher is viable whenever this gets picked up.
- [x] Linux click-through caveat documented in README: `setIgnoreMouseEvents`
      forward mode isn't reliably supported there; ghost mode may stay
      click-through with no in-app way back until the keyboard shortcut is
      used. No code fallback implemented yet — pure documentation for now.

## Docs & onboarding

- [x] README sections added: Local AI setup (Ollama + LM Studio, including the
      "you must start LM Studio's *server*, not just load the model" gotcha),
      Ghost Mode explained, Hybrid mode explained, and a Troubleshooting
      section covering the Windows Whisper corruption issue.
- [x] Fixed a stale/actively-wrong doc: the old "Environment Variables"
      section documented `ACTIVE_ANSWER_PROVIDER` / `ENABLED_PROVIDERS` /
      `GROQ_MODEL` / `OPENAI_MODEL` as `.env` overrides — that mechanism was
      removed earlier (it silently clobbered the UI's provider selection on
      every restart). README now correctly states `.env` is credentials-only.

## Testing

- [x] `test/prompts.test.js` added: asserts every profile's question-type
      headers are present in its assembled system prompt (catches a future
      edit silently dropping one), verifies the exam Q&A structure, the
      unknown-profile fallback, context interpolation, and the
      search-usage-section toggle. 11 new assertions, all passing.
- [ ] Test coverage for `MAX_ANSWER_HISTORY_MESSAGES` trimming behavior shared
      across providers (currently only Gemma's char-budget trimming has a
      test; the message-count trimming used by Groq/OpenAI/Claude/local paths
      does not, though it's now exercised indirectly by the fallback smoke
      tests run manually this session).
