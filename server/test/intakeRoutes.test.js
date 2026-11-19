const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');
const {
  UnknownFormError,
  ExtractionProviderError,
} = require('../modules/intake/utils/errors');

let server;
let baseUrl;
const state = {};

test.before(async () => {
  const app = createApp();

  app.locals.intakeServices = {
    healthService: {
      checkHealth: async (options) => {
        state.healthOptions = options;
        return state.healthResult;
      },
    },
    routingService: {
      route: async ({ userPrompt }) => {
        state.routeCalls = state.routeCalls || [];
        state.routeCalls.push(userPrompt);
        if (state.routeError) throw state.routeError;
        return state.routeResult;
      },
    },
    extractionService: {
      extract: async (params) => {
        state.extractCalls = state.extractCalls || [];
        state.extractCalls.push(params);
        if (state.extractError) throw state.extractError;
        return state.extractResult;
      },
    },
  };

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

function resetState() {
  state.healthResult = {
    ok: true,
    service: 'ai-intake',
    router: 'initialized',
    provider_configured: true,
    providers: {},
    timestamp: new Date().toISOString(),
  };
  state.healthOptions = null;
  state.routeResult = {
    form_id: 'FORM_TAX_FILING',
    confidence: 0.95,
    rationale: 'matched',
    clarification_required: false,
  };
  state.routeCalls = [];
  state.routeError = null;
  state.extractResult = {
    form_id: 'FORM_TAX_FILING',
    clarification_required: false,
    fields: {},
    requires_review: false,
  };
  state.extractCalls = [];
  state.extractError = null;
}

async function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

async function postJson(path, body) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET /api/intake/health returns the service status', async () => {
  resetState();
  const response = await request('/api/intake/health');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(state.healthOptions.deep, true);

  const shallow = await request('/api/intake/health?deep=false');
  assert.equal(shallow.status, 200);
  assert.equal(state.healthOptions.deep, false);
});

test('health failures use HTTP 503', async () => {
  resetState();
  state.healthResult = { ok: false, error: 'not configured' };
  const response = await request('/api/intake/health');
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ok, false);
});

test('POST /api/intake/route validates user_prompt', async () => {
  resetState();
  for (const body of [{}, { user_prompt: '' }, { user_prompt: 42 }]) {
    const response = await postJson('/api/intake/route', body);
    assert.equal(response.status, 400);
    const parsed = await response.json();
    assert.equal(parsed.error, 'validation_error');
  }
});

test('POST /api/intake/route returns the routing decision', async () => {
  resetState();
  const response = await postJson('/api/intake/route', {
    user_prompt: '  I need to file my taxes.  ',
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.form_id, 'FORM_TAX_FILING');
  assert.deepEqual(state.routeCalls, ['I need to file my taxes.']);
});

test('routing failures return 502 with a clarification fallback', async () => {
  resetState();
  state.routeError = new Error('router exploded');
  const response = await postJson('/api/intake/route', { user_prompt: 'hello' });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error, 'routing_error');
  assert.doesNotMatch(body.message, /router exploded/);
  assert.equal(body.routing.form_id, null);
  assert.equal(body.routing.clarification_required, true);
});

test('POST /api/intake/extract validates text and form_id', async () => {
  resetState();
  const missing = await postJson('/api/intake/extract', {});
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, 'validation_error');

  const empty = await postJson('/api/intake/extract', { text: '   ' });
  assert.equal(empty.status, 400);

  const badForm = await postJson('/api/intake/extract', {
    text: 'some text',
    form_id: 123,
  });
  assert.equal(badForm.status, 400);
  assert.equal((await badForm.json()).details.field, 'form_id');
});

test('POST /api/intake/extract passes trimmed input and optional form_id to the service', async () => {
  resetState();
  const response = await postJson('/api/intake/extract', {
    text: '  Tax year 2025.  ',
    form_id: '  FORM_TAX_FILING ',
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.form_id, 'FORM_TAX_FILING');
  assert.deepEqual(state.extractCalls, [
    { text: 'Tax year 2025.', formId: 'FORM_TAX_FILING' },
  ]);
});

test('POST /api/intake/extract accepts intake_text as an alias', async () => {
  resetState();
  const response = await postJson('/api/intake/extract', {
    intake_text: 'I need help.',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(state.extractCalls, [
    { text: 'I need help.', formId: undefined },
  ]);
});

test('POST /api/intake/extract returns clarification responses with 200', async () => {
  resetState();
  state.extractResult = {
    form_id: null,
    clarification_required: true,
    fields: {},
    requires_review: true,
    routing: { form_id: null, clarification_required: true, confidence: 0, rationale: 'ambiguous' },
  };

  const response = await postJson('/api/intake/extract', {
    text: 'I need some paperwork help.',
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.clarification_required, true);
  assert.deepEqual(body.fields, {});
});

test('unknown form ids return 400 with the supported list', async () => {
  resetState();
  state.extractError = new UnknownFormError('FORM_NOPE', ['FORM_TAX_FILING']);

  const response = await postJson('/api/intake/extract', {
    text: 'some text',
    form_id: 'FORM_NOPE',
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error, 'unknown_form_id');
  assert.equal(body.details.form_id, 'FORM_NOPE');
});

test('provider failures return 502 without fabricated fields', async () => {
  resetState();
  state.extractError = new ExtractionProviderError('provider down');

  const response = await postJson('/api/intake/extract', {
    text: 'Tax year 2025.',
    form_id: 'FORM_TAX_FILING',
  });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error, 'extraction_provider_error');
  assert.equal(body.fields, undefined);
});

test('unexpected failures return 500 without internal details', async () => {
  resetState();
  state.extractError = new Error('database password leaked');

  const response = await postJson('/api/intake/extract', {
    text: 'Tax year 2025.',
    form_id: 'FORM_TAX_FILING',
  });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error, 'internal_error');
  assert.equal(JSON.stringify(body).includes('database password leaked'), false);
});

test('malformed JSON and unknown routes are handled', async () => {
  resetState();
  const malformed = await request('/api/intake/extract', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'validation_error');

  const missing = await request('/api/intake/does-not-exist');
  assert.equal(missing.status, 404);
});
