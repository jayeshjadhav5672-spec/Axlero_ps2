/**
 * intake.controller.js
 *
 * HTTP controllers for health and diagnostics.
 */

const intakeService = require('../services/intake.service');

function resolveService(req, key, fallback) {
  return (
    (req.app && req.app.locals && req.app.locals.intakeServices &&
      req.app.locals.intakeServices[key]) ||
    fallback
  );
}

/**
 * GET /api/intake/health
 * Verifies provider configuration and, by default, performs a lightweight
 * live probe. Pass ?deep=false to only check configuration.
 */
exports.health = async (req, res) => {
  const service = resolveService(req, 'healthService', intakeService);
  const deep = String(req.query?.deep || '').toLowerCase() !== 'false';
  const status = await service.checkHealth({ deep });
  const httpStatus = status.ok ? 200 : 503;
  return res.status(httpStatus).json(status);
};
