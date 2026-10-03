import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { existsSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootPath = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const approved = new Map([
  ['gpt2-xl', 'openai-community/gpt2-xl'],
  ['qwen2.5-3b-instruct', 'Qwen/Qwen2.5-3B-Instruct'],
  ['qwen2.5-coder-1.5b-instruct', 'Qwen/Qwen2.5-Coder-1.5B-Instruct'],
  ['qwen2.5-coder-3b-instruct', 'Qwen/Qwen2.5-Coder-3B-Instruct'],
  ['lfm2.5-1.2b-instruct', 'LiquidAI/LFM2.5-1.2B-Instruct'],
  ['lfm2.5-2.6b', 'LiquidAI/LFM2.5-2.6B'],
]);
const displayNames = new Map([
  ['gpt2-xl', 'GPT-2 XL'],
  ['qwen2.5-3b-instruct', 'Qwen2.5-3B Instruct'],
  ['qwen2.5-coder-1.5b-instruct', 'Qwen2.5 Coder 1.5B Instruct'],
  ['qwen2.5-coder-3b-instruct', 'Qwen2.5 Coder 3B Instruct'],
  ['lfm2.5-1.2b-instruct', 'LFM2.5 1.2B Instruct'],
  ['lfm2.5-2.6b', 'LFM2.5 2.6B'],
]);

export function validateActiveModel({ activeModel, manifest, receipt, actualSha256 }) {
  if (!activeModel || activeModel.version !== 1 || !approved.has(activeModel.slug) ||
      approved.get(activeModel.slug) !== activeModel.originalId) {
    throw new Error('Active model must identify one approved candidate (version 1, slug and originalId).');
  }
  if (activeModel.slug === 'gpt2-xl') throw new Error('GPT-2 XL is a base completion model and is not supported by the chat profile.');
  if (!Array.isArray(manifest?.models) || manifest.version !== 1 || manifest.models.length !== approved.size ||
      manifest.models.some(model => approved.get(model.slug) !== model.originalId) ||
      new Set(manifest.models.map(model => model.slug)).size !== approved.size) {
    throw new Error('Pinned candidate manifest does not match the approved six-model set.');
  }
  const pinned = manifest.models.find(model => model.slug === activeModel.slug);
  if (!pinned || activeModel.revision !== pinned.revision) throw new Error('Active model revision does not match the pinned manifest.');
  if (!/^[a-f0-9]{64}$/i.test(activeModel.sha256 ?? '') || !Number.isSafeInteger(activeModel.size) || activeModel.size <= 0) {
    throw new Error('Active model requires a valid SHA-256 and positive byte size.');
  }
  if (!receipt || receipt.originalId !== pinned.originalId || receipt.revision !== pinned.revision ||
      receipt.quantization !== 'Q4_K_M' || receipt.sha256 !== activeModel.sha256 || receipt.size !== activeModel.size) {
    throw new Error('Active model does not match its Q4_K_M artifact receipt.');
  }
  if (actualSha256 !== activeModel.sha256) throw new Error('Active GGUF file SHA-256 does not match active-model.json.');
  const displayName = displayNames.get(activeModel.slug);
  return {
    slug: activeModel.slug,
    originalId: pinned.originalId,
    revision: pinned.revision,
    alias: activeModel.slug,
    displayName: `${displayName} Local`,
    modelPathRelative: `models/candidates/${activeModel.slug}/model-Q4_K_M.gguf`,
    contextWindow: 8192,
    sha256: activeModel.sha256,
    size: activeModel.size,
  };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function loadModelConfig(projectRoot = rootPath) {
  const activePath = resolve(projectRoot, 'config/active-model.json');
  if (!existsSync(activePath)) {
    return {
      slug: 'qwen3.5-2b',
      originalId: null,
      revision: null,
      alias: 'qwen3.5-2b',
      displayName: 'Qwen3.5-2B Local',
      modelPath: resolve(projectRoot, 'models/Qwen3.5-2B-Q4_K_M.gguf'),
      contextWindow: 8192,
      sha256: null,
      size: null,
    };
  }

  const activeModel = JSON.parse(await readFile(activePath, 'utf8'));
  const manifest = JSON.parse(await readFile(resolve(projectRoot, 'config/model-candidates-lock.json'), 'utf8'));
  if (!approved.has(activeModel.slug)) throw new Error('Active model slug is not approved.');
  const modelDirectory = resolve(projectRoot, 'models/candidates', activeModel.slug);
  const modelPath = resolve(modelDirectory, 'model-Q4_K_M.gguf');
  const receiptPath = resolve(modelDirectory, 'artifact.json');
  const [canonicalRoot, canonicalModels, canonicalCandidates, canonicalDirectory, canonicalReceipt, canonicalModel] = await Promise.all([
    realpath(projectRoot),
    realpath(resolve(projectRoot, 'models')),
    realpath(resolve(projectRoot, 'models/candidates')),
    realpath(modelDirectory),
    realpath(receiptPath),
    realpath(modelPath),
  ]);
  if (canonicalModels !== resolve(canonicalRoot, 'models') ||
      canonicalCandidates !== resolve(canonicalRoot, 'models/candidates') ||
      canonicalDirectory !== resolve(canonicalCandidates, activeModel.slug) ||
      canonicalReceipt !== resolve(canonicalDirectory, 'artifact.json') ||
      canonicalModel !== resolve(canonicalDirectory, 'model-Q4_K_M.gguf')) {
    throw new Error('Active candidate paths escape the expected model directory layout.');
  }
  const directoryInfo = await lstat(modelDirectory);
  const receiptInfo = await lstat(receiptPath);
  const fileInfo = await lstat(modelPath);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !receiptInfo.isFile() || receiptInfo.isSymbolicLink() ||
      !fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size !== activeModel.size) {
    throw new Error('Active GGUF, candidate directory, or artifact receipt is missing, unsafe, or has the wrong size.');
  }
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const config = validateActiveModel({ activeModel, manifest, receipt, actualSha256: await sha256File(modelPath) });
  return { ...config, modelPath };
}

async function main(args) {
  if (args.length !== 1 || args[0] !== '--json') throw new Error('Usage: node scripts/model-config.mjs --json');
  console.log(JSON.stringify(await loadModelConfig()));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
