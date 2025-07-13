const express = require('express');
const { getBirthChart } = require('../controllers/astrologyController');
const router = express.Router();

router.post('/api/chart', getBirthChart);

module.exports = router;