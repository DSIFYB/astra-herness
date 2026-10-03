import assert from 'node:assert/strict';
import { summarizeMeasurements, tensorMetrics } from '../scripts/calculate-candidates.mjs';
import test from 'node:test';

test('safetensors metrics count floating weights and separate known buffer tensors', () => {
  const metrics = tensorMetrics({
    __metadata__: { format: 'pt' },
    dense: { dtype: 'F32', shape: [2, 3] },
    half: { dtype: 'F16', shape: [4] },
    brain: { dtype: 'BF16', shape: [2] },
    scalar: { dtype: 'F64', shape: [] },
    'layer.attn.bias': { dtype: 'F32', shape: [2, 3] },
    'layer.masked_bias': { dtype: 'F16', shape: [4] },
    'layer.rotary_emb.inv_freq': { dtype: 'BF16', shape: [2] },
    integer_ids: { dtype: 'I64', shape: 'ignored for float count' },
    quantized: { dtype: 'U8', shape: null },
  });
  assert.deepEqual(metrics, { storedFloatParameters: 13, excludedBufferElements: 12 });
});

test('safetensors metrics reject invalid headers and malformed floating tensor shapes', () => {
  for (const invalid of [null, [], 'not an object']) {
    assert.throws(() => tensorMetrics(invalid), /Safetensors header/);
  }
  assert.throws(() => tensorMetrics({ weight: null }), /Invalid tensor metadata/);
  assert.throws(() => tensorMetrics({ weight: { dtype: 'F32', shape: '2x3' } }), /Invalid tensor shape/);
  assert.throws(() => tensorMetrics({ weight: { dtype: 'F32', shape: [-1, 3] } }), /Invalid tensor dimension/);
  assert.throws(() => tensorMetrics({ weight: { dtype: 'F32', shape: [Number.MAX_SAFE_INTEGER, 2] } }), /too large/);
});

function sampleReport() {
  return {
    summary: { complete: true },
    cases: [10, 20, 30, 40, 100].map((latencyMs, index) => ({
      result: { latencyMs, timings: { predicted_per_second: [1, 5, 3, 9, 7][index] } },
    })),
    vram: {
      totalMiB: 6144,
      samples: [
        { usedMiB: 2000, freeMiB: 4144 },
        { usedMiB: 3000, freeMiB: 3144 },
        { usedMiB: 2500, freeMiB: 3644 },
      ],
    },
  };
}

test('measurement summary uses median, nearest-rank p95, rate median and VRAM guard arithmetic', () => {
  assert.deepEqual(summarizeMeasurements(sampleReport()), {
    medianLatencyMs: 30,
    p95LatencyMs: 100,
    medianTokensPerSecond: 5,
    totalCaseLatencyMs: 200,
    peakMiB: 3000,
    minFreeMiB: 3144,
    guardMarginMiB: 2500,
    peakPercentOfVRAM: 3000 / 6144 * 100,
  });
});

test('measurement summary refuses incomplete reports or missing and invalid measurements', () => {
  const incomplete = sampleReport();
  incomplete.summary.complete = false;
  assert.throws(() => summarizeMeasurements(incomplete), /incomplete/i);

  const noLatency = sampleReport();
  for (const item of noLatency.cases) item.result.latencyMs = NaN;
  assert.throws(() => summarizeMeasurements(noLatency), /latency measurements/);

  const noRate = sampleReport();
  for (const item of noRate.cases) item.result.timings.predicted_per_second = 0;
  assert.throws(() => summarizeMeasurements(noRate), /predicted_per_second measurements/);

  const noSamples = sampleReport();
  noSamples.vram.samples = [];
  assert.throws(() => summarizeMeasurements(noSamples), /no VRAM samples/);

  const badSample = sampleReport();
  badSample.vram.samples[1].freeMiB = Infinity;
  assert.throws(() => summarizeMeasurements(badSample), /invalid VRAM samples/);

  const noCapacity = sampleReport();
  noCapacity.vram.totalMiB = 0;
  assert.throws(() => summarizeMeasurements(noCapacity), /VRAM capacity/);
});
