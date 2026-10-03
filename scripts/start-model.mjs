import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModelConfig } from './model-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = resolve(root, '.runtime/llama/llama-server.exe');
const config = await loadModelConfig(root);
const model = config.modelPath;
if (!existsSync(server)) throw new Error(`Missing llama-server: ${server}. Run npm run setup first.`);
if (!existsSync(model)) throw new Error(`Missing model: ${model}. Run npm run setup first.`);

const help = spawn(server, ['--help'], { stdio: 'ignore', windowsHide: true });
const helpExit = await new Promise((resolveExit, reject) => {
  help.once('error', reject);
  help.once('exit', code => resolveExit(code));
});
if (helpExit !== 0) throw new Error('Could not read llama-server --help.');

const child = spawn(server, [
  '--model', model,
  '--alias', config.alias,
  '--host', '127.0.0.1',
  '--port', '8081',
  '--ctx-size', String(config.contextWindow),
  '--n-gpu-layers', '99',
  '--parallel', '1',
  '--temp', '0',
  '--api-key', 'local-only',
  '--jinja',
  '--reasoning', 'off',
  '--chat-template-kwargs', JSON.stringify({ enable_thinking: false }),
], { cwd: root, stdio: 'inherit', windowsHide: true });
let closing = false;
const forwardSignal = signal => {
  if (!closing) {
    closing = true;
    child.kill(signal);
  }
};
process.once('SIGINT', () => forwardSignal('SIGINT'));
process.once('SIGTERM', () => forwardSignal('SIGTERM'));
child.once('error', error => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
