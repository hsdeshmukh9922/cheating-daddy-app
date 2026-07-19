const { GoogleGenAI, Modality } = require('@google/genai');
const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const { saveDebugAudio, STREAM_UI_INTERVAL_MS, MAX_ANSWER_HISTORY_MESSAGES } = require('../audioUtils');
const { stripThinkingTags, streamChatCompletion } = require('./streamingClient');
const { getSystemPrompt } = require('./prompts');
const {
    getAvailableModel,
    incrementLimitCount,
    getApiKey,
    getGroqApiKey,
    getOpenaiApiKey,
    incrementCharUsage,
    getModelForToday,
    getCredentials,
    getPreferences,
} = require('../storage');
const { connectCloud, sendCloudAudio, sendCloudText, sendCloudImage, closeCloud, isCloudActive, setOnTurnComplete } = require('./cloud');

// Lazy-loaded to avoid circular dependency (localai.js imports from gemini.js)
let _localai = null;
function getLocalAi() {
    if (!_localai) _localai = require('./localai');
    return _localai;
}

// Provider mode: 'byok', 'cloud', or 'local'
let currentProviderMode = 'byok';

// Groq conversation history for context
let groqConversationHistory = [];

// Conversation tracking variables
let currentSessionId = null;
let currentTranscription = '';
let conversationHistory = [];
let screenAnalysisHistory = [];
let currentProfile = null;
let currentCustomPrompt = null;
let isInitializingSession = false;
let currentSystemPrompt = null;

function formatSpeakerResults(results) {
    let text = '';
    for (const result of results) {
        if (result.transcript && result.speakerId) {
            const speakerLabel = result.speakerId === 1 ? 'Interviewer' : 'Candidate';
            text += `[${speakerLabel}]: ${result.transcript}\n`;
        }
    }
    return text;
}

module.exports.formatSpeakerResults = formatSpeakerResults;

// Audio capture variables
let systemAudioProc = null;
let messageBuffer = '';

// Dispatch transcription to Groq/Gemma as soon as the speaker pauses,
// instead of waiting for Gemini Live to finish generating its (unused) audio reply
let transcriptionDebounceTimer = null;
const TRANSCRIPTION_SILENCE_MS = 1000;

// Throttle streaming UI updates - defined in audioUtils.js so gemini.js and localai.js share one value

// Abort a Groq request if no token arrives for this long - a stalled stream
// otherwise leaves the app stuck without an answer for the whole turn
const GROQ_STALL_TIMEOUT_MS = 30000;

// Reused HTTP client (per API key) so each request doesn't rebuild the SDK client
let cachedHttpClient = null;
let cachedHttpClientKey = null;
function getHttpClient(apiKey) {
    if (!cachedHttpClient || cachedHttpClientKey !== apiKey) {
        cachedHttpClient = new GoogleGenAI({ apiKey: apiKey });
        cachedHttpClientKey = apiKey;
    }
    return cachedHttpClient;
}

function dispatchTranscription() {
    if (transcriptionDebounceTimer) {
        clearTimeout(transcriptionDebounceTimer);
        transcriptionDebounceTimer = null;
    }
    const text = currentTranscription.trim();
    if (text === '') return;
    currentTranscription = '';
    dispatchToAnswerProvider(text);
}

// Route transcription to the configured active model provider, with fallback to others.
// getPreferences() is a synchronous fs.readFileSync call — safe to call inline here.
// Function declarations below are hoisted, so referencing them here (before their
// textual definition) is safe - this map is only ever read once dispatch actually runs.
const ANSWER_PROVIDER_SENDERS = { groq: sendToGroq, openai: sendToOpenAI, claude: sendToClaude, gemini: sendToGemma };
const PROVIDER_KEY_CHECKS = { groq: hasGroqKey, openai: hasOpenaiKey, claude: hasAnthropicKey, gemini: () => !!getApiKey() };
const PROVIDER_LABELS = { groq: 'Groq', openai: 'OpenAI', claude: 'Claude', gemini: 'Gemini' };

function normalizeActiveProvider(prefs) {
    let activeProvider = prefs.activeAnswerProvider || 'groq';
    // Handle invalid saved values like 'groq,openai' gracefully
    if (activeProvider.includes(',')) {
        activeProvider = activeProvider.split(',')[0].trim();
    }
    if (!PROVIDER_LABELS[activeProvider]) {
        activeProvider = 'groq';
    }
    return activeProvider;
}

// Answers the current question, trying the active provider first and silently
// falling back to other configured-and-enabled providers on failure - as long
// as the failed attempt never showed the user any text (see `hadOutput` on each
// sender's return value). All providers share `groqConversationHistory`, so a
// failed attempt's history push is rolled back before the next one is tried,
// preventing a duplicate user-message entry.
async function dispatchToAnswerProvider(text) {
    const prefs = getPreferences();
    const activeProvider = normalizeActiveProvider(prefs);

    const enabledRaw = prefs.enabledProviders || 'groq,openai';
    const enabled = enabledRaw
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(s => PROVIDER_LABELS[s]);

    // Active provider first, then other enabled providers that actually have a
    // key configured (a provider with no key can't be retried, so skip it here
    // rather than surfacing a confusing mid-chain "no key" error).
    const candidates = [activeProvider, ...enabled.filter(p => p !== activeProvider)].filter(p => PROVIDER_KEY_CHECKS[p]());

    if (candidates.length === 0) {
        sendToRenderer(
            'new-response',
            `⚠️ ${PROVIDER_LABELS[activeProvider]} Error: No API key configured. Please enter your ${PROVIDER_LABELS[activeProvider]} API key in Settings.`
        );
        sendToRenderer('update-status', `${PROVIDER_LABELS[activeProvider]} error: missing API key`);
        return;
    }

    for (let i = 0; i < candidates.length; i++) {
        const provider = candidates[i];
        const isLast = i === candidates.length - 1;
        const historyLengthBeforeAttempt = groqConversationHistory.length;

        const result = await ANSWER_PROVIDER_SENDERS[provider](text, { silent: !isLast });

        if (!result || result.ok) return; // success, or a sender with no status contract (assume handled)

        // Roll back this attempt's own history push (each sender pushes the user
        // message before its network call) so the next attempt doesn't duplicate it.
        if (groqConversationHistory.length > historyLengthBeforeAttempt) {
            groqConversationHistory = groqConversationHistory.slice(0, historyLengthBeforeAttempt);
        }

        if (isLast) return; // last candidate already rendered its own error (silent: false)

        if (result.hadOutput) {
            // Partial text already reached the UI - falling back now would show a
            // second, unrelated answer stacked under a half-finished one. Stop here.
            return;
        }

        console.log(`[Dispatch] ${PROVIDER_LABELS[provider]} failed with no output shown, falling back to ${PROVIDER_LABELS[candidates[i + 1]]}...`);
    }
}

function scheduleTranscriptionDispatch() {
    if (transcriptionDebounceTimer) clearTimeout(transcriptionDebounceTimer);
    transcriptionDebounceTimer = setTimeout(dispatchTranscription, TRANSCRIPTION_SILENCE_MS);
}

// Reconnection variables
let isUserClosing = false;
let sessionParams = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY = 2000;

function sendToRenderer(channel, data) {
    if (!BrowserWindow) return; // not running under Electron (unit tests)
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}

// Build context message for session restoration
function buildContextMessage() {
    const lastTurns = conversationHistory.slice(-20);
    const validTurns = lastTurns.filter(turn => turn.transcription?.trim() && turn.ai_response?.trim());

    if (validTurns.length === 0) return null;

    const contextLines = validTurns.map(turn => `[Interviewer]: ${turn.transcription.trim()}\n[Your answer]: ${turn.ai_response.trim()}`);

    return `Session reconnected. Here's the conversation so far:\n\n${contextLines.join('\n\n')}\n\nContinue from here.`;
}

// Conversation management functions
function initializeNewSession(profile = null, customPrompt = null) {
    currentSessionId = Date.now().toString();
    currentTranscription = '';
    conversationHistory = [];
    screenAnalysisHistory = [];
    groqConversationHistory = [];
    currentProfile = profile;
    currentCustomPrompt = customPrompt;
    console.log('New conversation session started:', currentSessionId, 'profile:', profile);

    // Save initial session with profile context
    if (profile) {
        sendToRenderer('save-session-context', {
            sessionId: currentSessionId,
            profile: profile,
            customPrompt: customPrompt || '',
        });
    }
}

function saveConversationTurn(transcription, aiResponse) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const conversationTurn = {
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: aiResponse.trim(),
    };

    conversationHistory.push(conversationTurn);
    console.log('Saved conversation turn:', conversationTurn);

    // Send to renderer to save in IndexedDB
    sendToRenderer('save-conversation-turn', {
        sessionId: currentSessionId,
        turn: conversationTurn,
        fullHistory: conversationHistory,
    });
}

function saveScreenAnalysis(prompt, response, model) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const analysisEntry = {
        timestamp: Date.now(),
        prompt: prompt,
        response: response.trim(),
        model: model,
    };

    screenAnalysisHistory.push(analysisEntry);
    console.log('Saved screen analysis:', analysisEntry);

    // Send to renderer to save
    sendToRenderer('save-screen-analysis', {
        sessionId: currentSessionId,
        analysis: analysisEntry,
        fullHistory: screenAnalysisHistory,
        profile: currentProfile,
        customPrompt: currentCustomPrompt,
    });
}

function getCurrentSessionData() {
    return {
        sessionId: currentSessionId,
        history: conversationHistory,
    };
}

async function getEnabledTools() {
    const tools = [];

    // Check if Google Search is enabled (default: true)
    const googleSearchEnabled = await getStoredSetting('googleSearchEnabled', 'true');
    console.log('Google Search enabled:', googleSearchEnabled);

    if (googleSearchEnabled === 'true') {
        tools.push({ googleSearch: {} });
        console.log('Added Google Search tool');
    } else {
        console.log('Google Search tool disabled');
    }

    return tools;
}

async function getStoredSetting(key, defaultValue) {
    try {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
            // Try to get setting from renderer process localStorage
            const value = await windows[0].webContents.executeJavaScript(`
                (function() {
                    try {
                        if (typeof localStorage === 'undefined') {
                            console.log('localStorage not available yet for ${key}');
                            return '${defaultValue}';
                        }
                        const stored = localStorage.getItem('${key}');
                        console.log('Retrieved setting ${key}:', stored);
                        return stored || '${defaultValue}';
                    } catch (e) {
                        console.error('Error accessing localStorage for ${key}:', e);
                        return '${defaultValue}';
                    }
                })()
            `);
            return value;
        }
    } catch (error) {
        console.error('Error getting stored setting for', key, ':', error.message);
    }
    console.log('Using default value for', key, ':', defaultValue);
    return defaultValue;
}

// helper to check if groq has been configured
function hasGroqKey() {
    const key = getGroqApiKey();
    return key && key.trim() != '';
}

// helper to check if a Claude (Anthropic) API key has been configured
function getAnthropicApiKey() {
    return getCredentials().anthropicApiKey || '';
}

function hasAnthropicKey() {
    const key = getAnthropicApiKey();
    return key && key.trim() !== '';
}

// helper to check if openai has been configured
function hasOpenaiKey() {
    const key = getOpenaiApiKey();
    return key && key.trim() !== '';
}

// Reused Anthropic client (per API key)
let cachedAnthropicClient = null;
let cachedAnthropicKey = null;
function getAnthropicClient(apiKey) {
    if (!cachedAnthropicClient || cachedAnthropicKey !== apiKey) {
        const Anthropic = require('@anthropic-ai/sdk');
        cachedAnthropicClient = new Anthropic({ apiKey: apiKey });
        cachedAnthropicKey = apiKey;
    }
    return cachedAnthropicClient;
}

async function sendToClaude(transcription, { silent = false } = {}) {
    const apiKey = getAnthropicApiKey();
    if (!apiKey) {
        console.log('No Claude API key configured, skipping Claude response');
        return { ok: false, hadOutput: false };
    }

    if (!transcription || transcription.trim() === '') {
        console.log('Empty transcription, skipping Claude');
        return { ok: false, hadOutput: false };
    }

    console.log('Sending to Claude:', transcription.substring(0, 100) + '...');

    groqConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    if (groqConversationHistory.length > MAX_ANSWER_HISTORY_MESSAGES) {
        groqConversationHistory = groqConversationHistory.slice(-MAX_ANSWER_HISTORY_MESSAGES);
    }

    let isFirst = true;
    try {
        const client = getAnthropicClient(apiKey);

        const stream = client.messages.stream({
            model: 'claude-opus-4-8',
            max_tokens: 2048, // interview answers are deliberately short
            thinking: { type: 'adaptive' },
            system: currentSystemPrompt || 'You are a helpful assistant.',
            messages: groqConversationHistory.map(msg => ({ role: msg.role, content: msg.content })),
        });

        let fullText = '';
        let lastEmit = 0;

        stream.on('text', delta => {
            fullText += delta;
            const now = Date.now();
            if (isFirst || now - lastEmit >= STREAM_UI_INTERVAL_MS) {
                sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                isFirst = false;
                lastEmit = now;
            }
        });

        await stream.finalMessage();

        // Flush the final text - the throttle above may have skipped the last tokens
        if (fullText) {
            sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
        }

        if (fullText.trim()) {
            groqConversationHistory.push({
                role: 'assistant',
                content: fullText.trim(),
            });

            saveConversationTurn(transcription, fullText);
        }

        console.log('Claude response completed');
        sendToRenderer('update-status', 'Listening...');
        return { ok: true, hadOutput: true };
    } catch (error) {
        // isFirst still true means the stream never emitted a single token before
        // failing - safe for the dispatcher to silently retry another provider.
        const hadOutput = !isFirst;
        if (!silent) {
            console.error('Error calling Claude API:', error);
            sendToRenderer('new-response', `⚠️ Claude Error: ${error.message}`);
            sendToRenderer('update-status', 'Claude error: ' + error.message);
        } else {
            console.warn('[Claude] Silent failure (falling back to another provider):', error.message);
        }
        return { ok: false, hadOutput };
    }
}

// 16000 chars (~4000 tokens) is a safety net, not the primary limit — history is
// already capped at MAX_ANSWER_HISTORY_MESSAGES entries before this runs. Was
// 42000 (~10500 tokens), sized for a cap that no longer exists at the call site.
function trimConversationHistoryForGemma(history, maxChars = 16000) {
    if (!history || history.length === 0) return [];
    let totalChars = 0;
    const trimmed = [];

    for (let i = history.length - 1; i >= 0; i--) {
        const turn = history[i];
        const turnChars = (turn.content || '').length;

        if (totalChars + turnChars > maxChars) break;
        totalChars += turnChars;
        trimmed.unshift(turn);
    }
    return trimmed;
}

// Turns a raw HTTP-error body into a clean one-line message: try to pull
// `error.message` from JSON, then strip URLs so nothing is accidentally clickable.
function parseApiErrorText(errorText) {
    let parsed = errorText;
    try {
        parsed = JSON.parse(errorText).error?.message || errorText;
    } catch (e) {}
    return parsed
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\s+You can find your API key at\s*\.?$/i, '')
        .trim();
}

async function sendToGroq(transcription, { silent = false } = {}) {
    const groqApiKey = getGroqApiKey();
    if (!groqApiKey) {
        console.log('No Groq API key configured, skipping Groq response');
        return { ok: false, hadOutput: false };
    }

    if (!transcription || transcription.trim() === '') {
        console.log('Empty transcription, skipping Groq');
        return { ok: false, hadOutput: false };
    }

    const prefs = getPreferences();
    const modelToUse = prefs.groqModel || getModelForToday() || 'llama-3.3-70b-versatile';

    console.log(`Sending to Groq (${modelToUse}):`, transcription.substring(0, 100) + '...');

    groqConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    if (groqConversationHistory.length > MAX_ANSWER_HISTORY_MESSAGES) {
        groqConversationHistory = groqConversationHistory.slice(-MAX_ANSWER_HISTORY_MESSAGES);
    }

    const result = await streamChatCompletion({
        url: 'https://api.groq.com/openai/v1/chat/completions',
        headers: {
            Authorization: `Bearer ${groqApiKey}`,
            'Content-Type': 'application/json',
        },
        body: {
            model: modelToUse,
            messages: [{ role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' }, ...groqConversationHistory],
            stream: true,
            temperature: 0.7,
            max_tokens: 1024,
        },
        stallTimeoutMs: GROQ_STALL_TIMEOUT_MS,
        onEmit: (text, isFirst) => sendToRenderer(isFirst ? 'new-response' : 'update-response', text),
    });

    if (!result.ok) {
        if (!silent) {
            if (result.status) {
                console.error('Groq API error:', result.status, result.error);
                sendToRenderer('new-response', `⚠️ Groq Error (${result.status}): ${parseApiErrorText(result.error)}`);
                sendToRenderer('update-status', `Groq error: ${result.status}`);
            } else {
                console.error('Error calling Groq API:', result.error);
                sendToRenderer('new-response', `⚠️ Groq Error: ${result.error}`);
                sendToRenderer('update-status', 'Groq error: ' + result.error);
            }
        } else {
            console.warn('[Groq] Silent failure (falling back to another provider):', result.status || result.error);
        }
        return { ok: false, hadOutput: result.hadOutput };
    }

    const cleanedResponse = result.text;
    const modelKey = modelToUse.split('/').pop();

    const systemPromptChars = (currentSystemPrompt || 'You are a helpful assistant.').length;
    const historyChars = groqConversationHistory.reduce((sum, msg) => sum + (msg.content || '').length, 0);
    const inputChars = systemPromptChars + historyChars;
    const outputChars = cleanedResponse.length;

    incrementCharUsage('groq', modelKey, inputChars + outputChars);

    if (cleanedResponse) {
        groqConversationHistory.push({
            role: 'assistant',
            content: cleanedResponse,
        });

        saveConversationTurn(transcription, cleanedResponse);
    }

    console.log(`Groq response completed (${modelToUse})`);
    sendToRenderer('update-status', 'Listening...');
    return { ok: true, hadOutput: true };
}

async function sendToOpenAI(transcription, { silent = false } = {}) {
    const openaiApiKey = getOpenaiApiKey();
    if (!openaiApiKey) {
        console.log('No OpenAI API key configured, skipping OpenAI response');
        return { ok: false, hadOutput: false };
    }

    if (!transcription || transcription.trim() === '') {
        console.log('Empty transcription, skipping OpenAI');
        return { ok: false, hadOutput: false };
    }

    const prefs = getPreferences();
    const modelToUse = prefs.openaiModel || 'gpt-4o-mini';

    console.log(`Sending to OpenAI (${modelToUse}):`, transcription.substring(0, 100) + '...');

    groqConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    if (groqConversationHistory.length > MAX_ANSWER_HISTORY_MESSAGES) {
        groqConversationHistory = groqConversationHistory.slice(-MAX_ANSWER_HISTORY_MESSAGES);
    }

    const result = await streamChatCompletion({
        url: 'https://api.openai.com/v1/chat/completions',
        headers: {
            Authorization: `Bearer ${openaiApiKey}`,
            'Content-Type': 'application/json',
        },
        body: {
            model: modelToUse,
            messages: [{ role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' }, ...groqConversationHistory],
            stream: true,
            temperature: 0.7,
            max_tokens: 1536,
        },
        onEmit: (text, isFirst) => sendToRenderer(isFirst ? 'new-response' : 'update-response', text),
    });

    if (!result.ok) {
        if (!silent) {
            if (result.status) {
                console.error('OpenAI API error:', result.status, result.error);
                sendToRenderer('new-response', `⚠️ OpenAI Error (${result.status}): ${parseApiErrorText(result.error)}`);
                sendToRenderer('update-status', `OpenAI error: ${result.status}`);
            } else {
                console.error('Error calling OpenAI API:', result.error);
                sendToRenderer('new-response', `⚠️ OpenAI Error: ${result.error}`);
                sendToRenderer('update-status', 'OpenAI error: ' + result.error);
            }
        } else {
            console.warn('[OpenAI] Silent failure (falling back to another provider):', result.status || result.error);
        }
        return { ok: false, hadOutput: result.hadOutput };
    }

    const cleanedResponse = result.text;
    const modelKey = modelToUse.split('/').pop();
    const systemPromptChars = (currentSystemPrompt || 'You are a helpful assistant.').length;
    const historyChars = groqConversationHistory.reduce((sum, msg) => sum + (msg.content || '').length, 0);
    const inputChars = systemPromptChars + historyChars;
    const outputChars = cleanedResponse.length;

    incrementCharUsage('openai', modelKey, inputChars + outputChars);

    if (cleanedResponse) {
        groqConversationHistory.push({
            role: 'assistant',
            content: cleanedResponse,
        });

        saveConversationTurn(transcription, cleanedResponse);
    }

    console.log(`OpenAI response completed (${modelToUse})`);
    sendToRenderer('update-status', 'Listening...');
    return { ok: true, hadOutput: true };
}

async function sendToGemma(transcription) {
    const apiKey = getApiKey();
    if (!apiKey) {
        console.log('No Gemini API key configured');
        return;
    }

    if (!transcription || transcription.trim() === '') {
        console.log('Empty transcription, skipping Gemma');
        return;
    }

    console.log('Sending to Gemma:', transcription.substring(0, 100) + '...');

    groqConversationHistory.push({
        role: 'user',
        content: transcription.trim(),
    });

    const trimmedHistory = trimConversationHistoryForGemma(groqConversationHistory);

    try {
        const ai = getHttpClient(apiKey);

        const messages = trimmedHistory.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }],
        }));

        const systemPrompt = currentSystemPrompt || 'You are a helpful assistant.';
        const messagesWithSystem = [
            { role: 'user', parts: [{ text: systemPrompt }] },
            { role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] },
            ...messages,
        ];

        const response = await ai.models.generateContentStream({
            model: 'gemma-4-26b-a4b-it',
            contents: messagesWithSystem,
        });

        let fullText = '';
        let isFirst = true;
        let lastEmit = 0;

        for await (const chunk of response) {
            const chunkText = chunk.text;
            if (chunkText) {
                fullText += chunkText;
                const now = Date.now();
                if (isFirst || now - lastEmit >= STREAM_UI_INTERVAL_MS) {
                    sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                    isFirst = false;
                    lastEmit = now;
                }
            }
        }

        // Flush the final text - the throttle above may have skipped the last tokens
        if (fullText) {
            sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
        }

        const systemPromptChars = (currentSystemPrompt || 'You are a helpful assistant.').length;
        const historyChars = trimmedHistory.reduce((sum, msg) => sum + (msg.content || '').length, 0);
        const inputChars = systemPromptChars + historyChars;
        const outputChars = fullText.length;

        incrementCharUsage('gemini', 'gemma-4-26b-a4b-it', inputChars + outputChars);

        if (fullText.trim()) {
            groqConversationHistory.push({
                role: 'assistant',
                content: fullText.trim(),
            });

            if (groqConversationHistory.length > 40) {
                groqConversationHistory = groqConversationHistory.slice(-40);
            }

            saveConversationTurn(transcription, fullText);
        }

        console.log('Gemma response completed');
        sendToRenderer('update-status', 'Listening...');
    } catch (error) {
        console.error('Error calling Gemma API:', error);
        sendToRenderer('new-response', `⚠️ Gemini Error: ${error.message}`);
        sendToRenderer('update-status', 'Gemma error: ' + error.message);
    }
}

async function initializeGeminiSession(apiKey, customPrompt = '', profile = 'interview', language = 'en-US', isReconnect = false) {
    if (isInitializingSession) {
        console.log('Session initialization already in progress');
        return false;
    }

    isInitializingSession = true;
    if (!isReconnect) {
        sendToRenderer('session-initializing', true);
    }

    // Store params for reconnection
    if (!isReconnect) {
        sessionParams = { apiKey, customPrompt, profile, language };
        reconnectAttempts = 0;
    }

    const client = new GoogleGenAI({
        vertexai: false,
        apiKey: apiKey,
        httpOptions: { apiVersion: 'v1alpha' },
    });

    // Get enabled tools first to determine Google Search status
    const enabledTools = await getEnabledTools();
    const googleSearchEnabled = enabledTools.some(tool => tool.googleSearch);

    const systemPrompt = getSystemPrompt(profile, customPrompt, googleSearchEnabled);
    currentSystemPrompt = systemPrompt; // Store for Groq

    // Initialize new conversation session only on first connect
    if (!isReconnect) {
        initializeNewSession(profile, customPrompt);
    }

    try {
        const callbacks = {
            onopen: function () {
                sendToRenderer('update-status', 'Live session connected');
            },
            onmessage: function (message) {
                console.log('----------------', message);

                // Handle input transcription (what was spoken)
                if (message.serverContent?.inputTranscription?.results) {
                    currentTranscription += formatSpeakerResults(message.serverContent.inputTranscription.results);
                    scheduleTranscriptionDispatch();
                } else if (message.serverContent?.inputTranscription?.text) {
                    const text = message.serverContent.inputTranscription.text;
                    if (text.trim() !== '') {
                        currentTranscription += text;
                        scheduleTranscriptionDispatch();
                    }
                }

                // DISABLED: Gemini's outputTranscription - using Groq for faster responses instead
                // if (message.serverContent?.outputTranscription?.text) { ... }

                // Fallback only: the silence debounce above normally dispatches first.
                // dispatchTranscription() is a no-op if the transcription was already sent.
                if (message.serverContent?.generationComplete) {
                    dispatchTranscription();
                    messageBuffer = '';
                }

                if (message.serverContent?.turnComplete) {
                    sendToRenderer('update-status', 'Listening...');
                }
            },
            onerror: function (e) {
                console.log('Session error:', e.message);
                sendToRenderer('update-status', 'Error: ' + e.message);
            },
            onclose: function (e) {
                console.log('Session closed:', e.reason);

                // Don't reconnect if user intentionally closed
                if (isUserClosing) {
                    isUserClosing = false;
                    sendToRenderer('update-status', 'Session closed');
                    return;
                }

                // Quota/billing errors won't fix themselves - reconnecting just
                // burns the retry budget against the same wall. Tell the user
                // exactly which key is exhausted and what their options are.
                const reason = e?.reason || '';
                if (/quota|billing|resource.?exhausted|rate.?limit|429/i.test(reason)) {
                    sessionParams = null;
                    sendToRenderer('update-status', 'Gemini API quota exceeded');
                    sendToRenderer('reconnect-failed', {
                        message:
                            'Your GEMINI API key hit its quota (this is the transcription session, not Groq). ' +
                            'Options: wait for the free-tier daily reset, enable billing for the key at aistudio.google.com, ' +
                            'use a different Gemini key, or switch to Local mode (Whisper + Ollama, no API needed) from Home.',
                    });
                    return;
                }

                // Attempt reconnection
                if (sessionParams && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    attemptReconnect();
                } else {
                    sendToRenderer('update-status', 'Session closed');
                }
            },
        };

        const baseConfig = {
            tools: enabledTools,
            // Enable speaker diarization
            inputAudioTranscription: {
                enableSpeakerDiarization: true,
                minSpeakerCount: 2,
                maxSpeakerCount: 2,
            },
            contextWindowCompression: { slidingWindow: {} },
            speechConfig: { languageCode: language },
            systemInstruction: {
                parts: [{ text: systemPrompt }],
            },
        };

        const model = 'gemini-3.1-flash-live-preview';

        let session;
        try {
            // Gemini's own reply is discarded (Groq/Gemma generate the visible answer),
            // so request text output: much cheaper and faster than generating audio.
            // generationComplete still fires, keeping the fallback dispatch intact.
            session = await client.live.connect({
                model,
                callbacks,
                config: { ...baseConfig, responseModalities: [Modality.TEXT] },
            });
            console.log('Live session connected (text-only output)');
        } catch (textError) {
            console.warn('Text-only live session rejected, falling back to audio output:', textError.message);
            session = await client.live.connect({
                model,
                callbacks,
                config: {
                    ...baseConfig,
                    responseModalities: [Modality.AUDIO],
                    proactivity: { proactiveAudio: true },
                    outputAudioTranscription: {},
                },
            });
        }

        isInitializingSession = false;
        if (!isReconnect) {
            sendToRenderer('session-initializing', false);
        }
        return session;
    } catch (error) {
        console.error('Failed to initialize Gemini session:', error);
        isInitializingSession = false;
        if (!isReconnect) {
            sendToRenderer('session-initializing', false);
        }
        return null;
    }
}

async function attemptReconnect() {
    reconnectAttempts++;
    console.log(`Reconnection attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);

    // Clear stale buffers
    messageBuffer = '';
    currentTranscription = '';
    if (transcriptionDebounceTimer) {
        clearTimeout(transcriptionDebounceTimer);
        transcriptionDebounceTimer = null;
    }
    // Don't reset groqConversationHistory to preserve context across reconnects

    sendToRenderer('update-status', `Reconnecting... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

    // Wait before attempting
    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));

    try {
        const session = await initializeGeminiSession(
            sessionParams.apiKey,
            sessionParams.customPrompt,
            sessionParams.profile,
            sessionParams.language,
            true // isReconnect
        );

        if (session && global.geminiSessionRef) {
            global.geminiSessionRef.current = session;

            // Restore context from conversation history via text message
            const contextMessage = buildContextMessage();
            if (contextMessage) {
                try {
                    console.log('Restoring conversation context...');
                    await session.sendRealtimeInput({ text: contextMessage });
                } catch (contextError) {
                    console.error('Failed to restore context:', contextError);
                    // Continue without context - better than failing
                }
            }

            // Don't reset reconnectAttempts here - let it reset on next fresh session
            sendToRenderer('update-status', 'Reconnected! Listening...');
            console.log('Session reconnected successfully');
            return true;
        }
    } catch (error) {
        console.error(`Reconnection attempt ${reconnectAttempts} failed:`, error);
    }

    // If we still have attempts left, try again
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        return attemptReconnect();
    }

    // Max attempts reached - notify frontend
    console.log('Max reconnection attempts reached');
    sendToRenderer('reconnect-failed', {
        message: 'Tried 3 times to reconnect. Must be upstream/network issues. Try restarting or download updated app from site.',
    });
    sessionParams = null;
    return false;
}

function killExistingSystemAudioDump() {
    return new Promise(resolve => {
        console.log('Checking for existing SystemAudioDump processes...');

        // Kill any existing SystemAudioDump processes
        const killProc = spawn('pkill', ['-f', 'SystemAudioDump'], {
            stdio: 'ignore',
        });

        killProc.on('close', code => {
            if (code === 0) {
                console.log('Killed existing SystemAudioDump processes');
            } else {
                console.log('No existing SystemAudioDump processes found');
            }
            resolve();
        });

        killProc.on('error', err => {
            console.log('Error checking for existing processes (this is normal):', err.message);
            resolve();
        });

        // Timeout after 2 seconds
        setTimeout(() => {
            killProc.kill();
            resolve();
        }, 2000);
    });
}

async function startMacOSAudioCapture(geminiSessionRef) {
    if (process.platform !== 'darwin') return false;

    // Kill any existing SystemAudioDump processes first
    await killExistingSystemAudioDump();

    console.log('Starting macOS audio capture with SystemAudioDump...');

    const { app } = require('electron');
    const path = require('path');

    let systemAudioPath;
    if (app.isPackaged) {
        systemAudioPath = path.join(process.resourcesPath, 'SystemAudioDump');
    } else {
        systemAudioPath = path.join(__dirname, '../assets', 'SystemAudioDump');
    }

    console.log('SystemAudioDump path:', systemAudioPath);

    const spawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
        },
    };

    systemAudioProc = spawn(systemAudioPath, [], spawnOptions);

    if (!systemAudioProc.pid) {
        console.error('Failed to start SystemAudioDump');
        return false;
    }

    console.log('SystemAudioDump started with PID:', systemAudioProc.pid);

    const CHUNK_DURATION = 0.1;
    const SAMPLE_RATE = 24000;
    const BYTES_PER_SAMPLE = 2;
    const CHANNELS = 2;
    const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_DURATION;

    let audioBuffer = Buffer.alloc(0);

    systemAudioProc.stdout.on('data', data => {
        audioBuffer = Buffer.concat([audioBuffer, data]);

        while (audioBuffer.length >= CHUNK_SIZE) {
            const chunk = audioBuffer.slice(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.slice(CHUNK_SIZE);

            const monoChunk = CHANNELS === 2 ? convertStereoToMono(chunk) : chunk;

            if (currentProviderMode === 'cloud') {
                sendCloudAudio(monoChunk);
            } else if (currentProviderMode === 'local') {
                getLocalAi().processLocalAudio(monoChunk);
            } else {
                const base64Data = monoChunk.toString('base64');
                sendAudioToGemini(base64Data, geminiSessionRef);
            }

            if (process.env.DEBUG_AUDIO) {
                console.log(`Processed audio chunk: ${chunk.length} bytes`);
                saveDebugAudio(monoChunk, 'system_audio');
            }
        }

        const maxBufferSize = SAMPLE_RATE * BYTES_PER_SAMPLE * 1;
        if (audioBuffer.length > maxBufferSize) {
            audioBuffer = audioBuffer.slice(-maxBufferSize);
        }
    });

    systemAudioProc.stderr.on('data', data => {
        console.error('SystemAudioDump stderr:', data.toString());
    });

    systemAudioProc.on('close', code => {
        console.log('SystemAudioDump process closed with code:', code);
        systemAudioProc = null;
    });

    systemAudioProc.on('error', err => {
        console.error('SystemAudioDump process error:', err);
        systemAudioProc = null;
    });

    return true;
}

function convertStereoToMono(stereoBuffer) {
    const samples = stereoBuffer.length / 4;
    const monoBuffer = Buffer.alloc(samples * 2);

    for (let i = 0; i < samples; i++) {
        const leftSample = stereoBuffer.readInt16LE(i * 4);
        monoBuffer.writeInt16LE(leftSample, i * 2);
    }

    return monoBuffer;
}

function stopMacOSAudioCapture() {
    if (systemAudioProc) {
        console.log('Stopping SystemAudioDump...');
        systemAudioProc.kill('SIGTERM');
        systemAudioProc = null;
    }
}

async function sendAudioToGemini(base64Data, geminiSessionRef) {
    if (!geminiSessionRef.current) return;

    try {
        process.stdout.write('.');
        await geminiSessionRef.current.sendRealtimeInput({
            audio: {
                data: base64Data,
                mimeType: 'audio/pcm;rate=24000',
            },
        });
    } catch (error) {
        console.error('Error sending audio to Gemini:', error);
    }
}

async function sendImageToGeminiHttp(base64Data, prompt) {
    // Get available model based on rate limits
    const model = getAvailableModel();

    const apiKey = getApiKey();
    if (!apiKey) {
        return { success: false, error: 'No API key configured' };
    }

    try {
        const ai = getHttpClient(apiKey);

        const contents = [
            {
                inlineData: {
                    mimeType: 'image/jpeg',
                    data: base64Data,
                },
            },
            { text: prompt },
        ];

        console.log(`Sending image to ${model} (streaming)...`);
        const response = await ai.models.generateContentStream({
            model: model,
            contents: contents,
        });

        // Increment count after successful call
        incrementLimitCount(model);

        // Stream the response
        let fullText = '';
        let isFirst = true;
        let lastEmit = 0;
        for await (const chunk of response) {
            const chunkText = chunk.text;
            if (chunkText) {
                fullText += chunkText;
                // Send to renderer - new response for first chunk, throttled updates after
                const now = Date.now();
                if (isFirst || now - lastEmit >= STREAM_UI_INTERVAL_MS) {
                    sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
                    isFirst = false;
                    lastEmit = now;
                }
            }
        }

        // Flush the final text - the throttle above may have skipped the last tokens
        if (fullText) {
            sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
        }

        console.log(`Image response completed from ${model}`);

        // Save screen analysis to history
        saveScreenAnalysis(prompt, fullText, model);

        return { success: true, text: fullText, model: model };
    } catch (error) {
        console.error('Error sending image to Gemini HTTP:', error);
        return { success: false, error: error.message };
    }
}

function setupGeminiIpcHandlers(geminiSessionRef) {
    // Store the geminiSessionRef globally for reconnection access
    global.geminiSessionRef = geminiSessionRef;

    ipcMain.on('update-session-profile', (event, profile) => {
        console.log(`[Bridge] Live updating session profile to: ${profile}`);
        const storage = require('../storage');
        const prefs = storage.getPreferences();
        const customPrompt = prefs.customPrompt || '';
        const { getSystemPrompt } = require('./prompts');
        currentSystemPrompt = getSystemPrompt(profile, customPrompt, false);
        getLocalAi().updateActiveProfile(profile);
    });

    ipcMain.handle('initialize-cloud', async (event, token, profile, userContext) => {
        try {
            currentProviderMode = 'cloud';
            initializeNewSession(profile);
            setOnTurnComplete((transcription, response) => {
                saveConversationTurn(transcription, response);
            });
            sendToRenderer('session-initializing', true);
            await connectCloud(token, profile, userContext);
            sendToRenderer('session-initializing', false);
            return true;
        } catch (err) {
            console.error('[Cloud] Init error:', err);
            currentProviderMode = 'byok';
            sendToRenderer('session-initializing', false);
            return false;
        }
    });

    ipcMain.handle('initialize-gemini', async (event, apiKey, customPrompt, profile = 'interview', language = 'en-US') => {
        currentProviderMode = 'byok';
        const session = await initializeGeminiSession(apiKey, customPrompt, profile, language);
        if (session) {
            geminiSessionRef.current = session;
            return true;
        }
        return false;
    });

    ipcMain.handle('initialize-local', async (event, host, model, whisperModel, profile, customPrompt, backend = 'ollama', answerMode = 'local') => {
        currentProviderMode = 'local';
        const success = await getLocalAi().initializeLocalSession(host, model, whisperModel, profile, customPrompt, backend, answerMode);
        if (!success) {
            currentProviderMode = 'byok';
        }
        return success;
    });

    // Model picker: list models available on a local server (Ollama or LM Studio)
    ipcMain.handle('list-local-models', async (event, host, backend) => {
        return getLocalAi().listLocalModels(host, backend);
    });

    ipcMain.handle('send-audio-content', async (event, { data, mimeType }) => {
        if (currentProviderMode === 'cloud') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                sendCloudAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (currentProviderMode === 'local') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                getLocalAi().processLocalAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending local audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };
        try {
            process.stdout.write('.');
            await geminiSessionRef.current.sendRealtimeInput({
                audio: { data: data, mimeType: mimeType },
            });
            return { success: true };
        } catch (error) {
            console.error('Error sending system audio:', error);
            return { success: false, error: error.message };
        }
    });

    // Handle microphone audio on a separate channel
    ipcMain.handle('send-mic-audio-content', async (event, { data, mimeType }) => {
        if (currentProviderMode === 'cloud') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                sendCloudAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud mic audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (currentProviderMode === 'local') {
            try {
                const pcmBuffer = Buffer.from(data, 'base64');
                getLocalAi().processLocalAudio(pcmBuffer);
                return { success: true };
            } catch (error) {
                console.error('Error sending local mic audio:', error);
                return { success: false, error: error.message };
            }
        }
        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };
        try {
            process.stdout.write(',');
            await geminiSessionRef.current.sendRealtimeInput({
                audio: { data: data, mimeType: mimeType },
            });
            return { success: true };
        } catch (error) {
            console.error('Error sending mic audio:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-image-content', async (event, { data, prompt }) => {
        try {
            if (!data || typeof data !== 'string') {
                console.error('Invalid image data received');
                return { success: false, error: 'Invalid image data' };
            }

            const buffer = Buffer.from(data, 'base64');

            if (buffer.length < 1000) {
                console.error(`Image buffer too small: ${buffer.length} bytes`);
                return { success: false, error: 'Image buffer too small' };
            }

            process.stdout.write('!');

            if (currentProviderMode === 'cloud') {
                const sent = sendCloudImage(data);
                if (!sent) {
                    return { success: false, error: 'Cloud connection not active' };
                }
                return { success: true, model: 'cloud' };
            }

            if (currentProviderMode === 'local') {
                const result = await getLocalAi().sendLocalImage(data, prompt);
                return result;
            }

            // Use HTTP API instead of realtime session
            const result = await sendImageToGeminiHttp(data, prompt);
            return result;
        } catch (error) {
            console.error('Error sending image:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-text-message', async (event, text) => {
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            return { success: false, error: 'Invalid text message' };
        }

        if (currentProviderMode === 'cloud') {
            try {
                console.log('Sending text to cloud:', text);
                sendCloudText(text.trim());
                return { success: true };
            } catch (error) {
                console.error('Error sending cloud text:', error);
                return { success: false, error: error.message };
            }
        }

        if (currentProviderMode === 'local') {
            try {
                // If local session is running in hybrid/cloud-answer mode (BYOK),
                // route manual text queries to the cloud provider, not Ollama.
                if (getLocalAi().getLocalAnswerMode() === 'cloud') {
                    console.log('Sending text to cloud answer provider:', text);
                    dispatchToAnswerProvider(text.trim());
                    return { success: true };
                }
                console.log('Sending text to local Ollama:', text);
                return await getLocalAi().sendLocalText(text.trim());
            } catch (error) {
                console.error('Error sending local text:', error);
                return { success: false, error: error.message };
            }
        }

        if (!geminiSessionRef.current) return { success: false, error: 'No active Gemini session' };

        try {
            console.log('Sending text message:', text);

            dispatchToAnswerProvider(text.trim());

            await geminiSessionRef.current.sendRealtimeInput({ text: text.trim() });
            return { success: true };
        } catch (error) {
            console.error('Error sending text:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-macos-audio', async event => {
        if (process.platform !== 'darwin') {
            return {
                success: false,
                error: 'macOS audio capture only available on macOS',
            };
        }

        try {
            const success = await startMacOSAudioCapture(geminiSessionRef);
            return { success };
        } catch (error) {
            console.error('Error starting macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('stop-macos-audio', async event => {
        try {
            stopMacOSAudioCapture();
            return { success: true };
        } catch (error) {
            console.error('Error stopping macOS audio capture:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('close-session', async event => {
        try {
            stopMacOSAudioCapture();

            if (currentProviderMode === 'cloud') {
                closeCloud();
                currentProviderMode = 'byok';
                return { success: true };
            }

            if (currentProviderMode === 'local') {
                getLocalAi().closeLocalSession();
                currentProviderMode = 'byok';
                return { success: true };
            }

            // Set flag to prevent reconnection attempts
            isUserClosing = true;
            sessionParams = null;
            if (transcriptionDebounceTimer) {
                clearTimeout(transcriptionDebounceTimer);
                transcriptionDebounceTimer = null;
            }
            currentTranscription = '';

            // Cleanup session
            if (geminiSessionRef.current) {
                await geminiSessionRef.current.close();
                geminiSessionRef.current = null;
            }

            return { success: true };
        } catch (error) {
            console.error('Error closing session:', error);
            return { success: false, error: error.message };
        }
    });

    // Conversation history IPC handlers
    ipcMain.handle('get-current-session', async event => {
        try {
            return { success: true, data: getCurrentSessionData() };
        } catch (error) {
            console.error('Error getting current session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-new-session', async event => {
        try {
            initializeNewSession();
            return { success: true, sessionId: currentSessionId };
        } catch (error) {
            console.error('Error starting new session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('update-google-search-setting', async (event, enabled) => {
        try {
            console.log('Google Search setting updated to:', enabled);
            // The setting is already saved in localStorage by the renderer
            // This is just for logging/confirmation
            return { success: true };
        } catch (error) {
            console.error('Error updating Google Search setting:', error);
            return { success: false, error: error.message };
        }
    });
}

module.exports = {
    initializeGeminiSession,
    getEnabledTools,
    getStoredSetting,
    sendToRenderer,
    initializeNewSession,
    saveConversationTurn,
    getCurrentSessionData,
    killExistingSystemAudioDump,
    startMacOSAudioCapture,
    convertStereoToMono,
    stopMacOSAudioCapture,
    sendAudioToGemini,
    sendImageToGeminiHttp,
    setupGeminiIpcHandlers,
    formatSpeakerResults,
    trimConversationHistoryForGemma,
    stripThinkingTags,
    dispatchToAnswerProvider,
    setCurrentSystemPrompt: prompt => {
        currentSystemPrompt = prompt;
    },
};
