/**
 * routing.controller.js
 *
 * HTTP controllers for form routing in the AI Intake Pipeline.
 */

const routingService = require('../services/routingService');

function resolveService(req, key, fallback) {
  return (
    (req.app && req.app.locals && req.app.locals.intakeServices &&
      req.app.locals.intakeServices[key]) ||
    fallback
  );
}

/**
 * POST /api/intake/route
 * Body: { user_prompt: string }
 * Returns: FormRouteResponse (see services/routingService.js)
 */
exports.routeForm = async (req, res) => {
  const { user_prompt } = req.body || {};

  if (!user_prompt || typeof user_prompt !== 'string' || !user_prompt.trim()) {
    return res.status(400).json({
      error: 'validation_error',
      message: 'user_prompt is required and must be a non-empty string.',
    });
  }

  const service = resolveService(req, 'routingService', routingService);

  try {
    const result = await service.route({ userPrompt: user_prompt.trim() });
    return res.status(200).json(result);
  } catch (err) {
    // Defensive fallback: never guess on failure; require clarification.
    // The public message stays generic so provider errors cannot leak
    // identifiers or partially masked credentials.
    return res.status(502).json({
      error: 'routing_error',
      message: 'Routing failed because the provider was unavailable or misconfigured.',
      routing: {
        form_id: null,
        confidence: 0.0,
        rationale:
          'Routing service failed; unable to classify the prompt. Clarification required.',
        clarification_required: true,
      },
    });
  }
};
