const net = require('node:net');

const request = require('supertest');
const {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} = require('@jest/globals');

let app;
let server;
let originalPort;
let originalApiKey;
let originalDotenvQuiet;

/**
 * Ask the OS for a free loopback port without keeping a listener open.
 * This avoids forcing the exported application server onto port 3000.
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

  // dotenv does not override an existing variable. An empty value keeps a
  // developer's local .env from injecting a real key into this test process.
  process.env.OPENAI_API_KEY = '';

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

describe('GET /health', () => {
  test('returns the healthy backend payload with an ISO timestamp', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.service).toBe('ai-intake-backend');
    expect(typeof response.body.timestamp).toBe('string');
    expect(response.body.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
    expect(Number.isNaN(Date.parse(response.body.timestamp))).toBe(false);
  });
});
