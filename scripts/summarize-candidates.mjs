import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runIdPattern = /^[a-z0-9T_.-]{1,100}$/i;
const allowedModels = new Map([
  ['gpt2-xl', 'openai-community/gpt2-xl'],
  ['qwen2.5-3b-instruct', 'Qwen/Qwen2.5-3B-Instruct'],
  ['qwen2.5-coder-1.5b-instruct', 'Qwen/Qwen2.5-Coder-1.5B-Instruct'],
  ['qwen2.5-coder-3b-instruct', 'Qwen/Qwen2.5-Coder-3B-Instruct'],
  ['lfm2.5-1.2b-instruct', 'LiquidAI/LFM2.5-1.2B-Instruct'],
  ['lfm2.5-2.6b', 'LiquidAI/LFM2.5-2.6B'],
]);

function fail(slug, message) {
  throw new Error(`Invalid benchmark report ${slug}: ${message}`);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function finiteNonnegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function validateReport(report, model, artifact, suite, suiteSha256, order) {
  const slug = model.slug;
  if (!report || report.model?.slug !== slug) fail(slug, 'missing or mismatched model identity');
  for (const key of ['originalId', 'revision', 'license']) {
    if (report.model[key] !== model[key]) fail(slug, `model.${key} does not match pinned manifest`);
  }
  if (report.model.quantization !== 'Q4_K_M') fail(slug, 'quantization must be Q4_K_M');
  if (!artifact || artifact.originalId !== model.originalId || artifact.revision !== model.revision ||
      artifact.quantization !== 'Q4_K_M' || report.model.sha256 !== artifact.sha256 || report.model.bytes !== artifact.size) {
    fail(slug, 'model SHA-256 or byte size does not match the pinned artifact receipt');
  }
  if (!/^[a-f0-9]{64}$/i.test(report.model.sha256 ?? '')) fail(slug, 'invalid model SHA-256');
  if (report.suite?.id !== suite.id || report.suite?.sha256 !== suiteSha256 || report.suite?.count !== suite.cases.length) {
    fail(slug, 'suite id, fixture SHA-256, or case count does not match current fixture');
  }
  if (report.summary?.complete !== true || !Array.isArray(report.errors) || report.errors.length !== 0) {
    fail(slug, 'benchmark is incomplete or contains errors');
  }
  if (!Array.isArray(report.cases) || report.cases.length !== suite.cases.length) fail(slug, 'case count is incomplete');

  const expected = new Map(suite.cases.map(item => [item.id, item.category]));
  const seen = new Set();
  const categories = {};
  const latencies = [];
  for (const item of report.cases) {
    if (!expected.has(item.id) || seen.has(item.id)) fail(slug, `unexpected or duplicate case ${item.id}`);
    if (expected.get(item.id) !== item.category || typeof item.grade?.passed !== 'boolean') fail(slug, `invalid case data for ${item.id}`);
    seen.add(item.id);
    const group = categories[item.category] ??= { passed: 0, total: 0 };
    group.total++;
    if (item.grade.passed) group.passed++;
    if (finiteNonnegative(item.result?.latencyMs)) latencies.push(item.result.latencyMs);
  }
  if (seen.size !== expected.size) fail(slug, 'one or more fixture cases are missing');
  if (!latencies.length) fail(slug, 'no valid case latency measurements');

  const passed = Object.values(categories).reduce((sum, category) => sum + category.passed, 0);
  if (report.summary.passed !== passed || report.summary.total !== suite.cases.length ||
      !Number.isFinite(report.summary.percentage) || Math.abs(report.summary.percentage - passed / suite.cases.length * 100) > 1e-8) {
    fail(slug, 'summary pass counts do not match case grades');
  }
  for (const [name, values] of Object.entries(categories)) {
    const summary = report.summary.categories?.[name];
    if (!summary || summary.passed !== values.passed || summary.total !== values.total) fail(slug, `category summary mismatch for ${name}`);
  }
  if (Object.keys(report.summary.categories ?? {}).length !== Object.keys(categories).length) fail(slug, 'unexpected category summary');

  const vram = report.vram;
  if (!vram || !['beforeMiB', 'peakTotalMiB', 'peakDeltaMiB', 'totalMiB'].every(key => finiteNonnegative(vram[key]))) {
    fail(slug, 'missing or invalid VRAM measurements');
  }
  if (Math.abs(vram.peakDeltaMiB - (vram.peakTotalMiB - vram.beforeMiB)) > 1) fail(slug, 'VRAM delta is inconsistent');

  const nativeTool = categories.native_tool_planning ?? { passed: 0, total: 0 };
  return {
    model: {
      originalId: report.model.originalId,
      slug: report.model.slug,
      revision: report.model.revision,
      license: report.model.license,
      quantization: report.model.quantization,
      sha256: report.model.sha256,
      bytes: report.model.bytes,
    },
    report, passed, total: suite.cases.length, passRate: passed / suite.cases.length,
    categories,
    nativeToolPassed: nativeTool.passed, nativeToolTotal: nativeTool.total,
    medianLatencyMs: median(latencies), validLatencyCount: latencies.length,
    peakTotalMiB: vram.peakTotalMiB, peakDeltaMiB: vram.peakDeltaMiB,
    baselineMiB: vram.beforeMiB, bytes: report.model.bytes, rank: 0, order,
  };
}

export function selectCandidates({ reports, models, suite, suiteSha256, artifacts }) {
  if (!Array.isArray(models) || !models.length || reports?.length !== models.length) {
    throw new Error('Candidate selection requires one complete report for every pinned model');
  }
  const bySlug = new Map(reports.map(report => [report?.model?.slug, report]));
  if (bySlug.size !== reports.length) throw new Error('Candidate reports contain duplicate or missing model slugs');
  const entries = models.map((model, order) => {
    const report = bySlug.get(model.slug);
    if (!report) fail(model.slug, 'report is missing');
    return validateReport(report, model, artifacts?.[model.slug], suite, suiteSha256, order);
  });
  const ranking = entries.sort((a, b) =>
    b.passRate - a.passRate ||
    (b.nativeToolTotal ? b.nativeToolPassed / b.nativeToolTotal : 0) - (a.nativeToolTotal ? a.nativeToolPassed / a.nativeToolTotal : 0) ||
    a.peakDeltaMiB - b.peakDeltaMiB || a.medianLatencyMs - b.medianLatencyMs || a.order - b.order,
  );
  ranking.forEach((entry, index) => { entry.rank = index + 1; });
  const winner = ranking[0];
  const eligible = ranking.filter(entry => entry !== winner && entry.bytes < winner.bytes && Math.abs(entry.passRate - winner.passRate) <= 0.10);
  const runnerUp = eligible.length ? eligible.reduce((best, entry) => entry.bytes < best.bytes ? entry : best) : ranking[1];
  return {
    suite: { id: suite.id, sha256: suiteSha256, count: suite.cases.length },
    ranking, winner, runnerUp,
    runnerUpReason: eligible.length ? 'smallest smaller model within 10 percentage points of winner' : 'second-ranked fallback; no smaller qualifying candidate',
    limitations: [
      'VRAM is total device use and includes Windows and other processes; peak delta is not exclusive per-process memory.',
      'Latency median uses only finite, non-negative measurements; failed requests without latency are excluded.',
      'License identifiers are copied from the pinned source metadata; review the original license text before redistribution.',
    ],
  };
}

function formatEntry(entry) {
  return `| ${entry.rank} | ${entry.model.slug} | ${entry.passed}/${entry.total} (${(entry.passRate * 100).toFixed(1)}%) | ${entry.nativeToolPassed}/${entry.nativeToolTotal} | ${entry.bytes} | ${entry.peakTotalMiB.toFixed(0)} MiB (${entry.peakDeltaMiB.toFixed(0)} MiB delta) | ${entry.medianLatencyMs.toFixed(0)} ms (${entry.validLatencyCount} valid) | ${entry.model.license} |`;
}

export function summarizeReport(selection, { runId }) {
  const winner = selection.winner;
  const second = selection.runnerUp;
  return [
    `# Candidate selection: ${runId}`,
    '',
    `Suite: ${selection.suite.id} (${selection.suite.count} cases, SHA-256 \`${selection.suite.sha256}\`).`,
    '',
    `Winner: **${winner.model.slug}** (${winner.passed}/${winner.total}, ${(winner.passRate * 100).toFixed(1)}%).`,
    second ? `Second retained candidate: **${second.model.slug}** (${second.bytes} GGUF bytes, ${(second.passRate * 100).toFixed(1)}% pass rate; ${selection.runnerUpReason}).` : 'No second candidate is available.',
    '',
    '| Rank | Candidate | Whole suite | Native tool planning | GGUF bytes | Peak total (delta) | Median latency | Original license flag |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |',
    ...selection.ranking.map(formatEntry),
    '',
    '## Category passes',
    '',
    '| Candidate | Category | Passed |',
    '| --- | --- | ---: |',
    ...selection.ranking.flatMap(entry => Object.entries(entry.categories).map(([category, value]) =>
      `| ${entry.model.slug} | ${category} | ${value.passed}/${value.total} |`)),
    '',
    '## Limitations',
    ...selection.limitations.map(item => `- ${item}`),
    '',
  ].join('\n');
}

export function selectionSnapshot(selection) {
  const withoutReport = ({ report, ...entry }) => entry;
  return {
    ...selection,
    ranking: selection.ranking.map(withoutReport),
    winner: withoutReport(selection.winner),
    runnerUp: withoutReport(selection.runnerUp),
  };
}

function validateRunId(runId) {
  if (!runIdPattern.test(runId) || runId.includes('..')) throw new Error('Invalid run id');
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function loadArtifactReceipt(resultDirectory, modelDirectory, slug) {
  const archivedPath = resolve(resultDirectory, 'artifacts', `${slug}.json`);
  try {
    return await loadJson(archivedPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return loadJson(resolve(modelDirectory, 'artifact.json'));
}

async function main(args) {
  if (args.length !== 2 || args[0] !== '--run-id') throw new Error('Usage: node scripts/summarize-candidates.mjs --run-id <id>');
  const runId = args[1];
  validateRunId(runId);
  const manifest = await loadJson(resolve(root, 'config/model-candidates-lock.json'));
  if (manifest.version !== 1 || !Array.isArray(manifest.models) || manifest.models.length !== allowedModels.size ||
      manifest.models.some(model => allowedModels.get(model.slug) !== model.originalId) ||
      new Set(manifest.models.map(model => model.slug)).size !== allowedModels.size) {
    throw new Error('Candidate manifest must contain exactly the six approved model IDs and slugs');
  }
  const suiteBytes = await readFile(resolve(root, 'eval/cases/document-benchmark-v1.json'));
  const suite = JSON.parse(suiteBytes);
  const suiteSha256 = createHash('sha256').update(suiteBytes).digest('hex');
  const resultDirectory = resolve(root, 'eval/results', runId);
  const reports = [];
  const artifacts = {};
  for (const model of manifest.models) {
    reports.push(await loadJson(resolve(resultDirectory, `${model.slug}.json`)));
    artifacts[model.slug] = await loadArtifactReceipt(
      resultDirectory,
      resolve(root, 'models/candidates', model.slug),
      model.slug,
    );
  }
  const selection = selectCandidates({ reports, models: manifest.models, suite, suiteSha256, artifacts });
  selection.runId = runId;
  const report = summarizeReport(selection, { runId });
  const selectionForDisk = selectionSnapshot(selection);
  await mkdir(resultDirectory, { recursive: true });
  await writeFile(resolve(resultDirectory, 'selection.json'), `${JSON.stringify(selectionForDisk, null, 2)}\n`);
  await writeFile(resolve(resultDirectory, 'REPORT.md'), report);
  console.log(`Winner: ${selection.winner.model.slug}; second retained candidate: ${selection.runnerUp?.model.slug ?? 'none'}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
