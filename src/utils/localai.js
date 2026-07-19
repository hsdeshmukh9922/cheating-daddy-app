const { Ollama } = require('ollama');
const { getSystemPrompt } = require('./prompts');
const { getGroqApiKey } = require('../storage');
const { sendToRenderer, initializeNewSession, saveConversationTurn, dispatchToAnswerProvider } = require('./gemini');
const { pcmToWavBuffer, STREAM_UI_INTERVAL_MS, MAX_ANSWER_HISTORY_MESSAGES } = require('../audioUtils');
const { stripThinkingTags, streamChatCompletion } = require('./streamingClient');

// ── State ──

let ollamaClient = null;
let ollamaModel = null;
let localBackend = 'ollama'; // 'ollama' | 'lmstudio'
let localServerHost = null;
// 'local' = answers from the local model; 'cloud' = transcription stays on-device
// but answers come from Groq/Claude (no Gemini involved at all)
let localAnswerMode = 'local';

// Transcription engine: on-device Whisper worker, or Groq's hosted Whisper API
// (whisperModel pref set to 'groq-api'). Groq Whisper is much faster than
// running Whisper on a laptop and uses the same free Groq key as answers.
let useGroqWhisper = false;
const GROQ_TRANSCRIBE_MODEL = 'whisper-large-v3-turbo';

async function transcribeWithGroqWhisper(pcm16kBuffer) {
    const apiKey = getGroqApiKey();
    if (!apiKey || !apiKey.trim()) {
        console.error('[LocalAI] Groq Whisper selected but no Groq API key configured');
        sendToRenderer('update-status', 'Groq key required for Groq Whisper');
        return null;
    }

    try {
        const wav = pcmToWavBuffer(pcm16kBuffer, 16000, 1, 16);
        const form = new FormData();
        form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
        form.append('model', GROQ_TRANSCRIBE_MODEL);
        form.append('language', 'en');
        form.append('response_format', 'json');

        const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey.trim()}` },
            body: form,
            signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('[LocalAI] Groq Whisper error:', response.status, errorText.slice(0, 200));
            sendToRenderer('update-status', `Groq Whisper error: ${response.status}`);
            return null;
        }

        const json = await response.json();
        const text = (json.text || '').trim();
        if (text) console.log('[LocalAI] Groq Whisper transcription:', text);
        return text || null;
    } catch (error) {
        console.error('[LocalAI] Groq Whisper error:', error.message);
        sendToRenderer('update-status', 'Groq Whisper error: ' + error.message);
        return null;
    }
}
let isWhisperLoading = false;
let localConversationHistory = [];
let currentSystemPrompt = null;
let isLocalActive = false;

// VAD state
let isSpeaking = false;
let speechBuffers = [];
let speechBytes = 0;
let silenceFrameCount = 0;
let speechFrameCount = 0;

// Cap a speech segment at ~30s of 16kHz 16-bit audio. Whisper models only handle
// 30s windows, and letting a long segment accumulate unbounded makes transcription
// take so long the app appears hung.
const MAX_SPEECH_BYTES = 16000 * 2 * 30;

// Only one transcription at a time; keep at most the latest pending segment
let isTranscribing = false;
let pendingSpeechAudio = null;

// VAD configuration
const VAD_MODES = {
    NORMAL: { energyThreshold: 0.01, speechFramesRequired: 3, silenceFramesRequired: 30 },
    LOW_BITRATE: { energyThreshold: 0.008, speechFramesRequired: 4, silenceFramesRequired: 35 },
    AGGRESSIVE: { energyThreshold: 0.015, speechFramesRequired: 2, silenceFramesRequired: 20 },
    VERY_AGGRESSIVE: { energyThreshold: 0.02, speechFramesRequired: 2, silenceFramesRequired: 15 },
};
let vadConfig = VAD_MODES.VERY_AGGRESSIVE;

// Throttle streaming UI updates - imported from audioUtils to keep the value in sync with gemini.js

// Abort an Ollama generation if no token arrives for this long - a stalled request
// otherwise leaves the app stuck on "Generating response..." forever
const OLLAMA_STALL_TIMEOUT_MS = 60000;

function createStallWatchdog(abortFn) {
    let timer = null;
    return {
        reset() {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                console.error('[LocalAI] Local model stalled for', OLLAMA_STALL_TIMEOUT_MS / 1000, 's, aborting request');
                try {
                    abortFn();
                } catch (e) {
                    console.error('[LocalAI] Abort error:', e.message);
                }
            }, OLLAMA_STALL_TIMEOUT_MS);
        },
        clear() {
            if (timer) clearTimeout(timer);
            timer = null;
        },
    };
}

function abortOllama() {
    if (ollamaClient) ollamaClient.abort();
}

// List models available on a local server, for the model picker in the UI
async function listLocalModels(host, backend) {
    try {
        if (backend === 'lmstudio') {
            const res = await fetch(`${host}/v1/models`, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) return { success: false, error: `LM Studio returned ${res.status}` };
            const json = await res.json();
            return { success: true, models: (json.data || []).map(m => m.id) };
        }
        const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return { success: false, error: `Ollama returned ${res.status}` };
        const json = await res.json();
        return { success: true, models: (json.models || []).map(m => m.name) };
    } catch (error) {
        const label = backend === 'lmstudio' ? 'LM Studio (is the local server started?)' : 'Ollama (is it running?)';
        console.error('[LocalAI] Failed to list models:', error.message);
        return { success: false, error: `Cannot reach ${label}` };
    }
}

// Audio resampling buffer
let resampleRemainder = Buffer.alloc(0);

// ── Audio Resampling (24kHz → 16kHz) ──

function resample24kTo16k(inputBuffer) {
    // Combine with any leftover samples from previous call
    const combined = Buffer.concat([resampleRemainder, inputBuffer]);
    const inputSamples = Math.floor(combined.length / 2); // 16-bit = 2 bytes per sample
    // Ratio: 16000/24000 = 2/3, so for every 3 input samples we produce 2 output samples
    const outputSamples = Math.floor((inputSamples * 2) / 3);
    const outputBuffer = Buffer.alloc(outputSamples * 2);

    for (let i = 0; i < outputSamples; i++) {
        // Map output sample index to input position
        const srcPos = (i * 3) / 2;
        const srcIndex = Math.floor(srcPos);
        const frac = srcPos - srcIndex;

        const s0 = combined.readInt16LE(srcIndex * 2);
        const s1 = srcIndex + 1 < inputSamples ? combined.readInt16LE((srcIndex + 1) * 2) : s0;
        const interpolated = Math.round(s0 + frac * (s1 - s0));
        outputBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, interpolated)), i * 2);
    }

    // Store remainder for next call
    const consumedInputSamples = Math.ceil((outputSamples * 3) / 2);
    const remainderStart = consumedInputSamples * 2;
    resampleRemainder = remainderStart < combined.length ? combined.slice(remainderStart) : Buffer.alloc(0);

    return outputBuffer;
}

// ── VAD (Voice Activity Detection) ──

function calculateRMS(pcm16Buffer) {
    const samples = pcm16Buffer.length / 2;
    if (samples === 0) return 0;
    let sumSquares = 0;
    for (let i = 0; i < samples; i++) {
        const sample = pcm16Buffer.readInt16LE(i * 2) / 32768;
        sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / samples);
}

function processVAD(pcm16kBuffer) {
    const rms = calculateRMS(pcm16kBuffer);
    const isVoice = rms > vadConfig.energyThreshold;

    if (isVoice) {
        speechFrameCount++;
        silenceFrameCount = 0;

        if (!isSpeaking && speechFrameCount >= vadConfig.speechFramesRequired) {
            isSpeaking = true;
            speechBuffers = [];
            console.log('[LocalAI] Speech started (RMS:', rms.toFixed(4), ')');
            sendToRenderer('update-status', 'Listening... (speech detected)');
        }
    } else {
        silenceFrameCount++;
        speechFrameCount = 0;

        if (isSpeaking && silenceFrameCount >= vadConfig.silenceFramesRequired) {
            isSpeaking = false;
            console.log('[LocalAI] Speech ended, accumulated', speechBuffers.length, 'chunks');
            sendToRenderer('update-status', 'Transcribing...');
            flushSpeechSegment();
            return;
        }
    }

    // Accumulate audio during speech
    if (isSpeaking) {
        speechBuffers.push(Buffer.from(pcm16kBuffer));
        speechBytes += pcm16kBuffer.length;

        // Force a segment boundary on very long speech so transcription stays fast
        if (speechBytes >= MAX_SPEECH_BYTES) {
            console.log('[LocalAI] Max speech length reached, forcing transcription');
            sendToRenderer('update-status', 'Transcribing...');
            flushSpeechSegment();
        }
    }
}

function flushSpeechSegment() {
    if (speechBuffers.length === 0) return;
    const audioData = Buffer.concat(speechBuffers);
    speechBuffers = [];
    speechBytes = 0;
    handleSpeechEnd(audioData);
}

// ── Whisper Transcription (worker thread) ──
// Inference runs in a worker_threads Worker so the Electron main process (and
// with it the UI/IPC) never freezes during transcription.

let whisperWorker = null;
let whisperWorkerReady = false;
let whisperModelName = null;
let whisperCacheDir = null;
let transcribeSeq = 0;
const pendingTranscriptions = new Map(); // id -> { resolve, timer }
const TRANSCRIBE_TIMEOUT_MS = 120000;

function getWhisperWorkerPath() {
    const path = require('path');
    // worker_threads cannot load files from inside the asar archive; the packaged
    // build unpacks this file (see forge.config.js asar.unpack)
    return path.join(__dirname, 'whisperWorker.js').replace('app.asar', 'app.asar.unpacked');
}

function handleWorkerResult(msg) {
    const pending = pendingTranscriptions.get(msg.id);
    if (!pending) return;
    pendingTranscriptions.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.type === 'result') {
        pending.resolve(msg.text?.trim() || null);
    } else {
        console.error('[LocalAI] Worker transcription error:', msg.error);
        pending.resolve(null);
    }
}

function teardownWhisperWorker() {
    if (whisperWorker) {
        whisperWorker.removeAllListeners();
        whisperWorker.terminate().catch(() => {});
        whisperWorker = null;
    }
    whisperWorkerReady = false;
    for (const [id, pending] of pendingTranscriptions) {
        clearTimeout(pending.timer);
        pending.resolve(null);
        pendingTranscriptions.delete(id);
    }
}

// Runs after a Whisper worker failure (load-error / worker error / bad exit code).
// Clears the on-disk model cache in case the failure was a corrupted/incomplete
// download (e.g. "Protobuf parsing failed" - a truncated .onnx file, common on
// flaky or proxied networks), then repoints future sessions somewhere that will
// actually work instead of just retrying the same broken local download:
//   - Groq key present -> switch to Groq's cloud Whisper (no download, no native
//     ONNX runtime involved at all - sidesteps this whole class of failure)
//   - no Groq key -> fall back to the smallest local model, the least likely to
//     hit a partial-download failure again
// Without this, a corrupted download on an unstable connection becomes a crash
// loop: every retry re-downloads the same model over the same bad connection.
function recoverFromWhisperFailure(context) {
    teardownWhisperWorker();

    const fs = require('fs');
    const path = require('path');
    if (whisperCacheDir && whisperModelName) {
        const modelCachePath = path.join(whisperCacheDir, whisperModelName);
        if (fs.existsSync(modelCachePath)) {
            try {
                fs.rmSync(modelCachePath, { recursive: true, force: true });
                console.log(`[LocalAI] Cleared corrupted model cache (${context}) at: ${modelCachePath}`);
            } catch (rmError) {
                console.error(`[LocalAI] Failed to clear corrupted cache (${context}):`, rmError);
            }
        }
    }

    try {
        const storage = require('../storage');
        const fallbackModel = getGroqApiKey() && getGroqApiKey().trim() ? 'groq-api' : 'Xenova/whisper-small';
        storage.updatePreference('localByokWhisperModel', fallbackModel);
        storage.updatePreference('whisperModel', fallbackModel);
        console.log(`[LocalAI] Reset whisperModel preference to ${fallbackModel} (${context})`);
    } catch (prefError) {
        console.error(`[LocalAI] Failed to reset whisperModel preference (${context}):`, prefError);
    }
}

function loadWhisperPipeline(modelName) {
    if (whisperWorkerReady && whisperModelName === modelName) return Promise.resolve(true);
    if (isWhisperLoading) return Promise.resolve(null);

    isWhisperLoading = true;
    console.log('[LocalAI] Loading Whisper model in worker:', modelName);
    sendToRenderer('whisper-downloading', true);
    sendToRenderer('update-status', 'Loading Whisper model (first time may take a while)...');

    return new Promise(resolve => {
        try {
            const { Worker } = require('worker_threads');
            const { app } = require('electron');
            const path = require('path');

            // Switching models requires a fresh worker
            teardownWhisperWorker();

            whisperModelName = modelName;
            // Cache models outside the asar archive so ONNX runtime can load them
            whisperCacheDir = path.join(app.getPath('userData'), 'whisper-models');

            whisperWorker = new Worker(getWhisperWorkerPath());

            whisperWorker.on('message', msg => {
                if (msg.type === 'loaded') {
                    console.log('[LocalAI] Whisper model loaded successfully');
                    whisperWorkerReady = true;
                    isWhisperLoading = false;
                    sendToRenderer('whisper-downloading', false);
                    resolve(true);
                } else if (msg.type === 'load-error') {
                    console.error('[LocalAI] Failed to load Whisper model:', msg.error);
                    isWhisperLoading = false;
                    sendToRenderer('whisper-downloading', false);
                    sendToRenderer('update-status', 'Failed to load Whisper model: ' + msg.error);
                    recoverFromWhisperFailure('load-error');
                    resolve(null);
                } else {
                    handleWorkerResult(msg);
                }
            });

            whisperWorker.on('error', err => {
                console.error('[LocalAI] Whisper worker error:', err);
                isWhisperLoading = false;
                sendToRenderer('whisper-downloading', false);
                sendToRenderer('update-status', 'Whisper worker error: ' + err.message);
                recoverFromWhisperFailure('worker error');
                resolve(null);
            });

            whisperWorker.on('exit', code => {
                if (code !== 0) {
                    console.error('[LocalAI] Whisper worker exited with code', code);
                    isWhisperLoading = false;
                    sendToRenderer('whisper-downloading', false);
                    sendToRenderer(
                        'update-status',
                        'Whisper worker crashed (exit code ' + code + ') - this is usually a corrupted model download'
                    );
                    recoverFromWhisperFailure('exit code ' + code);
                    resolve(null);
                } else {
                    teardownWhisperWorker();
                }
            });

            whisperWorker.postMessage({ type: 'load', modelName, cacheDir: whisperCacheDir });
        } catch (error) {
            console.error('[LocalAI] Failed to start Whisper worker:', error);
            isWhisperLoading = false;
            sendToRenderer('whisper-downloading', false);
            sendToRenderer('update-status', 'Failed to start Whisper worker: ' + error.message);
            resolve(null);
        }
    });
}

function pcm16ToFloat32(pcm16Buffer) {
    const samples = pcm16Buffer.length / 2;
    const float32 = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
        float32[i] = pcm16Buffer.readInt16LE(i * 2) / 32768;
    }
    return float32;
}

function transcribeAudio(pcm16kBuffer) {
    if (!whisperWorker || !whisperWorkerReady) {
        console.error('[LocalAI] Whisper worker not ready');
        return Promise.resolve(null);
    }

    const float32Audio = pcm16ToFloat32(pcm16kBuffer);
    const id = ++transcribeSeq;

    return new Promise(resolve => {
        const timer = setTimeout(() => {
            console.error('[LocalAI] Transcription timed out after', TRANSCRIBE_TIMEOUT_MS / 1000, 's');
            pendingTranscriptions.delete(id);
            resolve(null);
        }, TRANSCRIBE_TIMEOUT_MS);

        pendingTranscriptions.set(id, { resolve, timer });

        whisperWorker.postMessage({ type: 'transcribe', id, audio: float32Audio, modelName: whisperModelName, cacheDir: whisperCacheDir }, [
            float32Audio.buffer,
        ]);
    }).then(text => {
        if (text) console.log('[LocalAI] Transcription:', text);
        return text;
    });
}

// ── Speech End Handler ──

async function handleSpeechEnd(audioData) {
    if (!isLocalActive) return;

    // Minimum audio length check (~0.5 seconds at 16kHz, 16-bit)
    if (audioData.length < 16000) {
        console.log('[LocalAI] Audio too short, skipping');
        sendToRenderer('update-status', 'Listening...');
        return;
    }

    // Serialize: a second segment arriving mid-transcription replaces any queued one
    // instead of running concurrently (overlapping Whisper runs stall the app)
    if (isTranscribing) {
        console.log('[LocalAI] Transcription busy, queueing latest segment');
        pendingSpeechAudio = audioData;
        return;
    }

    isTranscribing = true;
    try {
        const transcription = useGroqWhisper ? await transcribeWithGroqWhisper(audioData) : await transcribeAudio(audioData);

        if (!transcription || transcription.trim() === '' || transcription.trim().length < 2) {
            console.log('[LocalAI] Empty transcription, skipping');
            sendToRenderer('update-status', 'Listening...');
            return;
        }

        sendToRenderer('update-status', 'Generating response...');
        await sendToLocalModel(transcription);
    } finally {
        isTranscribing = false;
        if (pendingSpeechAudio && isLocalActive) {
            const queued = pendingSpeechAudio;
            pendingSpeechAudio = null;
            handleSpeechEnd(queued);
        } else {
            pendingSpeechAudio = null;
        }
    }
}

// ── Local Chat ──

// Route the transcription to the configured answer engine
async function sendToLocalModel(transcription) {
    if (localAnswerMode === 'cloud') {
        // Hybrid mode: on-device transcription, cloud answers (Claude > Groq > Gemma)
        return dispatchToAnswerProvider(transcription);
    }
    if (localBackend === 'lmstudio') {
        return sendToLmStudio(transcription);
    }
    return sendToOllama(transcription);
}

// LM Studio speaks the OpenAI-compatible API (default http://127.0.0.1:1234)
async function sendToLmStudio(transcription) {
    if (!localServerHost || !ollamaModel) {
        console.error('[LocalAI] LM Studio not configured');
        return;
    }

    console.log('[LocalAI] Sending to LM Studio:', transcription.substring(0, 100) + '...');

    localConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    if (localConversationHistory.length > MAX_ANSWER_HISTORY_MESSAGES) {
        localConversationHistory = localConversationHistory.slice(-MAX_ANSWER_HISTORY_MESSAGES);
    }

    const result = await streamChatCompletion({
        url: `${localServerHost}/v1/chat/completions`,
        headers: { 'Content-Type': 'application/json' },
        body: {
            model: ollamaModel,
            messages: [{ role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' }, ...localConversationHistory],
            stream: true,
        },
        onEmit: (text, isFirst) => sendToRenderer(isFirst ? 'new-response' : 'update-response', text),
    });

    if (!result.ok) {
        console.error('[LocalAI] LM Studio error:', result.status || '', result.error);
        sendToRenderer('update-status', result.status ? `LM Studio error: ${result.status}` : 'LM Studio error: ' + result.error);
        return;
    }

    const cleanedResponse = result.text;
    if (cleanedResponse) {
        localConversationHistory.push({
            role: 'assistant',
            content: cleanedResponse,
        });

        saveConversationTurn(transcription, cleanedResponse);
    }

    console.log('[LocalAI] LM Studio response completed');
    sendToRenderer('update-status', 'Listening...');
}

// Screenshot answers via LM Studio (OpenAI vision format; requires a vision-capable model)
async function sendLmStudioImage(base64Data, prompt) {
    try {
        console.log('[LocalAI] Sending image to LM Studio');
        sendToRenderer('update-status', 'Analyzing image...');

        // Store text-only version in history
        localConversationHistory.push({ role: 'user', content: prompt });
        if (localConversationHistory.length > MAX_ANSWER_HISTORY_MESSAGES) {
            localConversationHistory = localConversationHistory.slice(-MAX_ANSWER_HISTORY_MESSAGES);
        }

        const messages = [
            { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
            ...localConversationHistory.slice(0, -1),
            {
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Data}` } },
                ],
            },
        ];

        const controller = new AbortController();
        const watchdog = createStallWatchdog(() => controller.abort());
        let fullText = '';
        try {
            watchdog.reset();
            const response = await fetch(`${localServerHost}/v1/chat/completions`, {
                method: 'POST',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: ollamaModel, messages, stream: false }),
            });
            if (!response.ok) {
                const errorText = await response.text();
                return { success: false, error: `LM Studio ${response.status}: ${errorText.slice(0, 200)}` };
            }
            const json = await response.json();
            fullText = stripThinkingTags(json.choices?.[0]?.message?.content || '');
        } finally {
            watchdog.clear();
        }

        if (fullText) {
            sendToRenderer('new-response', fullText);
            localConversationHistory.push({ role: 'assistant', content: fullText });
            saveConversationTurn(prompt, fullText);
        }

        sendToRenderer('update-status', 'Listening...');
        return { success: true, text: fullText, model: ollamaModel };
    } catch (error) {
        console.error('[LocalAI] LM Studio image error:', error);
        sendToRenderer('update-status', 'LM Studio error: ' + error.message);
        return { success: false, error: error.message };
    }
}

// ── Ollama Chat ──

async function sendToOllama(transcription) {
    if (!ollamaClient || !ollamaModel) {
        console.error('[LocalAI] Ollama not configured');
        return;
    }
    // (routed here by sendToLocalModel when localBackend === 'ollama')

    console.log('[LocalAI] Sending to Ollama:', transcription.substring(0, 100) + '...');

    localConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    // Keep history manageable
    if (localConversationHistory.length > MAX_ANSWER_HISTORY_MESSAGES) {
        localConversationHistory = localConversationHistory.slice(-MAX_ANSWER_HISTORY_MESSAGES);
    }

    const watchdog = createStallWatchdog(abortOllama);
    try {
        const messages = [{ role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' }, ...localConversationHistory];

        watchdog.reset();
        const response = await ollamaClient.chat({
            model: ollamaModel,
            messages,
            stream: true,
        });

        let fullText = '';
        let isFirst = true;
        let lastEmit = 0;

        for await (const part of response) {
            watchdog.reset();
            const token = part.message?.content || '';
            if (token) {
                fullText += token;
                // Hide <think> reasoning from models like deepseek-r1 while streaming
                const displayText = stripThinkingTags(fullText);
                const now = Date.now();
                if (displayText && (isFirst || now - lastEmit >= STREAM_UI_INTERVAL_MS)) {
                    sendToRenderer(isFirst ? 'new-response' : 'update-response', displayText);
                    isFirst = false;
                    lastEmit = now;
                }
            }
        }

        const cleanedResponse = stripThinkingTags(fullText);

        // Flush the final text - the throttle above may have skipped the last tokens
        if (cleanedResponse) {
            sendToRenderer(isFirst ? 'new-response' : 'update-response', cleanedResponse);
        }

        if (cleanedResponse) {
            localConversationHistory.push({
                role: 'assistant',
                content: cleanedResponse,
            });

            saveConversationTurn(transcription, cleanedResponse);
        }

        console.log('[LocalAI] Ollama response completed');
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('[LocalAI] Ollama error:', error);
        sendToRenderer('update-status', 'Ollama error: ' + error.message);
    } finally {
        watchdog.clear();
    }
}

// ── Public API ──

async function initializeLocalSession(host, model, whisperModel, profile, customPrompt, backend = 'ollama', answerMode = 'local') {
    console.log('[LocalAI] Initializing local session:', { host, model, whisperModel, profile, backend, answerMode });

    sendToRenderer('session-initializing', true);

    try {
        // Setup system prompt (also shared with the cloud answer providers for hybrid mode)
        currentSystemPrompt = getSystemPrompt(profile, customPrompt, false);
        require('./gemini').setCurrentSystemPrompt(currentSystemPrompt);

        localBackend = backend;
        localServerHost = host;
        ollamaModel = model;
        localAnswerMode = answerMode;

        const storage = require('../storage');
        const prefs = storage.getPreferences();
        const activeVadMode = prefs.vadMode || 'VERY_AGGRESSIVE';
        vadConfig = VAD_MODES[activeVadMode] || VAD_MODES.VERY_AGGRESSIVE;
        console.log('[LocalAI] Configured VAD mode:', activeVadMode, vadConfig);

        // In hybrid (cloud-answer) mode the local model is only needed for screenshot
        // answers, so an unreachable server is a warning, not a failure.
        const serverOptional = answerMode === 'cloud';

        if (!host || !host.trim() || backend === 'byok') {
            ollamaClient = null;
            console.log('[LocalAI] No local server host provided (running in cloud-only mode)');
        } else if (backend === 'lmstudio') {
            ollamaClient = null;
            const check = await listLocalModels(host, 'lmstudio');
            if (!check.success) {
                console.error('[LocalAI] Cannot connect to LM Studio at', host, ':', check.error);
                if (!serverOptional) {
                    sendToRenderer('session-initializing', false);
                    sendToRenderer('update-status', 'Cannot connect to LM Studio at ' + host);
                    return false;
                }
                console.warn('[LocalAI] Continuing without LM Studio (cloud answers; screenshots unavailable)');
            } else {
                console.log('[LocalAI] LM Studio connection verified, models:', check.models.join(', '));
            }
        } else {
            // Initialize Ollama client
            ollamaClient = new Ollama({ host: host });

            // Test Ollama connection
            try {
                await ollamaClient.list();
                console.log('[LocalAI] Ollama connection verified');
            } catch (error) {
                console.error('[LocalAI] Cannot connect to Ollama at', host, ':', error.message);
                if (!serverOptional) {
                    sendToRenderer('session-initializing', false);
                    sendToRenderer('update-status', 'Cannot connect to Ollama at ' + host);
                    return false;
                }
                ollamaClient = null;
                console.warn('[LocalAI] Continuing without Ollama (cloud answers; screenshots unavailable)');
            }
        }

        useGroqWhisper = whisperModel === 'groq-api';

        if (!useGroqWhisper) {
            // Load Whisper model
            const pipeline = await loadWhisperPipeline(whisperModel);
            if (!pipeline) {
                sendToRenderer('session-initializing', false);
                return false;
            }
        } else {
            // Teardown local Whisper worker if running
            teardownWhisperWorker();
        }

        // Reset VAD state
        isSpeaking = false;
        speechBuffers = [];
        speechBytes = 0;
        silenceFrameCount = 0;
        speechFrameCount = 0;
        isTranscribing = false;
        pendingSpeechAudio = null;
        resampleRemainder = Buffer.alloc(0);
        localConversationHistory = [];

        // Initialize conversation session
        initializeNewSession(profile, customPrompt);

        isLocalActive = true;
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', 'Local AI ready - Listening...');

        console.log('[LocalAI] Session initialized successfully');
        return true;
    } catch (error) {
        console.error('[LocalAI] Initialization error:', error);
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', 'Local AI error: ' + error.message);
        return false;
    }
}

function processLocalAudio(monoChunk24k) {
    if (!isLocalActive) return;

    // Resample from 24kHz to 16kHz
    const pcm16k = resample24kTo16k(monoChunk24k);
    if (pcm16k.length > 0) {
        processVAD(pcm16k);
    }
}

function closeLocalSession() {
    console.log('[LocalAI] Closing local session');
    isLocalActive = false;
    isSpeaking = false;
    speechBuffers = [];
    speechBytes = 0;
    silenceFrameCount = 0;
    speechFrameCount = 0;
    isTranscribing = false;
    pendingSpeechAudio = null;
    resampleRemainder = Buffer.alloc(0);
    localConversationHistory = [];
    ollamaClient = null;
    ollamaModel = null;
    currentSystemPrompt = null;
    // Note: the Whisper worker is kept alive to avoid reloading the model on next session
}

function isLocalSessionActive() {
    return isLocalActive;
}

// ── Send text directly to Ollama (for manual text input) ──

async function sendLocalText(text) {
    if (!isLocalActive) {
        return { success: false, error: 'No active local session' };
    }

    try {
        await sendToLocalModel(text);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function runTesseractOcr(imageBuffer) {
    try {
        const { createWorker } = require('tesseract.js');
        console.log('[LocalAI] Running Tesseract OCR fallback...');
        const worker = await createWorker('eng');
        const {
            data: { text },
        } = await worker.recognize(imageBuffer);
        await worker.terminate();
        return text || '';
    } catch (err) {
        console.error('[LocalAI] Tesseract OCR error:', err);
        return '';
    }
}

async function runLocalOcr(base64Data) {
    const fs = require('fs');
    const path = require('path');
    const { execFile } = require('child_process');

    const tempDir = path.join(__dirname, '../assets');
    const tempFilePath = path.join(tempDir, `temp_ocr_${Date.now()}.jpg`);
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(tempFilePath, buffer);

    // 1. If macOS, attempt the native Vision framework binary first
    if (process.platform === 'darwin') {
        const ocrBinary = path.join(tempDir, 'macOSOCR');
        if (fs.existsSync(ocrBinary)) {
            return new Promise(resolve => {
                execFile(ocrBinary, [tempFilePath], (error, stdout, stderr) => {
                    try {
                        fs.unlinkSync(tempFilePath);
                    } catch (e) {}
                    if (error) {
                        console.error('[LocalAI] macOS native OCR binary failed, falling back to Tesseract.js:', error);
                        runTesseractOcr(buffer).then(resolve);
                    } else {
                        resolve(stdout || '');
                    }
                });
            });
        } else {
            // Swift binary is missing, check if swift is installed to compile
            const swiftFile = path.join(tempDir, 'macOSOCR.swift');
            if (fs.existsSync(swiftFile)) {
                console.log('[LocalAI] macOSOCR binary missing, compiling on-the-fly...');
                const { execSync } = require('child_process');
                try {
                    execSync(`swiftc -O "${swiftFile}" -o "${ocrBinary}"`);
                    return new Promise(resolve => {
                        execFile(ocrBinary, [tempFilePath], (error, stdout, stderr) => {
                            try {
                                fs.unlinkSync(tempFilePath);
                            } catch (e) {}
                            if (error) {
                                console.error('[LocalAI] Compiled macOS OCR failed, falling back to Tesseract.js:', error);
                                runTesseractOcr(buffer).then(resolve);
                            } else {
                                resolve(stdout || '');
                            }
                        });
                    });
                } catch (compileErr) {
                    console.warn('[LocalAI] macOS OCR compile failed, falling back to Tesseract.js:', compileErr.message);
                }
            }
        }
    }

    // 2. Non-macOS (Windows/Linux) or fallback -> use Tesseract.js
    try {
        const text = await runTesseractOcr(buffer);
        try {
            fs.unlinkSync(tempFilePath);
        } catch (e) {}
        return text;
    } catch (err) {
        console.error('[LocalAI] OCR failed entirely:', err);
        try {
            fs.unlinkSync(tempFilePath);
        } catch (e) {}
        return '';
    }
}

async function sendLocalImage(base64Data, prompt) {
    if (!isLocalActive) {
        return { success: false, error: 'No active local session' };
    }

    if (localAnswerMode === 'local' && localBackend === 'ollama' && !ollamaClient) {
        return { success: false, error: 'Ollama client not initialized' };
    }

    if (localAnswerMode === 'cloud') {
        try {
            console.log('[LocalAI] Performing local OCR for cloud answer provider');
            sendToRenderer('update-status', 'Running OCR on screen...');

            const ocrText = await runLocalOcr(base64Data);
            if (!ocrText || !ocrText.trim()) {
                return { success: false, error: 'No text detected on the screen' };
            }

            console.log(`[LocalAI] OCR completed. Extracted ${ocrText.length} characters.`);
            sendToRenderer('update-status', 'Analyzing screen content...');

            const ocrPrompt = `[SCREEN OCR TEXT]:\n${ocrText}\n\n[INSTRUCTION]:\n${prompt}`;

            const gemini = require('./gemini');
            gemini.dispatchToAnswerProvider(ocrPrompt);

            return { success: true, text: 'Sent screen OCR content to cloud model', model: 'local-ocr + cloud' };
        } catch (error) {
            console.error('[LocalAI] OCR cloud dispatch error:', error);
            sendToRenderer('update-status', 'OCR Error: ' + error.message);
            return { success: false, error: error.message };
        }
    }

    // Check if local model supports vision natively
    const isVisionModel =
        ollamaModel &&
        (ollamaModel.toLowerCase().includes('vision') ||
            ollamaModel.toLowerCase().includes('llava') ||
            ollamaModel.toLowerCase().includes('bakllava'));

    if (isVisionModel) {
        if (localBackend === 'lmstudio') {
            return sendLmStudioImage(base64Data, prompt);
        }

        try {
            console.log('[LocalAI] Sending image to Ollama');
            sendToRenderer('update-status', 'Analyzing image...');

            const userMessage = {
                role: 'user',
                content: prompt,
                images: [base64Data],
            };

            // Store text-only version in history
            localConversationHistory.push({ role: 'user', content: prompt });

            if (localConversationHistory.length > MAX_ANSWER_HISTORY_MESSAGES) {
                localConversationHistory = localConversationHistory.slice(-MAX_ANSWER_HISTORY_MESSAGES);
            }

            const messages = [
                { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
                ...localConversationHistory.slice(0, -1),
                userMessage,
            ];

            const watchdog = createStallWatchdog();
            let fullText = '';
            try {
                watchdog.reset();
                const response = await ollamaClient.chat({
                    model: ollamaModel,
                    messages,
                    stream: true,
                });

                let isFirst = true;
                let lastEmit = 0;

                for await (const part of response) {
                    watchdog.reset();
                    const token = part.message?.content || '';
                    if (token) {
                        fullText += token;
                        const now = Date.now();
                        if (isFirst || now - lastEmit >= STREAM_UI_INTERVAL_MS) {
                            sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                            isFirst = false;
                            lastEmit = now;
                        }
                    }
                }

                // Flush the final text
                if (fullText) {
                    sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                }
            } finally {
                watchdog.clear();
            }

            if (fullText.trim()) {
                localConversationHistory.push({ role: 'assistant', content: fullText.trim() });
                saveConversationTurn(prompt, fullText);
            }

            console.log('[LocalAI] Image response completed');
            sendToRenderer('update-status', 'Listening...');
            return { success: true, text: fullText, model: ollamaModel };
        } catch (error) {
            console.error('[LocalAI] Image error:', error);
            sendToRenderer('update-status', 'Ollama error: ' + error.message);
            return { success: false, error: error.message };
        }
    } else {
        // Text-only local model -> run local OCR first
        try {
            console.log('[LocalAI] Performing local OCR for text-only local model');
            sendToRenderer('update-status', 'Running OCR on screen...');

            const ocrText = await runLocalOcr(base64Data);
            if (!ocrText || !ocrText.trim()) {
                return { success: false, error: 'No text detected on the screen' };
            }

            console.log(`[LocalAI] OCR completed. Extracted ${ocrText.length} characters.`);
            sendToRenderer('update-status', 'Analyzing screen content...');

            const ocrPrompt = `[SCREEN OCR TEXT]:\n${ocrText}\n\n[INSTRUCTION]:\n${prompt}`;

            await sendLocalText(ocrPrompt);
            return { success: true, text: 'OCR completed', model: ollamaModel };
        } catch (error) {
            console.error('[LocalAI] OCR local model error:', error);
            sendToRenderer('update-status', 'OCR Error: ' + error.message);
            return { success: false, error: error.message };
        }
    }
}

function updateActiveProfile(profile) {
    const storage = require('../storage');
    const prefs = storage.getPreferences();
    const customPrompt = prefs.customPrompt || '';
    currentSystemPrompt = getSystemPrompt(profile, customPrompt, false);
}

function getLocalAnswerMode() {
    return localAnswerMode;
}

module.exports = {
    initializeLocalSession,
    processLocalAudio,
    closeLocalSession,
    isLocalSessionActive,
    sendLocalText,
    sendLocalImage,
    listLocalModels,
    updateActiveProfile,
    getLocalAnswerMode,
    // Exposed for unit tests only
    _internals: {
        resample24kTo16k,
        calculateRMS,
        processVAD,
        pcm16ToFloat32,
        pcm16ToWav: pcmToWavBuffer, // alias – now lives in audioUtils
        VAD_MODES,
        getVadState: () => ({ isSpeaking, speechChunks: speechBuffers.length, speechBytes }),
        resetVadState: () => {
            isSpeaking = false;
            speechBuffers = [];
            speechBytes = 0;
            silenceFrameCount = 0;
            speechFrameCount = 0;
            isTranscribing = false;
            pendingSpeechAudio = null;
            resampleRemainder = Buffer.alloc(0);
        },
    },
};
