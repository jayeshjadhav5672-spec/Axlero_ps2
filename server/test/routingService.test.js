const {
  FormRouteResponseSchema,
  RoutingService,
  UNRESOLVED_ROUTE,
  buildSystemPrompt,
  createRoutingService,
} = require('../modules/intake/services/routingService');
const { formCatalogue } = require('../modules/intake/data/formCatalogue');
const {
  describe,
  expect,
  jest: jestApi,
  test,
} = require('@jest/globals');

const validRoute = {
  form_id: 'FORM_INSURANCE_CLAIM',
  confidence: 0.92,
  rationale: 'The prompt describes an insurance claim.',
  clarification_required: false,
};

function createFakeModel({ result, error } = {}) {
  const invoke = jestApi.fn();

  if (error) {
    invoke.mockRejectedValue(error);
  } else {
    invoke.mockResolvedValue(result);
  }

  const structuredModel = { invoke };
  const model = {
    withStructuredOutput: jestApi.fn(() => structuredModel),
  };

  return { invoke, model, structuredModel };
}

describe('RoutingService', () => {
  test('uses the injected model and the routing response schema', () => {
    const fake = createFakeModel({ result: validRoute });

    new RoutingService({ model: fake.model });

    expect(fake.model.withStructuredOutput).toHaveBeenCalledWith(
      FormRouteResponseSchema
    );
  });

  test('returns a valid model response and sends the expected prompt', async () => {
    const fake = createFakeModel({ result: validRoute });
    const service = new RoutingService({ model: fake.model });

    const result = await service.route({
      userPrompt: '  I need to file an insurance claim  ',
    });

    expect(result).toEqual(validRoute);
    expect(fake.invoke).toHaveBeenCalledTimes(1);

    const messages = fake.invoke.mock.calls[0][0];

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      role: 'system',
      content: buildSystemPrompt(),
    });
    expect(messages[1]).toEqual({
      role: 'user',
      content: 'User prompt: "I need to file an insurance claim"',
    });
  });

  test.each([undefined, null, '', '   ', 42])(
    'returns an unresolved result for an empty or invalid prompt: %p',
    async (userPrompt) => {
      const fake = createFakeModel({ result: validRoute });
      const service = new RoutingService({ model: fake.model });

      const result = await service.route({ userPrompt });

      expect(result).toEqual({
        ...UNRESOLVED_ROUTE,
        rationale: 'Empty or missing user prompt; nothing to route.',
      });
      expect(fake.invoke).not.toHaveBeenCalled();
    }
  );

  test('returns an unresolved result when the model output is invalid', async () => {
    const fake = createFakeModel({
      result: {
        form_id: 123,
        confidence: 'high',
        rationale: null,
        clarification_required: 'no',
      },
    });
    const service = new RoutingService({ model: fake.model });

    const result = await service.route({
      userPrompt: 'I need help with a form.',
    });

    expect(result.form_id).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.clarification_required).toBe(true);
    expect(result.rationale).toContain(
      'Model output did not conform to the routing contract'
    );
    expect(result.rationale).toContain('form_id');
    expect(result.rationale).toContain('confidence');
  });

  test('returns an unresolved result when the provider throws', async () => {
    const fake = createFakeModel({
      error: new Error('provider unavailable'),
    });
    const service = new RoutingService({ model: fake.model });

    const result = await service.route({
      userPrompt: 'I need to file an insurance claim.',
    });

    expect(result).toEqual({
      ...UNRESOLVED_ROUTE,
      rationale:
        'Routing service error: provider unavailable. Treated as unresolved pending clarification.',
    });
  });

  test('forces clarification below the confidence threshold', async () => {
    const lowConfidenceRoute = {
      ...validRoute,
      confidence: 0.59,
    };
    const fake = createFakeModel({ result: lowConfidenceRoute });
    const service = new RoutingService({ model: fake.model });

    const result = await service.route({
      userPrompt: 'I might need insurance help.',
    });

    expect(result).toEqual({
      form_id: null,
      confidence: 0.59,
      rationale: validRoute.rationale,
      clarification_required: true,
    });
  });

  test('uses the fallback rationale when a low-confidence route has an empty rationale', async () => {
    const fake = createFakeModel({
      result: {
        ...validRoute,
        confidence: 0.2,
        rationale: '',
      },
    });
    const service = new RoutingService({ model: fake.model });

    const result = await service.route({
      userPrompt: 'I might need insurance help.',
    });

    expect(result).toEqual({
      form_id: null,
      confidence: 0.2,
      rationale:
        'Confidence below routing threshold; classification too uncertain.',
      clarification_required: true,
    });
    expect(FormRouteResponseSchema.safeParse(result).success).toBe(true);
  });

  test('accepts a route exactly at the confidence threshold', async () => {
    const thresholdRoute = {
      ...validRoute,
      confidence: 0.6,
    };
    const fake = createFakeModel({ result: thresholdRoute });
    const service = new RoutingService({ model: fake.model });

    const result = await service.route({
      userPrompt: 'I need to file an insurance claim.',
    });

    expect(result).toEqual(thresholdRoute);
  });

  test('forces clarification when the model omits a form identifier', async () => {
    const missingFormRoute = {
      ...validRoute,
      form_id: null,
      confidence: 0.9,
    };
    const fake = createFakeModel({ result: missingFormRoute });
    const service = new RoutingService({ model: fake.model });

    const result = await service.route({
      userPrompt: 'I need help with something.',
    });

    expect(result).toEqual({
      form_id: null,
      confidence: 0.9,
      rationale: validRoute.rationale,
      clarification_required: true,
    });
  });

  test('buildSystemPrompt includes every catalogue form', () => {
    const prompt = buildSystemPrompt();

    for (const entry of formCatalogue) {
      expect(prompt).toContain(entry.form_id);
      expect(prompt).toContain(entry.display_name);
    }

    expect(prompt).toContain('do NOT guess');
  });

  test('createRoutingService returns a RoutingService instance', () => {
    const fake = createFakeModel({ result: validRoute });

    expect(createRoutingService({ model: fake.model })).toBeInstanceOf(
      RoutingService
    );
  });
});
