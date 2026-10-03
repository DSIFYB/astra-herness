# Astra Harness

Local Windows test environment based on DeepSeek Harness, with Qwen3.5-2B.

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

Twelve automated checks passed, and a Russian answer was verified through the
actual Harness chat. The model API smoke also passed a synthetic tool call and
result roundtrip. These checks are not a DOCX editing or model-quality benchmark.
See [evaluation notes](docs/evaluation.md).

This repository contains the product configuration, scripts and project decisions.
The upstream Harness checkout is a pinned build dependency, not an unversioned
copy. This test environment is not yet the final desktop installer or a trained
document agent.

## Project Documents

- [Decisions](docs/decisions.md)
- [Component audit](docs/component-audit.md)
- [Model selection](docs/model-selection.md)
