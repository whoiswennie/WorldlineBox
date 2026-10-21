#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const ts = require('typescript');
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, esModuleInterop: true, resolveJsonModule: true },
}).outputText, file);
const { LocalTextEmbeddingInstaller, resolveLocalTextEmbeddingLayout } = require('../src/main/embedding-text-model-install.ts');
const { GlobalEmbeddingService } = require('../src/main/embedding-global-service.ts');
const { startLlamaEmbeddingSession } = require('../src/main/embedding-llama-session.ts');
const bundleDirectory = path.resolve(process.argv[2] ?? 'resources/embedding-models');
const reportFile = path.resolve(process.argv[3] ?? 'docs/developer/research-vcp-embedding-readonly-bundle-validation.json');
const userDataPath = fs.mkdtempSync(path.join(tmpdir(), 'worldlinebox-readonly-embedding-validation-'));
if (path.dirname(path.resolve(userDataPath)) !== path.resolve(tmpdir()) || !path.basename(userDataPath).startsWith('worldlinebox-readonly-embedding-validation-')) throw new Error('Invalid temporary validation directory.');
const cosine = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
function files(directory) { return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(path.join(directory, item.name)) : [path.join(directory, item.name)]); }
(async () => {
  let encoder; let remoteRequests = 0;
  try {
    const installer = new LocalTextEmbeddingInstaller({ userDataPath, bundleDirectory,
      downloadFile: async () => { remoteRequests++; throw new Error('Network forbidden during readonly bundle validation'); } });
    const started = performance.now(), status = await installer.seedBundledPackage(bundleDirectory);
    if (status.phase !== 'ready') throw new Error('The immutable package was not ready.');
    const verifiedMs = performance.now() - started, layout = resolveLocalTextEmbeddingLayout(userDataPath, bundleDirectory);
    if (!layout || !layout.corePath.startsWith(bundleDirectory) || !layout.runtimePath.startsWith(bundleDirectory)) throw new Error('The immutable layout escaped its resource directory.');
    const cleared = installer.uninstall();
    if (!cleared.installed) throw new Error('Clearing runtime metadata removed the immutable model.');
    await installer.install({ update: true });
    const attempts = [];
    encoder = new GlobalEmbeddingService({ userDataPath, bundleDirectory, koffiPath: require.resolve('koffi'),
      getSelectionId: () => { throw new Error('No user model selection is permitted.'); },
      loadService: () => { throw new Error('External embedding services are forbidden.'); },
      readKey: () => { throw new Error('No embedding API credential is needed.'); },
      startLocalSession: async options => {
        attempts.push({ executable: options.executable, gpuLayers: options.gpuLayers });
        if (options.gpuLayers > 0) throw new Error('Simulated unavailable GPU for real CPU fallback validation.');
        return startLlamaEmbeddingSession(options);
      } });
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../tests/fixtures/embedding-memory-retrieval.json'), 'utf8'));
    const documents = await encoder.embed(fixture.documents.map(doc => doc.text), { purpose: 'document' });
    const queries = await encoder.embed(fixture.queries.map(query => query.text), { purpose: 'query', expectedProfileKey: documents.profile.profileKey });
    const correct = fixture.queries.filter((query, index) => fixture.documents.map((doc, i) => ({ id: doc.id, score: cosine(queries.vectors[index], documents.vectors[i]) }))
      .sort((a, b) => b.score - a.score)[0].id === query.expected).length;
    await encoder.close(); encoder = undefined;
    const userFiles = files(userDataPath), userDataBytes = userFiles.reduce((sum, file) => sum + fs.statSync(file).size, 0);
    if (userFiles.some(file => /\.(gguf|dll|exe)$/iu.test(file)) || userDataBytes > 4096) throw new Error('Large model/runtime resources were duplicated under userData.');
    const report = { generatedAt: new Date().toISOString(), bundleDirectory, profileKey: documents.profile.profileKey,
      ready: true, verifiedMs, remoteRequests, userDataBytes, copiedModelFiles: 0, copiedRuntimeFiles: 0,
      clearKeepsBundledWeightsReady: cleared.installed, repairVerifiedInPlace: true,
      cpuFallback: { simulatedGpuUnavailable: true, attempts, actualCpuInference: true, queryCount: fixture.queries.length, top1Correct: correct, dimension: queries.vectors[0].length, closedSuccessfully: true } };
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    if (correct !== fixture.queries.length) process.exitCode = 1;
  } finally {
    if (encoder) await encoder.close();
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
