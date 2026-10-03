import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadModelConfig, validateActiveModel } from '../scripts/model-config.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.resolve(repoRoot, 'config/model-candidates-lock.json'), 'utf8'));
const baselineHash = createHash('sha256').update('synthetic candidate bytes').digest('hex');

async function temporaryRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'herness-model-config-'));
  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(path.join(root, 'config/model-candidates-lock.json'), `${JSON.stringify(manifest)}\n`);
  return root;
}

async function installFixtureCandidate(root, slug = 'qwen2.5-coder-1.5b-instruct') {
  const model = manifest.models.find(item => item.slug === slug);
  assert.ok(model, `fixture model ${slug} must be allowlisted`);
  const bytes = Buffer.from(`synthetic model artifact for ${slug}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const directory = path.join(root, 'models/candidates', slug);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'model-Q4_K_M.gguf'), bytes);
  const receipt = {
    originalId: model.originalId,
    revision: model.revision,
    quantization: 'Q4_K_M',
    sha256,
    size: bytes.length,
  };
  await writeFile(path.join(directory, 'artifact.json'), `${JSON.stringify(receipt)}\n`);
  const activeModel = {
    version: 1,
    slug,
    originalId: model.originalId,
    revision: model.revision,
    sha256,
    size: bytes.length,
  };
  await writeFile(path.join(root, 'config/active-model.json'), `${JSON.stringify(activeModel)}\n`);
  return { model, bytes, sha256, receipt, activeModel, directory };
}

test('missing active-model config resolves to the pinned baseline model and 8192 context', async t => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await loadModelConfig(root);
  assert.equal(config.slug, 'qwen3.5-2b');
  assert.equal(config.alias, 'qwen3.5-2b');
  assert.equal(config.displayName, 'Qwen3.5-2B Local');
  assert.equal(config.contextWindow, 8192);
  assert.equal(config.modelPath, path.join(root, 'models/Qwen3.5-2B-Q4_K_M.gguf'));
  assert.equal(config.sha256, null);
  assert.equal(config.size, null);
});

test('allowlisted candidate loads only from its contained path and uses chat context', async t => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await installFixtureCandidate(root);
  const config = await loadModelConfig(root);
  const relative = path.relative(path.join(root, 'models/candidates'), config.modelPath);
  assert.equal(config.slug, fixture.model.slug);
  assert.equal(config.originalId, fixture.model.originalId);
  assert.equal(config.revision, fixture.model.revision);
  assert.equal(config.alias, fixture.model.slug);
  assert.equal(config.displayName, `${fixture.model.slug === 'qwen2.5-coder-1.5b-instruct' ? 'Qwen2.5 Coder 1.5B Instruct' : fixture.model.slug} Local`);
  assert.equal(config.contextWindow, 8192);
  assert.equal(config.sha256, fixture.sha256);
  assert.equal(config.size, fixture.bytes.length);
  assert.equal(config.modelPath, path.join(fixture.directory, 'model-Q4_K_M.gguf'));
  assert.ok(!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
});

test('active config rejects unknown models, traversal slugs, and revision mismatches', async () => {
  const model = manifest.models.find(item => item.slug === 'qwen2.5-coder-1.5b-instruct');
  const receipt = {
    originalId: model.originalId,
    revision: model.revision,
    quantization: 'Q4_K_M',
    sha256: baselineHash,
    size: 25,
  };
  const base = { version: 1, slug: model.slug, originalId: model.originalId, revision: model.revision, sha256: baselineHash, size: 25 };
  assert.throws(() => validateActiveModel({ activeModel: { ...base, slug: '../outside' }, manifest, receipt, actualSha256: baselineHash }), /allowlist|approved|identity/i);
  assert.throws(() => validateActiveModel({ activeModel: { ...base, slug: 'not-a-candidate' }, manifest, receipt, actualSha256: baselineHash }), /allowlist|approved|identity/i);
  assert.throws(() => validateActiveModel({ activeModel: { ...base, revision: '0'.repeat(40) }, manifest, receipt, actualSha256: baselineHash }), /revision/i);
});

test('receipt identity, quantization, size, and actual model hash must match', async () => {
  const model = manifest.models.find(item => item.slug === 'qwen2.5-coder-1.5b-instruct');
  const activeModel = { version: 1, slug: model.slug, originalId: model.originalId, revision: model.revision, sha256: baselineHash, size: 25 };
  const receipt = { originalId: model.originalId, revision: model.revision, quantization: 'Q4_K_M', sha256: baselineHash, size: 25 };
  const validate = (changes = {}, actualSha256 = baselineHash) => validateActiveModel({
    activeModel,
    manifest,
    receipt: { ...receipt, ...changes },
    actualSha256,
  });
  assert.throws(() => validate({ originalId: 'other/model' }), /receipt|identity|match/i);
  assert.throws(() => validate({ quantization: 'Q5_K_M' }), /receipt|Q4_K_M/i);
  assert.throws(() => validate({ size: 26 }), /size|receipt|match/i);
  assert.throws(() => validate({}, 'f'.repeat(64)), /SHA|hash|match/i);
});

test('GPT-2 is refused for the chat profile even with valid pinned provenance', () => {
  const model = manifest.models.find(item => item.slug === 'gpt2-xl');
  const activeModel = { version: 1, slug: model.slug, originalId: model.originalId, revision: model.revision, sha256: baselineHash, size: 25 };
  const receipt = { originalId: model.originalId, revision: model.revision, quantization: 'Q4_K_M', sha256: baselineHash, size: 25 };
  assert.throws(() => validateActiveModel({ activeModel, manifest, receipt, actualSha256: baselineHash }), /GPT-2|chat/i);
});

test('present but invalid active config does not silently fall back to baseline', async t => {
  const root = await temporaryRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'config/active-model.json'), JSON.stringify({ version: 1, slug: '../outside' }));
  await assert.rejects(loadModelConfig(root), /allowlist|approved|identity|active model/i);
});

test('candidate resolver rejects an ancestor junction that redirects candidates outside the project', async t => {
  const root = await temporaryRoot();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'herness-model-outside-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await mkdir(path.join(outside, 'config'), { recursive: true });
  const fixture = await installFixtureCandidate(outside);
  await mkdir(path.join(root, 'models'), { recursive: true });
  await symlink(path.join(outside, 'models/candidates'), path.join(root, 'models/candidates'), 'junction');
  await writeFile(path.join(root, 'config/active-model.json'), `${JSON.stringify(fixture.activeModel)}\n`);
  await assert.rejects(loadModelConfig(root), /escape|expected model directory layout/i);
});
