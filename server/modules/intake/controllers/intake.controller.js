/**
 * intake.controller.js
 *
 * HTTP controllers for the AI Intake Pipeline module.
 */

const intakeService = require('../services/intake.service');

/**
 * GET /api/intake/health
 * Verifies the pipeline router service initializes correctly and responds 200 OK.
 */
exports.health = async (_req, res) => {
  const status = await intakeService.checkHealth();
  const httpStatus = status.ok ? 200 : 503;
  return res.status(httpStatus).json(status);
};
