import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const profilePath = resolve(root, 'profiles/astra/cordis.patch.yml');
const modelScriptPath = resolve(root, 'scripts/start-model.mjs');
const profile = readFileSync(profilePath, 'utf8');
const modelScript = readFileSync(modelScriptPath, 'utf8');

test('Astra profile reserves enough context for an answer and matches the server window', () => {
  assert.match(profile, /defaultContextWindow:\s*8192\b/);
  assert.match(profile, /contextWindow:\s*8192\b/);
  assert.match(profile, /defaultMaxTokens:\s*512\b/);
  assert.match(profile, /maxTokens:\s*512\b/);
  assert.match(modelScript, /'--ctx-size',\s*'8192'/);
});

test('Astra profile disables shipped shell, filesystem, network and preset tools', () => {
  for (const id of [
    'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-web',
    'web-search-deepseek', 'web-fetch-http', 'tool-jobs', 'tool-workflow',
    'tool-subagent', 'tool-subagent-fork', 'tool-subagent-control',
    'tool-subagent-list-agents', 'tool-plugin-manager',
    'preset-standard', 'preset-minimal', 'preset-ptc', 'preset-cordis',
  ]) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(profile, new RegExp(`- id: ${escaped}\\s+disabled: true`), `${id} must remain disabled`);
  }
});

const harnessModules = resolve(root, '.runtime/harness/node_modules/.pnpm');
const sdkStore = existsSync(harnessModules)
  ? readdirSync(harnessModules).find(name => name.startsWith('@earendil-works+pi-ai@'))
  : undefined;
const clampModule = sdkStore && resolve(
  harnessModules,
  sdkStore,
  'node_modules/@earendil-works/pi-ai/dist/api/simple-options.js',
);

test('installed pi-ai clamp leaves the configured answer budget when context is 8192', {
  skip: !clampModule || !existsSync(clampModule),
}, async () => {
  const { clampMaxTokensToContext } = await import(pathToFileURL(clampModule).href);
  const context = { messages: [{ role: 'user', content: 'x'.repeat(312) }] };
  assert.equal(clampMaxTokensToContext({ contextWindow: 4096 }, context, 512), 1);
  assert.equal(clampMaxTokensToContext({ contextWindow: 8192 }, context, 512), 512);
});
