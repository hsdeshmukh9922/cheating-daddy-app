<img width="1299" height="424" alt="cd (1)" src="https://github.com/user-attachments/assets/b25fff4d-043d-4f38-9985-f832ae0d0f6e" />

## Recall.ai - API for desktop recording

If you’re looking for a hosted desktop recording API, consider checking out [Recall.ai](https://www.recall.ai/product/desktop-recording-sdk/?utm_source=github&utm_medium=sponsorship&utm_campaign=sohzm-cheating-daddy), an API that records Zoom, Google Meet, Microsoft Teams, in-person meetings, and more.

This project is sponsored by Recall.ai.

---

> [!NOTE]  
> Use latest MacOS and Windows version, older versions have limited support

> [!NOTE]  
> During testing it wont answer if you ask something, you need to simulate interviewer asking question, which it will answer

A real-time AI assistant that provides contextual help during video calls, interviews, presentations, and meetings using screen capture and audio analysis.

## Features

- **On-Device Whisper Transcription**: Transcribe audio 100% locally and privately (no API costs, no third-party transcription endpoints). Supports different model sizes (Tiny/Base/Small/Medium).
- **Multiple AI Providers (BYOK)**: Supports Anthropic Claude, OpenAI ChatGPT, Google Gemini, and Groq Cloud for answering questions. Simple selection card interface.
- **Screen & Audio Capture**: Analyzes what you see and hear for contextual responses.
- **Multiple Profiles**: Interview, Sales Call, Business Meeting, Presentation, Negotiation.
- **Transparent Overlay**: Always-on-top window that can be positioned anywhere.
- **Click-through Mode (Ghost Mode)**: Make window transparent to clicks when needed.
- **Panic Hide**: Fully hide the window from the dock, taskbar, Mission Control, Alt+Tab, and Task Manager processes with a single keybind.
- **Emergency Erase**: Clear all overlay text instantly.

## Setup

1. **Install Dependencies**: `npm install`
2. **Run the App**: `npm start`
3. **Choose Mode**:
    - **BYOK (Bring Your Own Keys)**: Choose your active provider (Groq, Claude, OpenAI, or Gemini), enter the API key, and configure model options. Audio is transcribed 100% locally using Whisper.
    - **Local AI**: Connect to a local Ollama or LM Studio instance for fully offline/private processing.

## Configuration & Environment Variables

Copy `.env.example` to `.env` in the project root to pre-load API keys for local
development:

- **`GEMINI_API_KEY`**, **`GROQ_API_KEY`**, **`ANTHROPIC_API_KEY`**, **`OPENAI_API_KEY`**: loaded at startup and take priority over a key typed into the app UI.

**`.env` is credentials-only, by design.** Which provider/model actually answers
your questions is controlled entirely by the select fields in Settings, and is
saved to `preferences.json`, not `.env`. Earlier versions let `.env` also set
`ACTIVE_ANSWER_PROVIDER` / `ENABLED_PROVIDERS` / `GROQ_MODEL` / `OPENAI_MODEL` —
that was removed because it silently overwrote your UI selection on every
restart (pick OpenAI in Settings, quit and relaunch, and it would silently
revert to whatever `.env` said). If you're editing this codebase, don't
reintroduce env-var overrides for *behavior* — only for *credentials*.

## Local AI Setup (Ollama / LM Studio)

Local mode runs everything on your machine — no API keys, no per-request cost,
fully offline. In Settings, choose **Local AI** and pick a backend:

- **Ollama**: install from [ollama.com](https://ollama.com), then `ollama pull <model>` (e.g. `gemma3:4b`, `llama3.1`). Point the app at `http://127.0.0.1:11434` (default) — the model dropdown refreshes live from whatever you have pulled.
- **LM Studio**: load a model in LM Studio, then **start its local server** (Developer tab → Start Server). The model in LM Studio's chat window being "loaded" is not enough — the *server* has to be running for this app to reach it, or you'll see "Cannot reach LM Studio (is the local server started?)". Default URL: `http://127.0.0.1:1234`.

**Hybrid mode** (Answer Engine → "Groq / Claude API" while in Local AI mode):
transcription still runs 100% on-device via Whisper, but answers are generated
by your configured Groq/Claude/OpenAI key instead of the local model. Use this
when local model generation feels too slow but you still want private,
on-device transcription with no Gemini involved at all.

## Ghost Mode (Click-through)

Press `Cmd+M` / `Ctrl+M` to toggle the overlay between two states:

- **Off (default)**: the window is a normal window — drag it by the top bar, click buttons, type in the input box.
- **On**: every click and keystroke passes straight through to whatever is behind the overlay (Zoom, your notes, a browser). The overlay becomes read-only — use it to glance at an answer while typing somewhere else. Press the shortcut again to get interaction back.

**Linux:** click-through relies on `setIgnoreMouseEvents(true, { forward: true })`,
which is not reliably supported on Linux window managers. On Linux, ghost mode
may leave the overlay fully click-through with no way to interact until you
toggle it off again via the keyboard shortcut — there is currently no
Linux-specific fallback. macOS and Windows are unaffected.

## Troubleshooting

**"Protobuf parsing failed" / Whisper worker crashes on Windows**: this means
the local Whisper model file downloaded corrupted or incomplete — common on
unstable or corporate-proxied connections, or when antivirus software
interferes with the download mid-write. This is an environment issue, not a
platform bug (the same code runs identically on macOS/Windows/Linux — it just
depends on the download completing intact). The app auto-recovers: it clears
the corrupted cache and, if you have a Groq key configured, automatically
switches transcription to Groq's cloud Whisper (no local download involved at
all) so the next session works without you doing anything. If you don't have a
Groq key yet, get a free one at [console.groq.com/keys](https://console.groq.com/keys),
or manually delete the `whisper-models` folder shown in the error log and
retry on a more stable connection.

## Keyboard Shortcuts

The app supports custom global shortcuts (configurable in Settings → Shortcuts). Defaults are:

- **Hide / Show Window**: `Cmd+Shift+H` (macOS) / `Ctrl+Shift+H` (Windows) - Fully hide the window from taskbar and task managers. Press again to restore.
- **Toggle Visibility**: `Cmd+\` (macOS) / `Ctrl+\` (Windows) - Show or hide the window.
- **Click-through (Ghost Mode)**: `Cmd+M` (macOS) / `Ctrl+M` (Windows) - Toggle mouse event pass-through.
- **Emergency Erase**: `Cmd+Shift+E` (macOS) / `Ctrl+Shift+E` (Windows) - Wipe all AI content on screen instantly.
- **Ask Next Step**: `Cmd+Enter` (macOS) / `Ctrl+Enter` (Windows) - Take screenshot and query the model for the next step.
- **Window Movement**: `Alt + Arrow Keys` (macOS) / `Ctrl + Arrow Keys` (Windows) - Shift the overlay window position.
- **Scroll AI Responses**: `Cmd+Shift+Up/Down` (macOS) / `Ctrl+Shift+Up/Down` (Windows) - Scroll content in ghost mode.
- **Switch Responses**: `Cmd+[` / `Cmd+]` (macOS) - Cycle through response history.

## Audio Capture

- **macOS**: SystemAudioDump for system audio capture
- **Windows**: Loopback WASAPI audio capture
- **Linux**: Microphone input

## Requirements

- Electron-compatible OS (macOS, Windows, Linux)
- An active API key (Groq, Claude, OpenAI, or Gemini) or a running local inference server (Ollama/LM Studio)
- Screen recording permissions
- Microphone/audio permissions
