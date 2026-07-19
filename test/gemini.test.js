const { test, describe } = require('node:test');
const assert = require('node:assert');

const { formatSpeakerResults, convertStereoToMono, trimConversationHistoryForGemma, stripThinkingTags } = require('../src/utils/gemini');

describe('formatSpeakerResults', () => {
    test('labels speaker 1 as Interviewer and others as Candidate', () => {
        const text = formatSpeakerResults([
            { transcript: 'Tell me about yourself', speakerId: 1 },
            { transcript: 'Sure, I am a developer', speakerId: 2 },
        ]);
        assert.strictEqual(text, '[Interviewer]: Tell me about yourself\n[Candidate]: Sure, I am a developer\n');
    });

    test('skips results missing transcript or speakerId', () => {
        const text = formatSpeakerResults([
            { transcript: '', speakerId: 1 },
            { transcript: 'hello' },
            { speakerId: 2 },
        ]);
        assert.strictEqual(text, '');
    });

    test('handles empty results', () => {
        assert.strictEqual(formatSpeakerResults([]), '');
    });
});

describe('convertStereoToMono', () => {
    test('keeps the left channel of each stereo frame', () => {
        // Two stereo frames: [L=100, R=200], [L=-300, R=400]
        const stereo = Buffer.alloc(8);
        stereo.writeInt16LE(100, 0);
        stereo.writeInt16LE(200, 2);
        stereo.writeInt16LE(-300, 4);
        stereo.writeInt16LE(400, 6);

        const mono = convertStereoToMono(stereo);
        assert.strictEqual(mono.length, 4);
        assert.strictEqual(mono.readInt16LE(0), 100);
        assert.strictEqual(mono.readInt16LE(2), -300);
    });

    test('halves the buffer size', () => {
        const stereo = Buffer.alloc(4 * 1000);
        assert.strictEqual(convertStereoToMono(stereo).length, 2 * 1000);
    });
});

describe('trimConversationHistoryForGemma', () => {
    test('returns empty array for empty or missing history', () => {
        assert.deepStrictEqual(trimConversationHistoryForGemma([]), []);
        assert.deepStrictEqual(trimConversationHistoryForGemma(null), []);
    });

    test('keeps history under the character budget, newest first', () => {
        const history = [
            { role: 'user', content: 'a'.repeat(500) },
            { role: 'assistant', content: 'b'.repeat(500) },
            { role: 'user', content: 'c'.repeat(500) },
        ];
        const trimmed = trimConversationHistoryForGemma(history, 1000);
        assert.strictEqual(trimmed.length, 2);
        assert.strictEqual(trimmed[0].content[0], 'b'); // oldest turn dropped
        assert.strictEqual(trimmed[1].content[0], 'c');
    });

    test('preserves order of kept turns', () => {
        const history = [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'second' },
        ];
        const trimmed = trimConversationHistoryForGemma(history, 42000);
        assert.deepStrictEqual(trimmed.map(t => t.content), ['first', 'second']);
    });

    test('handles turns with missing content', () => {
        const trimmed = trimConversationHistoryForGemma([{ role: 'user' }, { role: 'user', content: 'ok' }], 100);
        assert.strictEqual(trimmed.length, 2);
    });
});

describe('stripThinkingTags', () => {
    test('removes think blocks and trims', () => {
        assert.strictEqual(stripThinkingTags('<think>reasoning here</think>The answer is 42'), 'The answer is 42');
    });

    test('removes multiline think blocks', () => {
        assert.strictEqual(stripThinkingTags('<think>line1\nline2\n</think>Answer'), 'Answer');
    });

    test('removes multiple think blocks', () => {
        assert.strictEqual(stripThinkingTags('<think>a</think>Hello <think>b</think>world'), 'Hello world');
    });

    test('returns text unchanged when no tags present', () => {
        assert.strictEqual(stripThinkingTags('plain answer'), 'plain answer');
    });

    test('hides an unclosed think block mid-stream without eating the text before it', () => {
        // While streaming, a response can end inside an open <think> block;
        // the in-progress reasoning must not flash on screen
        assert.strictEqual(stripThinkingTags('Answer so far <think>still reasoning'), 'Answer so far');
        assert.strictEqual(stripThinkingTags('<think>still reasoning'), '');
    });
});
