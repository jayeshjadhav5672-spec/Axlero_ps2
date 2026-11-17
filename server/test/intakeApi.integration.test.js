const net = require('node:net');

const request = require('supertest');
const {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest: jestApi,
  test,
} = require('@jest/globals');

// Only the external LangChain/OpenAI provider boundary is mocked.
// The Express app, router, controller, and intake service remain real.
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

let app;
let server;
let originalPort;
let originalApiKey;
let originalDotenvQuiet;
let originalRoutingModel;

const FAKE_API_KEY = 'unit-test-fake-key';

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
  originalRoutingModel = process.env.INTAKE_ROUTING_MODEL;

  process.env.PORT = String(await getFreePort());
  process.env.DOTENV_CONFIG_QUIET = 'true';
  process.env.OPENAI_API_KEY = FAKE_API_KEY;

  delete process.env.INTAKE_ROUTING_MODEL;

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
  delete process.env.INTAKE_ROUTING_MODEL;

  if (process.env.OPENAI_API_KEY === undefined) {
    process.env.OPENAI_API_KEY = FAKE_API_KEY;
  }
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

    if (originalRoutingModel === undefined) {
      delete process.env.INTAKE_ROUTING_MODEL;
    } else {
      process.env.INTAKE_ROUTING_MODEL = originalRoutingModel;
    }
  }
});

describe('GET /api/intake/health', () => {
  test('returns 200 with the provider response when the model is reachable', async () => {
    providerInvoke.mockResolvedValue({ content: 'ok' });

    const response = await request(app).get('/api/intake/health');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toMatchObject({
      ok: true,
      service: 'ai-intake',
      router: 'initialized',
      model: 'gpt-4o-mini',
      providerResponse: 'ok',
    });
    expect(typeof response.body.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(response.body.timestamp))).toBe(false);
    expect(providerInvoke).toHaveBeenCalledTimes(1);
  });

  test('returns 503 when the provider invocation fails', async () => {
    providerInvoke.mockRejectedValue(new Error('provider unavailable'));

    const response = await request(app).get('/api/intake/health');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      ok: false,
      service: 'ai-intake',
      router: 'initialization_failed',
      error: 'provider unavailable',
    });
    expect(typeof response.body.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(response.body.timestamp))).toBe(false);
  });

  test('reports the configured routing model name', async () => {
    process.env.INTAKE_ROUTING_MODEL = 'unit-test-routing-model';
    providerInvoke.mockResolvedValue({ content: 'ok' });

    const response = await request(app).get('/api/intake/health');

    expect(response.status).toBe(200);
    expect(response.body.model).toBe('unit-test-routing-model');
  });

  test('returns 503 without invoking the provider when the API key is missing', async () => {
    delete process.env.OPENAI_API_KEY;

    let response;

    try {
      response = await request(app).get('/api/intake/health');
    } finally {
      process.env.OPENAI_API_KEY = FAKE_API_KEY;
    }

    expect(response.status).toBe(503);
    expect(response.body.ok).toBe(false);
    expect(response.body.error).toContain('OPENAI_API_KEY is required');
    expect(providerInvoke).not.toHaveBeenCalled();
  });
});

describe('application error handling', () => {
  test('returns a JSON 404 payload for an unknown route', async () => {
    const response = await request(app).get('/api/intake/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Not found' });
  });
});
