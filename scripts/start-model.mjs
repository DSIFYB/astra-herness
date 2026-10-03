import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const server = resolve(root, '.runtime/llama/llama-server.exe');
const model = resolve(root, 'models/Qwen3.5-2B-Q4_K_M.gguf');
if (!existsSync(server)) throw new Error(`Missing llama-server: ${server}. Run npm run setup first.`);
if (!existsSync(model)) throw new Error(`Missing model: ${model}. Run npm run setup first.`);

const help = spawn(server, ['--help'], { stdio: 'ignore' });
const helpExit = await new Promise((resolveExit, reject) => {
  help.once('error', reject);
  help.once('exit', code => resolveExit(code));
});
if (helpExit !== 0) throw new Error('Could not read llama-server --help.');

const child = spawn(server, [
  '--model', model,
  '--alias', 'qwen3.5-2b',
  '--host', '127.0.0.1',
  '--port', '8081',
  '--ctx-size', '8192',
  '--n-gpu-layers', '99',
  '--parallel', '1',
  '--temp', '0',
  '--api-key', 'local-only',
  '--jinja',
  '--reasoning', 'off',
  '--chat-template-kwargs', JSON.stringify({ enable_thinking: false }),
], { cwd: root, stdio: 'inherit' });
child.once('error', error => { throw error; });
child.once('exit', code => { process.exitCode = code ?? 1; });
