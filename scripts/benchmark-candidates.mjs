import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { gradeCase } from './grade-candidates.mjs';
import { sha256 } from './download.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(root, 'config/model-candidates-lock.json'), 'utf8'));
const suiteBytes = await readFile(resolve(root, 'eval/cases/document-benchmark-v1.json'));
const suite = JSON.parse(suiteBytes);
const options = { runId: `candidate-benchmark-${new Date().toISOString().replaceAll(':', '-')}` };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const flag = args[index];
  if (!['--model', '--run-id'].includes(flag) || !args[index + 1]) {
    throw new Error('Usage: node scripts/benchmark-candidates.mjs [--model slug] [--run-id id]');
  }
  options[flag === '--model' ? 'slug' : 'runId'] = args[++index];
}
if (!/^[a-z0-9T_.-]{1,100}$/i.test(options.runId) || options.runId.includes('..')) throw new Error('Invalid run id');
const models = options.slug ? manifest.models.filter(model => model.slug === options.slug) : manifest.models;
if (!models.length) throw new Error('Unknown candidate');
const resultDirectory = resolve(root, 'eval/results', options.runId);
const logDirectory = resolve(root, '.runtime/evaluation', options.runId);
await mkdir(resultDirectory, { recursive: true });
await mkdir(logDirectory, { recursive: true });
const baseUrl = 'http://127.0.0.1:8082';
const vramLimitMiB = 5500;
const requestTimeoutMs = 90_000;
const system = 'Ты помощник по работе с документами. Отвечай по-русски. Выполняй точно указанную задачу и формат ответа. Не выдумывай данные или действия с файлами.';
const readTool = { type: 'function', function: {
  name: 'read_synthetic_document', description: 'Read the synthetic document supplied by the evaluation harness.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
} };

async function requireFreePort() {
  await new Promise((done, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(8082, '127.0.0.1', () => probe.close(done));
  });
}

function gpuSample() {
  const raw = execFileSync('nvidia-smi', [
    '--id=0', '--query-gpu=memory.total,memory.used,memory.free,temperature.gpu,utilization.gpu',
    '--format=csv,noheader,nounits',
  ], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
  const values = raw.split(',').map(value => Number(value.trim()));
  if (values.length !== 5 || values.some(value => !Number.isFinite(value))) throw new Error(`Invalid GPU sample: ${raw}`);
  const [totalMiB, usedMiB, freeMiB, temperatureC, utilizationPercent] = values;
  return { at: new Date().toISOString(), totalMiB, usedMiB, freeMiB, temperatureC, utilizationPercent };
}

function messagesFor(testCase) {
  const messages = [{ role: 'system', content: system }];
  if (testCase.toolResult !== undefined) {
    messages.push({ role: 'user', content: 'Прочитай синтетический документ.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'synthetic-read-1', type: 'function',
        function: { name: readTool.function.name, arguments: '{}' } }] },
      { role: 'tool', name: readTool.function.name, tool_call_id: 'synthetic-read-1', content: JSON.stringify(testCase.toolResult) });
  }
  messages.push({ role: 'user', content: testCase.followupPrompt ?? testCase.prompt });
  return messages;
}

async function request(testCase, model, signal) {
  const messages = messagesFor(testCase);
  const isBase = model.slug === 'gpt2-xl';
  const tools = testCase.tools ?? (testCase.toolResult !== undefined ? [readTool] : undefined);
  const payload = isBase ? {
    model: model.slug,
    prompt: `${system}\n${testCase.toolResult === undefined ? '' : `Результат инструмента: ${JSON.stringify(testCase.toolResult)}\n`}${testCase.followupPrompt ?? testCase.prompt}\nОтвет:`,
    stop: ['\nПользователь:', '<|endoftext|>'],
  } : {
    model: model.slug, messages,
    ...(tools ? { tools, tool_choice: 'auto' } : {}),
    chat_template_kwargs: { enable_thinking: false },
  };
  const started = performance.now();
  const response = await fetch(`${baseUrl}/v1/${isBase ? 'completions' : 'chat/completions'}`, {
    method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer benchmark-local' },
    body: JSON.stringify({ ...payload, max_tokens: 384, temperature: 0, seed: 42, stream: false }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 1000)}`);
  const data = JSON.parse(text);
  const choice = data.choices?.[0];
  if (!choice) throw new Error('Missing completion choice');
  return {
    content: isBase ? choice.text : choice.message?.content ?? '',
    tool_calls: choice.message?.tool_calls ?? [], finish_reason: choice.finish_reason,
    usage: data.usage, timings: data.timings, latencyMs: performance.now() - started,
  };
}

async function runModel(model) {
  const directory = resolve(root, 'models/candidates', model.slug);
  const modelPath = resolve(directory, 'model-Q4_K_M.gguf');
  const artifact = JSON.parse(await readFile(resolve(directory, 'artifact.json'), 'utf8'));
  const modelSize = (await stat(modelPath)).size;
  if (artifact.originalId !== model.originalId || artifact.revision !== model.revision || artifact.sha256 !== await sha256(modelPath)) {
    throw new Error(`Artifact receipt mismatch: ${model.slug}`);
  }
  const context = model.slug === 'gpt2-xl' ? 1024 : 4096;
  const before = gpuSample();
  const samples = [before];
  const report = {
    model: { originalId: model.originalId, slug: model.slug, revision: model.revision, license: model.license,
      quantization: 'Q4_K_M', sha256: artifact.sha256, bytes: modelSize },
    suite: { id: suite.id, sha256: createHash('sha256').update(suiteBytes).digest('hex'), count: suite.cases.length },
    startedAt: new Date().toISOString(),
    settings: { context, gpuLayers: 99, slots: 1, temperature: 0, seed: 42, maxOutputTokens: 384,
      vramLimitMiB, vramSampleIntervalMs: 1000, port: 8082, nativeBaseCompletion: model.slug === 'gpt2-xl' },
    cases: [], errors: [],
  };
  if (before.usedMiB > vramLimitMiB || before.freeMiB < Math.ceil(modelSize / 1048576) + 512) {
    throw new Error(`Insufficient free VRAM for ${model.slug}; not starting an unmonitored or over-budget model.`);
  }
  await requireFreePort();
  // The benchmark owns only this child. Existing Harness/model services are not stopped.
  const stdout = openSync(resolve(logDirectory, `${model.slug}.stdout.log`), 'w');
  const stderr = openSync(resolve(logDirectory, `${model.slug}.stderr.log`), 'w');
  const child = spawn(resolve(root, '.runtime/llama/llama-server.exe'), [
    '--model', modelPath, '--alias', model.slug, '--host', '127.0.0.1', '--port', '8082',
    '--ctx-size', String(context), '--n-gpu-layers', '99', '--parallel', '1', '--temp', '0',
    '--seed', '42', '--api-key', 'benchmark-local', '--jinja', '--reasoning', 'off',
    '--chat-template-kwargs', JSON.stringify({ enable_thinking: false }),
  ], { cwd: root, windowsHide: true, stdio: ['ignore', stdout, stderr] });
  closeSync(stdout);
  closeSync(stderr);
  let childError;
  let childClosed = false;
  const stopped = new Promise(done => child.once('close', () => { childClosed = true; done(); }));
  child.once('error', error => { childError = error; });
  const controller = new AbortController();
  const stopForMemory = error => {
    if (!controller.signal.aborted) {
      report.errors.push(error.message);
      controller.abort(error);
      child.kill();
    }
  };
  const sample = () => {
    try {
      const value = gpuSample();
      samples.push(value);
      if (value.usedMiB > vramLimitMiB) stopForMemory(new Error(`VRAM guard: ${value.usedMiB} MiB > ${vramLimitMiB} MiB`));
    } catch (error) { stopForMemory(new Error(`VRAM monitoring failed: ${error.message}`)); }
  };
  const monitor = setInterval(sample, 1000);
  const interrupt = () => stopForMemory(new Error('Benchmark interrupted by user; owned candidate stopped'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (childError) throw childError;
      if (childClosed || child.exitCode !== null || child.signalCode !== null || controller.signal.aborted) throw new Error('Candidate exited or VRAM guard stopped it during loading');
      try {
        const response = await fetch(`${baseUrl}/v1/models`, {
          headers: { Authorization: 'Bearer benchmark-local' }, signal: AbortSignal.timeout(1000),
        });
        const data = response.ok ? await response.json() : undefined;
        if (data?.data?.some(entry => entry.id === model.slug)) { ready = true; break; }
      } catch (error) {
        if (controller.signal.aborted) throw error;
      }
      await new Promise(done => setTimeout(done, 1000));
    }
    if (!ready) throw new Error('Candidate readiness timeout');
    sample();
    for (const testCase of suite.cases) {
      if (controller.signal.aborted) break;
      let result;
      try { result = await request(testCase, model, controller.signal); }
      catch (error) { result = { content: '', error: error.message }; }
      const grade = gradeCase(testCase, result);
      report.cases.push({ id: testCase.id, category: testCase.category, result, grade });
      console.log(`${model.slug} ${testCase.id}: ${grade.passed ? 'PASS' : 'FAIL'} (${Math.round(result.latencyMs ?? 0)} ms)`);
      sample();
    }
  } catch (error) { report.errors.push(error.message); }
  finally {
    clearInterval(monitor);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (!childClosed) child.kill();
    await stopped;
  }
  const passed = report.cases.filter(item => item.grade.passed).length;
  const categories = {};
  for (const testCase of suite.cases) {
    const group = categories[testCase.category] ??= { passed: 0, total: 0 };
    group.total++;
    if (report.cases.find(item => item.id === testCase.id)?.grade.passed) group.passed++;
  }
  report.summary = { passed, total: suite.cases.length, percentage: passed / suite.cases.length * 100,
    complete: report.cases.length === suite.cases.length && report.errors.length === 0, categories };
  report.vram = { beforeMiB: before.usedMiB, peakTotalMiB: Math.max(...samples.map(value => value.usedMiB)),
    peakDeltaMiB: Math.max(...samples.map(value => value.usedMiB)) - before.usedMiB,
    totalMiB: before.totalMiB, note: 'Total device use includes Windows and any other running model; delta is not exclusive per-process VRAM.', samples };
  report.finishedAt = new Date().toISOString();
  const path = resolve(resultDirectory, `${model.slug}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ model: model.slug, ...report.summary, peakTotalMiB: report.vram.peakTotalMiB, result: path }));
  if (!report.summary.complete) throw new Error(`Incomplete benchmark for ${model.slug}; results saved, not a valid quality ranking.`);
}

for (const model of models) await runModel(model);
