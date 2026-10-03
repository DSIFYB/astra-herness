import { isDeepStrictEqual } from 'node:util';

const INCOMPLETE_REASONS = new Set(['length', 'max_tokens', 'incomplete']);
const COMPLETION_CLAIMS = /(?<![\p{L}\p{N}])(?:готово|сделал[аи]?|сделано|исправил[аи]?|исправлено|изменил[аи]?|изменено|заменил[аи]?|заменено|сохранил[аи]?|сохранено|сохранён[ао]?|сохранен[ао]?|удалил[аи]?|удалено|перен[её]с(?:ла)?|выполнил[аи]?|выполнено)(?![\p{L}\p{N}])/giu;

function addCheck(checks, name, passed, detail) {
  checks.push({ name, passed, ...(detail ? { detail } : {}) });
}

function parseJson(content) {
  if (typeof content !== 'string') return { value: undefined, strict: false, error: 'content is not a string' };
  const trimmed = content.trim();
  let jsonText = trimmed;
  let strict = true;
  const fenced = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  if (fenced) {
    jsonText = fenced[1];
    strict = false;
  }
  try {
    return { value: JSON.parse(jsonText), strict };
  } catch (error) {
    return { value: undefined, strict: false, error: error.message };
  }
}

function exactFact(content, expected) {
  const normalized = content.toLocaleLowerCase('ru-RU');
  const fact = expected.toLocaleLowerCase('ru-RU');
  const escaped = fact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(normalized);
}

function hasCompletionClaim(content) {
  const text = String(content ?? '');
  const claims = new RegExp(COMPLETION_CLAIMS.source, COMPLETION_CLAIMS.flags);
  for (const match of text.matchAll(claims)) {
    const clauseStart = Math.max(
      text.lastIndexOf(',', match.index),
      text.lastIndexOf(';', match.index),
      text.lastIndexOf('.', match.index),
      text.lastIndexOf('!', match.index),
      text.lastIndexOf('?', match.index),
      text.lastIndexOf('\n', match.index),
    ) + 1;
    const before = text.slice(clauseStart, match.index).trimEnd();
    if (!/(?<![\p{L}\p{N}])не\s*(?:(?:был|была|было|были)\s+)?$/iu.test(before)) return true;
  }
  return false;
}

function isCompletionTerm(term) {
  return new RegExp(COMPLETION_CLAIMS.source, COMPLETION_CLAIMS.flags.replace('g', '')).test(term);
}

function checkText(expected, content, checks) {
  const text = typeof content === 'string' ? content : '';
  const missing = (expected.contains ?? []).filter(item => !exactFact(text, item));
  for (const alternatives of expected.containsAny ?? []) {
    if (!alternatives.some(item => exactFact(text, item))) missing.push(alternatives.join(' / '));
  }
  addCheck(checks, 'required_facts', missing.length === 0, missing.length ? `Missing: ${missing.join(', ')}` : undefined);
  const outOfOrder = (expected.ordered ?? []).some((item, index, all) => {
    const at = text.toLocaleLowerCase('ru-RU').indexOf(item.toLocaleLowerCase('ru-RU'));
    if (at < 0) return true;
    return index > 0 && at < text.toLocaleLowerCase('ru-RU').indexOf(all[index - 1].toLocaleLowerCase('ru-RU'));
  });
  if (expected.ordered) addCheck(checks, 'required_order', !outOfOrder);
  if (expected.pairs) {
    const normalized = text.toLocaleLowerCase('ru-RU');
    const mismatch = expected.pairs.find((pair, index) => {
      const start = normalized.indexOf(pair.key.toLocaleLowerCase('ru-RU'));
      if (start < 0) return true;
      let end = normalized.length;
      for (const next of expected.pairs.slice(index + 1)) {
        const nextAt = normalized.indexOf(next.key.toLocaleLowerCase('ru-RU'), start + pair.key.length);
        if (nextAt >= 0) end = Math.min(end, nextAt);
      }
      const delimiterAt = normalized.slice(start, end).search(/[,;\n.!?]/);
      if (delimiterAt >= 0) end = start + delimiterAt;
      return !exactFact(text.slice(start, end), pair.value);
    });
    addCheck(checks, 'required_pairings', !mismatch, mismatch ? `Incorrect or missing value for ${mismatch.key}.` : undefined);
  }
  const forbidden = (expected.forbids ?? []).filter(item => exactFact(text, item));
  addCheck(checks, 'no_contradictions', forbidden.length === 0, forbidden.length ? `Found: ${forbidden.join(', ')}` : undefined);
}

function checkJsonExpected(testCase, result, checks) {
  const parsed = parseJson(result.content);
  addCheck(checks, 'valid_json', parsed.value !== undefined, parsed.error);
  addCheck(checks, 'strict_json_format', parsed.strict, parsed.strict ? undefined : 'A single fenced JSON block is parseable but not strict JSON output.');
  const noToolCalls = !Array.isArray(result.tool_calls) || result.tool_calls.length === 0;
  addCheck(checks, 'no_unrequested_tool_calls', noToolCalls);
  const exact = parsed.value !== undefined && isDeepStrictEqual(parsed.value, testCase.expected.value);
  addCheck(checks, 'exact_expected_value', exact, exact ? undefined : 'Output must match the expected JSON exactly, including keys, values, and array order.');
}

function checkEditPlan(testCase, result, checks) {
  const parsed = parseJson(result.content);
  addCheck(checks, 'valid_json', parsed.value !== undefined, parsed.error);
  addCheck(checks, 'strict_json_format', parsed.strict);
  const value = parsed.value;
  const expected = testCase.expected.value;
  const shapeOk = value && typeof value === 'object' && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), ['arguments', 'tool'])
    && value.tool === 'replace_text'
    && value.arguments && typeof value.arguments === 'object' && !Array.isArray(value.arguments)
    && isDeepStrictEqual(Object.keys(value.arguments).sort(), ['new_text', 'old_text', 'paragraph_id'])
    && value.arguments.paragraph_id === expected.arguments.paragraph_id
    && typeof value.arguments.old_text === 'string'
    && typeof value.arguments.new_text === 'string';
  addCheck(checks, 'edit_plan_schema_and_target', shapeOk,
    shapeOk ? undefined : 'Expected one replace_text edit with the exact target and only paragraph_id, old_text, new_text.');
  const source = testCase.expected.sourceText;
  const oldText = shapeOk ? value.arguments.old_text : '';
  const occurrences = oldText ? source.split(oldText).length - 1 : 0;
  addCheck(checks, 'unique_source_match', occurrences === 1,
    occurrences === 1 ? undefined : `old_text must occur once in sourceText; found ${occurrences}.`);
  const finalText = shapeOk && occurrences === 1
    ? source.replace(oldText, value.arguments.new_text)
    : undefined;
  addCheck(checks, 'only_requested_text_changes', finalText === testCase.expected.finalText,
    finalText === testCase.expected.finalText ? undefined : 'Applying the exact replacement must yield finalText and preserve every other character.');
  const noToolCalls = !Array.isArray(result.tool_calls) || result.tool_calls.length === 0;
  addCheck(checks, 'no_unrequested_tool_calls', noToolCalls);
}

function checkClarification(testCase, result, checks) {
  const parsed = parseJson(result.content);
  addCheck(checks, 'valid_json', parsed.value !== undefined, parsed.error);
  addCheck(checks, 'strict_json_format', parsed.strict);
  const value = parsed.value;
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).sort() : [];
  const shapeOk = isDeepStrictEqual(keys, ['action', 'question']) && value.action === 'clarify' && typeof value.question === 'string' && value.question.trim().length > 0;
  addCheck(checks, 'clarification_shape', shapeOk, shapeOk ? undefined : 'Expected only {"action":"clarify","question":"..."}.');
  if (shapeOk) checkText({ contains: testCase.expected.contains, containsAny: testCase.expected.containsAny }, value.question, checks);
  else {
    addCheck(checks, 'required_facts', false, 'Question could not be checked because clarification structure is invalid.');
  }
  const forbidden = (testCase.expected.forbids ?? []).filter(item => !isCompletionTerm(item) && exactFact(String(result.content ?? ''), item));
  addCheck(checks, 'no_completion_claim', forbidden.length === 0 && !hasCompletionClaim(result.content),
    forbidden.length ? `Found forbidden claim: ${forbidden.join(', ')}` : undefined);
  if (Array.isArray(result.tool_calls) && result.tool_calls.length) addCheck(checks, 'no_unrequested_tool_calls', false);
}

function checkToolCall(testCase, result, checks) {
  const calls = Array.isArray(result.tool_calls) ? result.tool_calls : [];
  const protocolOk = calls.length === 1 && calls[0]?.function?.name === testCase.expected.name;
  addCheck(checks, 'native_tool_protocol', protocolOk, protocolOk ? undefined : 'Expected exactly one native tool call; prose-only imitation does not count.');
  let args;
  let argsError;
  if (protocolOk) {
    const raw = calls[0].function.arguments;
    try {
      args = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (error) {
      argsError = error.message;
    }
  }
  const argsOk = protocolOk && args !== undefined && isDeepStrictEqual(args, testCase.expected.arguments);
  addCheck(checks, 'tool_arguments', argsOk, argsError ?? (argsOk ? undefined : 'Tool arguments must match the expected object exactly.'));
}

export function gradeCase(testCase, result = {}) {
  const checks = [];
  const incomplete = result.error != null || INCOMPLETE_REASONS.has(String(result.finish_reason ?? '').toLowerCase());
  addCheck(checks, 'completed', !incomplete, result.error ?? (incomplete ? `finish_reason=${result.finish_reason}` : undefined));

  switch (testCase.expected?.kind) {
    case 'json':
      checkJsonExpected(testCase, result, checks);
      break;
    case 'edit_plan':
      checkEditPlan(testCase, result, checks);
      break;
    case 'clarify':
      checkClarification(testCase, result, checks);
      break;
    case 'tool_call':
      checkToolCall(testCase, result, checks);
      break;
    case 'text':
      checkText(testCase.expected, result.content, checks);
      break;
    default:
      throw new Error(`Unknown expected kind for case ${testCase.id}: ${testCase.expected?.kind}`);
  }

  const score = checks.filter(check => check.passed).length;
  return { passed: score === checks.length, score, maxScore: checks.length, checks };
}
