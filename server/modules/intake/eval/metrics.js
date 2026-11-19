/**
 * metrics.js
 *
 * Pure scoring helpers for the intake evaluation harness.
 * Kept separate from the runner so metrics are unit-testable.
 */

const {
  getSchemaByFormId,
} = require('../data/formSchemas');
const {
  isValueInSchema,
  resolveProvenance,
} = require('../utils/normalizer');

const FIELD_KEYS = ['value', 'confidence', 'provenance', 'requires_review'];

function sameValue(a, b) {
  return a === b;
}

function pct(numerator, denominator) {
  // Zero denominator means there is nothing to score; treat it as a perfect
  // (vacuous) rate so empty datasets report 100% rather than null.
  if (!denominator) return 1;
  return numerator / denominator;
}

function round(value, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(value)) return value;
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function getSchemaForCase(testCase, response) {
  const formId =
    (testCase.expected && testCase.expected.form_id) ||
    (response && response.form_id) ||
    testCase.form_id;
  return formId ? getSchemaByFormId(formId) : undefined;
}

/**
 * Score a routing case.
 * @param {Object} testCase
 * @param {Object} response
 * @returns {Object}
 */
function evaluateRoutingCase(testCase, response) {
  const expected = testCase.expected || {};
  const actual = {
    form_id: response && response.form_id !== undefined ? response.form_id : null,
    clarification_required: Boolean(
      response && response.clarification_required
    ),
  };

  const checks = [
    {
      id: 'form_id',
      pass: sameValue(actual.form_id, expected.form_id),
      expected: expected.form_id,
      actual: actual.form_id,
    },
    {
      id: 'clarification_required',
      pass: sameValue(
        actual.clarification_required,
        Boolean(expected.clarification_required)
      ),
      expected: Boolean(expected.clarification_required),
      actual: actual.clarification_required,
    },
  ];

  return {
    id: testCase.id,
    category: 'routing',
    tags: testCase.tags || [],
    passed: checks.every((check) => check.pass),
    checks,
  };
}

/**
 * Score an extraction case, including contract, null, provenance, and review
 * flag checks.
 *
 * @param {Object} testCase
 * @param {Object} response
 * @returns {Object}
 */
function evaluateExtractionCase(testCase, response) {
  const expected = testCase.expected || {};
  const expectedFields = expected.fields || {};
  const actualFields = (response && response.fields) || {};
  const schema = getSchemaForCase(testCase, response);

  const checks = [];
  const contractViolations = [];
  const assertions = [];

  checks.push({
    id: 'form_id',
    pass: sameValue(
      response && response.form_id !== undefined ? response.form_id : null,
      expected.form_id || testCase.form_id || null
    ),
    expected: expected.form_id || testCase.form_id || null,
    actual: response ? response.form_id : null,
  });

  const schemaFields = new Map(
    (schema ? schema.fields : []).map((field) => [field.path, field])
  );

  // Unknown fields must never survive the pipeline.
  for (const path of Object.keys(actualFields)) {
    if (!schemaFields.has(path)) {
      contractViolations.push({
        path,
        kind: 'unknown_field',
        detail: 'Field is not part of the form schema.',
      });
    }
  }

  let expectedNulls = 0;
  let nullCorrect = 0;
  let hallucinatedNulls = 0;
  let expectedPositives = 0;
  let predictedPositives = 0;
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  for (const [path, expectedValue] of Object.entries(expectedFields)) {
    const field = schemaFields.get(path);
    const entry = actualFields[path];
    const actualValue = entry ? entry.value : undefined;

    const fieldPass =
      Boolean(entry) &&
      FIELD_KEYS.every((key) => Object.prototype.hasOwnProperty.call(entry, key)) &&
      sameValue(actualValue, expectedValue);

    checks.push({
      id: `field:${path}`,
      pass: fieldPass,
      expected: expectedValue,
      actual: entry ? actualValue : undefined,
    });
    assertions.push({
      path,
      expected: expectedValue,
      actual: entry ? actualValue : undefined,
      pass: fieldPass,
    });

    if (expectedValue === null) {
      expectedNulls += 1;
      if (actualValue === null || actualValue === undefined) {
        nullCorrect += 1;
      } else {
        hallucinatedNulls += 1;
        predictedPositives += 1;
        falsePositives += 1;
      }
    } else {
      expectedPositives += 1;
      if (actualValue !== null && actualValue !== undefined) {
        predictedPositives += 1;
        if (sameValue(actualValue, expectedValue)) {
          truePositives += 1;
        } else {
          falsePositives += 1;
          falseNegatives += 1;
        }
      } else {
        falseNegatives += 1;
      }
    }

    if (entry) {
      const missingKeys = FIELD_KEYS.filter(
        (key) => !Object.prototype.hasOwnProperty.call(entry, key)
      );
      if (missingKeys.length) {
        contractViolations.push({
          path,
          kind: 'missing_contract_keys',
          detail: missingKeys.join(','),
        });
      }

      if (
        typeof entry.confidence !== 'number' ||
        !Number.isFinite(entry.confidence) ||
        entry.confidence < 0 ||
        entry.confidence > 1
      ) {
        contractViolations.push({
          path,
          kind: 'invalid_confidence',
          detail: String(entry.confidence),
        });
      }

      if (entry.value === null) {
        if (entry.provenance !== null) {
          contractViolations.push({
            path,
            kind: 'provenance_on_null',
            detail: 'A null value must have null provenance.',
          });
        }
      } else {
        const resolved = resolveProvenance(entry.provenance, testCase.text || '');
        if (!resolved.ok) {
          contractViolations.push({
            path,
            kind: 'invalid_provenance',
            detail: resolved.reason,
          });
        }
        if (field && !isValueInSchema(field, entry.value)) {
          contractViolations.push({
            path,
            kind: 'value_outside_schema',
            detail: String(entry.value),
          });
        }
      }
    }
  }

  // Review flag checks are separate from value correctness.
  let reviewChecks = 0;
  let reviewCorrect = 0;

  for (const path of expected.review_required || []) {
    reviewChecks += 1;
    const entry = actualFields[path];
    const pass = Boolean(entry && entry.requires_review === true);
    if (pass) reviewCorrect += 1;
    checks.push({
      id: `review_required:${path}`,
      pass,
      expected: true,
      actual: entry ? entry.requires_review : undefined,
    });
  }

  for (const path of expected.review_not_required || []) {
    reviewChecks += 1;
    const entry = actualFields[path];
    const pass = Boolean(entry && entry.requires_review === false);
    if (pass) reviewCorrect += 1;
    checks.push({
      id: `review_not_required:${path}`,
      pass,
      expected: false,
      actual: entry ? entry.requires_review : undefined,
    });
  }

  // Provenance validity over every non-null value the pipeline returned.
  let provenanceChecked = 0;
  let provenanceValid = 0;
  for (const entry of Object.values(actualFields)) {
    if (entry && entry.value !== null && entry.value !== undefined) {
      provenanceChecked += 1;
      if (resolveProvenance(entry.provenance, testCase.text || '').ok) {
        provenanceValid += 1;
      }
    }
  }

  const passed =
    checks.every((check) => check.pass) && contractViolations.length === 0;

  return {
    id: testCase.id,
    category: 'extraction',
    tags: testCase.tags || [],
    passed,
    checks,
    assertions,
    contractViolations,
    counters: {
      expectedNulls,
      nullCorrect,
      hallucinatedNulls,
      expectedPositives,
      predictedPositives,
      truePositives,
      falsePositives,
      falseNegatives,
      reviewChecks,
      reviewCorrect,
      provenanceChecked,
      provenanceValid,
    },
    aliasCase: (testCase.tags || []).includes('enum_alias'),
    aliasPassed:
      (testCase.tags || []).includes('enum_alias') &&
      Object.entries(expectedFields).every(([path, expectedValue]) => {
        if (expectedValue === null) return true;
        const entry = actualFields[path];
        return Boolean(entry) && sameValue(entry.value, expectedValue);
      }),
  };
}

/**
 * Aggregate case results into report metrics.
 * @param {Array<Object>} results
 * @returns {Object}
 */
function aggregateResults(results) {
  const routingResults = results.filter((result) => result.category === 'routing');
  const extractionResults = results.filter(
    (result) => result.category === 'extraction'
  );

  const totals = {
    cases: results.length,
    routing_cases: routingResults.length,
    extraction_cases: extractionResults.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
  };

  const routingPassed = routingResults.filter((result) => result.passed).length;

  const field = {
    assertions: 0,
    exact: 0,
    expectedPositives: 0,
    predictedPositives: 0,
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    expectedNulls: 0,
    nullCorrect: 0,
    hallucinatedNulls: 0,
    reviewChecks: 0,
    reviewCorrect: 0,
    provenanceChecked: 0,
    provenanceValid: 0,
    schemaViolations: 0,
    contractViolations: 0,
    aliasCases: 0,
    aliasPassed: 0,
  };

  for (const result of extractionResults) {
    for (const assertion of result.assertions || []) {
      field.assertions += 1;
      if (assertion.pass) field.exact += 1;
    }
    const counters = result.counters || {};
    field.expectedPositives += counters.expectedPositives || 0;
    field.predictedPositives += counters.predictedPositives || 0;
    field.truePositives += counters.truePositives || 0;
    field.falsePositives += counters.falsePositives || 0;
    field.falseNegatives += counters.falseNegatives || 0;
    field.expectedNulls += counters.expectedNulls || 0;
    field.nullCorrect += counters.nullCorrect || 0;
    field.hallucinatedNulls += counters.hallucinatedNulls || 0;
    field.reviewChecks += counters.reviewChecks || 0;
    field.reviewCorrect += counters.reviewCorrect || 0;
    field.provenanceChecked += counters.provenanceChecked || 0;
    field.provenanceValid += counters.provenanceValid || 0;
    if (result.aliasCase) field.aliasCases += 1;
    if (result.aliasPassed) field.aliasPassed += 1;

    for (const violation of result.contractViolations || []) {
      field.contractViolations += 1;
      if (violation.kind === 'value_outside_schema') field.schemaViolations += 1;
      if (violation.kind === 'unknown_field') field.schemaViolations += 1;
    }
  }

  const precision = pct(
    field.truePositives,
    field.truePositives + field.falsePositives
  );
  const recall = pct(
    field.truePositives,
    field.truePositives + field.falseNegatives
  );
  const f1 =
    precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : 0;

  const extractionPassed = extractionResults.filter(
    (result) => result.passed
  ).length;

  const failures = results
    .filter((result) => !result.passed)
    .map((result) => ({
      id: result.id,
      category: result.category,
      failed_checks: (result.checks || [])
        .filter((check) => !check.pass)
        .map((check) => ({
          check: check.id,
          expected: check.expected,
          actual: check.actual,
        })),
      contract_violations: result.contractViolations || [],
    }));

  return {
    totals,
    routing: {
      total: routingResults.length,
      passed: routingPassed,
      accuracy: round(pct(routingPassed, routingResults.length)),
    },
    extraction: {
      cases: extractionResults.length,
      passed: extractionPassed,
      exact_match: round(pct(field.exact, field.assertions)),
      precision: round(precision),
      recall: round(recall),
      f1: round(f1),
      null_accuracy: round(pct(field.nullCorrect, field.expectedNulls)),
      hallucination_rate: round(
        pct(field.hallucinatedNulls, field.expectedNulls)
      ),
      provenance_validity_rate: round(
        pct(field.provenanceValid, field.provenanceChecked)
      ),
      review_flag_accuracy: round(
        pct(field.reviewCorrect, field.reviewChecks)
      ),
      alias_normalization_accuracy: round(
        pct(field.aliasPassed, field.aliasCases)
      ),
      schema_violations: field.schemaViolations,
      contract_violations: field.contractViolations,
      assertions: field.assertions,
      expected_positives: field.expectedPositives,
      predicted_positives: field.predictedPositives,
      expected_nulls: field.expectedNulls,
      true_positives: field.truePositives,
      false_positives: field.falsePositives,
      false_negatives: field.falseNegatives,
    },
    case_pass_rate: round(pct(totals.passed, totals.cases)),
    failures,
  };
}

module.exports = {
  FIELD_KEYS,
  evaluateRoutingCase,
  evaluateExtractionCase,
  aggregateResults,
  pct,
  round,
};
