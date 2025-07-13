const { calculateChart } = require('../services/swissEphemeris');

exports.getBirthChart = async (req, res) => {
  try {
    const { birthDate, birthTime, lat, lon } = req.body;
    
    // Parse date/time
    const [year, month, day] = birthDate.split('-').map(Number);
    const [hour, minute] = birthTime.split(':').map(Number);

    const chart = await calculateChart({
      year, month, day, hour, minute, lat, lon
    });

    res.json({
      success: true,
      chart: {
        ascendant: chart.houses.house[0],
        houses: chart.houses.house.slice(1, 13),
        planets: chart.planets
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Chart calculation failed',
      error: error.message
    });
  }
};