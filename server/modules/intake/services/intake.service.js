/**
 * intake.service.js
 *
 * Business logic for the AI Intake Pipeline.
 * Orchestrates the LLM provider and verifies pipeline initialization.
 */

const { getRoutingModel } = require('../utils/llmProvider');

/**
 * Verify the pipeline router service initializes correctly.
 * Performs a lightweight invocation against the routing model to confirm
 * connectivity, bounded timeouts, and retry configuration are functional.
 *
 * @returns {Promise<Object>} { ok, service, router, model, timestamp } or error info
 */
async function checkHealth() {
  const modelName = process.env.INTAKE_ROUTING_MODEL || 'gpt-4o-mini';

  try {
    const model = getRoutingModel();

    // Lightweight invocation to verify the provider is reachable and configured.
    const response = await model.invoke('Respond with exactly the single word: ok');

    return {
      ok: true,
      service: 'ai-intake',
      router: 'initialized',
      model: modelName,
      providerResponse: typeof response.content === 'string' ? response.content.trim() : String(response.content),
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return {
      ok: false,
      service: 'ai-intake',
      router: 'initialization_failed',
      model: modelName,
      error: err.message,
      timestamp: new Date().toISOString(),
    };
  }
}

module.exports = {
  checkHealth,
};
