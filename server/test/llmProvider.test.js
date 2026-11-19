const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveProviderConfig,
  resolveRetryConfig,
  computeBackoffDelay,
  withRetry,
  createChatModel,
  getProviderSummary,
  ROLE_DEFAULTS,
} = require('../modules/intake/utils/llmProvider');

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORGANIZATION',
  'INTAKE_LLM_PROVIDER',
  'INTAKE_ROUTER_MODEL',
  'INTAKE_ROUTING_MODEL',
  'INTAKE_ROUTING_TEMPERATURE',
  'INTAKE_ROUTING_TIMEOUT_MS',
  'INTAKE_ROUTING_MAX_RETRIES',
  'INTAKE_ROUTING_BACKOFF_INITIAL_MS',
  'INTAKE_ROUTING_BACKOFF_MAX_MS',
  'INTAKE_ROUTING_BACKOFF_FACTOR',
  'INTAKE_ROUTING_BACKOFF_JITTER',
  'INTAKE_ROUTING_BASE_URL',
  'INTAKE_ROUTING_FALLBACK_MODEL',
  'INTAKE_EXTRACTION_MODEL',
  'INTAKE_EXTRACTION_TEMPERATURE',
  'INTAKE_EXTRACTION_TIMEOUT_MS',
  'INTAKE_EXTRACTION_MAX_RETRIES',
  'INTAKE_EXTRACTION_BACKOFF_INITIAL_MS',
  'INTAKE_EXTRACTION_BACKOFF_MAX_MS',
  'INTAKE_EXTRACTION_BACKOFF_FACTOR',
  'INTAKE_EXTRACTION_BACKOFF_JITTER',
  'INTAKE_EXTRACTION_BASE_URL',
  'INTAKE_EXTRACTION_FALLBACK_MODEL',
  'INTAKE_FALLBACK_MODEL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'OPENROUTER_APP_URL',
  'OPENROUTER_SITE_URL',
  'OPENROUTER_APP_NAME',
  'LLM_FALLBACK_MODEL',
  'LLM_TIMEOUT_MS',
  'LLM_MAX_RETRIES',
  'LLM_BACKOFF_INITIAL_MS',
  'LLM_BACKOFF_MAX_MS',
  'LLM_BACKOFF_FACTOR',
  'LLM_BACKOFF_JITTER',
];

async function withCleanEnv(vars, fn) {
  const saved = new Map();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }

  try {
    return await fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('reads credentials only from the environment and never returns the key', async () => {
  await withCleanEnv({ INTAKE_LLM_PROVIDER: 'openai' }, async () => {
    const config = resolveProviderConfig('routing', {}, {});
    assert.equal(config.apiKey, undefined);
    assert.throws(
      () => createChatModel({ role: 'routing' }),
      /OPENAI_API_KEY is required/
    );
  });

  await withCleanEnv(
    { INTAKE_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-secret' },
    async () => {
    const config = resolveProviderConfig('routing', {}, process.env);
    assert.equal(config.apiKey, 'sk-test-secret');

    const summary = getProviderSummary('routing');
    assert.equal(summary.configured, true);
    assert.equal(JSON.stringify(summary).includes('sk-test-secret'), false);

    const model = createChatModel({ role: 'routing' });
    assert.equal(model.intake.role, 'routing');
    assert.equal(model.apiKey, 'sk-test-secret');
    assert.equal(JSON.stringify(model.intake).includes('sk-test-secret'), false);
  });
});

test('supports OpenRouter credentials, endpoint, and attribution headers', async () => {
  await withCleanEnv(
    {
      INTAKE_LLM_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'sk-or-test',
      OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
      OPENROUTER_SITE_URL: 'https://example.test',
      OPENROUTER_APP_NAME: 'Intake Tests',
      INTAKE_ROUTING_MODEL: 'vendor/fast:free',
      INTAKE_EXTRACTION_MODEL: 'vendor/reasoning:free',
    },
    async () => {
      const routing = resolveProviderConfig('routing', {}, process.env);
      assert.equal(routing.provider, 'openrouter');
      assert.equal(routing.apiKey, 'sk-or-test');
      assert.equal(routing.baseURL, 'https://openrouter.ai/api/v1');
      assert.deepEqual(routing.defaultHeaders, {
        'HTTP-Referer': 'https://example.test',
        'X-Title': 'Intake Tests',
      });
      assert.equal(routing.model, 'vendor/fast:free');

      const model = createChatModel({ role: 'routing' });
      assert.equal(model.intake.provider, 'openrouter');
      assert.equal(model.intake.model, 'vendor/fast:free');
      // The provider key must reach the client, not the ambient OPENAI_API_KEY.
      assert.equal(model.apiKey, 'sk-or-test');
      assert.equal(JSON.stringify(model.intake).includes('sk-or-test'), false);

      const summary = getProviderSummary('extraction');
      assert.equal(summary.provider, 'openrouter');
      assert.equal(summary.configured, true);
      assert.equal(summary.model, 'vendor/reasoning:free');
      assert.equal(JSON.stringify(summary).includes('sk-or-test'), false);
    }
  );

  await withCleanEnv({ INTAKE_LLM_PROVIDER: 'openrouter' }, async () => {
    assert.throws(
      () => createChatModel({ role: 'routing' }),
      /OPENROUTER_API_KEY is required/
    );
  });
});

test('role-specific base URL overrides the provider default', async () => {
  await withCleanEnv(
    {
      INTAKE_LLM_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'sk-or-test',
      INTAKE_ROUTING_BASE_URL: 'https://gateway.internal/v1',
    },
    async () => {
      const routing = resolveProviderConfig('routing', {}, process.env);
      assert.equal(routing.baseURL, 'https://gateway.internal/v1');

      const extraction = resolveProviderConfig('extraction', {}, process.env);
      assert.equal(extraction.baseURL, 'https://openrouter.ai/api/v1');
    }
  );
});

test('supports independent routing and extraction configuration', async () => {
  await withCleanEnv(
    {
      INTAKE_LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test',
      OPENAI_BASE_URL: 'https://gateway.example/v1',
      INTAKE_ROUTING_MODEL: 'fast-model',
      INTAKE_ROUTING_TEMPERATURE: '0.1',
      INTAKE_ROUTING_TIMEOUT_MS: '1111',
      INTAKE_ROUTING_MAX_RETRIES: '1',
      INTAKE_ROUTING_BACKOFF_INITIAL_MS: '100',
      INTAKE_ROUTING_BACKOFF_MAX_MS: '500',
      INTAKE_ROUTING_BACKOFF_FACTOR: '3',
      INTAKE_ROUTING_BACKOFF_JITTER: '0',
      INTAKE_EXTRACTION_MODEL: 'reasoning-model',
      INTAKE_EXTRACTION_TEMPERATURE: '0.2',
      INTAKE_EXTRACTION_TIMEOUT_MS: '2222',
      INTAKE_EXTRACTION_MAX_RETRIES: '4',
      INTAKE_EXTRACTION_BACKOFF_INITIAL_MS: '200',
      INTAKE_EXTRACTION_BACKOFF_MAX_MS: '900',
      INTAKE_EXTRACTION_BACKOFF_FACTOR: '2',
      INTAKE_EXTRACTION_BACKOFF_JITTER: '0',
    },
    async () => {
      const routing = resolveProviderConfig('routing', {}, process.env);
      assert.equal(routing.model, 'fast-model');
      assert.equal(routing.temperature, 0.1);
      assert.equal(routing.timeoutMs, 1111);
      assert.equal(routing.maxRetries, 1);
      assert.deepEqual(routing.backoff, {
        initialMs: 100,
        maxMs: 500,
        factor: 3,
        jitterRatio: 0,
      });
      assert.equal(routing.baseURL, 'https://gateway.example/v1');

      const extraction = resolveProviderConfig('extraction', {}, process.env);
      assert.equal(extraction.model, 'reasoning-model');
      assert.equal(extraction.temperature, 0.2);
      assert.equal(extraction.timeoutMs, 2222);
      assert.equal(extraction.maxRetries, 4);
      assert.deepEqual(extraction.backoff, {
        initialMs: 200,
        maxMs: 900,
        factor: 2,
        jitterRatio: 0,
      });
    }
  );
});

test('falls back to role defaults and global env values', async () => {
  await withCleanEnv(
    { INTAKE_LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' },
    async () => {
    const routing = resolveProviderConfig('routing', {}, process.env);
    assert.equal(routing.model, ROLE_DEFAULTS.routing.model);
    assert.equal(routing.timeoutMs, ROLE_DEFAULTS.routing.timeoutMs);
    assert.equal(routing.maxRetries, ROLE_DEFAULTS.routing.maxRetries);

    const extraction = resolveProviderConfig('extraction', {}, process.env);
    assert.equal(extraction.model, ROLE_DEFAULTS.extraction.model);
    assert.equal(extraction.timeoutMs, ROLE_DEFAULTS.extraction.timeoutMs);
  });

  await withCleanEnv(
    {
      INTAKE_LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test',
      LLM_TIMEOUT_MS: '7777',
      LLM_MAX_RETRIES: '5',
      LLM_BACKOFF_INITIAL_MS: '321',
      LLM_BACKOFF_MAX_MS: '654',
      LLM_BACKOFF_FACTOR: '1.5',
      LLM_BACKOFF_JITTER: '0',
    },
    async () => {
      const routing = resolveProviderConfig('routing', {}, process.env);
      assert.equal(routing.timeoutMs, 7777);
      assert.equal(routing.maxRetries, 5);
      assert.deepEqual(routing.backoff, {
        initialMs: 321,
        maxMs: 654,
        factor: 1.5,
        jitterRatio: 0,
      });

      const retry = resolveRetryConfig('routing', process.env);
      assert.equal(retry.maxRetries, 5);
    }
  );
});

test('rejects unsupported providers, invalid roles and invalid backoff ranges', async () => {
  assert.throws(
    () => resolveProviderConfig('websearch', {}, {}),
    /Unsupported LLM role/
  );

  assert.throws(
    () =>
      resolveProviderConfig(
        'routing',
        {},
        { INTAKE_LLM_PROVIDER: 'anthropic', OPENAI_API_KEY: 'sk-test' }
      ),
    /Unsupported LLM provider/
  );

  assert.throws(
    () =>
      resolveRetryConfig('routing', {
        INTAKE_ROUTING_BACKOFF_INITIAL_MS: '500',
        INTAKE_ROUTING_BACKOFF_MAX_MS: '100',
      }),
    /BACKOFF_MAX_MS/
  );

  assert.throws(
    () => resolveRetryConfig('routing', { INTAKE_ROUTING_MAX_RETRIES: 'lots' }),
    /Invalid numeric configuration/
  );
});

test('computes bounded exponential backoff with deterministic jitter', () => {
  const backoff = { initialMs: 100, maxMs: 250, factor: 2, jitterRatio: 0 };
  assert.equal(computeBackoffDelay(0, backoff, () => 0.5), 100);
  assert.equal(computeBackoffDelay(1, backoff, () => 0.5), 200);
  assert.equal(computeBackoffDelay(2, backoff, () => 0.5), 250);
  assert.equal(computeBackoffDelay(5, backoff, () => 0.5), 250);

  const jittered = { initialMs: 100, maxMs: 1000, factor: 2, jitterRatio: 0.2 };
  assert.equal(computeBackoffDelay(0, jittered, () => 1), 120);
  assert.equal(computeBackoffDelay(0, jittered, () => 0), 80);
  assert.equal(computeBackoffDelay(0, jittered, () => 0.5), 100);
});

test('withRetry retries with backoff and eventually succeeds', async () => {
  let calls = 0;
  const delays = [];

  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
      return 'ok';
    },
    {
      maxRetries: 2,
      backoff: { initialMs: 10, maxMs: 20, factor: 2, jitterRatio: 0 },
      sleep: async (ms) => delays.push(ms),
      random: () => 0.5,
    }
  );

  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
});

test('withRetry throws the final error after exhausting retries', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls += 1;
          throw new Error(`failure-${calls}`);
        },
        {
          maxRetries: 2,
          backoff: { initialMs: 0, maxMs: 0, factor: 1, jitterRatio: 0 },
          sleep: async () => {},
        }
      ),
    /failure-3/
  );
  assert.equal(calls, 3);
});

test('withRetry rejects non-function operations', async () => {
  await assert.rejects(() => withRetry('nope'), /requires an async operation/);
});

test('models expose non-secret retry and timeout metadata', async () => {
  await withCleanEnv(
    {
      INTAKE_LLM_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test',
      INTAKE_EXTRACTION_MODEL: 'reasoning-model',
      INTAKE_EXTRACTION_TIMEOUT_MS: '4321',
      INTAKE_EXTRACTION_MAX_RETRIES: '3',
    },
    async () => {
      const model = createChatModel({ role: 'extraction' });
      assert.equal(model.intake.provider, 'openai');
      assert.equal(model.intake.role, 'extraction');
      assert.equal(model.intake.model, 'reasoning-model');
      assert.equal(model.intake.timeoutMs, 4321);
      assert.equal(model.intake.maxRetries, 3);
      assert.equal(Object.prototype.hasOwnProperty.call(model.intake, 'apiKey'), false);
    }
  );
});
