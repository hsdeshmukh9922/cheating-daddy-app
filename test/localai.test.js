const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');

const { _internals } = require('../src/utils/localai');
const { resample24kTo16k, calculateRMS, processVAD, pcm16ToFloat32, pcm16ToWav, VAD_MODES, getVadState, resetVadState } = _internals;

// Build a 16-bit PCM buffer from an array of sample values
function pcmBuffer(samples) {
    const buf = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
    return buf;
}

// A loud 100ms chunk at 16kHz (1600 samples) that clears every VAD threshold
function loudChunk(sampleCount = 1600, amplitude = 8000) {
    return pcmBuffer(Array.from({ length: sampleCount }, (_, i) => (i % 2 === 0 ? amplitude : -amplitude)));
}

function silentChunk(sampleCount = 1600) {
    return pcmBuffer(new Array(sampleCount).fill(0));
}

describe('resample24kTo16k', () => {
    beforeEach(() => resetVadState());

    test('produces 2 output samples for every 3 input samples', () => {
        const input = pcmBuffer(new Array(2400).fill(1000)); // 100ms at 24kHz
        const output = resample24kTo16k(input);
        assert.strictEqual(output.length / 2, 1600); // 100ms at 16kHz
    });

    test('preserves a constant signal', () => {
        const input = pcmBuffer(new Array(300).fill(5000));
        const output = resample24kTo16k(input);
        for (let i = 0; i < output.length / 2; i++) {
            assert.strictEqual(output.readInt16LE(i * 2), 5000);
        }
    });

    test('carries remainder samples across calls without losing audio', () => {
        // Feed odd-sized buffers; total output should still match the 2/3 ratio overall
        let totalOut = 0;
        let totalIn = 0;
        for (const size of [101, 257, 1000, 43]) {
            const input = pcmBuffer(new Array(size).fill(100));
            totalIn += size;
            totalOut += resample24kTo16k(input).length / 2;
        }
        const expected = Math.floor((totalIn * 2) / 3);
        assert.ok(Math.abs(totalOut - expected) <= 2, `expected ~${expected} samples, got ${totalOut}`);
    });

    test('handles empty input', () => {
        assert.strictEqual(resample24kTo16k(Buffer.alloc(0)).length, 0);
    });
});

describe('calculateRMS', () => {
    test('returns 0 for silence', () => {
        assert.strictEqual(calculateRMS(silentChunk()), 0);
    });

    test('returns 0 for empty buffer instead of NaN', () => {
        assert.strictEqual(calculateRMS(Buffer.alloc(0)), 0);
    });

    test('scales with amplitude', () => {
        const quiet = calculateRMS(loudChunk(1600, 1000));
        const loud = calculateRMS(loudChunk(1600, 8000));
        assert.ok(loud > quiet);
        assert.ok(Math.abs(loud - 8000 / 32768) < 0.001);
    });
});

describe('VAD state machine', () => {
    beforeEach(() => resetVadState());

    test('does not trigger speaking on a single loud frame', () => {
        processVAD(loudChunk());
        assert.strictEqual(getVadState().isSpeaking, false);
    });

    test('enters speaking state after required consecutive speech frames', () => {
        const required = VAD_MODES.VERY_AGGRESSIVE.speechFramesRequired;
        for (let i = 0; i < required; i++) processVAD(loudChunk());
        assert.strictEqual(getVadState().isSpeaking, true);
    });

    test('accumulates audio while speaking', () => {
        for (let i = 0; i < 5; i++) processVAD(loudChunk());
        assert.ok(getVadState().speechChunks > 0);
        assert.ok(getVadState().speechBytes > 0);
    });

    test('silence during non-speech does not accumulate audio', () => {
        for (let i = 0; i < 50; i++) processVAD(silentChunk());
        assert.strictEqual(getVadState().isSpeaking, false);
        assert.strictEqual(getVadState().speechChunks, 0);
    });

    test('exits speaking state and flushes buffers after sustained silence', () => {
        for (let i = 0; i < 5; i++) processVAD(loudChunk());
        assert.strictEqual(getVadState().isSpeaking, true);

        const silenceNeeded = VAD_MODES.VERY_AGGRESSIVE.silenceFramesRequired;
        for (let i = 0; i < silenceNeeded; i++) processVAD(silentChunk());

        const state = getVadState();
        assert.strictEqual(state.isSpeaking, false);
        assert.strictEqual(state.speechChunks, 0); // flushed to transcription
        assert.strictEqual(state.speechBytes, 0);
    });

    test('caps speech segments at ~30s instead of growing unbounded', () => {
        // 100ms chunks at 16kHz = 3200 bytes each; 30s = 960000 bytes = 300 chunks
        for (let i = 0; i < 400; i++) processVAD(loudChunk());
        const state = getVadState();
        // Buffer must have been force-flushed at the 30s cap, never exceeding it
        assert.ok(state.speechBytes < 960000, `speechBytes ${state.speechBytes} should stay under the 30s cap`);
    });
});

describe('pcm16ToFloat32', () => {
    test('normalizes samples to [-1, 1)', () => {
        const buf = pcmBuffer([0, 16384, -16384, 32767, -32768]);
        const out = pcm16ToFloat32(buf);
        assert.strictEqual(out[0], 0);
        assert.ok(Math.abs(out[1] - 0.5) < 0.001);
        assert.ok(Math.abs(out[2] + 0.5) < 0.001);
        assert.ok(out[3] < 1);
        assert.strictEqual(out[4], -1);
    });
});

describe('pcm16ToWav', () => {
    test('correctly wraps PCM bytes with a 44-byte WAV header', () => {
        // Create 100 samples (200 bytes) of PCM data
        const pcmSamples = new Array(100).fill(1000);
        const pcm = pcmBuffer(pcmSamples);
        const wav = pcm16ToWav(pcm, 16000);

        // Header (44 bytes) + PCM data (200 bytes) = 244 bytes
        assert.strictEqual(wav.length, 244);

        // RIFF header
        assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF');
        // Total chunk size minus 8 bytes = 236
        assert.strictEqual(wav.readUInt32LE(4), 236);
        // WAVE header
        assert.strictEqual(wav.toString('ascii', 8, 12), 'WAVE');
        // fmt chunk header
        assert.strictEqual(wav.toString('ascii', 12, 16), 'fmt ');
        // fmt chunk size (16)
        assert.strictEqual(wav.readUInt32LE(16), 16);
        // Audio format (1 for PCM)
        assert.strictEqual(wav.readUInt16LE(20), 1);
        // Number of channels (1 for mono)
        assert.strictEqual(wav.readUInt16LE(22), 1);
        // Sample rate (16000)
        assert.strictEqual(wav.readUInt32LE(24), 16000);
        // Byte rate (sampleRate * numChannels * bitsPerSample/8 = 16000 * 1 * 2 = 32000)
        assert.strictEqual(wav.readUInt32LE(28), 32000);
        // Block align (numChannels * bitsPerSample/8 = 2)
        assert.strictEqual(wav.readUInt16LE(32), 2);
        // Bits per sample (16)
        assert.strictEqual(wav.readUInt16LE(34), 16);
        // data chunk header
        assert.strictEqual(wav.toString('ascii', 36, 40), 'data');
        // Data chunk size (200 bytes)
        assert.strictEqual(wav.readUInt32LE(40), 200);

        // Verify the PCM data payload starts at offset 44
        for (let i = 0; i < 100; i++) {
            assert.strictEqual(wav.readInt16LE(44 + i * 2), 1000);
        }
    });
});
