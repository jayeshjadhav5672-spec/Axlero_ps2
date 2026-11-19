const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ExtractionService,
  DEFAULT_REVIEW_THRESHOLD,
} = require('../modules/intake/services/extractionService');
const { getSchemaByFormId } = require('../modules/intake/data/formSchemas');
const { field } = require('./support/fakes');
const {
  ExtractionContractError,
} = require('../modules/intake/chains/extractionChain');

function createService({
  rawFields = {},
  routeResult = null,
  routingError = null,
  chainError = null,
  chainFactoryError = null,
  reviewThreshold = DEFAULT_REVIEW_THRESHOLD,
  maxInputChars = 20000,
} = {}) {
  const state = {
    routingCalls: 0,
    chainCalls: 0,
    capturedRoutingPrompt: null,
  };

  const routingService = {
    route: async ({ userPrompt }) => {
      state.routingCalls += 1;
      state.capturedRoutingPrompt = userPrompt;
      if (routingError) throw routingError;
      return (
        routeResult || {
          form_id: 'FORM_TAX_FILING',
          confidence: 0.95,
          rationale: 'stubbed route',
          clarification_required: false,
        }
      );
    },
  };

  const service = new ExtractionService({
    routingService,
    chainFactory: () => {
      if (chainFactoryError) throw chainFactoryError;
      return {
        invoke: async () => {
          state.chainCalls += 1;
          if (chainError) throw chainError;
          return { fields: rawFields, warnings: { unknown_fields: [] } };
        },
      };
    },
    reviewThreshold,
    maxInputChars,
    extractionModelName: 'test-model',
    clock: (() => {
      let now = 1000;
      return () => {
        now += 10;
        return now;
      };
    })(),
  });

  return { service, state };
}

test('explicit form extraction normalizes aliases and forces review on alias mapping', async () => {
  const text = 'My filing status is married filing jointly and I have 2 dependents.';
  const { service, state } = createService({
    rawFields: {
      filing_status: field('MFJ', 0.9, 'married filing jointly', false),
      dependents_count: field(2, 0.9, '2 dependents', false),
    },
  });

  const result = await service.extract({
    text,
    formId: 'FORM_TAX_FILING',
  });

  assert.equal(state.routingCalls, 0);
  assert.equal(state.chainCalls, 1);
  assert.equal(result.form_id, 'FORM_TAX_FILING');
  assert.equal(result.routing_source, 'explicit');
  assert.equal(result.clarification_required, false);

  assert.equal(result.fields.filing_status.value, 'married_filing_jointly');
  assert.equal(result.fields.filing_status.requires_review, true);
  assert.equal(result.fields.dependents_count.value, 2);
  assert.equal(result.fields.dependents_count.requires_review, false);
  assert.equal(result.requires_review, true);

  assert.deepEqual(Object.keys(result.fields.filing_status).sort(), [
    'confidence',
    'provenance',
    'requires_review',
    'value',
  ]);

  assert.equal(result.meta.extracted_count, 2);
  assert.equal(result.meta.alias_mapped_count, 1);
  assert.equal(result.meta.provenance_rejected_count, 0);
  assert.equal(result.meta.model, 'test-model');
});

test('discards values whose provenance is not in the source text', async () => {
  const { service } = createService({
    rawFields: {
      tax_year: field(2025, 0.95, '2030', false),
      dependents_count: field(2, 0.9, '2 dependents', false),
    },
  });

  const result = await service.extract({
    text: 'I have 2 dependents.',
    formId: 'FORM_TAX_FILING',
  });

  assert.equal(result.fields.tax_year.value, null);
  assert.equal(result.fields.tax_year.provenance, null);
  assert.equal(result.fields.tax_year.requires_review, true);
  assert.equal(result.fields.dependents_count.value, 2);
  assert.equal(result.meta.provenance_rejected_count, 1);
});

test('null values never retain provenance and always require review', async () => {
  const { service } = createService({
    rawFields: {
      filing_status: field(null, 0.4, 'married filing jointly', false),
    },
  });

  const result = await service.extract({
    text: 'My filing status is married filing jointly.',
    formId: 'FORM_TAX_FILING',
  });

  assert.equal(result.fields.filing_status.value, null);
  assert.equal(result.fields.filing_status.provenance, null);
  assert.equal(result.fields.filing_status.requires_review, true);
});

test('unsupported enum values are nulled instead of passed through', async () => {
  const { service } = createService({
    rawFields: {
      patent_type: field('provisional', 0.9, 'provisional patent', false),
    },
  });

  const result = await service.extract({
    text: 'I want to file a provisional patent.',
    formId: 'FORM_PATENT_INTAKE',
  });

  assert.equal(result.fields.patent_type.value, null);
  assert.equal(result.fields.patent_type.provenance, null);
  assert.equal(result.fields.patent_type.requires_review, true);
});

test('low confidence forces requires_review', async () => {
  const { service } = createService({
    rawFields: {
      tax_year: field(2025, 0.5, '2025', false),
    },
    reviewThreshold: 0.75,
  });

  const result = await service.extract({
    text: 'I am filing for tax year 2025.',
    formId: 'FORM_TAX_FILING',
  });

  assert.equal(result.fields.tax_year.value, 2025);
  assert.equal(result.fields.tax_year.requires_review, true);
});

test('provenance whitespace differences are repaired to the verbatim source snippet', async () => {
  const { service } = createService({
    rawFields: {
      filing_status: field(
        'married_filing_jointly',
        0.9,
        'married filing jointly. I have 2 dependents.',
        false
      ),
    },
  });

  const text =
    'My filing status is married filing jointly.\nI have 2 dependents.';
  const result = await service.extract({ text, formId: 'FORM_TAX_FILING' });

  assert.equal(
    result.fields.filing_status.provenance,
    'married filing jointly.\nI have 2 dependents.'
  );
});

test('auto-routes when form_id is omitted', async () => {
  const { service, state } = createService({
    rawFields: {
      tax_year: field(2025, 0.9, '2025', false),
    },
  });

  const result = await service.extract({ text: 'I need to file my 2025 taxes.' });

  assert.equal(state.routingCalls, 1);
  assert.equal(state.chainCalls, 1);
  assert.equal(result.form_id, 'FORM_TAX_FILING');
  assert.equal(result.routing_source, 'auto');
  assert.equal(result.clarification_required, false);
  assert.equal(result.fields.tax_year.value, 2025);
});

test('returns clarification without extracting when routing is ambiguous', async () => {
  const { service, state } = createService({
    routeResult: {
      form_id: null,
      confidence: 0.2,
      rationale: 'ambiguous',
      clarification_required: true,
    },
    rawFields: {},
  });

  const result = await service.extract({ text: 'I need some paperwork help.' });

  assert.equal(state.routingCalls, 1);
  assert.equal(state.chainCalls, 0);
  assert.equal(result.form_id, null);
  assert.equal(result.clarification_required, true);
  assert.equal(result.requires_review, true);
  assert.deepEqual(result.fields, {});
  assert.equal(result.routing.rationale, 'ambiguous');
});

test('treats an unknown routed form id as clarification instead of extracting', async () => {
  const { service, state } = createService({
    routeResult: {
      form_id: 'FORM_INVENTED_BY_MODEL',
      confidence: 0.99,
      rationale: 'invented',
      clarification_required: false,
    },
  });

  const result = await service.extract({ text: 'Some text.' });

  assert.equal(result.clarification_required, true);
  assert.equal(result.form_id, null);
  assert.equal(state.chainCalls, 0);
});

test('rejects unknown explicit form ids and invalid input', async () => {
  const { service } = createService({ rawFields: {} });

  await assert.rejects(
    () => service.extract({ text: 'Some text.', formId: 'FORM_NOPE' }),
    (err) => {
      assert.equal(err.code, 'unknown_form_id');
      assert.equal(err.status, 400);
      assert.deepEqual(err.details.supported_form_ids.sort(), [
        'FORM_EMPLOYEE_ONBOARDING',
        'FORM_INSURANCE_CLAIM',
        'FORM_PATENT_INTAKE',
        'FORM_SUPPORT_TICKET',
        'FORM_TAX_FILING',
      ]);
      return true;
    }
  );

  await assert.rejects(
    () => service.extract({ text: '   ', formId: 'FORM_TAX_FILING' }),
    (err) => err.code === 'validation_error'
  );

  const { service: shortService } = createService({ maxInputChars: 5 });
  await assert.rejects(
    () => shortService.extract({ text: 'too long', formId: 'FORM_TAX_FILING' }),
    (err) => err.code === 'validation_error' && err.details.max_chars === 5
  );
});

test('provider failures surface as a 502 error without fabricated fields', async () => {
  const { service } = createService({
    chainError: new Error('provider down'),
  });

  await assert.rejects(
    () => service.extract({ text: 'Tax year 2025.', formId: 'FORM_TAX_FILING' }),
    (err) => {
      assert.equal(err.code, 'extraction_provider_error');
      assert.equal(err.status, 502);
      assert.equal(err.fields, undefined);
      // Public messages stay generic; the provider detail lives on `cause`.
      assert.match(err.message, /provider was unavailable or misconfigured/);
      assert.match(err.cause.message, /provider down/);
      return true;
    }
  );
});

test('routing initialization failures also surface as a 502 provider error', async () => {
  const { service } = createService({
    routingError: new Error('OPENAI_API_KEY is required'),
  });

  await assert.rejects(
    () => service.extract({ text: 'I need help with some paperwork.' }),
    (err) => {
      assert.equal(err.code, 'extraction_provider_error');
      assert.equal(err.status, 502);
      assert.doesNotMatch(err.message, /OPENAI_API_KEY/);
      assert.match(err.cause.message, /OPENAI_API_KEY is required/);
      return true;
    }
  );
});

test('chain construction failures surface as a 502 provider error', async () => {
  const { service } = createService({
    chainFactoryError: new Error('extraction model unavailable'),
  });

  await assert.rejects(
    () => service.extract({ text: 'Tax year 2025.', formId: 'FORM_TAX_FILING' }),
    (err) => {
      assert.equal(err.code, 'extraction_provider_error');
      assert.equal(err.status, 502);
      assert.match(err.cause.message, /extraction model unavailable/);
      return true;
    }
  );
});

test('contract errors keep their specific error code', async () => {
  const { service } = createService({
    chainError: new ExtractionContractError('non-object payload'),
  });

  await assert.rejects(
    () => service.extract({ text: 'Tax year 2025.', formId: 'FORM_TAX_FILING' }),
    (err) => {
      assert.equal(err.code, 'extraction_contract_error');
      assert.equal(err.status, 502);
      return true;
    }
  );
});

test('unknown raw fields never appear in the response', async () => {
  const { service } = createService({
    rawFields: {
      tax_year: field(2025, 0.9, '2025', false),
      hallucinated_field: field('invented', 0.99, '2025', false),
    },
  });

  const result = await service.extract({
    text: 'Tax year 2025.',
    formId: 'FORM_TAX_FILING',
  });

  assert.equal(result.fields.hallucinated_field, undefined);
  assert.deepEqual(
    Object.keys(result.fields).sort(),
    getSchemaByFormId('FORM_TAX_FILING').fields.map((entry) => entry.path).sort()
  );
});

test('chain results are cached per schema within a service instance', async () => {
  const { service, state } = createService({
    rawFields: { tax_year: field(2025, 0.9, '2025', false) },
  });

  await service.extract({ text: '2025', formId: 'FORM_TAX_FILING' });
  await service.extract({ text: '2025 again', formId: 'FORM_TAX_FILING' });

  assert.equal(state.chainCalls, 2);
  assert.equal(service.chains.size, 1);
});

test('reported model metadata follows the configured provider, not a hardcoded default', () => {
  const key = 'INTAKE_EXTRACTION_MODEL';
  const saved = process.env[key];
  process.env[key] = 'vendor/reasoning-test';

  try {
    const service = new ExtractionService({
      routingService: { route: async () => ({}) },
    });
    assert.equal(service.extractionModelName, 'vendor/reasoning-test');
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});
