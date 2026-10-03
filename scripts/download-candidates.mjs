import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { download, downloadParallel, sha256 } from './download.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'config/model-candidates-lock.json');
const modelIds = [
  ['gpt2-xl', 'openai-community/gpt2-xl'],
  ['qwen2.5-3b-instruct', 'Qwen/Qwen2.5-3B-Instruct'],
  ['qwen2.5-coder-1.5b-instruct', 'Qwen/Qwen2.5-Coder-1.5B-Instruct'],
  ['qwen2.5-coder-3b-instruct', 'Qwen/Qwen2.5-Coder-3B-Instruct'],
  ['lfm2.5-1.2b-instruct', 'LiquidAI/LFM2.5-1.2B-Instruct'],
  ['lfm2.5-2.6b', 'LiquidAI/LFM2.5-2.6B'],
];
const allowedSlugs = new Set(modelIds.map(([slug]) => slug));
const weightsMinBytes = 256 * 1024 * 1024;
const maxAttempts = 3;
const rangeCount = Number(process.env.MODEL_DOWNLOAD_RANGES ?? 16);
if (!Number.isInteger(rangeCount) || rangeCount < 1 || rangeCount > 32) {
  throw new Error('MODEL_DOWNLOAD_RANGES must be an integer from 1 to 32.');
}

function safeRelativePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\\') || path.startsWith('/') || /[<>:"|?*\u0000-\u001f]/.test(path)) {
    throw new Error(`Unexpected repository path: ${JSON.stringify(path)}`);
  }
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Unexpected repository path: ${JSON.stringify(path)}`);
  }
  return path;
}

function isSelectedAsset(path) {
  if (path.includes('/')) return false;
  const file = basename(path).toLowerCase();
  if (file.endsWith('.safetensors')) return true;
  if (file === 'config.json' || file === 'generation_config.json' || file === 'preprocessor_config.json' ||
      file === 'tokenizer.json' || file === 'tokenizer_config.json' || file === 'special_tokens_map.json' ||
      file === 'added_tokens.json' || file === 'vocab.json' || file === 'vocab.txt' || file === 'merges.txt' ||
      file === 'tokenizer.model' || file === 'spiece.model') return true;
  if (file.endsWith('.index.json')) return true;
  if (/^chat_template.*\.(jinja|json|txt)$/.test(file)) return true;
  if (/^readme(?:\.[a-z0-9_-]+)?\.md$/.test(file)) return true;
  return /^licen[cs]e(?:\.[a-z0-9_-]+)?$/.test(file) || /^copying(?:\.[a-z0-9_-]+)?$/.test(file);
}

function lfsSha256(file) {
  const value = file.lfs?.sha256 ?? file.lfs?.oid ?? file.sha256;
  if (typeof value !== 'string') return null;
  const match = /^(?:sha256:)?([a-f0-9]{64})$/i.exec(value);
  return match?.[1].toLowerCase() ?? null;
}

async function discover([slug, originalId]) {
  const endpoint = `https://huggingface.co/api/models/${originalId}/revision/main?blobs=true`;
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Hugging Face metadata HTTP ${response.status} for ${originalId}`);
  const metadata = await response.json();
  const revision = metadata.sha;
  if (!/^[a-f0-9]{40}$/i.test(revision ?? '')) throw new Error(`No immutable commit revision for ${originalId}`);
  const allFiles = metadata.siblings ?? [];
  const selected = [];
  for (const entry of allFiles) {
    const path = safeRelativePath(entry.rfilename);
    if (!isSelectedAsset(path)) continue;
    const size = Number(entry.size ?? entry.lfs?.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Missing file size for ${originalId}/${path}`);
    const isWeight = path.toLowerCase().endsWith('.safetensors');
    const checksum = lfsSha256(entry);
    if (isWeight && !checksum) throw new Error(`Missing LFS SHA-256 for ${originalId}/${path}`);
    const blobId = typeof entry.blobId === 'string' && /^[a-f0-9]{40}$/i.test(entry.blobId)
      ? entry.blobId.toLowerCase()
      : null;
    selected.push({ path, size, sha256: checksum, blobId });
  }
  if (!selected.some(file => file.path.toLowerCase().endsWith('.safetensors'))) {
    throw new Error(`No original safetensors files found for ${originalId}`);
  }
  const license = metadata.cardData?.license;
  if (typeof license !== 'string' || !license) throw new Error(`No license metadata for ${originalId}`);
  selected.sort((a, b) => a.path.localeCompare(b.path));
  return {
    originalId,
    slug,
    revision: revision.toLowerCase(),
    license,
    files: selected,
    totalbytes: selected.reduce((total, file) => total + file.size, 0),
  };
}

async function plan() {
  const models = [];
  for (const identity of modelIds) {
    console.log(`Reading pinned repository metadata: ${identity[1]}`);
    models.push(await discover(identity));
  }
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify({ version: 1, models }, null, 2)}\n`);
  console.log(`Wrote ${manifestPath}`);
  for (const model of models) {
    console.log(`${model.slug}: ${model.files.length} files, ${(model.totalbytes / 1e9).toFixed(2)} GB, ${model.revision}`);
  }
}

async function gitBlobSha1(path, size) {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`blob ${size}\0`));
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function retry(operation, description) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxAttempts) throw new Error(`${description} failed after ${maxAttempts} attempts: ${error.message}`, { cause: error });
      const pauseMs = attempt * 2000;
      console.warn(`${description} failed (${attempt}/${maxAttempts}): ${error.message}; retrying in ${pauseMs / 1000}s`);
      await new Promise(resolveDelay => setTimeout(resolveDelay, pauseMs));
    }
  }
}

function validateManifest(manifest) {
  if (manifest.version !== 1 || !Array.isArray(manifest.models)) throw new Error(`Invalid candidate manifest: ${manifestPath}`);
  if (manifest.models.length !== modelIds.length) throw new Error('Candidate manifest does not contain all six expected models.');
  const seenModels = new Set();
  for (const model of manifest.models) {
    if (!allowedSlugs.has(model.slug) || !modelIds.some(([slug, id]) => slug === model.slug && id === model.originalId)) {
      throw new Error(`Unexpected model in candidate manifest: ${model.slug}`);
    }
    if (seenModels.has(model.slug)) throw new Error(`Duplicate model in candidate manifest: ${model.slug}`);
    seenModels.add(model.slug);
    if (!/^[a-f0-9]{40}$/i.test(model.revision ?? '') || !Array.isArray(model.files)) {
      throw new Error(`Invalid revision or file list for ${model.slug}`);
    }
    if (typeof model.license !== 'string' || !model.license) throw new Error(`Missing license for ${model.slug}`);
    let totalbytes = 0;
    for (const file of model.files) {
      safeRelativePath(file.path);
      if (!isSelectedAsset(file.path)) throw new Error(`Unexpected candidate file: ${file.path}`);
      if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error(`Invalid size for ${model.slug}/${file.path}`);
      if (file.path.endsWith('.safetensors') && !/^[a-f0-9]{64}$/i.test(file.sha256 ?? '')) {
        throw new Error(`Missing safetensors SHA-256 for ${model.slug}/${file.path}`);
      }
      if (file.blobId !== null && file.blobId !== undefined && !/^[a-f0-9]{40}$/i.test(file.blobId)) {
        throw new Error(`Invalid Git blob SHA-1 for ${model.slug}/${file.path}`);
      }
      totalbytes += file.size;
    }
    if (totalbytes !== model.totalbytes) throw new Error(`Incorrect totalbytes for ${model.slug}`);
  }
}

async function downloadModel(model) {
  if (!allowedSlugs.has(model.slug)) throw new Error(`Unexpected candidate model: ${model.slug}`);
  console.log(`Downloading ${model.originalId} at ${model.revision}`);
  for (const file of model.files) {
    const destination = resolve(root, 'models/candidates', model.slug, 'original', ...file.path.split('/'));
    const base = resolve(root, 'models/candidates', model.slug, 'original');
    if (destination !== base && !destination.startsWith(base + sep)) throw new Error(`Unsafe destination for ${file.path}`);
    const url = `https://huggingface.co/${model.originalId}/resolve/${model.revision}/${file.path.split('/').map(encodeURIComponent).join('/')}`;
    const description = `${model.slug}/${file.path}`;
    await retry(async () => {
      if (file.size >= weightsMinBytes) {
        await downloadParallel(url, destination, file.sha256, rangeCount);
      } else {
        await download(url, destination, file.sha256 ?? undefined);
      }
      if (file.sha256 && await sha256(destination) !== file.sha256) throw new Error('SHA-256 mismatch');
      if (!file.sha256 && file.blobId && await gitBlobSha1(destination, file.size) !== file.blobId) {
        throw new Error('Git blob SHA-1 mismatch');
      }
    }, description);
  }
}

const args = process.argv.slice(2);
if (args.includes('--plan')) {
  if (args.some(arg => arg !== '--plan')) throw new Error('Usage: node scripts/download-candidates.mjs [--plan | --model <slug>]');
  await plan();
} else {
  let selectedSlug;
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== '--model' || selectedSlug || !args[index + 1]) {
      throw new Error('Usage: node scripts/download-candidates.mjs [--plan | --model <slug>]');
    }
    selectedSlug = args[++index];
  }
  if (selectedSlug && !allowedSlugs.has(selectedSlug)) throw new Error(`Unknown model slug: ${selectedSlug}`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  validateManifest(manifest);
  const models = selectedSlug ? manifest.models.filter(model => model.slug === selectedSlug) : manifest.models;
  if (selectedSlug && models.length === 0) throw new Error(`Model ${selectedSlug} is not present in ${manifestPath}`);
  for (const model of models) await downloadModel(model);
}
