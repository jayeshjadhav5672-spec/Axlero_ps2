const net = require('node:net');

const request = require('supertest');
const {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest: jestApi,
  test,
} = require('@jest/globals');

// Only the external LangChain/OpenAI provider boundary is mocked.
// The Express app, router, routing controller, and RoutingService stay real.
const providerInvoke = jestApi.fn();

jestApi.mock('@langchain/openai', () => {
  class ChatOpenAI {
    constructor(config) {
      this.config = config;
      this.invoke = providerInvoke;
      this.withStructuredOutput = () => ({ invoke: providerInvoke });
    }
  }

  return { ChatOpenAI };
});

const routingService = require('../modules/intake/services/routingService');

let app;
let server;
let originalPort;
let originalApiKey;
let originalDotenvQuiet;

const FAKE_API_KEY = 'unit-test-fake-key';

const validRoute = {
  form_id: 'FORM_INSURANCE_CLAIM',
  confidence: 0.92,
  rationale: 'The prompt describes an insurance claim.',
  clarification_required: false,
};

function postRoute(body) {
  const pending = request(app).post('/api/intake/route');

  return body === undefined ? pending : pending.send(body);
}

/**
 * Ask the OS for a free loopback port so requiring index.js does not bind 3000.
 */
async function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();

    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();

      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

beforeAll(async () => {
  originalPort = process.env.PORT;
  originalApiKey = process.env.OPENAI_API_KEY;
  originalDotenvQuiet = process.env.DOTENV_CONFIG_QUIET;

  process.env.PORT = String(await getFreePort());
  process.env.DOTENV_CONFIG_QUIET = 'true';
  process.env.OPENAI_API_KEY = FAKE_API_KEY;

  ({ app, server } = require('../index'));

  await new Promise((resolve, reject) => {
    if (server.listening) {
      resolve();
      return;
    }

    server.once('listening', resolve);
    server.once('error', reject);
  });
});

beforeEach(() => {
  providerInvoke.mockReset();
});

afterEach(() => {
  jestApi.restoreAllMocks();
});

afterAll(async () => {
  try {
    if (server && server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  } finally {
    if (originalPort === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = originalPort;
    }

    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }

    if (originalDotenvQuiet === undefined) {
      delete process.env.DOTENV_CONFIG_QUIET;
    } else {
      process.env.DOTENV_CONFIG_QUIET = originalDotenvQuiet;
    }
  }
});

describe('POST /api/intake/route', () => {
  test('returns the routed form for a valid prompt and forwards the trimmed input', async () => {
    providerInvoke.mockResolvedValue(validRoute);

    const response = await postRoute({
      user_prompt: '  I need to file an insurance claim  ',
    });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual(validRoute);
    expect(providerInvoke).toHaveBeenCalledTimes(1);

    const messages = providerInvoke.mock.calls[0][0];

    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({
      role: 'user',
      content: 'User prompt: "I need to file an insurance claim"',
    });
  });

  test('returns the expected routing response structure', async () => {
    const route = {
      form_id: 'FORM_PATENT_INTAKE',
      confidence: 0.8,
      rationale: 'The prompt describes a patent application.',
      clarification_required: false,
    };

    providerInvoke.mockResolvedValue(route);

    const response = await postRoute({
      user_prompt: 'I want to file a patent application.',
    });

    expect(response.status).toBe(200);
    expect(response.body.form_id).toBe('FORM_PATENT_INTAKE');
    expect(typeof response.body.confidence).toBe('number');
    expect(typeof response.body.rationale).toBe('string');
    expect(typeof response.body.clarification_required).toBe('boolean');
    expect(Object.keys(response.body).sort()).toEqual([
      'clarification_required',
      'confidence',
      'form_id',
      'rationale',
    ]);
  });

  test('returns 400 when the request body is missing', async () => {
    const response = await postRoute(undefined);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'validation_error',
      message: 'user_prompt is required and must be a non-empty string.',
    });
    expect(providerInvoke).not.toHaveBeenCalled();
  });

  test('returns 400 when the request body is an empty object', async () => {
    const response = await postRoute({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('validation_error');
    expect(providerInvoke).not.toHaveBeenCalled();
  });

  test('returns 400 when user_prompt is missing from an otherwise valid body', async () => {
    const response = await postRoute({ prompt: 'I need help.' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('validation_error');
    expect(providerInvoke).not.toHaveBeenCalled();
  });

  test('returns 400 when user_prompt is blank', async () => {
    const response = await postRoute({ user_prompt: '   ' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('validation_error');
    expect(providerInvoke).not.toHaveBeenCalled();
  });

  test('returns 400 when user_prompt has the wrong type', async () => {
    const response = await postRoute({ user_prompt: 42 });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('validation_error');
    expect(providerInvoke).not.toHaveBeenCalled();
  });

  test('returns 400 for malformed JSON before the controller runs', async () => {
    const response = await request(app)
      .post('/api/intake/route')
      .set('Content-Type', 'application/json')
      .send('{"user_prompt": ');

    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(providerInvoke).not.toHaveBeenCalled();
  });

  test('returns an unresolved route with 200 when the provider fails', async () => {
    providerInvoke.mockRejectedValue(new Error('provider unavailable'));

    const response = await postRoute({
      user_prompt: 'I need to file an insurance claim.',
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      form_id: null,
      confidence: 0,
      clarification_required: true,
    });
    expect(response.body.rationale).toContain(
      'Routing service error: provider unavailable'
    );
  });

  test('returns an unresolved route when the model output violates the contract', async () => {
    providerInvoke.mockResolvedValue({
      form_id: 123,
      confidence: 'high',
      rationale: null,
      clarification_required: 'no',
    });

    const response = await postRoute({
      user_prompt: 'I need help with a form.',
    });

    expect(response.status).toBe(200);
    expect(response.body.form_id).toBeNull();
    expect(response.body.confidence).toBe(0);
    expect(response.body.clarification_required).toBe(true);
    expect(response.body.rationale).toContain(
      'Model output did not conform to the routing contract'
    );
  });

  test('forces clarification when confidence is below the routing threshold', async () => {
    providerInvoke.mockResolvedValue({
      ...validRoute,
      confidence: 0.59,
    });

    const response = await postRoute({
      user_prompt: 'I might need insurance help.',
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      form_id: null,
      confidence: 0.59,
      rationale: validRoute.rationale,
      clarification_required: true,
    });
  });

  test('returns 502 when the routing service itself throws unexpectedly', async () => {
    jestApi
      .spyOn(routingService, 'route')
      .mockRejectedValueOnce(new Error('unexpected failure'));

    const response = await postRoute({
      user_prompt: 'I need to file an insurance claim.',
    });

    expect(response.status).toBe(502);
    expect(response.body).toEqual({
      error: 'routing_error',
      message: 'unexpected failure',
      routing: {
        form_id: null,
        confidence: 0,
        rationale:
          'Routing service failed; unable to classify the prompt. Clarification required.',
        clarification_required: true,
      },
    });
    expect(providerInvoke).not.toHaveBeenCalled();
  });
});
