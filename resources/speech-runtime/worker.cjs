'use strict';
// One CPU recognizer per application, outside the Electron main/UI process.
const readline = require('node:readline');
const config = JSON.parse(process.argv[2]);
const sherpa = require(config.modulePath);
const native = { featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: {
  senseVoice: { model: config.model, language: 'auto', useInverseTextNormalization: 1 },
  tokens: config.tokens, numThreads: 2, provider: 'cpu', debug: 0,
} };
const recognizer = new sherpa.OfflineRecognizer(native);
const vad = new sherpa.Vad({ sileroVad: { model: config.vad, threshold: 0.5, minSilenceDuration: 0.5,
  minSpeechDuration: 0.25, maxSpeechDuration: 15, windowSize: 512 }, sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0 }, 22);
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
send({ ready: true, memory: process.memoryUsage() });
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', line => {
  try {
    if (line.length > 900000) throw Error('Speech chunk exceeded its limit');
    const input = JSON.parse(line), pcm = Buffer.from(input.pcm, 'base64');
    if (!pcm.length || pcm.length > 20 * 32000 || pcm.length % 2) throw Error('Invalid PCM chunk');
    const samples = Float32Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2) / 32768);
    vad.reset(); const texts = []; let first = true;
    const drain = () => {
      while (!vad.isEmpty()) {
        // Copy: Electron V8's memory cage cannot accept external native buffers.
        const segment = vad.front(false); let speech = segment.samples;
        if (first) {
          first = false; const from = Math.max(0, segment.start - 4800);
          if (from < segment.start) {
            const restored = new Float32Array(segment.start - from + speech.length);
            restored.set(samples.subarray(from, segment.start)); restored.set(speech, segment.start - from); speech = restored;
          }
        }
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate: 16000, samples: speech }); recognizer.decode(stream);
        texts.push(recognizer.getResult(stream).text.trim()); vad.pop();
      }
    };
    for (let offset = 0; offset < samples.length; offset += 512) { vad.acceptWaveform(samples.subarray(offset, offset + 512)); drain(); }
    vad.flush(); drain();
    if (global.gc) global.gc();
    send({ text: texts.filter(Boolean).join(' ').trim(), memory: process.memoryUsage() });
  } catch (error) { send({ error: error.message }); }
});
lines.once('close', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));
