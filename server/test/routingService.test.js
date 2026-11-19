/**
 * routingService.test.js
 *
 * Unit tests for services/routingService.js using a stub chat model (no LLM
 * provider or credentials required). Covers clear routing, ambiguity /
 * clarification, low-confidence override, and provider failure.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { createRoutingService } = require('../modules/intake/services/routingService');

/**
 * Build a stub model whose structured output returns a fixed routing decision.
 * @param {Object} decision
 * @returns {Object}
 */
function stubModel(decision) {
  return {
    withStructuredOutput() {
      return {
        async invoke() {
          return decision;
        },
      };
    },
  };
}

test('clear route returns the matched form and no clarification', async () => {
  const service = createRoutingService({
    model: stubModel({
      form_id: 'FORM_PATENT_INTAKE',
      confidence: 0.95,
      rationale: 'Utility patent request.',
      clarification_required: false,
    }),
  });
  const result = await service.route({
    userPrompt: 'I want to file a utility patent for my invention.',
  });
  assert.strictEqual(result.form_id, 'FORM_PATENT_INTAKE');
  assert.strictEqual(result.clarification_required, false);
  assert.strictEqual(result.confidence, 0.95);
});

test('ambiguous prompt returns clarification_required and null form', async () => {
  const service = createRoutingService({
    model: stubModel({
      form_id: null,
      confidence: 0.0,
      rationale: 'Too vague.',
      clarification_required: true,
    }),
  });
  const result = await service.route({
    userPrompt: 'I need help with some paperwork.',
  });
  assert.strictEqual(result.form_id, null);
  assert.strictEqual(result.clarification_required, true);
});

test('low model confidence is overridden to clarification_required', async () => {
  const service = createRoutingService({
    model: stubModel({
      form_id: 'FORM_TAX_FILING',
      confidence: 0.4,
      rationale: 'Uncertain.',
      clarification_required: false,
    }),
  });
  const result = await service.route({
    userPrompt: 'something about taxes maybe',
  });
  assert.strictEqual(result.form_id, null);
  assert.strictEqual(result.clarification_required, true);
});

test('unsupported form id from the model is treated as unresolved', async () => {
  const service = createRoutingService({
    model: stubModel({
      form_id: 'FORM_INVENTED_BY_MODEL',
      confidence: 0.99,
      rationale: 'Invented.',
      clarification_required: false,
    }),
  });
  const result = await service.route({
    userPrompt: 'I need help with something.',
  });
  assert.strictEqual(result.form_id, null);
  assert.strictEqual(result.clarification_required, true);
  assert.match(result.rationale, /unsupported form/i);
});

test('non-conforming model output is treated as unresolved', async () => {
  const service = createRoutingService({
    model: stubModel({
      form_id: 'FORM_PATENT_INTAKE',
      confidence: 'not-a-number',
      rationale: 'x',
      clarification_required: false,
    }),
  });
  const result = await service.route({
    userPrompt: 'I want to file a patent.',
  });
  assert.strictEqual(result.form_id, null);
  assert.strictEqual(result.clarification_required, true);
});

test('empty prompt returns unresolved without calling the model', async () => {
  let invoked = false;
  const service = createRoutingService({
    model: {
      withStructuredOutput() {
        return {
          async invoke() {
            invoked = true;
            return {};
          },
        };
      },
    },
  });
  const result = await service.route({ userPrompt: '   ' });
  assert.strictEqual(result.form_id, null);
  assert.strictEqual(result.clarification_required, true);
  assert.strictEqual(invoked, false);
});

test('provider failure returns clarification_required rather than guessing', async () => {
  const service = createRoutingService({
    model: {
      withStructuredOutput() {
        return {
          async invoke() {
            throw new Error('provider down');
          },
        };
      },
    },
  });
  const result = await service.route({
    userPrompt: 'I want to file a patent.',
  });
  assert.strictEqual(result.form_id, null);
  assert.strictEqual(result.clarification_required, true);
});
