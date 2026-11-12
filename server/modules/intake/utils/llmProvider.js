/**
 * llmProvider.js
 *
 * LLM Provider Abstraction for the AI Intake Pipeline.
 *
 * Provides a factory for creating LangChain ChatOpenAI models with:
 *   - Bounded timeouts (prevents hanging requests under load)
 *   - Automatic retry with exponential backoff (handled by LangChain core)
 *   - Secure API key loading from environment (no hardcoded credentials)
 *   - Two model presets:
 *       * routing model  -> gpt-4o-mini  (fast, cheap classification)
 *       * extraction model -> gpt-4o     (high-reasoning structured extraction)
 */

const { ChatOpenAI } = require('@langchain/openai');

/**
 * Create a bounded, retry-enabled ChatOpenAI model.
 *
 * @param {Object} options
 * @param {string} [options.model]            Model name (defaults to INTAKE_ROUTING_MODEL env or gpt-4o-mini)
 * @param {number} [options.temperature]      Sampling temperature (default 0.0)
 * @param {number} [options.timeoutMs]        Request timeout in milliseconds (default LLM_TIMEOUT_MS or 12000)
 * @param {number} [options.maxRetries]       Max retry attempts (default LLM_MAX_RETRIES or 3)
 * @param {string} [options.apiKey]           OpenAI API key (defaults to OPENAI_API_KEY env)
 * @param {Object} [options.extra]            Any additional ChatOpenAI constructor options
 * @returns {ChatOpenAI}                      Configured LangChain chat model instance
 */
function createChatModel(options = {}) {
  const {
    model = process.env.INTAKE_ROUTING_MODEL || 'gpt-4o-mini',
    temperature = 0.0,
    timeoutMs = parseInt(process.env.LLM_TIMEOUT_MS, 10) || 12000,
    maxRetries = parseInt(process.env.LLM_MAX_RETRIES, 10) || 3,
    apiKey = process.env.OPENAI_API_KEY,
    extra = {},
  } = options;

  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is required. Set it in .env (copy from .env.example). ' +
      'Credentials must never be hardcoded in source.'
    );
  }

  return new ChatOpenAI({
    modelName: model,
    temperature,
    timeout: timeoutMs,        // bounded timeout in ms
    maxRetries,                // LangChain applies exponential backoff on retries
    openAIApiKey: apiKey,
    ...extra,
  });
}

/**
 * Fast routing model for intent / form classification.
 * Optimized for low latency and low cost.
 *
 * @param {Object} options - Overrides merged into createChatModel
 * @returns {ChatOpenAI}
 */
function getRoutingModel(options = {}) {
  return createChatModel({
    model: process.env.INTAKE_ROUTING_MODEL || 'gpt-4o-mini',
    temperature: 0.0,
    ...options,
  });
}

/**
 * High-reasoning extraction model for structured field extraction.
 *
 * @param {Object} options - Overrides merged into createChatModel
 * @returns {ChatOpenAI}
 */
function getExtractionModel(options = {}) {
  return createChatModel({
    model: process.env.INTAKE_EXTRACTION_MODEL || 'gpt-4o',
    temperature: 0.0,
    ...options,
  });
}

module.exports = {
  createChatModel,
  getRoutingModel,
  getExtractionModel,
};
