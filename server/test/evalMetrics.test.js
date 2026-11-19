const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateRoutingCase,
  evaluateExtractionCase,
  aggregateResults,
} = require('../modules/intake/eval/metrics');
const { field } = require('./support/fakes');

test('routing cases compare form_id and clarification_required', () => {
  const testCase = {
    id: 'routing-1',
    category: 'routing',
    tags: ['routing'],
    expected: { form_id: 'FORM_TAX_FILING', clarification_required: false },
  };

  const pass = evaluateRoutingCase(testCase, {
    form_id: 'FORM_TAX_FILING',
    clarification_required: false,
  });
  assert.equal(pass.passed, true);

  const wrongForm = evaluateRoutingCase(testCase, {
    form_id: 'FORM_SUPPORT_TICKET',
    clarification_required: false,
  });
  assert.equal(wrongForm.passed, false);
  assert.equal(wrongForm.checks.find((c) => c.id === 'form_id').pass, false);

  const wrongClarification = evaluateRoutingCase(testCase, {
    form_id: 'FORM_TAX_FILING',
    clarification_required: true,
  });
  assert.equal(wrongClarification.passed, false);
});

test('extraction cases score exact matches, nulls, and hallucinations', () => {
  const testCase = {
    id: 'extraction-1',
    category: 'extraction',
    tags: ['extraction'],
    text: 'Tax year 2025, maybe single.',
    expected: {
      form_id: 'FORM_TAX_FILING',
      fields: {
        tax_year: 2025,
        filing_status: null,
      },
    },
  };

  const result = evaluateExtractionCase(testCase, {
    form_id: 'FORM_TAX_FILING',
    fields: {
      tax_year: field(2025, 0.9, '2025'),
      filing_status: field('single', 0.9, 'single'),
    },
  });

  assert.equal(result.passed, false);
  assert.equal(result.counters.expectedNulls, 1);
  assert.equal(result.counters.nullCorrect, 0);
  assert.equal(result.counters.hallucinatedNulls, 1);
  assert.equal(result.counters.truePositives, 1);
  assert.equal(result.counters.falsePositives, 1);
  assert.equal(result.assertions.find((a) => a.path === 'tax_year').pass, true);

  const summary = aggregateResults([result]);
  assert.equal(summary.extraction.hallucination_rate, 1);
  assert.equal(summary.extraction.null_accuracy, 0);
  assert.equal(summary.extraction.precision, 0.5);
  assert.equal(summary.extraction.recall, 1);
  assert.equal(summary.failures.length, 1);
});

test('null expected values with correct null results are not hallucinations', () => {
  const testCase = {
    id: 'extraction-2',
    category: 'extraction',
    tags: ['extraction'],
    text: 'I need to file my taxes.',
    expected: {
      form_id: 'FORM_TAX_FILING',
      fields: { filing_status: null, tax_year: null },
    },
  };

  const result = evaluateExtractionCase(testCase, {
    form_id: 'FORM_TAX_FILING',
    fields: {
      filing_status: field(null, 0.1, null, true),
      tax_year: field(null, 0.1, null, true),
    },
  });

  assert.equal(result.passed, true);
  assert.equal(result.counters.nullCorrect, 2);
  assert.equal(result.counters.hallucinatedNulls, 0);

  const summary = aggregateResults([result]);
  assert.equal(summary.extraction.hallucination_rate, 0);
  assert.equal(summary.extraction.null_accuracy, 1);
});

test('invalid provenance and schema violations fail the case', () => {
  const testCase = {
    id: 'extraction-3',
    category: 'extraction',
    tags: ['extraction'],
    text: 'Tax year 2025.',
    expected: {
      form_id: 'FORM_TAX_FILING',
      fields: { tax_year: 2025 },
    },
  };

  const badProvenance = evaluateExtractionCase(testCase, {
    form_id: 'FORM_TAX_FILING',
    fields: { tax_year: field(2025, 0.9, '2030') },
  });
  assert.equal(badProvenance.passed, false);
  assert.equal(badProvenance.counters.provenanceChecked, 1);
  assert.equal(badProvenance.counters.provenanceValid, 0);
  assert.ok(
    badProvenance.contractViolations.some((v) => v.kind === 'invalid_provenance')
  );

  const schemaViolation = evaluateExtractionCase(testCase, {
    form_id: 'FORM_TAX_FILING',
    fields: { tax_year: field('twenty twenty-five', 0.9, '2025') },
  });
  assert.equal(schemaViolation.passed, false);
  const summary = aggregateResults([schemaViolation]);
  assert.equal(summary.extraction.schema_violations, 1);
});

test('review flag expectations are scored independently', () => {
  const testCase = {
    id: 'extraction-4',
    category: 'extraction',
    tags: ['extraction'],
    text: 'Tax year 2025.',
    expected: {
      form_id: 'FORM_TAX_FILING',
      fields: { tax_year: 2025 },
      review_required: ['tax_year'],
    },
  };

  const missingReview = evaluateExtractionCase(testCase, {
    form_id: 'FORM_TAX_FILING',
    fields: { tax_year: field(2025, 0.9, '2025', false) },
  });
  assert.equal(missingReview.passed, false);
  assert.equal(missingReview.counters.reviewCorrect, 0);

  const reviewed = evaluateExtractionCase(testCase, {
    form_id: 'FORM_TAX_FILING',
    fields: { tax_year: field(2025, 0.9, '2025', true) },
  });
  assert.equal(reviewed.passed, true);
});

test('aggregate results handle an empty extraction set', () => {
  const summary = aggregateResults([]);
  assert.equal(summary.totals.cases, 0);
  // Zero-denominator metrics are vacuous; the runner never scores an empty
  // dataset because dataset validation requires cases.
  assert.equal(summary.routing.accuracy, 1);
  assert.equal(summary.extraction.exact_match, 1);
  assert.equal(summary.case_pass_rate, 1);
  assert.deepEqual(summary.failures, []);
});
