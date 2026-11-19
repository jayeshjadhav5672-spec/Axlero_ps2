/**
 * normalizer.js
 *
 * Deterministic normalization for extracted values.
 *
 * This module is the last line of defence against hallucination:
 *   - Values must match the field's declared type.
 *   - Enum values must exactly match an allowed value or a finite, explicit
 *     synonym. Unknown or unsupported values normalize to null.
 *   - Provenance must be a verbatim snippet from the source text. If it is
 *     not, the value is discarded.
 *
 * Nothing here invents a "closest" value, applies fuzzy matching, or falls
 * back to a default. Unsupported input always produces null.
 */

const MONTHS = Object.freeze({
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
});

const TRUE_STRINGS = new Set(['true', 'yes', 'y', 't', '1']);
const FALSE_STRINGS = new Set(['false', 'no', 'n', 'f', '0']);

const enumIndexCache = new WeakMap();

/**
 * Collapse all runs of whitespace and trim.
 * @param {*} value
 * @returns {string}
 */
function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Normalize a string for exact enum/alias comparison.
 * Case-insensitive; underscores, hyphens and slashes become spaces; common
 * punctuation is removed. This is still an exact comparison, not fuzzy.
 *
 * @param {*} value
 * @returns {string}
 */
function normalizeEnumKey(value) {
  return normalizeWhitespace(
    String(value ?? '')
      .toLowerCase()
      .replace(/[_\-\/]+/g, ' ')
      .replace(/[.,;:!?'"()[\]{}]/g, ' ')
  );
}

/**
 * Build (and cache) the exact-match index for an enum field.
 * @param {Object} field
 * @returns {{index: Map<string, Object>, ambiguities: Map<string, string[]>}}
 */
function buildEnumIndex(field) {
  if (enumIndexCache.has(field)) return enumIndexCache.get(field);

  const index = new Map();
  const ambiguities = new Map();

  const add = (key, canonical, aliasMapped) => {
    if (!key) return;
    const existing = index.get(key);
    if (existing && existing.canonical !== canonical) {
      ambiguities.set(key, [existing.canonical, canonical]);
      index.delete(key);
      return;
    }
    if (!existing) {
      index.set(key, { canonical, aliasMapped });
    }
  };

  for (const canonical of field.enum || []) {
    add(normalizeEnumKey(canonical), canonical, false);
    for (const alias of field.aliases?.[canonical] || []) {
      add(normalizeEnumKey(alias), canonical, true);
    }
  }

  const result = { index, ambiguities };
  enumIndexCache.set(field, result);
  return result;
}

/**
 * Match a raw value against an enum field's allowed values and aliases.
 *
 * @param {Object} field
 * @param {*} raw
 * @returns {{value: string|null, ok: boolean, reason: string|null, aliasMapped: boolean}}
 */
function matchEnum(field, raw) {
  if (typeof raw !== 'string') {
    return { value: null, ok: false, reason: 'type_mismatch', aliasMapped: false };
  }

  const key = normalizeEnumKey(raw);
  if (!key) {
    return { value: null, ok: false, reason: 'empty_value', aliasMapped: false };
  }

  const { index, ambiguities } = buildEnumIndex(field);

  if (ambiguities.has(key)) {
    return { value: null, ok: false, reason: 'ambiguous_alias', aliasMapped: false };
  }

  const match = index.get(key);
  if (!match) {
    return { value: null, ok: false, reason: 'enum_not_allowed', aliasMapped: false };
  }

  return {
    value: match.canonical,
    ok: true,
    reason: null,
    // Case/underscore normalization is not an alias. A synonym is.
    aliasMapped: match.aliasMapped && key !== normalizeEnumKey(match.canonical),
  };
}

/**
 * Is this a real calendar date?
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 * @returns {boolean}
 */
function isValidDateParts(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (year < 1900 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function formatDate(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(
    day
  ).padStart(2, '0')}`;
}

/**
 * Normalize an explicit, unambiguous date to YYYY-MM-DD.
 * Numeric formats such as 03/04/2026 are rejected because day/month order is
 * ambiguous; the extractor must not guess.
 *
 * @param {*} raw
 * @returns {{value: string|null, ok: boolean, reason: string|null}}
 */
function normalizeDate(raw) {
  if (typeof raw !== 'string') {
    return { value: null, ok: false, reason: 'type_mismatch' };
  }

  const text = normalizeWhitespace(raw).replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  if (!text) return { value: null, ok: false, reason: 'empty_value' };

  // YYYY-MM-DD or YYYY/MM/DD
  let match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!isValidDateParts(year, month, day)) {
      return { value: null, ok: false, reason: 'invalid_date' };
    }
    return { value: formatDate(year, month, day), ok: true, reason: null };
  }

  // Month D, YYYY  /  Month D YYYY
  match = text.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (match) {
    const month = MONTHS[match[1].toLowerCase()];
    const day = Number(match[2]);
    const year = Number(match[3]);
    if (!month) return { value: null, ok: false, reason: 'invalid_date' };
    if (!isValidDateParts(year, month, day)) {
      return { value: null, ok: false, reason: 'invalid_date' };
    }
    return { value: formatDate(year, month, day), ok: true, reason: null };
  }

  // D Month YYYY
  match = text.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (match) {
    const day = Number(match[1]);
    const month = MONTHS[match[2].toLowerCase()];
    const year = Number(match[3]);
    if (!month) return { value: null, ok: false, reason: 'invalid_date' };
    if (!isValidDateParts(year, month, day)) {
      return { value: null, ok: false, reason: 'invalid_date' };
    }
    return { value: formatDate(year, month, day), ok: true, reason: null };
  }

  return { value: null, ok: false, reason: 'ambiguous_or_unsupported_date' };
}

/**
 * Coerce a raw value into the field's declared type.
 *
 * @param {Object} field
 * @param {*} raw
 * @returns {{value: *, ok: boolean, reason: string|null, aliasMapped: boolean}}
 */
function normalizeValue(field, raw) {
  if (!field || !field.type) {
    return { value: null, ok: false, reason: 'unknown_field', aliasMapped: false };
  }

  if (raw === null || raw === undefined) {
    return { value: null, ok: false, reason: 'missing', aliasMapped: false };
  }

  switch (field.type) {
    case 'string': {
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        // Numeric identifiers (for example a policy number) are safe to
        // stringify. Objects/arrays are not coerced.
        return { value: String(raw), ok: true, reason: null, aliasMapped: false };
      }
      if (typeof raw !== 'string') {
        return { value: null, ok: false, reason: 'type_mismatch', aliasMapped: false };
      }
      const text = normalizeWhitespace(raw).replace(/^["']|["']$/g, '');
      if (!text) {
        return { value: null, ok: false, reason: 'empty_value', aliasMapped: false };
      }
      if (field.maxLength && text.length > field.maxLength) {
        return { value: null, ok: false, reason: 'too_long', aliasMapped: false };
      }
      return { value: text, ok: true, reason: null, aliasMapped: false };
    }

    case 'number': {
      let numeric;

      if (typeof raw === 'number') {
        numeric = raw;
      } else if (typeof raw === 'string') {
        const cleaned = raw
          .trim()
          .replace(/^(usd|eur|gbp)\s*/i, '')
          .replace(/\s*(usd|eur|gbp)$/i, '')
          .replace(/[$€£,]/g, '')
          .replace(/\s+/g, '');

        if (!/^[+-]?\d+(\.\d+)?$/.test(cleaned)) {
          return { value: null, ok: false, reason: 'not_numeric', aliasMapped: false };
        }
        numeric = Number(cleaned);
      } else {
        return { value: null, ok: false, reason: 'type_mismatch', aliasMapped: false };
      }

      if (!Number.isFinite(numeric)) {
        return { value: null, ok: false, reason: 'not_numeric', aliasMapped: false };
      }
      if (field.integer && !Number.isInteger(numeric)) {
        return { value: null, ok: false, reason: 'not_integer', aliasMapped: false };
      }
      if (Number.isFinite(field.min) && numeric < field.min) {
        return { value: null, ok: false, reason: 'below_minimum', aliasMapped: false };
      }
      if (Number.isFinite(field.max) && numeric > field.max) {
        return { value: null, ok: false, reason: 'above_maximum', aliasMapped: false };
      }

      return { value: numeric, ok: true, reason: null, aliasMapped: false };
    }

    case 'boolean': {
      if (typeof raw === 'boolean') {
        return { value: raw, ok: true, reason: null, aliasMapped: false };
      }
      if (typeof raw === 'string') {
        const key = normalizeWhitespace(raw).toLowerCase();
        if (TRUE_STRINGS.has(key)) {
          return { value: true, ok: true, reason: null, aliasMapped: false };
        }
        if (FALSE_STRINGS.has(key)) {
          return { value: false, ok: true, reason: null, aliasMapped: false };
        }
        return { value: null, ok: false, reason: 'not_boolean', aliasMapped: false };
      }
      return { value: null, ok: false, reason: 'type_mismatch', aliasMapped: false };
    }

    case 'date': {
      const result = normalizeDate(raw);
      return { ...result, aliasMapped: false };
    }

    case 'enum': {
      return matchEnum(field, raw);
    }

    default:
      return { value: null, ok: false, reason: 'unsupported_type', aliasMapped: false };
  }
}

/**
 * Check that a normalized value conforms to its schema field.
 * Used by the extraction service and the evaluation harness.
 *
 * @param {Object} field
 * @param {*} value
 * @returns {boolean}
 */
function isValueInSchema(field, value) {
  if (!field || value === null || value === undefined) return false;

  switch (field.type) {
    case 'string':
      return typeof value === 'string' && normalizeWhitespace(value).length > 0;
    case 'number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (!field.integer || Number.isInteger(value)) &&
        (!Number.isFinite(field.min) || value >= field.min) &&
        (!Number.isFinite(field.max) || value <= field.max)
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'date': {
      if (typeof value !== 'string') return false;
      const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!match) return false;
      return isValidDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
    }
    case 'enum':
      return typeof value === 'string' && (field.enum || []).includes(value);
    default:
      return false;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isWordChar(char) {
  return /[A-Za-z0-9]/.test(char);
}

/**
 * Require that a matched quote is not embedded inside a larger alphanumeric
 * token. Without this, a quote like "2 dependents" would match inside
 * "12 dependents", which could make a hallucinated value look supported.
 *
 * @param {string} text
 * @param {number} index
 * @param {number} length
 * @param {string} quote
 * @returns {boolean}
 */
function hasWordBoundaries(text, index, length, quote) {
  if (isWordChar(quote[0]) && index > 0 && isWordChar(text[index - 1])) {
    return false;
  }
  const after = index + length;
  if (
    isWordChar(quote[quote.length - 1]) &&
    after < text.length &&
    isWordChar(text[after])
  ) {
    return false;
  }
  return true;
}

/**
 * Resolve a model-provided provenance quote against the source text.
 *
 * Exact substring matches are returned unchanged. Whitespace-only differences
 * (including newlines collapsed by a model) are repaired by returning the
 * actual source snippet, so the final provenance is always verbatim. Anything
 * else is rejected.
 *
 * @param {*} provenance
 * @param {string} sourceText
 * @returns {{ok: boolean, quote: string|null, reason: string|null}}
 */
function resolveProvenance(provenance, sourceText) {
  if (typeof provenance !== 'string' || !provenance.trim()) {
    return { ok: false, quote: null, reason: 'missing_provenance' };
  }
  if (typeof sourceText !== 'string' || !sourceText) {
    return { ok: false, quote: null, reason: 'missing_source_text' };
  }

  const quote = provenance.trim();
  if (!/[A-Za-z0-9]/.test(quote)) {
    return { ok: false, quote: null, reason: 'uninformative_provenance' };
  }

  // Preserve original source bytes for the returned snippet.
  let searchFrom = 0;
  let exactIndex = sourceText.indexOf(quote, searchFrom);
  while (exactIndex !== -1) {
    if (hasWordBoundaries(sourceText, exactIndex, quote.length, quote)) {
      return { ok: true, quote, reason: null };
    }
    searchFrom = exactIndex + 1;
    exactIndex = sourceText.indexOf(quote, searchFrom);
  }

  // Repair line-ending / whitespace differences. Every run of whitespace in
  // the quote may match any run of whitespace in the source.
  const tokens = quote.split(/\s+/).filter(Boolean);
  const pattern = tokens.map(escapeRegExp).join('\\s+');
  const regex = new RegExp(pattern, 'g');
  let match;
  while ((match = regex.exec(sourceText)) !== null) {
    if (hasWordBoundaries(sourceText, match.index, match[0].length, quote)) {
      return { ok: true, quote: match[0], reason: null };
    }
    regex.lastIndex = match.index + 1;
  }

  return { ok: false, quote: null, reason: 'provenance_not_in_source' };
}

module.exports = {
  normalizeWhitespace,
  normalizeEnumKey,
  matchEnum,
  normalizeDate,
  normalizeValue,
  isValueInSchema,
  isValidDateParts,
  resolveProvenance,
};
