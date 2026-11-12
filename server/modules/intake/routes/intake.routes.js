/**
 * intake.routes.js
 *
 * Route definitions for the AI Intake Pipeline module.
 * Mounted at /api/intake by the main application.
 */

const express = require('express');
const router = express.Router();
const intakeController = require('../controllers/intake.controller');
const routingController = require('../controllers/routing.controller');

// Health & verification endpoint
router.get('/health', intakeController.health);

// Form routing endpoint: classifies a user prompt against the form catalogue.
router.post('/route', routingController.routeForm);

module.exports = router;
