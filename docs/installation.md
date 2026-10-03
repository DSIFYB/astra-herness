# Local Installation

Verified on 4 October 2026, Asia/Qyzylorda. This is a development prototype,
not a packaged desktop installer. It uses the existing Codex-bundled Node.js
24.19.0 and Python 3.12.14 on this account. RTX 3050 Laptop GPU 6 GB and NVIDIA
driver 616.56 were detected; the driver was not replaced.

## Installed Components

| Component | Installed version or revision |
| --- | --- |
| DeepSeek Harness | 0.2.1-alpha.1, commit `5badb15009ae1756c3afe0ae0cef1faafc290ccc` |
| Portable Git | 2.56.0.windows.1 |
| pnpm / npm | 11.7.0 / 12.2.0 |
| llama.cpp | b11379, Windows CUDA 12.4 build with matching CUDA runtime DLLs |
| Qwen3.5-2B | Unsloth Q4_K_M GGUF, pinned revision and SHA-256 in runtime-lock.json |
| Document libraries | python-docx 1.2.0, Pillow 12.3.0, lxml 6.1.1 |

The GGUF is 1,280,835,840 bytes. Its SHA-256 was checked after downloading;
the Git and llama.cpp archives were also verified against the lock file.
The npm/pnpm archives were checked with their pinned SHA-512 integrity values.
Harness dependencies were installed using its frozen lockfile. Its complete
build exited successfully, including the CLI and web client. The upstream
checkout has no source modifications.

The document libraries were installed into `.runtime/python`, and each import
and pinned package version was verified. Installing these libraries does not
yet expose document-editing tools to the model. Vision projection weights
were not downloaded; only text input is configured and tested.

## Start

From the repository root in PowerShell:

```powershell
& .\scripts\start-local.ps1 -Open
```

The script starts services hidden, checks the expected local model, waits for
the authenticated Harness URL and prints log locations. `-Open` opens that URL.
Without `-Open`, no browser is launched. The URL token is local session data,
not a value to store in GitHub. A running Harness on port 3080 causes a clear
conflict message; the launcher does not kill existing processes.

For separate foreground processes, use two terminals:

```powershell
node scripts/start-model.mjs
node scripts/start-harness.mjs
```

The model binds to `127.0.0.1:8081`, the chat to `127.0.0.1:3080`. The model
requires the development bearer value `local-only`; this is not a production
credential. Neither service is intentionally exposed to the LAN.

The server uses the alias selected by `config/active-model.json` (currently
`qwen2.5-3b-instruct`), real context 8192, one inference slot,
temperature 0 and disabled thinking. The profile caps answers at 512 tokens.
The SDK reserves 4096 context tokens, making the earlier 4096-window hypothesis
unusable through this Harness version; see evaluation.md.

## Fresh Checkout

Provide Node.js 24.19+ and Python 3.12, then run:

```powershell
node scripts/bootstrap.mjs
```

The bootstrap downloads pinned portable tools and model weights, clones and
checks out the pinned upstream commit, installs dependencies and builds it.
It refuses to move an existing dirty upstream checkout to another commit.
On another machine, set `ASTRA_PYTHON` to the Python 3.12 executable if it is
not in PATH. `ASTRA_NODE` can select node.exe for the PowerShell launcher.
The current scripts retain this account's bundled Python path as a fallback;
they do not download Python or Node for arbitrary machines.

The baseline bootstrap installs Qwen3.5. The selected research candidate is
downloaded and converted separately using the instructions in
[candidate-benchmark.md](candidate-benchmark.md). The active-model resolver
checks its pinned revision, receipt, file size and SHA-256; a fresh checkout
without those weights fails clearly rather than silently substituting a model.
The selected Qwen2.5-3B is under the Qwen Research License, not Apache 2.0;
commercial use requires a separate license.

## Local Data And Product Scope

`.runtime/`, `models/`, `logs/` and `work/` are ignored by Git. They contain
dependencies, model weights, credentials, chat sessions, logs and working
documents. The default-directory policy for new first-use profiles points
inside `work/`; a previously registered workspace is not silently relocated.

`profiles/astra` uses the normal public CLI profile mechanism. It selects the
local model, retains chat/history/action views and the plugin manager UI,
and disables model-facing shell, general filesystem, web, subagent, workflow
and plugin-installation tools. All shipped agent presets are disabled; the
local preset currently contains only its persona. Telemetry providers are
disabled in this profile. Shared UI/backend dependencies remain installed,
so this is not yet a physically reduced Harness distribution.

Dedicated DOCX tools, working copies, revisions, undo, branding, packaging
and fine-tuning are still pending. Development subagents in Codex are separate
from the disabled model-facing subagent tools in the product.
