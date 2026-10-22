import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const initialRoot = path.resolve(process.argv[2] ?? 'artifacts/vcp-validation/large-memory-initial');
const currentRoot = path.resolve(process.argv[3] ?? 'artifacts/vcp-validation/large-memory-current');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const [initial, current, corpus] = await Promise.all([
  readJson(path.join(initialRoot, 'report.json')), readJson(path.join(currentRoot, 'report.json')),
  readJson(path.join(currentRoot, 'corpus.json')),
]);
const hash = createHash('sha256').update(JSON.stringify({ documents: corpus.documents, queries: corpus.queries })).digest('hex');
if (hash !== initial.corpusHash || hash !== current.corpusHash || hash !== corpus.corpusHash) throw new Error('Frozen corpus/gold mismatch.');
const documents = new Map(corpus.documents.map(document => [document.key, document]));
const distribution = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, min: sorted[0] ?? null, p50: sorted[Math.floor(sorted.length * .5)] ?? null,
    p95: sorted[Math.floor(sorted.length * .95)] ?? null, max: sorted.at(-1) ?? null };
};
async function verifiedManualReview(root) {
  let manual;
  try { manual = await readJson(path.join(root, 'semantic-review.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const raw = await readFile(path.join(root, 'report.json'));
  if (manual.evaluatedReportSha256 !== createHash('sha256').update(raw).digest('hex')) throw new Error('Manual review does not match this evaluation report.');
  return manual;
}
function lightMemoText(serialized) {
  if (typeof serialized !== 'string') return undefined;
  try {
    const result = JSON.parse(serialized);
    if (Array.isArray(result.result?.content)) return result.result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    if (typeof result.result === 'string') return result.result;
  } catch { /* A plain native context is already text. */ }
  return serialized;
}
function coverage(report) {
  const rows = report.retrievals.filter(row => row.expectedKeys.length).map(row => {
    const context = lightMemoText(row.context);
    const present = context === undefined ? null : row.expectedKeys.filter(key => context.includes(documents.get(key).text));
    const starts = context === undefined ? [] : [...context.matchAll(/^--- \(来源:/gmu)].map(match => match.index);
    const targetStart = context === undefined ? -1 : context.indexOf(documents.get(row.expectedKeys[0]).text);
    const presentDocuments = context === undefined ? [] : [...documents.values()].filter(document => context.includes(document.text));
    return { id: row.queryId, category: row.category, nativePageRank: row.firstRelevantRank,
      actualLightMemoSourcePresent: present === null ? null : present.length === row.expectedKeys.length,
      expectedKeys: row.expectedKeys, foundKeys: present,
      transportChars: row.context?.length ?? null, unwrappedContextChars: context?.length ?? null,
      sourceFragmentCount: context === undefined ? null : starts.length,
      uniquelyIdentifiedCorpusParagraphs: context === undefined ? null : presentDocuments.length,
      identifiedSourceParagraphChars: context === undefined ? null : presentDocuments.reduce((sum, document) => sum + document.text.length, 0),
      targetFragmentRank: targetStart < 0 ? null : starts.filter(start => start < targetStart).length,
      targetRelativeCharPosition: targetStart < 0 ? null : targetStart / context.length };
  });
  const measured = rows.filter(row => row.actualLightMemoSourcePresent !== null);
  return { method: 'Exact expected source paragraph presence in the actual unwrapped LightMemo response. This is separate from native-page ranks and final answer correctness.',
    measured: measured.length, present: measured.filter(row => row.actualLightMemoSourcePresent).length,
    volume: { characterUnit: 'JavaScript UTF-16 code units; native formatting/path/ID text is included in returned context characters.',
      transportChars: distribution(measured.map(row => row.transportChars)), unwrappedContextChars: distribution(measured.map(row => row.unwrappedContextChars)),
      sourceFragments: distribution(measured.map(row => row.sourceFragmentCount)),
      uniqueCorpusParagraphs: distribution(measured.map(row => row.uniquelyIdentifiedCorpusParagraphs)),
      sourceParagraphChars: distribution(measured.map(row => row.identifiedSourceParagraphChars)),
      targetFragmentRank: distribution(measured.filter(row => row.targetFragmentRank !== null).map(row => row.targetFragmentRank)),
      targetRelativeCharPosition: distribution(measured.filter(row => row.targetRelativeCharPosition !== null).map(row => row.targetRelativeCharPosition)),
      interpretation: 'Coverage is not precision. Gold specifies one necessary target, not an exhaustive relevance label for every recalled neighbor. Twenty paragraphs is bounded retrieval, not the full 1024-document corpus, but repeated nearby themes and verbose machine paths still add noise and token cost.' },
    perCategory: Object.fromEntries([...new Set(rows.map(row => row.category))].map(category => {
      const values = measured.filter(row => row.category === category);
      return [category, { count: values.length, present: values.filter(row => row.actualLightMemoSourcePresent).length }];
    })), rows };
}
function processMemory(report) {
  const mib = bytes => Math.round(bytes / 1048576 * 10) / 10;
  return report.processSamples.map(sample => ({ phase: sample.phase, hostRssMiB: mib(sample.host.rss),
    encoderRssMiB: (sample.descendants ?? []).filter(item => item.ProcessName === 'llama-server').map(item => mib(item.WorkingSet64)),
    nativeWorkerRssMiB: (sample.descendants ?? []).filter(item => item.ProcessName === 'electron' && item.Id !== sample.host.pid).map(item => mib(item.WorkingSet64)),
  }));
}
const actualCoverage = coverage(current);
const [initialManual, currentManual] = await Promise.all([verifiedManualReview(initialRoot), verifiedManualReview(currentRoot)]);
const review = {
  generatedAt: new Date().toISOString(), corpusHash: hash,
  corpus: { primaryAuthoredSourceBackedNotes: 1024, otherOwnerNotes: 32, automaticCaptureSourcesPerRun: 10,
    automaticCaptureNotes: { initial: initial.automaticCaptureSubset.noteCount, current: current.automaticCaptureSubset.noteCount },
    actualSourceAppendCountsPerRun: { authoredMemorySourceMessages: 1056, automaticCaptureMessages: 10,
      evaluationQuestionMessages: current.answers.length, total: 1066 + current.answers.length,
      method: 'Derived from successful source-backed fixture append operations, not raw history injection or automatically learned-note counts.' },
    categories: current.categoryCounts, positiveGold: 64, noAnswerGold: 8, actualPassiveModelAnswersPerRun: 24 },
  rankedPage: { initial: initial.retrievalSummary, current: current.retrievalSummary,
    perCategoryInitial: initial.perCategory, perCategoryCurrent: current.perCategory },
  actualActiveLightMemo: { initial: coverage(initial), current: actualCoverage },
  actualPassiveAIMemo: { savedFocusedContextChars: distribution(current.answers.map(answer => answer.context.length)),
    emptyFocusedContexts: current.answers.filter(answer => !answer.context).map(answer => answer.queryId),
    reportedNativeInputFragments: distribution(current.answers.flatMap(answer => {
      const match = answer.context.match(/\[AIMemo\+ 后缀管线: (\d+)片段/u); return match ? [Number(match[1])] : [];
    })),
    limitation: 'Fragment counts are upstream header observations for nonempty outputs; they are not distinct-document precision labels. The final focused context is separate from the larger upstream candidate material.' },
  timings: { milliseconds: true, initial: { canonicalIndex: initial.canonicalIndexMs, coldOwnerQuery: initial.retrievals[0].latencyMs,
    warmQueries: initial.latency.activeAfterColdFirst, passiveAndFinalAnswer: initial.latency.passiveAndFinalAnswer },
    current: { canonicalIndex: current.canonicalIndexMs, coldOwnerQuery: current.retrievals[0].latencyMs,
      warmQueries: current.latency.activeAfterColdFirst, passiveAndFinalAnswer: current.latency.passiveAndFinalAnswer },
    interpretation: 'Document inference duplication is removed by exact cache counters; remaining cold cost includes native worker files, SQLite ingestion and graph publication. These sequential runs are not a controlled hardware performance experiment.' },
  encoderWork: { initial: initial.embeddings, current: current.embeddings,
    currentAfterCanonicalIndex: current.afterCanonicalEmbeddingInputs, currentAfterColdOwnerQuery: current.afterColdFirstEmbeddingInputs,
    finalCache: current.finalGatewayCache, noAdditionalDocumentInferenceForOwnerViewOrForgetRebuild:
      current.afterCanonicalEmbeddingInputs.documents === current.afterColdFirstEmbeddingInputs.documents
      && current.afterCanonicalEmbeddingInputs.documents === current.embeddings.documents },
  sampledMemory: { initial: processMemory(initial), current: processMemory(current),
    limitation: 'Four host/tree samples, not continuous peaks; excludes GPU VRAM. Native worker working sets are listed individually, not added as physical memory consumption because shared pages may overlap.' },
  automatedAnswerSurfaceChecks: { initial: initial.answerSummary, current: current.answerSummary },
  semanticAdjudication: { initial: initialManual, current: currentManual,
    limitation: 'Manual reviews are bound to their report SHA256 and are not automatically reused for a new stochastic run.' },
  securityAndForgetting: { initial: { isolation: initial.ownerIsolation, forgetting: initial.forgetting },
    current: { isolation: current.ownerIsolation, forgetting: current.forgetting } },
  reproducibility: { sameFrozenHumanCorpusAndGold: true, initialImplementationHashes: initial.implementationHashes ?? null,
    currentImplementationHashes: current.implementationHashes,
    serializationLimitation: 'Fresh source UUIDs produce new host note IDs and WorldlineBoxMemory hash anchors in native diary text. Upstream Rust prepare_text_for_embedding retains HTML comments. Full serialized embedding inputs are therefore not byte-identical across the two fixtures; ranking changes cannot be attributed to cache quality or prompt grounding.',
    vendorChanged: false, retrievalAlgorithmsRetuned: false, initialFailuresRetained: true },
  limitations: current.limitations,
};
await writeFile(path.join(currentRoot, 'comparison-review.json'), JSON.stringify(review, null, 2));
process.stdout.write(JSON.stringify({ corpusHash: hash, currentLightMemoCoverage: `${actualCoverage.present}/${actualCoverage.measured}`,
  missingLightMemoSources: actualCoverage.rows.filter(row => !row.actualLightMemoSourcePresent).map(row => row.id),
  rankedPageInitial: initial.retrievalSummary, rankedPageCurrent: current.retrievalSummary,
  saved: path.join(currentRoot, 'comparison-review.json') }, null, 2) + '\n');
