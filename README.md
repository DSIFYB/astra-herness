# Astra Harness

Local Windows research environment based on DeepSeek Harness. The six-candidate
comparison selected Qwen2.5-3B-Instruct; LFM2.5-1.2B-Instruct is retained as the
second candidate. Qwen3.5 is stopped, with its baseline files preserved.

The first target is creating and editing DOCX documents. The agreed composition
keeps chat, session history, action logs and the plugin manager. Model-facing
shell, coding tools, subagents, scheduling and web search are excluded from the
first local profile. Document copies, revisions and undo require dedicated tools.

## Installation

Runtime versions, model provenance and download hashes are pinned in
`config/runtime-lock.json`. Portable tools and downloaded model weights live in
`.runtime/` and `models/`; they are excluded from Git. Installation and validation
results are recorded in `docs/installation.md` as they become available.

The local environment has been installed and built on Windows. With Node.js
24.19+ and Python 3.12 available, a fresh checkout can be prepared with:

```powershell
node scripts/bootstrap.mjs
```

Start both local services in hidden windows and open the authenticated chat:

```powershell
& .\scripts\start-local.ps1 -Open
```

The launcher prints a session-specific URL. It checks the model on port 8081
and reports conflicts on port 3080 without stopping other processes. Do not
share or commit the URL token. See [installation details](docs/installation.md)
for prerequisites, paths and separate foreground commands.

## Verification

```powershell
node --test tests/*.test.mjs
node scripts/test-model.mjs --save
```

All six candidates completed 25 synthetic cases each. Qwen2.5-3B-Instruct passed
16/25 (64%); LFM2.5-1.2B-Instruct passed 10/25 (40%). Four other candidates' local
weights were removed after evidence and calculations were archived. The latest
Node suite passed 44 checks, plus two Python converter-wrapper tests.

The selected model is not production-ready: the separate Harness smoke returned
an incorrect factual answer, and native tool roundtrip remained unreliable.
No DOCX editing tools or fine-tuning are implemented. See the
[PDF report](output/pdf/astra-model-benchmark.pdf),
[benchmark protocol/results](docs/candidate-benchmark.md) and
[historical evaluation notes](docs/evaluation.md).

`config/active-model.json` pins the selected local GGUF. A fresh checkout needs
the candidate tooling and that candidate's download/conversion in addition to
the baseline bootstrap; the weights themselves are not stored in GitHub.
Qwen2.5-3B's research license requires separate permission for commercial use.

This repository contains the product configuration, scripts and project decisions.
The upstream Harness checkout is a pinned build dependency, not an unversioned
copy. This test environment is not yet the final desktop installer or a trained
document agent.

## Project Documents

- [Decisions](docs/decisions.md)
- [Component audit](docs/component-audit.md)
- [Model selection](docs/model-selection.md)
- [Six-candidate benchmark and VRAM limits](docs/candidate-benchmark.md)
