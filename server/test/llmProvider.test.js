const {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest: jestApi,
  test,
} = require('@jest/globals');

// Jest 30 injects `jest` as a CommonJS wrapper parameter, so the explicit
// import is aliased to avoid a redeclaration conflict.
jestApi.mock('@langchain/openai', () => ({
  ChatOpenAI: jestApi.fn(),
}));

const { ChatOpenAI } = require('@langchain/openai');
const {
  createChatModel,
  getExtractionModel,
  getRoutingModel,
} = require('../modules/intake/utils/llmProvider');

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'INTAKE_ROUTING_MODEL',
  'INTAKE_EXTRACTION_MODEL',
  'LLM_TIMEOUT_MS',
  'LLM_MAX_RETRIES',
];

let envSnapshot;

function latestConfig() {
  const { calls } = ChatOpenAI.mock;

  return calls[calls.length - 1][0];
}

beforeEach(() => {
  envSnapshot = {};

  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key];
    delete process.env[key];
  }

  jestApi.clearAllMocks();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (envSnapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = envSnapshot[key];
    }
  }
});

describe('llmProvider', () => {
  test('uses the default model, timeout, and retry settings', () => {
    createChatModel({ apiKey: 'test-api-key' });

    expect(ChatOpenAI).toHaveBeenCalledTimes(1);
    expect(latestConfig()).toEqual(
      expect.objectContaining({
        modelName: 'gpt-4o-mini',
        temperature: 0,
        timeout: 12000,
        maxRetries: 3,
        openAIApiKey: 'test-api-key',
      })
    );
  });

  test('uses environment values for timeout and retries', () => {
    process.env.LLM_TIMEOUT_MS = '2500';
    process.env.LLM_MAX_RETRIES = '7';

    createChatModel({ apiKey: 'test-api-key' });

    expect(latestConfig()).toEqual(
      expect.objectContaining({
        timeout: 2500,
        maxRetries: 7,
      })
    );
  });

  test('falls back to defaults for non-numeric timeout and retry values', () => {
    process.env.LLM_TIMEOUT_MS = 'not-a-number';
    process.env.LLM_MAX_RETRIES = 'also-not-a-number';

    createChatModel({ apiKey: 'test-api-key' });

    expect(latestConfig()).toEqual(
      expect.objectContaining({
        timeout: 12000,
        maxRetries: 3,
      })
    );
  });

  test('uses explicit options over environment values', () => {
    process.env.OPENAI_API_KEY = 'environment-key';
    process.env.INTAKE_ROUTING_MODEL = 'environment-model';
    process.env.LLM_TIMEOUT_MS = '9000';
    process.env.LLM_MAX_RETRIES = '9';

    createChatModel({
      apiKey: 'explicit-test-key',
      model: 'explicit-model',
      temperature: 0.4,
      timeoutMs: 1500,
      maxRetries: 2,
      extra: { maxTokens: 128 },
    });

    expect(latestConfig()).toEqual(
      expect.objectContaining({
        modelName: 'explicit-model',
        temperature: 0.4,
        timeout: 1500,
        maxRetries: 2,
        openAIApiKey: 'explicit-test-key',
        maxTokens: 128,
      })
    );
  });

  test('getRoutingModel uses the configured routing model', () => {
    process.env.INTAKE_ROUTING_MODEL = 'routing-environment-model';

    getRoutingModel({ apiKey: 'test-api-key' });

    expect(latestConfig().modelName).toBe('routing-environment-model');
  });

  test('getRoutingModel defaults to the routing model preset', () => {
    getRoutingModel({ apiKey: 'test-api-key' });

    expect(latestConfig().modelName).toBe('gpt-4o-mini');
  });

  test('getExtractionModel uses the configured extraction model', () => {
    process.env.INTAKE_EXTRACTION_MODEL = 'extraction-environment-model';

    getExtractionModel({ apiKey: 'test-api-key' });

    expect(latestConfig().modelName).toBe('extraction-environment-model');
  });

  test('getExtractionModel defaults to the extraction model preset', () => {
    getExtractionModel({ apiKey: 'test-api-key' });

    expect(latestConfig().modelName).toBe('gpt-4o');
  });

  test('rejects a missing API key without constructing a client', () => {
    expect(() => createChatModel()).toThrow('OPENAI_API_KEY is required');
    expect(ChatOpenAI).not.toHaveBeenCalled();
  });

  test('rejects an empty API key without constructing a client', () => {
    expect(() => createChatModel({ apiKey: '' })).toThrow(
      'OPENAI_API_KEY is required'
    );
    expect(ChatOpenAI).not.toHaveBeenCalled();
  });
});
