import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const harness = resolve(root, '.runtime/harness');
const cli = resolve(root, '.runtime/harness/apps/cli/lib/bin.js');
const profile = resolve(root, 'profiles/astra');
const profileHome = resolve(root, '.runtime/dsh-home/profiles/astra');
if (!existsSync(cli)) throw new Error(`Missing built Harness CLI: ${cli}. Run npm run setup first.`);
if (!existsSync(resolve(harness, 'node_modules'))) throw new Error('Harness dependencies are missing. Run npm run setup first.');
if (!existsSync(resolve(profile, 'package.json')) || !existsSync(resolve(profile, 'cordis.patch.yml'))) {
  throw new Error(`Astra profile config is missing under ${profile}.`);
}

const gitBin = resolve(root, '.runtime/git/ucrt64/bin');
const pythonDirectory = 'C:/Users/luna/.cache/codex-runtimes/codex-primary-runtime/dependencies/python';
const dshHome = resolve(root, '.runtime/dsh-home');
const gitConfigIndex = Number(process.env.GIT_CONFIG_COUNT ?? 0);
mkdirSync(dshHome, { recursive: true });
mkdirSync(resolve(dshHome, 'profiles'), { recursive: true });
mkdirSync(resolve(root, 'work'), { recursive: true });
if (!existsSync(profileHome)) symlinkSync(profile, profileHome, 'junction');
const env = {
  ...process.env,
  DSH_HOME: dshHome,
  PATH: [resolve(root, '.runtime/bin'), resolve(root, '.runtime/python/Scripts'), gitBin, resolve(root, '.runtime/git/cmd'), resolve(root, '.runtime/git/usr/bin'), dirname(process.execPath), pythonDirectory, process.env.PATH].join(';'),
  GIT_EXEC_PATH: gitBin,
  GIT_CONFIG_COUNT: String(gitConfigIndex + 1),
  [`GIT_CONFIG_KEY_${gitConfigIndex}`]: 'safe.directory',
  [`GIT_CONFIG_VALUE_${gitConfigIndex}`]: harness,
  DSH_TELEMETRY_DISABLED: '1',
  DSH_PERMISSION_MODE: 'workspace-write',
  ASTRA_LOCAL_API_KEY: 'local-only',
  ASTRA_WORKSPACE_ROOT: resolve(root, 'work'),
};

const userArgs = process.argv.slice(2);
const isConfigCommand = userArgs.some(argument => ['--dump-config', '--dump-config-schema', '--dump-default-config'].includes(argument));
const dshArgs = ['--profile', 'astra'];
if (!isConfigCommand) dshArgs.push('--no-open', '--host', '127.0.0.1', '--port', '3080');
dshArgs.push(...userArgs);

const child = spawn(process.execPath, [cli, ...dshArgs], {
  cwd: harness,
  env,
  stdio: 'inherit',
});
child.once('error', error => { throw error; });
child.once('exit', code => { process.exitCode = code ?? 1; });
