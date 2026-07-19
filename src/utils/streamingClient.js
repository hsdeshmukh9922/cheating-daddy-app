// Shared OpenAI-compatible SSE streaming client — used by Groq, OpenAI, and LM
// Studio (gemini.js's sendToGroq/sendToOpenAI, localai.js's sendToLmStudio).
// All three previously hand-rolled the same fetch + SSE-parse + stall-watchdog
// + throttled-emit logic; a fix to the parsing here now applies to all three
// instead of needing to be copied by hand.
const { STREAM_UI_INTERVAL_MS } = require('../audioUtils');

function stripThinkingTags(text) {
    // Also strips a trailing unclosed <think> block so in-progress reasoning
    // never flashes on screen while a response is streaming
    return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
}

// Extract the delta token from one SSE "data: {...}" line, or null for
// anything else (blank lines, "[DONE]", malformed JSON). Split out from
// streamChatCompletion to keep that function's branching shallow.
function parseSseToken(line) {
    if (!line.startsWith('data: ')) return null;
    const data = line.slice(6);
    if (data === '[DONE]') return null;
    try {
        return JSON.parse(data).choices?.[0]?.delta?.content || null;
    } catch {
        // Malformed/partial JSON chunk - expected occasionally with SSE, not fatal
        return null;
    }
}

/**
 * Streams a POST to an OpenAI-compatible /chat/completions endpoint, parses the
 * SSE token stream, throttles UI emits to STREAM_UI_INTERVAL_MS, and aborts on
 * stall. Callers own request construction (url/headers/body) and error
 * presentation — this only owns the streaming mechanics shared by every
 * OpenAI-compatible provider.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {object} opts.headers
 * @param {object} opts.body - JSON-serializable request body (must set stream: true)
 * @param {number} [opts.stallTimeoutMs=30000] - abort if no chunk arrives within this window
 * @param {(displayText: string, isFirst: boolean) => void} opts.onEmit - called with the
 *   think-tag-stripped cumulative text whenever it should be rendered (throttled during
 *   streaming, and once more for the final flush after the stream ends)
 * @returns {Promise<
 *   {ok: true, text: string, hadOutput: true} |
 *   {ok: false, status?: number, error: string, aborted?: boolean, hadOutput: boolean}
 * >} `hadOutput` is true once any text has reached `onEmit` - callers use this to decide
 *   whether a failure is safe to silently retry against a different provider (never retry
 *   once the user has already seen part of an answer).
 */
async function streamChatCompletion({ url, headers, body, stallTimeoutMs = 30000, onEmit }) {
    const controller = new AbortController();
    let stallTimer = null;
    const resetStall = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => controller.abort(), stallTimeoutMs);
    };

    // Declared outside the try block so the catch clause can still see how much
    // (if anything) was already shown to the user when a failure happens.
    let fullText = '';
    let isFirst = true;
    let lastEmit = 0;

    try {
        resetStall();
        const response = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errorText = await response.text();
            return { ok: false, status: response.status, error: errorText, hadOutput: false };
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            resetStall();

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n').filter(line => line.trim() !== '');

            for (const line of lines) {
                const token = parseSseToken(line);
                if (!token) continue;

                fullText += token;
                const displayText = stripThinkingTags(fullText);
                const now = Date.now();
                if (displayText && (isFirst || now - lastEmit >= STREAM_UI_INTERVAL_MS)) {
                    onEmit(displayText, isFirst);
                    isFirst = false;
                    lastEmit = now;
                }
            }
        }

        const cleanedResponse = stripThinkingTags(fullText);
        // Flush the final text - the throttle above may have skipped the last tokens
        if (cleanedResponse) {
            onEmit(cleanedResponse, isFirst);
        }

        return { ok: true, text: cleanedResponse, hadOutput: !!cleanedResponse };
    } catch (error) {
        const hadOutput = !isFirst;
        if (error.name === 'AbortError') {
            return { ok: false, error: 'request stalled and was aborted', aborted: true, hadOutput };
        }
        return { ok: false, error: error.message, hadOutput };
    } finally {
        if (stallTimer) clearTimeout(stallTimer);
    }
}

module.exports = {
    stripThinkingTags,
    streamChatCompletion,
};
