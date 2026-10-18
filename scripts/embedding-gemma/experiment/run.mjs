import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, realpath, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ExperimentError,
  PROFILES,
  discoverCorpusImages,
  resolveProfileFiles,
  runExperiment,
  safeErrorMessage,
  sha256File,
} from './core.mjs';
import { startLlamaServerSession } from './llama-http-session.mjs';
import { renderReportHtml } from './report-html.mjs';
import { makePrivacySafeReport } from './report-data.mjs';

const TOOL_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TOOL_DIRECTORY, '../../..');
const APP_OUTPUT_DIRECTORY = 'worldlinebox-embedding-gemma';
const MIN_FREE_OUTPUT_BYTES = 16 * 1024 * 1024;
const PINNED_RUNTIME = {
  build: '11457',
  shortCommit: '5ad1c5da0',
  fullCommit: '5ad1c5da0ad7f6176256b823925aad19134f0263',
};

function usage() {
  return `EmbeddingGemma 2 GGUF image retrieval experiment

Usage:
  node scripts/embedding-gemma/experiment/run.mjs --images <folder> --models <folder> --output <existing-folder> --runtime <llama-server> --text "a red car" [--profile Q4_K_XL]

Provide at least one --text query or --query-image (the image query can be used by itself). Repeat --text for more queries. With no --profile flags, all three profiles run sequentially. Models are never downloaded.`;
}

function parseArgs(argv) {
  const args = {
    profiles: [],
    textQueries: [],
    topK: 10,
    gpuLayers: 0,
  };
  const valueFlags = new Set([
    '--images', '--models', '--output', '--runtime', '--query-image', '--text', '--profile',
    '--top-k', '--gpu-layers', '--runtime-commit',
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      args.help = true;
      continue;
    }
    if (!valueFlags.has(flag)) throw new ExperimentError('unknown-option', `Unknown option: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new ExperimentError('missing-option-value', `Missing value for ${flag}.`);
    index += 1;
    switch (flag) {
      case '--images': args.imageDirectory = value; break;
      case '--models': args.modelDirectory = value; break;
      case '--output': args.outputDirectory = value; break;
      case '--runtime': args.runtimeExecutable = value; break;
      case '--query-image': args.queryImagePath = value; break;
      case '--text': args.textQueries.push({ id: `text-${args.textQueries.length + 1}`, text: value }); break;
      case '--profile': args.profiles.push(value.toUpperCase()); break;
      case '--top-k': args.topK = Number(value); break;
      case '--gpu-layers': args.gpuLayers = Number(value); break;
      case '--runtime-commit': args.runtimeCommit = value; break;
      default: throw new ExperimentError('unknown-option', `Unknown option: ${flag}`);
    }
  }

  if (args.help) return args;
  for (const required of ['imageDirectory', 'modelDirectory', 'outputDirectory', 'runtimeExecutable']) {
    if (!args[required]) throw new ExperimentError('missing-option', `Missing required option: ${{
      imageDirectory: '--images', modelDirectory: '--models', outputDirectory: '--output', runtimeExecutable: '--runtime',
    }[required]}`);
  }
  if (!Number.isInteger(args.topK) || args.topK < 1 || args.topK > 100) {
    throw new ExperimentError('invalid-top-k', '--top-k must be an integer from 1 to 100.');
  }
  if (!Number.isInteger(args.gpuLayers) || args.gpuLayers < 0 || args.gpuLayers > 999) {
    throw new ExperimentError('invalid-gpu-layers', '--gpu-layers must be an integer from 0 to 999.');
  }
  if (args.runtimeCommit && !/^[0-9a-f]{40}$/i.test(args.runtimeCommit)) {
    throw new ExperimentError('invalid-runtime-commit', '--runtime-commit must be a full 40-character commit SHA.');
  }
  if (args.profiles.length === 0) args.profiles = PROFILES.map((profile) => profile.id);
  if (new Set(args.profiles).size !== args.profiles.length) {
    throw new ExperimentError('duplicate-profile', 'Each --profile can be provided only once.');
  }
  const unknownProfiles = args.profiles.filter((id) => !PROFILES.some((profile) => profile.id === id));
  if (unknownProfiles.length > 0) throw new ExperimentError('unknown-profile', `Unknown profile: ${unknownProfiles.join(', ')}`);
  if (args.textQueries.some(({ text }) => !text.trim())) throw new ExperimentError('empty-query', 'Text queries cannot be empty.');
  if (args.textQueries.length === 0 && !args.queryImagePath) {
    throw new ExperimentError('missing-query', 'Provide at least one --text query or --query-image.');
  }
  return args;
}

function isSameOrInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertDisjointDirectories(leftLabel, left, rightLabel, right) {
  if (isSameOrInside(left, right) || isSameOrInside(right, left)) {
    throw new ExperimentError('overlapping-directories', `${leftLabel} and ${rightLabel} must be separate directory trees.`);
  }
}

async function resolveExistingDirectory(directory, label) {
  const resolved = await realpath(directory).catch((cause) => {
    throw new ExperimentError('directory-unavailable', `The selected ${label} directory is unavailable.`, { cause });
  });
  if (!(await stat(resolved)).isDirectory()) throw new ExperimentError('not-a-directory', `The selected ${label} path is not a directory.`);
  return resolved;
}

async function verifyOutputDirectory(outputDirectory, imageDirectory, modelDirectory) {
  const resolvedOutput = await resolveExistingDirectory(outputDirectory, 'output');
  const resolvedImages = await resolveExistingDirectory(imageDirectory, 'image');
  const resolvedModels = await resolveExistingDirectory(modelDirectory, 'model');
  assertDisjointDirectories('Output', resolvedOutput, 'image', resolvedImages);
  assertDisjointDirectories('Output', resolvedOutput, 'model', resolvedModels);
  assertDisjointDirectories('Image sample', resolvedImages, 'model', resolvedModels);
  if (isSameOrInside(resolvedModels, REPOSITORY_ROOT)) {
    throw new ExperimentError('models-inside-repository', 'Choose a model-cache folder outside the WorldlineBox repository.');
  }
  if (isSameOrInside(resolvedOutput, REPOSITORY_ROOT)) {
    throw new ExperimentError('output-inside-repository', 'Choose an output folder outside the WorldlineBox repository.');
  }
  const { bavail, bsize } = await statfs(resolvedOutput);
  const freeBytes = Number(bavail) * Number(bsize);
  if (!Number.isFinite(freeBytes) || freeBytes < MIN_FREE_OUTPUT_BYTES) {
    throw new ExperimentError('insufficient-output-space', 'The selected output drive needs at least 16 MiB of free space.');
  }
  return { outputDirectory: resolvedOutput, imageDirectory: resolvedImages, modelDirectory: resolvedModels, freeBytes };
}

function imageMimeSupported(filename) {
  return ['.jpg', '.jpeg', '.png', '.webp'].includes(path.extname(filename).toLowerCase());
}

async function resolveQueryImage(queryImagePath, imagePaths, imageDirectory) {
  if (!queryImagePath) return null;
  const resolved = await realpath(queryImagePath).catch((cause) => {
    throw new ExperimentError('query-image-unavailable', 'The selected query image is unavailable.', { cause });
  });
  if (!(await stat(resolved)).isFile()) throw new ExperimentError('invalid-query-image', 'The query image path is not a file.');
  if (!imageMimeSupported(resolved)) throw new ExperimentError('unsupported-query-image', 'Query images must be JPG, PNG, or WebP.');
  if (isSameOrInside(resolved, imageDirectory)) {
    throw new ExperimentError('query-image-in-corpus-folder', 'Choose a query image outside the selected sample folder.');
  }
  const corpusSet = new Set(await Promise.all(imagePaths.map((imagePath) => realpath(imagePath))));
  if (corpusSet.has(resolved)) {
    throw new ExperimentError('query-image-in-corpus', 'Choose a query image outside the selected corpus folder.');
  }
  return resolved;
}

function getRuntimeCommitFromVersion(executable) {
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  const versionText = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().slice(0, 2_000);
  const fullCommit = versionText.match(/\b[0-9a-f]{40}\b/i)?.[0] ?? null;
  const reportsPinnedBuild = new RegExp(`\\bbuild\\s+${PINNED_RUNTIME.build}\\b`, 'i').test(versionText)
    && new RegExp(`\\b${PINNED_RUNTIME.shortCommit}\\b`, 'i').test(versionText);
  return { fullCommit: fullCommit ?? (reportsPinnedBuild ? PINNED_RUNTIME.fullCommit : null) };
}

function makeRunDirectory(outputRoot, runId) {
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('-', '').replace(/\.\d{3}Z$/, 'Z');
  return path.join(outputRoot, APP_OUTPUT_DIRECTORY, `${stamp}-${runId.slice(0, 8)}`);
}

function printProgress(event) {
  if (event.type === 'profile-complete') {
    console.log(`[${event.profileId}] ${event.status}`);
  } else if (event.type === 'image') {
    process.stdout.write(`\r[${event.profileId}] images ${event.completed}/${event.total}`);
    if (event.completed === event.total) process.stdout.write('\n');
  }
}

function printResults(report) {
  console.log(`\nExperiment ${report.runId}: ${report.status}`);
  for (const profile of report.profiles) {
    console.log(`\n${profile.label ?? profile.id}: ${profile.status}`);
    if (profile.error) console.log(`  ${profile.error.code}: ${profile.error.message}`);
    if (profile.status === 'failed') continue;
    console.log(`  runtime: ${profile.runtimeCommit ?? 'commit unavailable'}; startup ${profile.timingsMs.startup} ms`);
    console.log(`  image canary: ${profile.canary?.verified ? 'passed' : 'failed'}; encoded ${profile.corpus.length}; skipped ${profile.skippedImages.length}`);
    for (const query of profile.queries) {
      console.log(`  ${query.type === 'text' ? `text: ${query.text}` : `image: ${query.filename}`}`);
      for (const [index, result] of query.results.slice(0, 5).entries()) {
        console.log(`    ${index + 1}. ${result.filename} (${result.score.toFixed(4)})`);
      }
    }
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const selectedProfiles = args.profiles.map((id) => PROFILES.find((profile) => profile.id === id));
  const directories = await verifyOutputDirectory(args.outputDirectory, args.imageDirectory, args.modelDirectory);
  const imagePaths = await discoverCorpusImages(directories.imageDirectory);
  const queryImagePath = await resolveQueryImage(args.queryImagePath, imagePaths, directories.imageDirectory);
  const runId = randomUUID();
  const outputDirectory = makeRunDirectory(directories.outputDirectory, runId);
  const profileFiles = {};
  const hashCache = new Map();

  for (const profile of selectedProfiles) {
    const files = await resolveProfileFiles(directories.modelDirectory, profile);
    for (const key of ['core', 'projector']) {
      const modelPath = files[key].path;
      if (!hashCache.has(modelPath)) {
        console.log(`Hashing ${path.basename(modelPath)}...`);
        hashCache.set(modelPath, await sha256File(modelPath));
      }
      files[key].sha256 = hashCache.get(modelPath);
    }
    profileFiles[profile.id] = files;
  }

  const runtimeVersion = getRuntimeCommitFromVersion(args.runtimeExecutable);
  const runtimeCommit = args.runtimeCommit ?? runtimeVersion.fullCommit;
  if (!runtimeCommit) {
    console.warn('Runtime version did not expose a full commit SHA. Results will record runtimeCommit as unavailable.');
  }

  console.log(`Images: ${imagePaths.length} (2 minimum; 20–100 recommended); profiles: ${selectedProfiles.map((profile) => profile.id).join(', ')}`);
  console.log(`Output: ${path.relative(directories.outputDirectory, outputDirectory)}`);
  if (selectedProfiles.length === PROFILES.length) console.log('Model downloads are disabled; all three existing profiles are required.');

  let activeSession = null;
  let interrupted = false;
  const stopOnSignal = async (signal) => {
    if (interrupted) return;
    interrupted = true;
    console.error(`\n${signal}: stopping the active local runtime...`);
    try {
      await activeSession?.close();
    } catch (error) {
      console.error(`Could not stop the local runtime cleanly: ${safeErrorMessage(error)}`);
    }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const onSigint = () => void stopOnSignal('SIGINT');
  const onSigterm = () => void stopOnSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  try {
    const report = await runExperiment({
      runId,
      profiles: selectedProfiles,
      profileFiles,
      imagePaths,
      textQueries: args.textQueries,
      queryImagePath,
      topK: args.topK,
      onProgress: printProgress,
      createSession: async (profile, files) => {
        const session = await startLlamaServerSession({
          executable: args.runtimeExecutable,
          profile,
          files,
          gpuLayers: args.gpuLayers,
          runtimeCommit,
        });
        const originalClose = session.close;
        session.close = async () => {
          await originalClose();
          if (activeSession === session) activeSession = null;
        };
        activeSession = session;
        return session;
      },
    });
    report.environment = {
      platform: process.platform,
      architecture: process.arch,
      runtimeCommit,
      gpuLayers: args.gpuLayers,
      memoryMeasurement: 'unavailable: this first CLI harness does not collect llama-server process-tree peak memory',
      imageSizeLimitBytes: 64 * 1024 * 1024,
    };
    printResults(report);
    report.output = 'report.json';
    const reportWithoutSourceFilenames = makePrivacySafeReport(report, imagePaths, queryImagePath);
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, 'report.json'), `${JSON.stringify(reportWithoutSourceFilenames, null, 2)}\n`, { flag: 'wx' });
    const sampleMap = {
      privacyNote: 'Contains filenames from the selected image sample and text queries. Keep this file local and do not share it unless intended.',
      samples: imagePaths.map((imagePath, index) => ({ id: `image-${String(index + 1).padStart(3, '0')}`, relativeFilename: path.basename(imagePath) })),
      queryImage: queryImagePath ? path.basename(queryImagePath) : null,
      textQueries: args.textQueries.map((query, index) => ({ id: `text-query-${String(index + 1).padStart(2, '0')}`, text: query.text })),
    };
    await writeFile(path.join(outputDirectory, 'sample-map.json'), `${JSON.stringify(sampleMap, null, 2)}\n`, { flag: 'wx' });
    await writeFile(path.join(outputDirectory, 'report.html'), renderReportHtml(reportWithoutSourceFilenames), { flag: 'wx' });
    console.log(`\nSaved: ${path.join(APP_OUTPUT_DIRECTORY, path.basename(outputDirectory), 'report.html')}`);
    return report.status === 'incomplete' ? 1 : 0;
  } finally {
    await activeSession?.close();
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

run().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error) => {
  console.error(`${error instanceof ExperimentError ? error.code : 'experiment-error'}: ${safeErrorMessage(error)}`);
  console.error('No fallback text-only image results were generated.');
  process.exitCode = 1;
});
