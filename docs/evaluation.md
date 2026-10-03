# First Local Evaluation

Verified on 4 October 2026, Asia/Qyzylorda. JSON filenames use UTC timestamps.

## Passed Checks

`node --test tests/*.test.mjs`: 12 passed, 0 failed, 0 skipped on the installed
environment. Nine tests exercise downloads, cached files, resume, HTTP errors,
parallel ranges, fallback and integrity failures. Three checks cover profile
context alignment, disabled tools/presets and the installed SDK token clamp.
The SDK-specific check skips when the upstream dependencies are not installed.

`node scripts/test-model.mjs --save`: three model-API checks passed:

1. The Russian capital question returned `Астана`.
2. The model requested `lookup_synthetic_record` with `{ "id": 17 }`.
3. After a synthetic tool result, the reply contained `SYNTHETIC_RECORD_17_OK`.

The final run with context 8192 and server temperature 0 is saved in
`eval/results/model-smoke-2026-10-03T19-21-05.321Z.json`. These are synthetic
protocol checks, not document operations. No external account or user document
was sent to the local model during these checks.

The actual Harness browser chat was also exercised with preset `astra-local`
and model `Qwen3.5-2B Q4_K_M`: it returned `Астана` and completed normally.
A local screenshot is kept under ignored `work/harness-smoke.jpg`.

## Issues Found And Corrected

The first browser test at context 4096 was capped at one output token. The
installed pi-ai SDK subtracts a 4096-token safety reserve before choosing an
output budget. Both the real server and the profile now use 8192, leaving the
configured 512-token answer budget for short inputs. A regression test proves
the old clamp-to-1 case and the corrected clamp-to-512 case. Longer conversations
still require context handling; this is not a claim of unlimited document size.

At the default server temperature 0.8, several short factual answers were wrong.
At temperature 0, the same profile prompt returned the correct answer. The
server default is now 0. This does not establish general factual reliability.

The combined PowerShell launcher was exercised end to end. A race on reading
an initially empty stdout log was found and fixed by treating it as an empty
string. The corrected launch completed and printed its authenticated chat URL.

## Not Yet Evaluated

Real DOCX edits, tables/images, target selection, revision/undo, multi-step
document tasks, long sessions, latency distributions and peak memory were not
benchmarked. No fine-tuning, LoRA training or vision input test was performed.
Qwen3.5-2B remains the first test candidate, not a confirmed release choice.
