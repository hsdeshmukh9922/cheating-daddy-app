// Whisper transcription worker - runs speech-to-text off the Electron main
// process so heavy inference never freezes the UI.
const { parentPort } = require('worker_threads');

let pipelinePromise = null;

function getPipeline(modelName, cacheDir) {
    if (!pipelinePromise) {
        pipelinePromise = (async () => {
            const { pipeline, env } = await import('@huggingface/transformers');
            env.cacheDir = cacheDir;
            return pipeline('automatic-speech-recognition', modelName, {
                dtype: 'q8',
                device: 'auto',
            });
        })();
    }
    return pipelinePromise;
}

parentPort.on('message', async msg => {
    if (msg.type === 'load') {
        try {
            await getPipeline(msg.modelName, msg.cacheDir);
            parentPort.postMessage({ type: 'loaded' });
        } catch (error) {
            pipelinePromise = null;
            parentPort.postMessage({ type: 'load-error', error: error.message });
        }
    } else if (msg.type === 'transcribe') {
        try {
            const pipe = await getPipeline(msg.modelName, msg.cacheDir);
            const result = await pipe(msg.audio, {
                sampling_rate: 16000,
                language: 'en',
                task: 'transcribe',
                chunk_length_s: 30,
                stride_length_s: 5,
            });
            parentPort.postMessage({ type: 'result', id: msg.id, text: result.text || '' });
        } catch (error) {
            parentPort.postMessage({ type: 'result-error', id: msg.id, error: error.message });
        }
    }
});
