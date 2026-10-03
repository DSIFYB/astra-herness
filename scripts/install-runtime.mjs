import { mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { download, downloadParallel } from './download.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(resolve(root, 'config/runtime-lock.json'), 'utf8'));
if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('This bootstrap currently supports Windows x64.');
}

function extract(zip, target) {
  const result = spawnSync('tar.exe', ['-xf', zip, '-C', target], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Archive extraction failed: ${zip}`);
}

const component = process.argv[2] ?? 'all';
const installs = [];
if (component === 'git' || component === 'all') {
  installs.push({ name: 'git', ...lock.git });
}
if (component === 'llama' || component === 'all') {
  installs.push({ name: 'llama', ...lock.llama });
  installs.push({ name: 'llama-cuda', directory: 'llama',
    url: lock.llama.cudaUrl, sha256: lock.llama.cudaSha256 });
}
for (const item of installs) {
  const archive = resolve(root, '.runtime/downloads', `${item.name}.zip`);
  const target = resolve(root, '.runtime', item.directory ?? item.name);
  await (item.name.startsWith('llama') ? downloadParallel : download)(item.url, archive, item.sha256);
  await mkdir(target, { recursive: true });
  extract(archive, target);
}
if (component === 'model' || component === 'all') {
  const { model } = lock;
  const base = `https://huggingface.co/${model.ggufRepository}/resolve/${model.revision}`;
  await download(`${base}/${model.file}`, resolve(root, 'models', model.file), model.sha256);
  if (process.argv.includes('--vision')) {
    await download(`${base}/${model.visionFile}`, resolve(root, 'models', model.visionFile), model.visionSha256);
  }
}
