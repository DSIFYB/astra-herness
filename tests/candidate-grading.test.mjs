import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { gradeCase } from '../scripts/grade-candidates.mjs';

const benchmarkPath = resolve(import.meta.dirname, '../eval/cases/document-benchmark-v1.json');
const benchmark = JSON.parse(await readFile(benchmarkPath, 'utf8'));
const byId = new Map(benchmark.cases.map(testCase => [testCase.id, testCase]));

function check(result, name) {
  return result.checks.find(item => item.name === name);
}

test('benchmark has 24-30 unique synthetic cases across all requested categories', () => {
  assert.ok(benchmark.cases.length >= 24 && benchmark.cases.length <= 30);
  assert.equal(byId.size, benchmark.cases.length);
  assert.match(benchmark.description, /synthetic/i);
  for (const category of [
    'targeted_edit', 'strict_json_extraction', 'table_extraction',
    'clarification_no_edit', 'native_tool_planning', 'tool_result_followup',
  ]) assert.ok(benchmark.cases.some(testCase => testCase.category === category), `missing ${category}`);
  for (const testCase of benchmark.cases) {
    assert.ok(testCase.prompt);
    assert.ok(testCase.expected?.kind);
    if (testCase.category === 'native_tool_planning') assert.ok(testCase.tools?.length);
    if (testCase.category === 'tool_result_followup') assert.ok(testCase.toolResult && testCase.followupPrompt);
  }
});

test('targeted edit accepts minimal or whole-paragraph replacement while preserving all other text', () => {
  const testCase = byId.get('EDIT-02');
  const value = testCase.expected.value;
  const good = gradeCase(testCase, { content: JSON.stringify(value), finish_reason: 'stop' });
  assert.equal(good.passed, true);
  assert.equal(good.score, good.maxScore);

  const wholeParagraph = {
    tool: 'replace_text',
    arguments: {
      paragraph_id: 'p4',
      old_text: testCase.expected.sourceText,
      new_text: testCase.expected.finalText,
    },
  };
  assert.equal(gradeCase(testCase, { content: JSON.stringify(wholeParagraph) }).passed, true);

  const wrongUnchangedAmount = structuredClone(value);
  wrongUnchangedAmount.arguments.new_text = '14 коробок, цена 1 250 рублей за коробку, итого 17 500 рублей; номер 99';
  const bad = gradeCase(testCase, { content: JSON.stringify(wrongUnchangedAmount) });
  assert.equal(check(bad, 'only_requested_text_changes').passed, false);

  const wrongTarget = structuredClone(value);
  wrongTarget.arguments.paragraph_id = 'p5';
  assert.equal(check(gradeCase(testCase, { content: JSON.stringify(wrongTarget) }), 'edit_plan_schema_and_target').passed, false);

  const extraField = { ...value, note: 'unused' };
  assert.equal(check(gradeCase(testCase, { content: JSON.stringify(extraField) }), 'edit_plan_schema_and_target').passed, false);
});

test('strict JSON extraction preserves exact numbers, key set, and array order', () => {
  const invoice = byId.get('EXTRACT-01');
  assert.equal(gradeCase(invoice, { content: JSON.stringify(invoice.expected.value) }).passed, true);
  const changedAmount = { ...invoice.expected.value, amount: 48750 };
  assert.equal(check(gradeCase(invoice, { content: JSON.stringify(changedAmount) }), 'exact_expected_value').passed, false);

  const table = byId.get('EXTRACT-04');
  const reversed = [...table.expected.value].reverse();
  assert.equal(check(gradeCase(table, { content: JSON.stringify(reversed) }), 'exact_expected_value').passed, false);
});

test('a single JSON fence is parsed for diagnosis but fails strict formatting', () => {
  const testCase = byId.get('EXTRACT-02');
  const response = `\`\`\`json\n${JSON.stringify(testCase.expected.value)}\n\`\`\``;
  const result = gradeCase(testCase, { content: response });
  assert.equal(check(result, 'valid_json').passed, true);
  assert.equal(check(result, 'strict_json_format').passed, false);
  assert.equal(check(result, 'exact_expected_value').passed, true);
  assert.equal(result.passed, false);
});

test('clarification requires the ambiguous alternatives and cannot claim completion', () => {
  const testCase = byId.get('CLARIFY-01');
  const good = gradeCase(testCase, { content: JSON.stringify({ action: 'clarify', question: 'Речь об авансе или возврате?' }) });
  assert.equal(good.passed, true);

  const wrongAction = gradeCase(testCase, { content: JSON.stringify({ action: 'edit', question: 'Аванс или возврат?' }) });
  assert.equal(check(wrongAction, 'clarification_shape').passed, false);
  const claimsDone = gradeCase(testCase, { content: JSON.stringify({ action: 'clarify', question: 'Аванс или возврат? Исправил и сохранил.' }) });
  assert.equal(check(claimsDone, 'no_completion_claim').passed, false);
  const explicitlyNotDone = gradeCase(testCase, { content: JSON.stringify({ action: 'clarify', question: 'Аванс или возврат? Не исправил и не сохранил.' }) });
  assert.equal(check(explicitlyNotDone, 'no_completion_claim').passed, true);
  const noQuestion = gradeCase(testCase, { content: JSON.stringify({ action: 'clarify', question: 'Какой именно платёж?' }) });
  assert.equal(check(noQuestion, 'required_facts').passed, false);
});

test('native tool cases require one structured call and exact parsed arguments', () => {
  const testCase = byId.get('TOOL-01');
  const call = { tool_calls: [{ id: 'call-1', type: 'function', function: {
    name: testCase.expected.name,
    arguments: JSON.stringify(testCase.expected.arguments),
  } }] };
  assert.equal(gradeCase(testCase, call).passed, true);
  assert.equal(check(gradeCase(testCase, { content: 'replace_text(p3, ...)' }), 'native_tool_protocol').passed, false);
  const wrongArgs = structuredClone(call);
  wrongArgs.tool_calls[0].function.arguments = JSON.stringify({ ...testCase.expected.arguments, paragraph_id: 'p4' });
  assert.equal(check(gradeCase(testCase, wrongArgs), 'tool_arguments').passed, false);
  const extraCalls = structuredClone(call);
  extraCalls.tool_calls.push(structuredClone(call.tool_calls[0]));
  assert.equal(check(gradeCase(testCase, extraCalls), 'native_tool_protocol').passed, false);
});

test('follow-up facts use numeric token boundaries and reject contradictions or reordered rows', () => {
  const first = byId.get('FOLLOWUP-01');
  const good = gradeCase(first, { content: 'В разделе S-14 «Сроки хранения» срок составляет 5 лет, владелец — архив.' });
  assert.equal(good.passed, true);

  const wrongNumber = gradeCase(first, { content: 'S-14. Сроки хранения — 15 лет, владелец архив.' });
  assert.equal(check(wrongNumber, 'required_facts').passed, false);
  const contradictory = gradeCase(first, { content: 'S-14, Сроки хранения — 5 лет; владелец архив и бухгалтерия, также указано 10 лет.' });
  assert.equal(check(contradictory, 'no_contradictions').passed, false);

  const ordered = byId.get('FOLLOWUP-03');
  const reversed = gradeCase(ordered, { content: 'R-3 — 11, R-8 — 2, R-5 — 4.' });
  assert.equal(check(reversed, 'required_order').passed, false);
  const crossed = gradeCase(ordered, { content: 'R-8 — 11, R-3 — 2, R-5 — 4.' });
  assert.equal(check(crossed, 'required_pairings').passed, false);
});

test('cutoff and API errors fail every case even when visible text looks correct', () => {
  const testCase = byId.get('EXTRACT-05');
  const content = JSON.stringify(testCase.expected.value);
  const cutoff = gradeCase(testCase, { content, finish_reason: 'length' });
  assert.equal(check(cutoff, 'completed').passed, false);
  assert.equal(cutoff.passed, false);
  const apiError = gradeCase(testCase, { error: 'HTTP 500', content: '' });
  assert.equal(check(apiError, 'completed').passed, false);
  assert.equal(apiError.passed, false);
});
