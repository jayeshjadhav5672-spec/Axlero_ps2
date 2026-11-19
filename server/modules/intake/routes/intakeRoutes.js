/**
 * intakeRoutes.js
 *
 * Route definitions for the AI Intake Pipeline module.
 * Mounted at /api/intake by the main application.
 *
 *   GET  /api/intake/health   - provider configuration + connectivity probe
 *   POST /api/intake/route    - classify text against the form catalogue
 *   POST /api/intake/extract  - route (optional) + schema-conditioned extraction
 */

const express = require('express');
const router = express.Router();
const intakeController = require('../controllers/intake.controller');
const routingController = require('../controllers/routing.controller');
const extractionController = require('../controllers/extraction.controller');

router.get('/health', intakeController.health);
router.post('/route', routingController.routeForm);
router.post('/extract', extractionController.extract);

module.exports = router;
