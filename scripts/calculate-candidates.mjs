import { open, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './download.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runIdPattern = /^[a-z0-9T_.-]{1,100}$/i;
const approvedModels = new Map([
  ['gpt2-xl', 'openai-community/gpt2-xl'],
  ['qwen2.5-3b-instruct', 'Qwen/Qwen2.5-3B-Instruct'],
  ['qwen2.5-coder-1.5b-instruct', 'Qwen/Qwen2.5-Coder-1.5B-Instruct'],
  ['qwen2.5-coder-3b-instruct', 'Qwen/Qwen2.5-Coder-3B-Instruct'],
  ['lfm2.5-1.2b-instruct', 'LiquidAI/LFM2.5-1.2B-Instruct'],
  ['lfm2.5-2.6b', 'LiquidAI/LFM2.5-2.6B'],
]);
const floatBytes = new Map([['F64', 8], ['F32', 4], ['F16', 2], ['BF16', 2]]);
const excludedBufferName = /(?:\.attn\.bias|\.masked_bias|\.rotary_emb\.inv_freq)$/;
const maxHeaderBytes = 64 * 1024 * 1024;

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function tensorMetrics(header) {
  ensure(header && typeof header === 'object' && !Array.isArray(header), 'Safetensors header must be a JSON object');
  let storedFloatParameters = 0;
  let excludedBufferElements = 0;
  for (const [name, tensor] of Object.entries(header)) {
    if (name === '__metadata__') continue;
    ensure(tensor && typeof tensor === 'object' && !Array.isArray(tensor), `Invalid tensor metadata for ${name}`);
    const bytes = floatBytes.get(tensor.dtype);
    if (bytes === undefined) continue;
    ensure(Array.isArray(tensor.shape), `Invalid tensor shape for ${name}`);
    let count = 1;
    for (const dimension of tensor.shape) {
      ensure(Number.isSafeInteger(dimension) && dimension >= 0, `Invalid tensor dimension for ${name}`);
      count *= dimension;
      ensure(Number.isSafeInteger(count), `Tensor element count is too large for ${name}`);
    }
    if (excludedBufferName.test(name)) excludedBufferElements += count;
    else storedFloatParameters += count;
    ensure(Number.isSafeInteger(storedFloatParameters) && Number.isSafeInteger(excludedBufferElements), 'Safetensors element count exceeds safe integer range');
  }
  return { storedFloatParameters, excludedBufferElements };
}

export function summarizeMeasurements(report) {
  ensure(report?.summary?.complete === true, 'Benchmark report is incomplete');
  ensure(Array.isArray(report.cases), 'Benchmark report has no case measurements');
  const latencies = report.cases.map(item => item?.result?.latencyMs).filter(value => Number.isFinite(value) && value >= 0);
  const rates = report.cases.map(item => item?.result?.timings?.predicted_per_second).filter(value => Number.isFinite(value) && value > 0);
  ensure(latencies.length > 0, 'Benchmark report has no valid case latency measurements');
  ensure(rates.length > 0, 'Benchmark report has no valid predicted_per_second measurements');

  const samples = report.vram?.samples;
  ensure(Number.isFinite(report.vram?.totalMiB) && report.vram.totalMiB > 0, 'Benchmark report has invalid VRAM capacity');
  ensure(Array.isArray(samples) && samples.length > 0, 'Benchmark report has no VRAM samples');
  ensure(samples.every(sample => Number.isFinite(sample?.usedMiB) && sample.usedMiB >= 0 && Number.isFinite(sample?.freeMiB) && sample.freeMiB >= 0), 'Benchmark report contains invalid VRAM samples');
  const peakMiB = Math.max(...samples.map(sample => sample.usedMiB));
  return {
    medianLatencyMs: median(latencies),
    p95LatencyMs: latencies.sort((a, b) => a - b)[Math.ceil(0.95 * latencies.length) - 1],
    medianTokensPerSecond: median(rates),
    totalCaseLatencyMs: latencies.reduce((sum, value) => sum + value, 0),
    peakMiB,
    minFreeMiB: Math.min(...samples.map(sample => sample.freeMiB)),
    guardMarginMiB: 5500 - peakMiB,
    peakPercentOfVRAM: peakMiB / report.vram.totalMiB * 100,
  };
}

async function loadJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function validateRunId(runId) {
  ensure(typeof runId === 'string' && runIdPattern.test(runId) && !runId.includes('..'), 'Invalid run id');
}

function validateManifest(manifest) {
  ensure(manifest?.version === 1 && Array.isArray(manifest.models) && manifest.models.length === approvedModels.size, 'Pinned model manifest must contain exactly the six approved models');
  ensure(new Set(manifest.models.map(model => model.slug)).size === approvedModels.size, 'Pinned model manifest contains duplicate slugs');
  for (const model of manifest.models) {
    ensure(typeof model.slug === 'string' && /^[a-z0-9][a-z0-9.-]*$/i.test(model.slug), 'Pinned model manifest contains an unsafe slug');
    ensure(approvedModels.get(model.slug) === model.originalId && typeof model.revision === 'string' && Array.isArray(model.files), `Invalid or unapproved pinned identity for ${model.slug}`);
    ensure(Number.isSafeInteger(model.totalbytes) && model.totalbytes >= 0, `Invalid pinned asset size for ${model.slug}`);
    let assets = 0;
    for (const file of model.files) {
      ensure(typeof file.path === 'string' && Number.isSafeInteger(file.size) && file.size >= 0, `Invalid pinned asset for ${model.slug}`);
      assets += file.size;
      ensure(Number.isSafeInteger(assets), `Pinned asset byte total exceeds safe integer range for ${model.slug}`);
    }
    ensure(assets === model.totalbytes, `Pinned asset byte totals do not match for ${model.slug}`);
  }
}

async function readSafetensorsHeader(path, slug, expectedFileSize) {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    ensure(size === expectedFileSize, `Original safetensors file size does not match the pinned manifest for ${slug}`);
    ensure(size >= 8, `Safetensors file is too short for ${slug}`);
    const prefix = Buffer.alloc(8);
    const { bytesRead: prefixBytes } = await file.read(prefix, 0, prefix.length, 0);
    ensure(prefixBytes === 8, `Could not read safetensors header length for ${slug}`);
    const headerLength = Number(prefix.readBigUInt64LE(0));
    ensure(headerLength > 0 && headerLength <= maxHeaderBytes && headerLength <= size - 8, `Invalid or oversized safetensors header for ${slug}`);
    const bytes = Buffer.alloc(headerLength);
    const { bytesRead } = await file.read(bytes, 0, headerLength, 8);
    ensure(bytesRead === headerLength, `Safetensors header is truncated for ${slug}`);
    let header;
    try { header = JSON.parse(bytes.toString('utf8')); }
    catch (error) { throw new Error(`Malformed safetensors header for ${slug}: ${error.message}`); }
    return tensorMetrics(header);
  } finally {
    await file.close();
  }
}

function validateReport(report, model, artifact, suite, suiteSha256) {
  const slug = model.slug;
  ensure(report?.model?.slug === slug && report.model.originalId === model.originalId && report.model.revision === model.revision,
    `Benchmark report identity does not match pinned manifest for ${slug}`);
  ensure(report.model.license === model.license, `Benchmark report license does not match pinned manifest for ${slug}`);
  ensure(report.model.quantization === 'Q4_K_M' && artifact?.originalId === model.originalId && artifact.revision === model.revision && artifact.quantization === 'Q4_K_M',
    `GGUF artifact identity does not match pinned manifest for ${slug}`);
  ensure(/^[a-f0-9]{64}$/i.test(artifact.sha256 ?? '') && Number.isSafeInteger(artifact.size) && artifact.size > 0 &&
    report.model.sha256 === artifact.sha256 && report.model.bytes === artifact.size,
    `Benchmark GGUF hash or size does not match artifact receipt for ${slug}`);
  ensure(report.suite?.id === suite.id && report.suite.sha256 === suiteSha256 && report.suite.count === suite.cases.length,
    `Benchmark suite identity, SHA-256, or case count is stale for ${slug}`);
  ensure(report.summary?.complete === true && Array.isArray(report.errors) && report.errors.length === 0,
    `Benchmark for ${slug} is incomplete or contains errors`);
  ensure(Array.isArray(report.cases) && report.cases.length === suite.cases.length, `Benchmark case count is incomplete for ${slug}`);
  const expected = new Map(suite.cases.map(item => [item.id, item.category]));
  const seen = new Set();
  for (const item of report.cases) {
    ensure(expected.has(item.id) && !seen.has(item.id) && expected.get(item.id) === item.category, `Unexpected, duplicate, or mismatched benchmark case for ${slug}: ${item.id}`);
    seen.add(item.id);
  }
  ensure(seen.size === expected.size, `Benchmark cases do not match the current suite for ${slug}`);
}

async function calculateRun(runId) {
  const manifest = await loadJson(resolve(root, 'config/model-candidates-lock.json'));
  validateManifest(manifest);
  const suitePath = resolve(root, 'eval/cases/document-benchmark-v1.json');
  const suiteBytes = await readFile(suitePath);
  const suite = JSON.parse(suiteBytes);
  const suiteSha256 = createHash('sha256').update(suiteBytes).digest('hex');
  const resultDirectory = resolve(root, 'eval/results', runId);
  const validated = [];
  for (const model of manifest.models) {
    const report = await loadJson(resolve(resultDirectory, `${model.slug}.json`));
    const artifact = await loadJson(resolve(root, 'models/candidates', model.slug, 'artifact.json'));
    validateReport(report, model, artifact, suite, suiteSha256);
    validated.push({ model, report });
  }
  const models = [];
  for (const { model, report } of validated) {
    const weightFiles = model.files.filter(file => file.path.endsWith('.safetensors'));
    ensure(weightFiles.length > 0, `No pinned safetensors files for ${model.slug}`);
    let pinnedWeightBytes = 0;
    let storedFloatParameters = 0;
    let excludedBufferElements = 0;
    for (const file of weightFiles) {
      ensure(Number.isSafeInteger(file.size) && file.size >= 0 && /^[a-f0-9]{64}$/i.test(file.sha256 ?? ''), `Invalid pinned weight size or hash for ${model.slug}/${file.path}`);
      pinnedWeightBytes += file.size;
      ensure(Number.isSafeInteger(pinnedWeightBytes), `Pinned weight byte total exceeds safe integer range for ${model.slug}`);
      const originalDirectory = resolve(root, 'models/candidates', model.slug, 'original');
      const originalPath = resolve(originalDirectory, file.path);
      ensure(originalPath.startsWith(originalDirectory + sep), `Unsafe original weight path for ${model.slug}`);
      ensure(await sha256(originalPath) === file.sha256.toLowerCase(), `Original safetensors SHA-256 mismatch for ${model.slug}/${file.path}`);
      const metrics = await readSafetensorsHeader(originalPath, model.slug, file.size);
      storedFloatParameters += metrics.storedFloatParameters;
      excludedBufferElements += metrics.excludedBufferElements;
      ensure(Number.isSafeInteger(storedFloatParameters) && Number.isSafeInteger(excludedBufferElements), `Safetensors element total exceeds safe integer range for ${model.slug}`);
    }
    const assets = model.files.reduce((sum, file) => sum + file.size, 0);
    ensure(assets === model.totalbytes && pinnedWeightBytes > 0, `Pinned asset byte totals do not match for ${model.slug}`);
    const measurements = summarizeMeasurements(report);
    const p = storedFloatParameters;
    ensure(p > 0, `No stored floating-point parameters found for ${model.slug}`);
    models.push({
      slug: model.slug,
      originalId: model.originalId,
      revision: model.revision,
      storedFloatParameters: p,
      excludedBufferElements,
      originalWeightBytes: pinnedWeightBytes,
      originalAssetsBytes: assets,
      ggufBytes: report.model.bytes,
      fp16WeightEstimateBytes: 2 * p,
      ideal4BitWeightEstimateBytes: Math.ceil(p / 2),
      effectiveGGUFBitsPerParameter: 8 * report.model.bytes / p,
      originalToGGUFCompression: pinnedWeightBytes / report.model.bytes,
      ...measurements,
    });
  }
  const output = { version: 1, runId, models };
  const outputPath = resolve(resultDirectory, 'calculations.json');
  const directoryStat = await stat(resultDirectory);
  ensure(directoryStat.isDirectory(), 'Benchmark result path is not a directory');
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: 'w' });
  return output;
}

async function main(args) {
  ensure(args.length === 2 && args[0] === '--run-id', 'Usage: node scripts/calculate-candidates.mjs --run-id <safeid>');
  validateRunId(args[1]);
  const output = await calculateRun(args[1]);
  console.log(`Calculated metrics for ${output.models.length} candidates in run ${output.runId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
