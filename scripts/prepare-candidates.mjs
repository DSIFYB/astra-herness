import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from './download.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidatesPath = resolve(root, 'config/model-candidates-lock.json');
const requirementsPath = resolve(root, 'config/model-tools-requirements.txt');
const converterSource = resolve(root, '.runtime/llama-source');
const converterPath = resolve(converterSource, 'convert_hf_to_gguf.py');
const gpt2WrapperPath = resolve(root, 'scripts/convert-gpt2.py');
const converterCommit = '1537a0a8b2f8711d840878b0a0677ab2213c882c';
const expectedCandidates = new Map([
  ['gpt2-xl', 'openai-community/gpt2-xl'],
  ['qwen2.5-3b-instruct', 'Qwen/Qwen2.5-3B-Instruct'],
  ['qwen2.5-coder-1.5b-instruct', 'Qwen/Qwen2.5-Coder-1.5B-Instruct'],
  ['qwen2.5-coder-3b-instruct', 'Qwen/Qwen2.5-Coder-3B-Instruct'],
  ['lfm2.5-1.2b-instruct', 'LiquidAI/LFM2.5-1.2B-Instruct'],
  ['lfm2.5-2.6b', 'LiquidAI/LFM2.5-2.6B'],
]);
const llamaBin = resolve(root, '.runtime/llama');
const quantizer = resolve(llamaBin, 'llama-quantize.exe');
const python = resolve(root, '.runtime/model-tools/Scripts/python.exe');
const git = resolve(root, '.runtime/git/ucrt64/bin/git.exe');
const gitBin = resolve(root, '.runtime/git/ucrt64/bin');

function safeRelativePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/') || /[<>:"|?*\u0000-\u001f]/.test(path)) {
    throw new Error(`Unexpected original asset path: ${JSON.stringify(path)}`);
  }
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Unexpected original asset path: ${JSON.stringify(path)}`);
  }
  return parts;
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} ${args.join(' ')} failed with exit code ${result.status}.`);
  return result;
}

function gitOutput(args) {
  return execFileSync(git, [
    `--exec-path=${gitBin}`,
    '-c', 'http.sslBackend=openssl',
    '-c', `safe.directory=${converterSource}`,
    '-C', converterSource,
    ...args,
  ], { cwd: root, encoding: 'utf8' }).trim();
}

function getPackagePins() {
  return readFile(requirementsPath, 'utf8').then(contents => contents.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('--'))
    .map(line => {
      const match = /^([A-Za-z0-9_.-]+)==([A-Za-z0-9.+-]+)$/.exec(line);
      if (!match) throw new Error(`Unexpected unpinned model-tools requirement: ${line}`);
      return [match[1], match[2]];
    }));
}

async function verifyRuntime() {
  for (const path of [converterPath, quantizer, python, git]) {
    if (!existsSync(path)) throw new Error(`Required model tooling is missing: ${path}`);
  }
  const actualCommit = gitOutput(['rev-parse', 'HEAD']);
  if (actualCommit !== converterCommit) {
    throw new Error(`llama.cpp source revision is ${actualCommit}; expected ${converterCommit}.`);
  }
  if (gitOutput(['status', '--porcelain'])) throw new Error('llama.cpp source checkout has local changes; refusing an unpinned conversion.');

  const pins = await getPackagePins();
  const checkCode = [
    'import importlib.metadata,json,sys',
    'pins=json.loads(sys.argv[1])',
    'actual={name:importlib.metadata.version(name) for name in pins}',
    'print(json.dumps({"python":sys.version.split()[0],"packages":actual}))',
  ].join('\n');
  const result = spawnSync(python, ['-c', checkCode, JSON.stringify(Object.fromEntries(pins))], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, CUDA_VISIBLE_DEVICES: '-1' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Could not inspect model-tools Python packages: ${result.stderr.trim()}`);
  const runtime = JSON.parse(result.stdout.trim());
  for (const [name, expected] of pins) {
    const actual = runtime.packages[name];
    if (actual !== expected && !(name === 'torch' && actual === `${expected}+cpu`)) {
      throw new Error(`.runtime/model-tools has ${name} ${actual}, expected ${expected}.`);
    }
  }
  return { python: runtime.python, packages: runtime.packages };
}

async function verifyOriginal(model, modelRoot) {
  const originalInfo = await lstat(modelRoot).catch(() => null);
  if (!originalInfo?.isDirectory() || originalInfo.isSymbolicLink()) {
    throw new Error(`Original model directory is missing or is not a real directory: ${modelRoot}`);
  }
  if ((await realpath(modelRoot)).toLowerCase() !== modelRoot.toLowerCase()) {
    throw new Error(`Original model directory resolves outside its expected location: ${modelRoot}`);
  }
  for (const file of model.files) {
    const parts = safeRelativePath(file.path);
    const path = resolve(modelRoot, ...parts);
    if (path !== modelRoot && !path.startsWith(modelRoot + sep)) throw new Error(`Unsafe original asset path: ${file.path}`);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`Missing or unsafe original asset: ${path}`);
    if ((await realpath(path)).toLowerCase() !== path.toLowerCase()) throw new Error(`Original asset resolves outside its expected location: ${path}`);
    if (info.size !== file.size) throw new Error(`Original asset size mismatch for ${model.slug}/${file.path}: ${info.size}, expected ${file.size}`);
    if (file.path.toLowerCase().endsWith('.safetensors')) {
      if (!/^[a-f0-9]{64}$/i.test(file.sha256 ?? '')) throw new Error(`Manifest has no safetensors SHA-256 for ${model.slug}/${file.path}`);
      if (await sha256(path) !== file.sha256.toLowerCase()) throw new Error(`Original safetensors SHA-256 mismatch for ${model.slug}/${file.path}`);
    }
  }
}

async function reuseIfVerified(model, runtime, receiptPath, artifactPath, wrapperSha256) {
  const receiptInfo = await lstat(receiptPath).catch(() => null);
  if (!receiptInfo) return false;
  if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink()) throw new Error(`Unsafe artifact receipt: ${receiptPath}`);
  let receipt;
  try {
    receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read artifact receipt ${receiptPath}: ${error.message}`);
  }
  const artifactInfo = await lstat(artifactPath).catch(() => null);
  if (!artifactInfo?.isFile() || artifactInfo.isSymbolicLink()) throw new Error(`Receipt exists but quantized model is missing or unsafe: ${artifactPath}`);
  if (receipt.slug !== model.slug || receipt.originalId !== model.originalId || receipt.revision !== model.revision ||
      receipt.converterCommit !== converterCommit || receipt.quantization !== 'Q4_K_M' || receipt.pythonVersion !== runtime.python) {
    throw new Error(`Existing receipt does not match the pinned candidate: ${receiptPath}`);
  }
  if (model.slug === 'gpt2-xl' && receipt.converterWrapperSha256 !== wrapperSha256) {
    throw new Error(`GPT-2 converter wrapper provenance mismatch: ${receiptPath}`);
  }
  if (model.slug !== 'gpt2-xl' && Object.hasOwn(receipt, 'converterWrapperSha256')) {
    throw new Error(`Unexpected converter wrapper provenance for ${model.slug}: ${receiptPath}`);
  }
  for (const [name, version] of Object.entries(runtime.packages)) {
    if (receipt.pythonPackageVersions?.[name] !== version) throw new Error(`Python package provenance mismatch for ${model.slug}: ${name}`);
  }
  if (receipt.size !== artifactInfo.size || !/^[a-f0-9]{64}$/i.test(receipt.sha256 ?? '') ||
      await sha256(artifactPath) !== receipt.sha256.toLowerCase()) {
    throw new Error(`Existing GGUF does not match its receipt: ${artifactPath}`);
  }
  console.log(`Verified existing artifact: ${artifactPath}`);
  return true;
}

async function prepare(model, runtime) {
  if (expectedCandidates.get(model.slug) !== model.originalId) throw new Error(`Unexpected candidate identity: ${model.slug}/${model.originalId}`);
  if (!/^[a-f0-9]{40}$/i.test(model.revision ?? '') || !Array.isArray(model.files)) {
    throw new Error(`Invalid pinned manifest record for ${model.slug}`);
  }
  const modelRoot = resolve(root, 'models/candidates', model.slug, 'original');
  const candidateRoot = resolve(root, 'models/candidates', model.slug);
  const f16Path = resolve(candidateRoot, 'model-f16.gguf');
  const artifactPath = resolve(candidateRoot, 'model-Q4_K_M.gguf');
  const receiptPath = resolve(candidateRoot, 'artifact.json');
  const candidateInfo = await lstat(candidateRoot).catch(() => null);
  if (candidateInfo && (!candidateInfo.isDirectory() || candidateInfo.isSymbolicLink())) {
    throw new Error(`Candidate output directory is unsafe: ${candidateRoot}`);
  }
  if (candidateInfo && (await realpath(candidateRoot)).toLowerCase() !== candidateRoot.toLowerCase()) {
    throw new Error(`Candidate output directory resolves outside its expected location: ${candidateRoot}`);
  }
  await verifyOriginal(model, modelRoot);

  let wrapperSha256;
  let converterEntrypoint = converterPath;
  if (model.slug === 'gpt2-xl') {
    if (!existsSync(gpt2WrapperPath)) throw new Error(`Required GPT-2 converter wrapper is missing: ${gpt2WrapperPath}`);
    wrapperSha256 = await sha256(gpt2WrapperPath);
    converterEntrypoint = gpt2WrapperPath;
  }
  if (await reuseIfVerified(model, runtime, receiptPath, artifactPath, wrapperSha256)) return;
  for (const path of [f16Path, artifactPath]) {
    if (await lstat(path).catch(() => null)) throw new Error(`Unreceipted or partial output exists; refusing to reuse or overwrite: ${path}`);
  }
  await mkdir(candidateRoot, { recursive: true });

  const env = {
    ...process.env,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
    CUDA_VISIBLE_DEVICES: '-1',
    OMP_NUM_THREADS: '4',
    MKL_NUM_THREADS: '4',
    OPENBLAS_NUM_THREADS: '4',
  };
  console.log(`Converting ${model.slug} on CPU to F16 GGUF.`);
  run(python, [converterEntrypoint, modelRoot, '--outtype', 'f16', '--outfile', f16Path], { env });
  const f16Info = await lstat(f16Path).catch(() => null);
  if (!f16Info?.isFile() || f16Info.isSymbolicLink() || f16Info.size === 0) throw new Error(`Converter did not produce a non-empty F16 GGUF: ${f16Path}`);

  console.log(`Quantizing ${model.slug} to Q4_K_M on CPU (four threads, 512 MiB tensor buffer).`);
  run(quantizer, ['--max-buffer-size', '512', f16Path, artifactPath, 'Q4_K_M', '4'], { cwd: candidateRoot, env });
  const artifactInfo = await lstat(artifactPath).catch(() => null);
  if (!artifactInfo?.isFile() || artifactInfo.isSymbolicLink() || artifactInfo.size === 0) throw new Error(`Quantizer did not produce a non-empty GGUF: ${artifactPath}`);
  const ggufSha256 = await sha256(artifactPath);

  const resolvedF16 = resolve(f16Path);
  const actualF16 = await realpath(resolvedF16);
  const actualCandidate = await realpath(candidateRoot);
  if (!actualF16.toLowerCase().startsWith((actualCandidate + sep).toLowerCase())) {
    throw new Error(`Refusing to remove an F16 file outside ${candidateRoot}`);
  }
  const f16FileInfo = await lstat(actualF16);
  if (!f16FileInfo.isFile() || f16FileInfo.isSymbolicLink()) throw new Error(`Refusing to remove an unsafe F16 output: ${actualF16}`);
  await unlink(actualF16);

  const receipt = {
    originalId: model.originalId,
    slug: model.slug,
    revision: model.revision,
    converterCommit,
    quantization: 'Q4_K_M',
    sha256: ggufSha256,
    size: artifactInfo.size,
    pythonPackageVersions: runtime.packages,
    pythonVersion: runtime.python,
    ...(wrapperSha256 ? { converterWrapperSha256: wrapperSha256 } : {}),
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  console.log(`Prepared ${model.slug}: ${artifactInfo.size} bytes, SHA-256 ${ggufSha256}`);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/prepare-candidates.mjs --model <slug|all>');
  process.exit(0);
}
if (args.length !== 2 || args[0] !== '--model') throw new Error('Usage: node scripts/prepare-candidates.mjs --model <slug|all>');
const selected = args[1];
const manifest = JSON.parse(await readFile(candidatesPath, 'utf8'));
if (manifest.version !== 1 || !Array.isArray(manifest.models)) throw new Error(`Invalid candidate manifest: ${candidatesPath}`);
const models = selected === 'all' ? manifest.models : manifest.models.filter(model => model.slug === selected);
if (!models.length) throw new Error(`No model candidate found for ${selected}`);
if (selected !== 'all' && models.length !== 1) throw new Error(`Expected one model candidate for ${selected}`);
if (selected === 'all' && (models.length !== expectedCandidates.size || models.some(model => expectedCandidates.get(model.slug) !== model.originalId))) {
  throw new Error('The candidate manifest does not contain exactly the six expected model identities.');
}

const runtime = await verifyRuntime();
for (const model of models) await prepare(model, runtime);
