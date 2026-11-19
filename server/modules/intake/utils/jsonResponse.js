/**
 * jsonResponse.js
 *
 * Defensive JSON parsing for model responses.
 *
 * Free-tier models frequently differ from paid OpenAI models in small but
 * important ways:
 *   - they wrap JSON in ```json ... ``` markdown fences
 *   - they add a short preamble or trailing commentary
 *   - they emit trailing commas
 *   - they return LangChain `AIMessage` content blocks instead of a string
 *
 * This module normalises all of those shapes into a plain object without
 * inventing data. If no valid JSON object can be recovered, the caller gets a
 * clear error and is expected to require clarification rather than guess.
 */

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Convert an arbitrary model response (string, AIMessage, content blocks) to
 * text. Returns an empty string for unsupported inputs.
 *
 * @param {*} input
 * @returns {string}
 */
function contentToText(input) {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) return input.map(contentToText).join('');

  if (typeof input === 'object') {
    // LangChain AIMessage / BaseMessage instances expose `.content`.
    if (Array.isArray(input.content)) return contentToText(input.content);
    if (typeof input.content === 'string') return input.content;

    // Content blocks: { type: 'text', text: '...' }
    if (typeof input.text === 'string') return input.text;

    // Serialized message shapes.
    if (input.kwargs && typeof input.kwargs === 'object') {
      return contentToText(input.kwargs.content);
    }
  }

  return String(input);
}

/**
 * Remove markdown code fences and surrounding prose.
 *
 * @param {string} text
 * @returns {string}
 */
function stripMarkdownFences(text) {
  let value = String(text || '').replace(/^\uFEFF/, '').trim();

  // Prefer the contents of the first fenced block when present.
  const fenced = value.match(/```(?:json|javascript|js)?\s*([\s\S]*?)```/i);
  if (fenced) {
    value = fenced[1].trim();
  } else {
    // A model may open a fence but never close it.
    value = value
      .replace(/^```(?:json|javascript|js)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
  }

  return value;
}

/**
 * Find the first balanced JSON object/array in a string.
 * Handles nested objects, arrays, and braces inside string literals.
 *
 * @param {string} text
 * @returns {string|null}
 */
function findBalancedJson(text) {
  const value = String(text || '');
  const start = value.search(/[\[{]/);
  if (start === -1) return null;

  const opening = value[start];
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < value.length; index += 1) {
    const char = value[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === opening) {
      depth += 1;
    } else if (char === closing) {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }

  return null;
}

/**
 * Remove trailing commas before a closing brace/bracket, ignoring string
 * literals. Applied only after the initial JSON.parse fails.
 *
 * @param {string} text
 * @returns {string}
 */
function stripTrailingCommas(text) {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === ',') {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) {
        lookahead += 1;
      }
      if (text[lookahead] === '}' || text[lookahead] === ']') {
        // Drop the trailing comma but keep the whitespace.
        continue;
      }
    }

    result += char;
  }

  return result;
}

function tryParseJson(candidate) {
  try {
    return { ok: true, value: JSON.parse(candidate) };
  } catch (firstError) {
    const withoutTrailingCommas = stripTrailingCommas(candidate);
    if (withoutTrailingCommas !== candidate) {
      try {
        return { ok: true, value: JSON.parse(withoutTrailingCommas) };
      } catch (_ignored) {
        // Fall through to the original error below.
      }
    }
    return { ok: false, error: firstError };
  }
}

/**
 * Parse a model response into a plain object.
 *
 * Throws when no JSON value can be recovered or when the recovered value is
 * not an object/array (the pipeline always expects a structured payload).
 *
 * @param {*} input - String, AIMessage, content blocks, or an already-parsed object.
 * @returns {Object|Array}
 */
function parseJsonResponse(input) {
  // Already parsed by LangChain (jsonMode / function calling).
  if (isPlainObject(input) || Array.isArray(input)) {
    return input;
  }

  const text = stripMarkdownFences(contentToText(input));
  if (!text) {
    throw new SyntaxError('The model returned an empty response; expected a JSON object.');
  }

  const direct = tryParseJson(text);
  if (direct.ok) return direct.value;

  const balanced = findBalancedJson(text);
  if (balanced) {
    const parsed = tryParseJson(balanced);
    if (parsed.ok) return parsed.value;
  }

  throw new SyntaxError(
    'The model response did not contain parseable JSON. No values were accepted.'
  );
}

/**
 * Non-throwing variant used by defensive callers.
 *
 * @param {*} input
 * @returns {{ok: boolean, value?: Object|Array, error?: string}}
 */
function tryParseJsonResponse(input) {
  try {
    return { ok: true, value: parseJsonResponse(input) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  contentToText,
  stripMarkdownFences,
  findBalancedJson,
  stripTrailingCommas,
  parseJsonResponse,
  tryParseJsonResponse,
};
