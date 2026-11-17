const {
  FormRouteResponseSchema,
  UNRESOLVED_ROUTE,
} = require('../modules/intake/services/routingService');
const { describe, expect, test } = require('@jest/globals');

const validRoute = {
  form_id: 'FORM_INSURANCE_CLAIM',
  confidence: 0.92,
  rationale: 'The prompt describes an insurance claim.',
  clarification_required: false,
};

function parse(overrides = {}) {
  return FormRouteResponseSchema.safeParse({
    ...validRoute,
    ...overrides,
  });
}

function parseWithout(property) {
  const candidate = { ...validRoute };
  delete candidate[property];

  return FormRouteResponseSchema.safeParse(candidate);
}

describe('FormRouteResponseSchema', () => {
  test('accepts a valid resolved route', () => {
    const result = parse();

    expect(result.success).toBe(true);
    expect(result.data).toEqual(validRoute);
  });

  test('accepts a valid unresolved route with a null form identifier', () => {
    const result = FormRouteResponseSchema.safeParse(UNRESOLVED_ROUTE);

    expect(result.success).toBe(true);
    expect(result.data).toEqual(UNRESOLVED_ROUTE);
  });

  test.each([
    'form_id',
    'confidence',
    'rationale',
    'clarification_required',
  ])('rejects a route missing the %s property', (property) => {
    const result = parseWithout(property);

    expect(result.success).toBe(false);
  });

  test.each([
    ['form_id', 123],
    ['confidence', '0.92'],
    ['rationale', null],
    ['clarification_required', 'false'],
  ])('rejects an invalid type for %s', (property, value) => {
    const result = parse({ [property]: value });

    expect(result.success).toBe(false);
  });

  test.each([
    [-0.01, false],
    [0, true],
    [1, true],
    [1.01, false],
  ])('handles confidence boundary %s correctly', (confidence, expectedSuccess) => {
    const result = parse({ confidence });

    expect(result.success).toBe(expectedSuccess);
  });

  test('strips unexpected properties from otherwise valid data', () => {
    const result = parse({ unexpected_field: 'not part of the contract' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual(validRoute);
    expect(result.data).not.toHaveProperty('unexpected_field');
  });
});
