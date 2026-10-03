# Candidate Benchmark

Status: completed on 2026-10-04 (Asia/Qyzylorda), run
`candidate-benchmark-2026-10-04-v1`: all six candidates, 150 cases.

| Candidate | Passed | Sampled peak total GPU |
| --- | ---: | ---: |
| Qwen2.5-3B-Instruct | 16/25 (64%) | 2161 MiB |
| LFM2.5-1.2B-Instruct | 10/25 (40%) | 905 MiB |
| LFM2.5-2.6B | 4/25 (16%) | 1827 MiB |
| Qwen2.5-Coder-3B-Instruct | 3/25 (12%) | 2161 MiB |
| Qwen2.5-Coder-1.5B-Instruct | 1/25 (4%) | 1209 MiB |
| GPT2-XL | 0/25 (0%) | 1545 MiB |

The first two candidates above are retained with original safetensors and
Q4_K_M artifacts. The other four candidate directories were deleted only after
all reports, source metadata/licenses, receipts and calculations were archived.
`cleanup.json` records 26,902,529,888 removed bytes (about 25.06 GiB). Existing
Qwen3.5 baseline files were not in the deletion scope; its server remains off.

The [PDF report](../output/pdf/astra-model-benchmark.pdf) includes calculations,
graphs and limitations. Raw evidence lives under
`eval/results/candidate-benchmark-2026-10-04-v1`. The separately archived initial
runs with Qwen3.5 consuming 1483 MiB are not used in this ranking.

The winner is connected to Astra for local research at context 8192, not cleared
for real document edits. Its separate integration smoke produced an incorrect
Harness answer and failed the native tool roundtrip. `integration.json` and both
API smoke reports preserve those failures. Do not conflate a completed benchmark
with passed production acceptance tests.

## Inputs

The six user-requested Hugging Face repositories are pinned by commit and file
hash in `config/model-candidates-lock.json`. Original safetensors are downloaded
without repository Python code or pickle checkpoints. Those originals are kept
for retained candidates; this process does not fine-tune any model.

The pinned llama.cpp b11379 converter runs on CPU, producing F16 GGUF and then
Q4_K_M. Intermediate F16 is removed only after quantization and verification.
Each final GGUF has a hash and conversion receipt. Python dependencies are in
`config/model-tools-requirements.txt`.

## Comparison Rules

The frozen synthetic suite has 25 Russian document-work cases: exact edit plans,
JSON and table extraction, clarification, native tool calls, and tool-result
follow-up. A case passes only when all mandatory checks pass. Diagnostic partial
check scores do not determine the ranking. There is no model-based judge.

All candidates use temperature 0, seed 42, one slot, and a 384-token output cap.
Chat models use their own native templates and a 4096-token context. GPT2-XL is a
base continuation model, not a chat model: it uses native completions and its
1024-token context. Its protocol limitations are reported separately from text
quality. HTTP, loading, monitoring, and output-cutoff errors remain visible.

Retain at most two candidates, ranked by complete-case passes. Ties are broken
by native-tool pass count, then measured peak VRAM increase, then median latency.
A smaller candidate may occupy the second slot if its pass rate is within ten
percentage points of the leading candidate. License restrictions are checked
before adopting a candidate into the product. An incomplete run is not eligible
for selection or loser deletion.

These results apply only to this test set, quantization, and runtime. They do not
establish broad model superiority, safe real-file editing, or trainability.

## VRAM Safety

Hardware: RTX 3050 Laptop, 6144 MiB VRAM. Candidates run sequentially on port
8082, separate from the current app. `nvidia-smi` is sampled every second and
between cases. Total-device use above 5500 MiB, or failed monitoring, aborts the
request and stops only the benchmark-owned process. Loading requires enough
reported free memory for the GGUF plus a 512 MiB minimum buffer allowance.

Reports include baseline, peak total device use, peak increase, and all samples.
Total use includes Windows and other running services; the increase is not a
precise per-process allocation. Sub-second spikes may escape sampling. Ctrl+C
also stops the owned candidate. Conversion uses CPU-only PyTorch.

## Commands

Candidate conversion requires a separate CPU-only Python 3.12 virtual
environment at `.runtime/model-tools`. Install CPU PyTorch from the official
CPU wheel index, then the exact package versions in
`config/model-tools-requirements.txt`. The converter source must be a clean
llama.cpp checkout at `.runtime/llama-source`, commit
`1537a0a8b2f8711d840878b0a0677ab2213c882c` (b11379). The preparation script
checks these versions and the source revision before conversion. The normal
product bootstrap does not download all six research candidates.

The first two artifacts used Transformers 4.57.6; the remaining artifacts
use 5.0.0 to support LFM2.5-2.6B's tokenizer metadata. Each archived receipt
records its actual environment. Rebuilding an older artifact under newer
package pins requires a fresh candidate output, not silent receipt reuse.

GPT2-XL needs a local compatibility wrapper, `scripts/convert-gpt2.py`: the
pinned converter incorrectly tries to map stored `.attn.bias` and
`.attn.masked_bias` buffers. The wrapper omits only these deterministic attention
mask buffers and delegates every learned tensor unchanged to the upstream
converter. It does not modify the original checkpoint or the pinned source
checkout. The GPT2 receipt records the wrapper's SHA-256 separately.

```powershell
node scripts/download-candidates.mjs --model lfm2.5-1.2b-instruct
node scripts/prepare-candidates.mjs --model lfm2.5-1.2b-instruct
node scripts/benchmark-candidates.mjs --model lfm2.5-1.2b-instruct --run-id candidate-benchmark-v1
node scripts/summarize-candidates.mjs --run-id candidate-benchmark-v1
node scripts/calculate-candidates.mjs --run-id candidate-benchmark-v1
```

Run the last two commands only after all six reports are complete. Calculations
verify the original safetensors hashes and read tensor shapes from their bounded
JSON headers. They report stored floating-point elements, not a guarantee of
unique trainable parameter count. FP16 and ideal 4-bit estimates cover weights
only, not training, KV cache, activations or optimizer memory. Archive receipts
under the run's `artifacts/` directory before deleting any candidate. Selection
can subsequently be regenerated from those archived receipts; recalculating
tensor shapes still requires the original weights.

Run every candidate with the same run ID and suite. Reports under `eval/results`
contain synthetic prompts' responses, grading, timing, and VRAM samples. Local
downloaded weights and runtime logs remain excluded from Git. Only downloaded
loser directories inside `models/candidates` may be removed after all six runs
have complete reports; existing baseline models and user files are preserved.
