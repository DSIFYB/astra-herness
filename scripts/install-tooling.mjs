import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { download } from './download.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(resolve(root, 'config/runtime-lock.json'), 'utf8'));
await mkdir(resolve(root, '.runtime/bin'), { recursive: true });
for (const [name, item] of Object.entries(lock.tooling)) {
  const archive = resolve(root, `.runtime/downloads/${name}.tgz`);
  const target = resolve(root, '.runtime', name);
  await download(item.url, archive);
  const actual = createHash('sha512').update(await readFile(archive)).digest('base64');
  if (`sha512-${actual}` !== item.integrity) throw new Error(`${name}: integrity mismatch`);
  await mkdir(target, { recursive: true });
  const extracted = spawnSync('tar.exe', ['-xzf', archive, '-C', target], { stdio: 'inherit' });
  if (extracted.status !== 0) throw new Error(`${name}: extraction failed`);
  const cli = name === 'npm' ? 'npm-cli.js' : 'pnpm.cjs';
  await writeFile(resolve(root, `.runtime/bin/${name}.cmd`),
    `@echo off\r\n"${process.execPath}" "%~dp0..\\${name}\\package\\bin\\${cli}" %*\r\n`);
  console.log(`Installed and verified: ${name} ${item.version}`);
}
await writeFile(resolve(root, '.runtime/bin/node.cmd'),
  `@echo off\r\n"${process.execPath}" %*\r\n`);
