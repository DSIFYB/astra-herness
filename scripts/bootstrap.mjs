import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodeDirectory = dirname(process.execPath);
const runtimeBin = resolve(root, '.runtime/bin');
const gitBin = resolve(root, '.runtime/git/ucrt64/bin');
const gitDirectory = resolve(root, '.runtime/git/cmd');
const gitUsrBin = resolve(root, '.runtime/git/usr/bin');
const pythonDirectory = 'C:/Users/luna/.cache/codex-runtimes/codex-primary-runtime/dependencies/python';
const harness = resolve(root, '.runtime/harness');
const gitConfigIndex = Number(process.env.GIT_CONFIG_COUNT ?? 0);
const env = {
  ...process.env,
  PATH: [runtimeBin, resolve(root, '.runtime/python/Scripts'), gitBin, gitDirectory, gitUsrBin, nodeDirectory, pythonDirectory, process.env.PATH].join(';'),
  GIT_EXEC_PATH: gitBin,
  GIT_CONFIG_COUNT: String(gitConfigIndex + 1),
  [`GIT_CONFIG_KEY_${gitConfigIndex}`]: 'safe.directory',
  [`GIT_CONFIG_VALUE_${gitConfigIndex}`]: harness,
};

execFileSync(process.execPath, ['scripts/install-tooling.mjs'], { cwd: root, env, stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/install-runtime.mjs', 'all'], { cwd: root, env, stdio: 'inherit' });

const lock = JSON.parse(readFileSync(resolve(root, 'config/runtime-lock.json'), 'utf8'));
execFileSync(process.execPath, ['scripts/install-doc-tools.mjs'], { cwd: root, env, stdio: 'inherit' });
const git = resolve(root, '.runtime/git/ucrt64/bin/git.exe');
const gitArgs = ['--exec-path=' + gitBin, '-c', 'http.sslBackend=openssl'];
if (!existsSync(resolve(harness, '.git'))) {
  execFileSync(git, [...gitArgs, 'clone', '--depth', '1', lock.harness.repository, harness], { cwd: root, env, stdio: 'inherit' });
}

const head = execFileSync(git, [...gitArgs, '-C', harness, 'rev-parse', 'HEAD'], { cwd: root, env, encoding: 'utf8' }).trim();
if (head !== lock.harness.commit) {
  const dirty = execFileSync(git, [...gitArgs, '-C', harness, 'status', '--porcelain'], { cwd: root, env, encoding: 'utf8' }).trim();
  if (dirty) throw new Error(`Harness has local changes at ${head}; refusing to move it to ${lock.harness.commit}.`);
  execFileSync(git, [...gitArgs, '-C', harness, 'fetch', 'origin', lock.harness.commit], { cwd: root, env, stdio: 'inherit' });
  execFileSync(git, [...gitArgs, '-C', harness, 'checkout', '--detach', lock.harness.commit], { cwd: root, env, stdio: 'inherit' });
}

const pnpm = resolve(root, '.runtime/pnpm/package/bin/pnpm.cjs');
const pnpmArgs = ['install', '--frozen-lockfile', '--store-dir', resolve(root, '.runtime/pnpm-store'), '--cache-dir', resolve(root, '.runtime/pnpm-cache')];
execFileSync(process.execPath, [pnpm, ...pnpmArgs], { cwd: harness, env, stdio: 'inherit' });
execFileSync(process.execPath, [pnpm, 'run', 'build'], { cwd: harness, env, stdio: 'inherit' });
