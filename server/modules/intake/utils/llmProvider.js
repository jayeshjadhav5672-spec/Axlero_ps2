/**
 * llmProvider.js
 *
 * LLM provider abstraction for the AI Intake Pipeline.
 *
 * Design goals:
 *   - Credentials come only from environment variables. Nothing secret is
 *     hardcoded, logged, or returned by the health endpoint.
 *   - Routing and extraction are configured independently:
 *       * routing    -> fast / low-latency classification (cheap model)
 *       * extraction -> higher-reasoning structured extraction
 *     Each role can override model, temperature, timeout, retry count and
 *     exponential-backoff parameters.
 *   - Retries are implemented here (not delegated to the SDK) so backoff and
 *     retry behaviour is explicit, testable, and identical across services.
 *     The underlying ChatOpenAI client is therefore created with maxRetries: 0.
 *
 * Environment variables (role = ROUTING | EXTRACTION):
 *   INTAKE_LLM_PROVIDER                 - provider id: openrouter | openai (default: openrouter)
 *   OPENROUTER_API_KEY                  - required credential for openrouter
 *   OPENROUTER_BASE_URL                 - optional OpenRouter base URL
 *   OPENROUTER_SITE_URL                - optional OpenRouter HTTP-Referer header (alias: OPENROUTER_APP_URL)
 *   OPENROUTER_APP_NAME                 - optional OpenRouter X-Title header
 *   OPENAI_API_KEY                      - optional credential for openai provider
 *   OPENAI_BASE_URL                     - optional OpenAI API base URL
 *   OPENAI_ORGANIZATION                 - optional OpenAI organization id
 *   INTAKE_ROUTER_MODEL                 - routing model name (alias: INTAKE_ROUTING_MODEL)
 *   INTAKE_EXTRACTION_MODEL             - extraction model name
 *   INTAKE_<ROLE>_TEMPERATURE           - sampling temperature
 *   INTAKE_<ROLE>_TIMEOUT_MS            - per-request timeout
 *   INTAKE_<ROLE>_MAX_RETRIES           - retries after the first attempt
 *   INTAKE_<ROLE>_BACKOFF_INITIAL_MS    - first backoff delay
 *   INTAKE_<ROLE>_BACKOFF_MAX_MS        - backoff ceiling
 *   INTAKE_<ROLE>_BACKOFF_FACTOR        - exponential growth factor
 *   INTAKE_<ROLE>_BACKOFF_JITTER        - jitter ratio (0.0 - 1.0)
 *   INTAKE_FALLBACK_MODEL               - fallback free model used on 429/transient upstream errors
 *   INTAKE_<ROLE>_FALLBACK_MODEL        - role-specific fallback model
 *
 * Global fallbacks:
 *   LLM_TIMEOUT_MS, LLM_MAX_RETRIES, LLM_BACKOFF_INITIAL_MS,
 *   LLM_BACKOFF_MAX_MS, LLM_BACKOFF_FACTOR, LLM_BACKOFF_JITTER
 */

const { ChatOpenAI } = require('@langchain/openai');

const SUPPORTED_PROVIDERS = Object.freeze(['openai', 'openrouter']);
const SUPPORTED_ROLES = Object.freeze(['routing', 'extraction']);

// Provider-specific credential and endpoint names. Both providers expose an
// OpenAI-compatible chat completions API, so a single ChatOpenAI client works.
const PROVIDER_DEFAULTS = Object.freeze({
  openai: {
    apiKeyVars: ['OPENAI_API_KEY'],
    baseUrlVars: ['OPENAI_BASE_URL'],
    defaultBaseURL: undefined,
  },
  openrouter: {
    apiKeyVars: ['OPENROUTER_API_KEY'],
    baseUrlVars: ['OPENROUTER_BASE_URL'],
    defaultBaseURL: 'https://openrouter.ai/api/v1',
  },
});

const ROLE_DEFAULTS = Object.freeze({
  routing: {
    model: 'nvidia/nemotron-3.5-lightning:free',
    temperature: 0,
    timeoutMs: 8000,
    maxRetries: 2,
    backoff: {
      initialMs: 250,
      maxMs: 2000,
      factor: 2,
      jitterRatio: 0.1,
    },
  },
  extraction: {
    model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    temperature: 0,
    timeoutMs: 45000,
    maxRetries: 2,
    backoff: {
      initialMs: 500,
      maxMs: 8000,
      factor: 2,
      jitterRatio: 0.2,
    },
  },
});

/**
 * Environment variable names that may override a role's model. The first
 * match wins, preserving the historical INTAKE_ROUTING_MODEL name as an alias.
 */
const ROLE_MODEL_ENV_VARS = Object.freeze({
  routing: ['INTAKE_ROUTER_MODEL', 'INTAKE_ROUTING_MODEL'],
  extraction: ['INTAKE_EXTRACTION_MODEL'],
});

function assertRole(role) {
  if (!SUPPORTED_ROLES.includes(role)) {
    throw new Error(
      `Unsupported LLM role "${role}". Expected one of: ${SUPPORTED_ROLES.join(', ')}.`
    );
  }
}

function envName(role, suffix) {
  return `INTAKE_${role.toUpperCase()}_${suffix}`;
}

function readFirst(env, names) {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value).trim();
    }
  }
  return undefined;
}

function readNumber(env, names, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = readFirst(env, names);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `Invalid numeric configuration for ${names.join(' / ')}: "${raw}" (expected ${min}..${max}).`
    );
  }
  return parsed;
}

function readInteger(env, names, fallback, options = {}) {
  const parsed = readNumber(env, names, fallback, options);
  if (!Number.isInteger(parsed)) {
    throw new Error(
      `Invalid integer configuration for ${names.join(' / ')}: "${parsed}".`
    );
  }
  return parsed;
}

/**
 * Resolve retry/backoff configuration for a role. Does not require provider
 * credentials, so it is safe to call when models are injected in tests.
 *
 * @param {'routing'|'extraction'} role
 * @param {Object} [env] - Injectable environment (defaults to process.env).
 * @returns {{maxRetries: number, backoff: {initialMs: number, maxMs: number, factor: number, jitterRatio: number}}}
 */
function resolveRetryConfig(role = 'routing', env = process.env) {
  assertRole(role);
  const defaults = ROLE_DEFAULTS[role];

  const maxRetries = readInteger(
    env,
    [envName(role, 'MAX_RETRIES'), 'LLM_MAX_RETRIES'],
    defaults.maxRetries,
    { min: 0, max: 10 }
  );

  const initialMs = readNumber(
    env,
    [envName(role, 'BACKOFF_INITIAL_MS'), 'LLM_BACKOFF_INITIAL_MS'],
    defaults.backoff.initialMs,
    { min: 0, max: 60000 }
  );

  const maxMs = readNumber(
    env,
    [envName(role, 'BACKOFF_MAX_MS'), 'LLM_BACKOFF_MAX_MS'],
    defaults.backoff.maxMs,
    { min: 0, max: 120000 }
  );

  const factor = readNumber(
    env,
    [envName(role, 'BACKOFF_FACTOR'), 'LLM_BACKOFF_FACTOR'],
    defaults.backoff.factor,
    { min: 1, max: 10 }
  );

  const jitterRatio = readNumber(
    env,
    [envName(role, 'BACKOFF_JITTER'), 'LLM_BACKOFF_JITTER'],
    defaults.backoff.jitterRatio,
    { min: 0, max: 1 }
  );

  if (maxMs < initialMs) {
    throw new Error(
      `Invalid backoff configuration for role "${role}": BACKOFF_MAX_MS (${maxMs}) must be >= BACKOFF_INITIAL_MS (${initialMs}).`
    );
  }

  return { maxRetries, backoff: { initialMs, maxMs, factor, jitterRatio } };
}

/**
 * Resolve the full provider + role configuration from the environment.
 *
 * @param {'routing'|'extraction'} role
 * @param {Object} [overrides]
 * @param {Object} [env] - Injectable environment (defaults to process.env).
 * @returns {Object}
 */
function resolveProviderConfig(role = 'routing', overrides = {}, env = process.env) {
  assertRole(role);
  const defaults = ROLE_DEFAULTS[role];

  const provider = String(
    overrides.provider || readFirst(env, ['INTAKE_LLM_PROVIDER']) || 'openrouter'
  ).toLowerCase();

  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw new Error(
      `Unsupported LLM provider "${provider}". Supported providers: ${SUPPORTED_PROVIDERS.join(', ')}.`
    );
  }

  const providerDefaults = PROVIDER_DEFAULTS[provider];
  const retry = resolveRetryConfig(role, env);

  const apiKey =
    overrides.apiKey ?? readFirst(env, providerDefaults.apiKeyVars);
  const baseURL =
    overrides.baseURL ??
    readFirst(env, [
      envName(role, 'BASE_URL'),
      ...providerDefaults.baseUrlVars,
    ]) ??
    providerDefaults.defaultBaseURL;
  const organization =
    provider === 'openai'
      ? overrides.organization ?? readFirst(env, ['OPENAI_ORGANIZATION'])
      : undefined;

  // OpenRouter optionally uses these headers for app attribution/ranking.
  const defaultHeaders = {};
  if (provider === 'openrouter') {
    const siteUrl =
      readFirst(env, ['OPENROUTER_APP_URL']) ||
      readFirst(env, ['OPENROUTER_SITE_URL']);
    const appName = readFirst(env, ['OPENROUTER_APP_NAME']);
    if (siteUrl) defaultHeaders['HTTP-Referer'] = siteUrl;
    if (appName) defaultHeaders['X-Title'] = appName;
  }

  const model =
    overrides.model ??
    readFirst(env, ROLE_MODEL_ENV_VARS[role]) ??
    defaults.model;

  const temperature =
    overrides.temperature ??
    readNumber(env, [envName(role, 'TEMPERATURE')], defaults.temperature, {
      min: 0,
      max: 2,
    });

  const timeoutMs =
    overrides.timeoutMs ??
    readNumber(
      env,
      [envName(role, 'TIMEOUT_MS'), 'LLM_TIMEOUT_MS'],
      defaults.timeoutMs,
      { min: 100, max: 300000 }
    );

  return {
    provider,
    role,
    apiKey,
    baseURL,
    organization,
    defaultHeaders,
    model,
    temperature,
    timeoutMs,
    maxRetries: retry.maxRetries,
    backoff: retry.backoff,
  };
}

/**
 * Compute the exponential-backoff delay for a zero-based retry attempt.
 * `attempt = 0` is the delay before the first retry.
 *
 * @param {number} attempt
 * @param {{initialMs: number, maxMs: number, factor: number, jitterRatio: number}} backoff
 * @param {() => number} [random] - Injectable RNG for deterministic tests.
 * @returns {number} delay in milliseconds
 */
function computeBackoffDelay(attempt, backoff, random = Math.random) {
  const base = Math.min(
    backoff.initialMs * Math.pow(backoff.factor, attempt),
    backoff.maxMs
  );
  const jitter =
    base * backoff.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/**
 * Default sleep implementation.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

/**
 * Resolve the fallback model name for a role, if configured.
 *
 * The fallback is used only when the primary `:free` endpoint returns a
 * rate-limit (429) or transient upstream error. It lets the pipeline keep
 * serving traffic on a different free Nemotron model instead of failing hard.
 *
 * Resolution order:
 *   INTAKE_<ROLE>_FALLBACK_MODEL
 *   INTAKE_FALLBACK_MODEL
 *   LLM_FALLBACK_MODEL
 *   DEFAULT_FALLBACK_MODEL
 *
 * @param {'routing'|'extraction'} [role='routing']
 * @param {Object} [env] - Injectable environment (defaults to process.env).
 * @returns {string|undefined} Fallback model name, or undefined when none configured.
 */
function resolveFallbackModel(role = 'routing', env = process.env) {
  assertRole(role);
  return (
    readFirst(env, [envName(role, 'FALLBACK_MODEL')]) ||
    readFirst(env, ['INTAKE_FALLBACK_MODEL']) ||
    readFirst(env, ['LLM_FALLBACK_MODEL']) ||
    DEFAULT_FALLBACK_MODEL
  );
}

/**
 * Default free-model fallback used when no INTAKE_FALLBACK_MODEL is set.
 * @type {string}
 */
const DEFAULT_FALLBACK_MODEL = 'nvidia/nemotron-3.5-super-vl:free';

/**
 * Determine whether an error is a rate-limit or transient upstream error that
 * warrants a retry and/or a fallback to another model.
 *
 * Detects HTTP 429 (rate limit), 502/503/504 (upstream/gateway), common
 * network error codes, and rate-limit wording in the message.
 *
 * @param {Error|Object} error
 * @returns {boolean}
 */
function isRateLimitOrTransientError(error) {
  if (!error) return false;

  const status = error.status ?? error.statusCode ?? error.response?.status;
  const code = String(error.code || '');
  const message = String(error.message || '');

  if (
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return true;
  }

  if (
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(code)
  ) {
    return true;
  }

  return /rate.?limit|too many requests|service unavailable|bad gateway|gateway timeout/i.test(
    message
  );
}

/**
 * Execute an async operation with bounded retries, falling back to a secondary
 * operation (typically the same call against a different free model) when the
 * primary fails with a rate-limit or transient error.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} primaryOp
 * @param {(attempt: number) => Promise<T>|undefined} fallbackOp
 * @param {Object} [options]
 * @param {number} [options.maxRetries]
 * @param {Object} [options.backoff]
 * @param {Function} [options.sleep]
 * @param {Function} [options.random]
 * @returns {Promise<T>}
 */
async function invokeWithFallback(primaryOp, fallbackOp, options = {}) {
  const {
    maxRetries = 0,
    backoff = { initialMs: 250, maxMs: 2000, factor: 2, jitterRatio: 0 },
    sleep: sleepFn = sleep,
    random = Math.random,
  } = options;

  let lastError;
  try {
    return await withRetry(primaryOp, {
      maxRetries,
      backoff,
      sleep: sleepFn,
      random,
    });
  } catch (error) {
    lastError = error;
    if (
      !fallbackOp ||
      !isRateLimitOrTransientError(error)
    ) {
      throw error;
    }
  }

  // Fall back to the secondary model/operation. Use the same backoff budget so
  // total latency stays bounded.
  return await withRetry(fallbackOp, {
    maxRetries,
    backoff,
    sleep: sleepFn,
    random,
  });
}

/**
 * Execute an async operation with bounded exponential-backoff retries.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} operation
 * @param {Object} [options]
 * @param {number} [options.maxRetries] - Retries after the first attempt.
 * @param {Object} [options.backoff]
 * @param {Function} [options.sleep] - Injectable sleep function for tests.
 * @param {Function} [options.random] - Injectable RNG for tests.
 * @param {Function} [options.onRetry] - Called with {attempt, delay, error}.
 * @returns {Promise<T>}
 */
async function withRetry(operation, options = {}) {
  const {
    maxRetries = 0,
    backoff = { initialMs: 250, maxMs: 2000, factor: 2, jitterRatio: 0 },
    sleep: sleepFn = sleep,
    random = Math.random,
    onRetry,
  } = options;

  if (typeof operation !== 'function') {
    throw new TypeError('withRetry requires an async operation function.');
  }

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) break;

      const delay = computeBackoffDelay(attempt, backoff, random);
      if (typeof onRetry === 'function') {
        await onRetry({ attempt: attempt + 1, delay, error });
      }
      await sleepFn(delay);
    }
  }

  throw lastError;
}

/**
 * Create a bounded, retry-configured ChatOpenAI model for a role.
 *
 * The SDK's own retries are disabled; callers should wrap invocations with
 * `withRetry(..., resolveRetryConfig(role))` so backoff stays explicit.
 *
 * @param {Object} [options]
 * @param {'routing'|'extraction'} [options.role='routing']
 * @param {string} [options.model]
 * @param {number} [options.temperature]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxRetries] - Stored on the returned instance for callers.
 * @param {string} [options.apiKey] - Optional DI override; defaults to OPENROUTER_API_KEY (or OPENAI_API_KEY for the openai provider).
 * @param {Object} [options.extra] - Additional ChatOpenAI constructor options.
 * @returns {ChatOpenAI}
 */
function createChatModel(options = {}) {
  const {
    role = 'routing',
    extra = {},
    ...overrides
  } = options;

  const config = resolveProviderConfig(role, overrides);

  if (!config.apiKey) {
    const keyName =
      config.provider === 'openrouter'
        ? 'OPENROUTER_API_KEY'
        : 'OPENAI_API_KEY';
    throw new Error(
      `${keyName} is required for provider "${config.provider}". Set it in the environment (see .env.example). ` +
        'Provider credentials must never be hardcoded in source.'
    );
  }

  const configuration = {};
  if (config.baseURL) configuration.baseURL = config.baseURL;
  if (config.organization) configuration.organization = config.organization;
  if (Object.keys(config.defaultHeaders || {}).length > 0) {
    configuration.defaultHeaders = config.defaultHeaders;
  }

  const model = new ChatOpenAI({
    modelName: config.model,
    temperature: config.temperature,
    timeout: config.timeoutMs,
    // Retries are handled by withRetry() so backoff is explicit and uniform.
    maxRetries: 0,
    // @langchain/openai 1.x reads `apiKey`; passing only the legacy
    // `openAIApiKey` alias silently falls back to OPENAI_API_KEY in the
    // environment, which breaks non-OpenAI providers such as OpenRouter.
    apiKey: config.apiKey,
    openAIApiKey: config.apiKey,
    ...(Object.keys(configuration).length > 0 ? { configuration } : {}),
    ...extra,
  });

  // Non-secret metadata for services and health reporting.
  model.intake = {
    provider: config.provider,
    role: config.role,
    model: config.model,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    backoff: config.backoff,
  };

  return model;
}

/**
 * Fast routing model for intent / form classification.
 * @param {Object} [options]
 * @returns {ChatOpenAI}
 */
function getRoutingModel(options = {}) {
  return createChatModel({ role: 'routing', ...options });
}

/**
 * Higher-reasoning extraction model for structured field extraction.
 * @param {Object} [options]
 * @returns {ChatOpenAI}
 */
function getExtractionModel(options = {}) {
  return createChatModel({ role: 'extraction', ...options });
}

/**
 * Non-secret configuration summary for health endpoints and diagnostics.
 * Never includes the API key.
 *
 * @param {'routing'|'extraction'} role
 * @param {Object} [env]
 * @returns {Object}
 */
function getProviderSummary(role = 'routing', env = process.env) {
  try {
    const config = resolveProviderConfig(role, {}, env);
    return {
      provider: config.provider,
      role: config.role,
      model: config.model,
      fallback_model: resolveFallbackModel(role, env),
      configured: Boolean(config.apiKey),
      timeout_ms: config.timeoutMs,
      max_retries: config.maxRetries,
      backoff: config.backoff,
      base_url_configured: Boolean(config.baseURL),
      organization_configured: Boolean(config.organization),
      attribution_headers: Object.keys(config.defaultHeaders || {}),
    };
  } catch (err) {
    return {
      provider: env.INTAKE_LLM_PROVIDER || 'openrouter',
      role,
      configured: false,
      error: err.message,
    };
  }
}

module.exports = {
  SUPPORTED_PROVIDERS,
  SUPPORTED_ROLES,
  ROLE_DEFAULTS,
  resolveProviderConfig,
  resolveRetryConfig,
  resolveFallbackModel,
  DEFAULT_FALLBACK_MODEL,
  computeBackoffDelay,
  isRateLimitOrTransientError,
  withRetry,
  invokeWithFallback,
  sleep,
  createChatModel,
  getRoutingModel,
  getExtractionModel,
  getProviderSummary,
};
