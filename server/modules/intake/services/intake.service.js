/**
 * intake.service.js
 *
 * Health/diagnostics for the AI Intake Pipeline.
 * Reports non-secret provider configuration and performs a lightweight
 * connectivity probe when credentials are present.
 */

const { getRoutingModel, getProviderSummary } = require('../utils/llmProvider');

/**
 * @param {Object} [options]
 * @param {boolean} [options.deep=true] - Perform a live provider probe.
 * @returns {Promise<Object>}
 */
async function checkHealth({ deep = true } = {}) {
  const routing = getProviderSummary('routing');
  const extraction = getProviderSummary('extraction');
  const providerConfigured = Boolean(routing.configured && extraction.configured);

  if (!providerConfigured) {
    return {
      ok: false,
      service: 'ai-intake',
      router: 'not_configured',
      provider_configured: false,
      providers: { routing, extraction },
      error:
        'Provider credentials are not configured. Set OPENROUTER_API_KEY in the environment (see .env.example).',
      timestamp: new Date().toISOString(),
    };
  }

  if (!deep) {
    return {
      ok: true,
      service: 'ai-intake',
      router: 'initialized',
      provider_configured: true,
      providers: { routing, extraction },
      timestamp: new Date().toISOString(),
    };
  }

  try {
    const model = getRoutingModel();

    // Lightweight invocation to verify the provider is reachable and configured.
    const response = await model.invoke('Respond with exactly the single word: ok');

    return {
      ok: true,
      service: 'ai-intake',
      router: 'initialized',
      provider_configured: true,
      providers: { routing, extraction },
      providerResponse:
        typeof response.content === 'string'
          ? response.content.trim()
          : String(response.content),
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ok: false,
      service: 'ai-intake',
      router: 'initialization_failed',
      provider_configured: true,
      providers: { routing, extraction },
      error: err.message,
      timestamp: new Date().toISOString(),
    };
  }
}

module.exports = {
  checkHealth,
};
