import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { loadArtifactReceipt, selectCandidates, selectionSnapshot, summarizeReport } from '../scripts/summarize-candidates.mjs';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(resolve(root, 'config/model-candidates-lock.json'), 'utf8'));
const suiteBytes = await readFile(resolve(root, 'eval/cases/document-benchmark-v1.json'));
const suite = JSON.parse(suiteBytes);
const suiteSha256 = createHash('sha256').update(suiteBytes).digest('hex');
const models = manifest.models;
const toolsCases = suite.cases.filter(testCase => testCase.category === 'native_tool_planning');

function createArtifacts(sizes = []) {
  return Object.fromEntries(models.map((model, index) => [model.slug, {
    originalId: model.originalId,
    revision: model.revision,
    quantization: 'Q4_K_M',
    sha256: (index + 1).toString(16).padStart(64, '0'),
    size: sizes[index] ?? (1000 + index),
  }]));
}

function createReport(model, artifact, {
  passedCount = 12,
  nativeToolPassed = 0,
  deltaMiB = 200,
  latencyMs = 100,
} = {}) {
  const passIds = new Set(toolsCases.slice(0, nativeToolPassed).map(testCase => testCase.id));
  for (const testCase of suite.cases) {
    if (passIds.size >= passedCount) break;
    if (testCase.category !== 'native_tool_planning') passIds.add(testCase.id);
  }
  for (const testCase of toolsCases) {
    if (passIds.size >= passedCount) break;
    passIds.add(testCase.id);
  }
  const cases = suite.cases.map(testCase => ({
    id: testCase.id,
    category: testCase.category,
    result: { latencyMs },
    grade: { passed: passIds.has(testCase.id), score: passIds.has(testCase.id) ? 1 : 100, maxScore: 100 },
  }));
  const categories = {};
  for (const item of cases) {
    const group = categories[item.category] ??= { passed: 0, total: 0 };
    group.total++;
    if (item.grade.passed) group.passed++;
  }
  const passed = cases.filter(item => item.grade.passed).length;
  return {
    model: {
      slug: model.slug,
      originalId: model.originalId,
      revision: model.revision,
      license: model.license,
      quantization: 'Q4_K_M',
      sha256: artifact.sha256,
      bytes: artifact.size,
    },
    suite: { id: suite.id, sha256: suiteSha256, count: suite.cases.length },
    errors: [],
    cases,
    summary: {
      passed,
      total: suite.cases.length,
      percentage: passed / suite.cases.length * 100,
      complete: true,
      categories,
    },
    vram: { beforeMiB: 1000, peakTotalMiB: 1000 + deltaMiB, peakDeltaMiB: deltaMiB, totalMiB: 6144 },
  };
}

function makeSelection(overrides = {}, sizes = []) {
  const artifacts = createArtifacts(sizes);
  const reports = models.map((model, index) => createReport(model, artifacts[model.slug], overrides[index]));
  const selection = selectCandidates({ reports, models, suite, suiteSha256, artifacts });
  return { selection, reports, artifacts };
}

test('selection requires complete reports for all six pinned candidates', () => {
  const { reports, artifacts } = makeSelection();
  assert.throws(
    () => selectCandidates({ reports: reports.slice(0, 5), models, suite, suiteSha256, artifacts }),
    /one complete report for every pinned model/,
  );
  const { selection } = makeSelection();
  assert.equal(selection.ranking.length, 6);
  assert.equal(selection.winner.total, suite.cases.length);
});

test('persisted selection drops full reports while retaining ranking metadata', () => {
  const { selection } = makeSelection();
  const snapshot = selectionSnapshot(selection);
  assert.equal(selection.ranking[0].report.cases.length, suite.cases.length);
  for (const entry of snapshot.ranking) {
    assert.equal(Object.hasOwn(entry, 'report'), false);
    assert.equal(typeof entry.rank, 'number');
    assert.equal(entry.model.sha256, selection.ranking.find(item => item.model.slug === entry.model.slug).report.model.sha256);
    assert.equal(typeof entry.model.sha256, 'string');
    assert.equal(typeof entry.peakDeltaMiB, 'number');
    assert.ok(entry.categories);
  }
  assert.equal(Object.hasOwn(snapshot.winner, 'report'), false);
  assert.equal(Object.hasOwn(snapshot.runnerUp, 'report'), false);
  assert.equal(snapshot.winner.rank, selection.winner.rank);
  assert.equal(snapshot.runnerUp.model.slug, selection.runnerUp.model.slug);
});

test('run archive artifact receipts take precedence, with current receipt as fallback', async t => {
  const root = await mkdtemp(resolve(os.tmpdir(), 'candidate-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const resultDirectory = resolve(root, 'run');
  const modelDirectory = resolve(root, 'model');
  await mkdir(resolve(resultDirectory, 'artifacts'), { recursive: true });
  await mkdir(modelDirectory, { recursive: true });
  const archived = { originalId: 'archived/model', revision: 'archive-revision', quantization: 'Q4_K_M', sha256: 'a'.repeat(64), size: 10 };
  const current = { originalId: 'current/model', revision: 'current-revision', quantization: 'Q4_K_M', sha256: 'b'.repeat(64), size: 20 };
  await writeFile(resolve(resultDirectory, 'artifacts/test-model.json'), JSON.stringify(archived));
  await writeFile(resolve(modelDirectory, 'artifact.json'), JSON.stringify(current));
  assert.deepEqual(await loadArtifactReceipt(resultDirectory, modelDirectory, 'test-model'), archived);
  await rm(resolve(resultDirectory, 'artifacts/test-model.json'));
  assert.deepEqual(await loadArtifactReceipt(resultDirectory, modelDirectory, 'test-model'), current);
});

test('selection rejects report errors and report suites or revisions from another run', () => {
  for (const mutate of [
    report => { report.errors = ['worker failed']; report.summary.complete = false; },
    report => { report.suite.sha256 = 'f'.repeat(64); },
    report => { report.model.revision = '0'.repeat(40); },
  ]) {
    const { reports, artifacts } = makeSelection();
    mutate(reports[0]);
    assert.throws(
      () => selectCandidates({ reports, models, suite, suiteSha256, artifacts }),
      /Invalid benchmark report .*?(?:incomplete or contains errors|suite id, fixture SHA-256|model\.revision)/,
    );
  }
});

test('ranking counts whole passing cases, not diagnostic partial points', () => {
  const { selection } = makeSelection({
    0: { passedCount: 12 },
    1: { passedCount: 13 },
  });
  assert.equal(selection.winner.model.slug, models[1].slug);
  assert.equal(selection.ranking[0].passed, 13);
  assert.equal(selection.ranking.find(entry => entry.model.slug === models[0].slug).passed, 12);
});

test('ranking ties break by native-tool pass rate, VRAM delta, latency, then manifest order', () => {
  const { selection } = makeSelection({
    0: { passedCount: 15, nativeToolPassed: 1, deltaMiB: 0, latencyMs: 1 },
    1: { passedCount: 15, nativeToolPassed: 3, deltaMiB: 500, latencyMs: 1 },
    2: { passedCount: 15, nativeToolPassed: 3, deltaMiB: 400, latencyMs: 100 },
    3: { passedCount: 15, nativeToolPassed: 3, deltaMiB: 400, latencyMs: 20 },
    4: { passedCount: 15, nativeToolPassed: 3, deltaMiB: 400, latencyMs: 100 },
    5: { passedCount: 15, nativeToolPassed: 0, deltaMiB: 0, latencyMs: 0 },
  });
  assert.deepEqual(selection.ranking.map(entry => entry.model.slug), [
    models[3].slug, models[2].slug, models[4].slug, models[1].slug, models[0].slug, models[5].slug,
  ]);
});

test('smaller alternative must be smaller and within ten percentage points of winner', () => {
  const sizes = [100, 20, 30, 5, 1, 2];
  const { selection } = makeSelection({
    0: { passedCount: 25 },
    1: { passedCount: 23 },
    2: { passedCount: 23, deltaMiB: 100 },
    3: { passedCount: 22 },
    4: { passedCount: 10 },
    5: { passedCount: 9 },
  }, sizes);
  assert.equal(selection.winner.model.slug, models[0].slug);
  assert.equal(selection.runnerUp.model.slug, models[1].slug);
  assert.equal(selection.runnerUp.passRate, 23 / 25);
  assert.ok(selection.runnerUp.bytes < selection.winner.bytes);
  assert.ok(Math.abs(selection.runnerUp.passRate - selection.winner.passRate) <= 0.10);
  assert.notEqual(selection.runnerUp.model.slug, models[3].slug);
});

test('markdown summary shows the selected winner, smaller alternative, and limitations', () => {
  const { selection } = makeSelection({
    0: { passedCount: 25 },
    1: { passedCount: 23 },
  }, [100, 20, 30, 5, 1, 2]);
  const summary = summarizeReport(selection, { runId: 'synthetic-test' });
  assert.match(summary, /Candidate selection: synthetic-test/);
  assert.match(summary, new RegExp(`Winner: \\*\\*${models[0].slug}\\*\\*`));
  assert.match(summary, new RegExp(`Second retained candidate: \\*\\*${models[1].slug}\\*\\*`));
  assert.match(summary, /Limitations/);
  assert.match(summary, /total device use/i);
  assert.match(summary, /Category passes/);
});
