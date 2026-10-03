import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseUrl = process.env.MODEL_API_URL ?? 'http://127.0.0.1:8081';
const outputPath = resolve('eval/results', `model-smoke-${new Date().toISOString().replaceAll(':', '-')}.json`);
const timeoutMs = Number(process.env.MODEL_TEST_TIMEOUT_MS ?? 90000);
const maxTokens = Number(process.env.MODEL_TEST_MAX_TOKENS ?? 192);
const model = 'qwen3.5-2b';
const apiKey = process.env.ASTRA_LOCAL_API_KEY ?? 'local-only';
const toolSystemPrompt = 'Отвечай по-русски. Для запроса записи вызови lookup_synthetic_record. Не выдумывай результат.';
const toolUserPrompt = 'Покажи все поля записи id 17.';
const tools = [{
  type: 'function',
  function: {
    name: 'lookup_synthetic_record',
    description: 'Return the fixed synthetic demo record for a numeric ID.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
}];

async function requestChat(messages, includeTools = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages,
        ...(includeTools ? { tools, tool_choice: 'auto' } : {}),
        max_tokens: maxTokens,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`Malformed JSON response: ${body.slice(0, 500)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function choiceContent(result) {
  const choice = result?.choices?.[0];
  if (!choice?.message) throw new Error('Response is missing choices[0].message');
  return { choice, message: choice.message };
}

const checks = [];
const results = { baseUrl, startedAt: new Date().toISOString(), checks };

try {
  const textResult = await requestChat([
    { role: 'system', content: 'Ответь кратко по-русски.' },
    { role: 'user', content: 'Назови столицу Казахстана одним словом.' },
  ]);
  const { message: textMessage } = choiceContent(textResult);
  if (typeof textMessage.content !== 'string' || !/астана/i.test(textMessage.content)) {
    throw new Error(`Short answer did not include Astana: ${String(textMessage.content)}`);
  }
  checks.push({ name: 'short_russian_answer', passed: true, content: textMessage.content });

  const toolResult = await requestChat([
    { role: 'system', content: toolSystemPrompt },
    { role: 'user', content: toolUserPrompt },
  ], true);
  const { choice: toolChoice, message: toolMessage } = choiceContent(toolResult);
  const call = toolMessage.tool_calls?.[0];
  if (call?.function?.name !== 'lookup_synthetic_record') {
    throw new Error(`Expected lookup_synthetic_record tool call, got ${call?.function?.name ?? 'none'}`);
  }
  let args;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    throw new Error(`Malformed tool arguments: ${String(call.function.arguments).slice(0, 300)}`);
  }
  if (args.id !== 17) throw new Error(`Expected tool argument id=17, got ${JSON.stringify(args)}`);
  checks.push({ name: 'tool_call', passed: true, toolName: call.function.name, args });

  const expectedMarker = 'SYNTHETIC_RECORD_17_OK';
  const syntheticValue = { id: 17, label: 'demo-entry', marker: expectedMarker };
  const continued = await requestChat([
    { role: 'system', content: toolSystemPrompt },
    { role: 'user', content: toolUserPrompt },
    { role: 'assistant', content: toolMessage.content ?? null, tool_calls: toolMessage.tool_calls },
    { role: 'tool', tool_call_id: call.id, content: JSON.stringify(syntheticValue) },
  ]);
  const { message: continuedMessage } = choiceContent(continued);
  if (typeof continuedMessage.content !== 'string' || !continuedMessage.content.trim()) {
    throw new Error('Tool continuation has no non-empty assistant content');
  }
  if (!continuedMessage.content.toUpperCase().includes(expectedMarker)) {
    throw new Error(`Tool continuation did not include expected marker ${expectedMarker}: ${continuedMessage.content}`);
  }
  checks.push({ name: 'tool_roundtrip', passed: true, expectedMarker, content: continuedMessage.content });

  results.passed = true;
} catch (error) {
  results.passed = false;
  results.error = error.name === 'AbortError' ? `Request timed out after ${timeoutMs}ms` : error.message;
  process.exitCode = 1;
} finally {
  results.finishedAt = new Date().toISOString();
  const output = `${JSON.stringify(results, null, 2)}\n`;
  if (results.passed) console.log(output);
  else console.error(output);
  if (process.argv.includes('--save')) {
    await mkdir(resolve('eval/results'), { recursive: true });
    await writeFile(outputPath, output, 'utf8');
    console.log(`Saved JSON result: ${outputPath}`);
  }
}
