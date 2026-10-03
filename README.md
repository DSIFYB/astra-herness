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

This repository contains the product configuration, scripts and project decisions.
The upstream Harness checkout is a pinned build dependency, not an unversioned
copy. This test environment is not yet the final desktop installer or a trained
document agent.

## Project Documents

- [Decisions](docs/decisions.md)
- [Component audit](docs/component-audit.md)
- [Model selection](docs/model-selection.md)
