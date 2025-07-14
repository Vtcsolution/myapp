const { OpenAI } = require("openai");
const axios = require("axios");
const ChatMessage = require("../models/chatMessage");
const AiPsychic = require("../models/aiPsychic");
const AiFormData = require("../models/aiFormData");
const { getCoordinatesFromCity } = require("../utils/geocode");
const { getRequiredFieldsByType } = require("../utils/formLogic");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY?.trim() // Ensure no whitespace
});

// Verify the key is loaded correctly
if (!process.env.OPENAI_API_KEY) {
  process.exit(1);
}
const auth = {
  username: process.env.ASTROLOGY_API_USER_ID,
  password: process.env.ASTROLOGY_API_KEY,
};

function getSignFromDate(dateStr) {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (isNaN(date)) return null;

  const month = date.getMonth() + 1;
  const day = date.getDate();

  if ((month === 3 && day >= 21) || (month === 4 && day <= 19)) return 'Aries';
  if ((month === 4 && day >= 20) || (month === 5 && day <= 20)) return 'Taurus';
  if ((month === 5 && day >= 21) || (month === 6 && day <= 20)) return 'Gemini';
  if ((month === 6 && day >= 21) || (month === 7 && day <= 22)) return 'Cancer';
  if ((month === 7 && day >= 23) || (month === 8 && day <= 22)) return 'Leo';
  if ((month === 8 && day >= 23) || (month === 9 && day <= 22)) return 'Virgo';
  if ((month === 9 && day >= 23) || (month === 10 && day <= 22)) return 'Libra';
  if ((month === 10 && day >= 23) || (month === 11 && day <= 21)) return 'Scorpio';
  if ((month === 11 && day >= 22) || (month === 12 && day <= 21)) return 'Sagittarius';
  if ((month === 12 && day >= 22) || (month === 1 && day <= 19)) return 'Capricorn';
  if ((month === 1 && day >= 20) || (month === 2 && day <= 18)) return 'Aquarius';
  if ((month === 2 && day >= 19) || (month === 3 && day <= 20)) return 'Pisces';
  
  return null;
}
const parseTime = (timeStr = "") => {
  const [hourStr, minStr] = timeStr.split(":");
  return {
    hour: parseInt(hourStr, 10) || 0,
    min: parseInt(minStr, 10) || 0,
  };
};
const parseDateParts = (dateStr = "") => {
  if (!dateStr || isNaN(Date.parse(dateStr))) {
    return { day: 1, month: 1, year: 2000 };
  }
  const d = new Date(dateStr);
  return {
    day: d.getDate(),
    month: d.getMonth() + 1,
    year: d.getFullYear(),
  };
};


// 🔮 Fetch astrology data
const getWesternChartData = async (formData, coords) => {
  const { hour, min } = parseTime(formData.birthTime);

  let timezone = 0; // default fallback
  try {
    const tzRes = await axios.post(
      "https://json.astrologyapi.com/v1/timezone_with_dst",
      { latitude: coords.latitude, longitude: coords.longitude, date: formData.birthDate },
      { auth }
    );
    timezone = tzRes.data.timezone;
  } catch (err) {
    console.warn("Timezone API fallback used:", err?.response?.data || err.message);
  }

  const payload = {
    day: new Date(formData.birthDate).getDate(),
    month: new Date(formData.birthDate).getMonth() + 1,
    year: new Date(formData.birthDate).getFullYear(),
    hour,
    min,
    lat: coords.latitude,
    lon: coords.longitude,
    tzone: timezone,
  };

  const [chart, personality, planets, houses] = await Promise.all([
    axios.post("https://json.astrologyapi.com/v1/western_chart_data", payload, { auth }),
    axios.post("https://json.astrologyapi.com/v1/personality_report/tropical", payload, { auth }),
    axios.post("https://json.astrologyapi.com/v1/planets/tropical", payload, { auth }),
    axios.post("https://json.astrologyapi.com/v1/house_cusps/tropical", payload, { auth }),
  ]);

  return {
    sunSign: chart.data?.sun?.sign || "Unknown",
    moonSign: chart.data?.moon?.sign || "Unknown",
    ascendant: chart.data?.ascendant?.sign || "Unknown",
    planets: Array.isArray(planets.data) ? planets.data : [],
    houses: typeof houses.data === "object" ? houses.data : {},
    personality: personality.data?.traits || [],
    payload,
    timezone,
  };
};

// 🌌 Main chat logic
const chatWithPsychic = async (req, res) => {
  try {
    const userId = req.user._id;
    const psychicId = req.params.psychicId;
    const { message } = req.body;

    if (!psychicId || !message) {
      return res.status(400).json({ success: false, message: "Psychic ID and message are required." });
    }

    const psychic = await AiPsychic.findById(psychicId);
    if (!psychic) return res.status(404).json({ success: false, message: "Psychic not found." });

    const { type } = psychic;
   let f = {};

if (type !== "Tarot") {
  const requiredFields = getRequiredFieldsByType(type);
  const form = await AiFormData.findOne({ userId, type });

  if (!form?.formData) {
    return res.status(400).json({ 
      success: false, 
      message: `Please fill the required ${type} form.` 
    });
  }

  f = form.formData;
  const missingFields = requiredFields.filter(field => !f[field]);

  if (missingFields.length > 0) {
    return res.status(400).json({ 
      success: false, 
      message: `Missing fields: ${missingFields.join(", ")}` 
    });
  }
}

    let chat = await ChatMessage.findOne({ userId, psychicId }) || new ChatMessage({ userId, psychicId, messages: [] });
    chat.messages.push({ sender: "user", text: message });

    // ♓ Astrology Handling
   if (type === "Astrology") {
  const coords = await getCoordinatesFromCity(f.birthPlace);
  const western = await getWesternChartData(f, coords); // must include accurate house + timezone info

  const planetDetails = western.planets.map(p =>
    `- ${p.name}: ${p.sign} (House ${p.house || "N/A"})`
  ).join("\n");

  const houseDetails = Object.entries(western.houses).map(
    ([num, data]) => `- House ${num}: ${data?.sign || "Unknown"}`
  ).join("\n");

  const systemContent = `
You are a professional Western astrologer giving spiritual readings.

Client Details:
• Name: ${f.yourName || "N/A"}
• Birth Date & Time: ${f.birthDate} at ${f.birthTime}
• Birth Place: ${f.birthPlace}
• Coordinates: ${coords.latitude}, ${coords.longitude}
• Timezone Used: ${western.timezone}

🌞 Sun Sign: ${western.sunSign}
🌙 Moon Sign: ${western.moonSign}
⬆ Ascendant: ${western.ascendant}

🔭 Planetary Positions:
${planetDetails}

🏠 House Cusps:
${houseDetails}

🧠 Personality Traits:
${western.personality.join("\n")}

Please provide a deep, mystical, and personalized astrology reading.
Focus especially on:
- Sun, Moon, Mars, Venus, and Ascendant
- Interpret their signs and house placements clearly
- Offer life guidance, emotional patterns, and soul purpose from the chart.
  `.trim();

  const messagesForAI = [
    { role: "system", content: systemContent },
    ...chat.messages.map(msg => ({
      role: msg.sender === "user" ? "user" : "assistant",
      content: msg.text
    }))
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-4",
    messages: messagesForAI,
    temperature: 0.75
  });

  const aiText = completion.choices[0].message.content;

  chat.messages.push({ sender: "ai", text: aiText });
  await chat.save();

  return res.status(200).json({
    success: true,
    reply: aiText,
    messages: chat.messages,
    source: "AstrologyAPI + GPT-4"
  });
}

else if (type === "Love") {
  try {
    console.log('[Love Psychic] Starting enhanced love reading process...');
    console.log('[API] Using endpoints: western_chart_data, planets/tropical, synastry_report');

    // 1. First check for simple informational queries
    const lowerMessage = message.toLowerCase().trim();
    
    // Handle "my info?" query
    if (lowerMessage.includes('my info') || lowerMessage.includes('my information')) {
      const userInfo = `
Your Information:
• Name: ${f.yourName}
• Birth Date: ${f.yourBirthDate}
• Birth Time: ${f.yourBirthTime}
• Birth Place: ${f.yourBirthPlace}
• Zodiac Sign: ${getSignFromDate(f.yourBirthDate) || 'Unknown'}
      `.trim();
      
      chat.messages.push({ sender: "ai", text: userInfo });
      await chat.save();
      return res.status(200).json({
        success: true,
        reply: userInfo,
        messages: chat.messages
      });
    }
    
    // Handle "partner info" query
    if (lowerMessage.includes('partner info') || lowerMessage.includes('partner name') || 
        lowerMessage.includes('my partner')) {
      if (!f.partnerName) {
        const noPartnerMsg = "You haven't provided partner information yet.";
        chat.messages.push({ sender: "ai", text: noPartnerMsg });
        await chat.save();
        return res.status(200).json({
          success: true,
          reply: noPartnerMsg,
          messages: chat.messages
        });
      }
      
      const partnerInfo = `
Partner Information:
• Name: ${f.partnerName}
• Birth Date: ${f.partnerBirthDate || 'Not provided'}
• Birth Time: ${f.partnerBirthTime || 'Not provided'}
• Birth Place: ${f.partnerPlaceOfBirth || 'Not provided'}
• Zodiac Sign: ${f.partnerBirthDate ? getSignFromDate(f.partnerBirthDate) || 'Unknown' : 'Not provided'}
      `.trim();
      
      chat.messages.push({ sender: "ai", text: partnerInfo });
      await chat.save();
      return res.status(200).json({
        success: true,
        reply: partnerInfo,
        messages: chat.messages
      });
    }

    // 2. Validate required fields
    const requiredFields = ['yourName', 'yourBirthDate', 'yourBirthTime', 'yourBirthPlace'];
    const missingFields = requiredFields.filter(field => !f[field]);
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missingFields.join(', ')}`
      });
    }

    // 3. Get coordinates with improved error handling
    let userCoords, partnerCoords;
    try {
      userCoords = await getCoordinatesFromCity(f.yourBirthPlace);
      console.log(`[Geocode] User coordinates: ${JSON.stringify(userCoords)}`);
      
      if (f.partnerPlaceOfBirth) {
        partnerCoords = await getCoordinatesFromCity(f.partnerPlaceOfBirth);
        console.log(`[Geocode] Partner coordinates: ${JSON.stringify(partnerCoords)}`);
      }
    } catch (geoError) {
      console.warn('[Geocode] Error getting coordinates:', geoError.message);
      // Use default coordinates that will still work for astro calculations
      userCoords = { latitude: 0, longitude: 0 };
      partnerCoords = { latitude: 0, longitude: 0 };
    }

    // 4. Prepare payloads with timezone and validation
    const buildPayload = async (dateStr, timeStr, coords) => {
      // Validate date
      if (!dateStr || isNaN(new Date(dateStr))) {
        throw new Error('Invalid date format');
      }
      
      const date = new Date(dateStr);
      const [hour = 12, min = 0] = (timeStr || '').split(':').map(Number);
      
      let timezone = 0;
      try {
        const tzRes = await axios.post(
          "https://json.astrologyapi.com/v1/timezone_with_dst",
          { 
            latitude: coords.latitude || 0, 
            longitude: coords.longitude || 0, 
            date: dateStr 
          },
          { auth, timeout: 5000 }
        );
        timezone = tzRes.data.timezone;
      } catch (err) {
        console.warn("Timezone API error, using default:", err.message);
      }

      return {
        day: date.getDate(),
        month: date.getMonth() + 1,
        year: date.getFullYear(),
        hour: Math.min(23, Math.max(0, hour)),
        min: Math.min(59, Math.max(0, min)),
        lat: coords.latitude || 0,
        lon: coords.longitude || 0,
        tzone: timezone
      };
    };

    // Build payloads with error handling
    let userPayload, partnerPayload;
    try {
      userPayload = await buildPayload(f.yourBirthDate, f.yourBirthTime, userCoords);
      console.log('[Payload] User payload prepared');
      
      if (f.partnerBirthDate) {
        partnerPayload = await buildPayload(f.partnerBirthDate, f.partnerBirthTime, partnerCoords || userCoords);
        console.log('[Payload] Partner payload prepared');
      }
    } catch (err) {
      console.error('[Payload] Error building payload:', err.message);
      throw new Error('Invalid birth data provided');
    }

    // 5. Fetch core astrological data with retry logic
    console.log('[API] Fetching essential astrological data...');
    let astrologyData = {
      userChart: null,
      partnerChart: null,
      compatibility: {
        zodiac: null
      },
      planetaryData: {
        user: {},
        partner: {}
      },
      zodiacSigns: {
        user: getSignFromDate(f.yourBirthDate),
        partner: f.partnerBirthDate ? getSignFromDate(f.partnerBirthDate) : null
      }
    };

    // Function to fetch with retry
    const fetchWithRetry = async (url, data, retries = 2) => {
      try {
        const response = await axios.post(url, data, { auth, timeout: 10000 });
        return response.data;
      } catch (err) {
        if (retries > 0) {
          console.log(`[API] Retrying ${url}... (${retries} left)`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          return fetchWithRetry(url, data, retries - 1);
        }
        throw err;
      }
    };

    // Get user's planetary data
    try {
      console.log('[API] Getting user chart and planets');
      const [userChartRes, userPlanetsRes] = await Promise.all([
        fetchWithRetry("https://json.astrologyapi.com/v1/western_chart_data", userPayload),
        fetchWithRetry("https://json.astrologyapi.com/v1/planets/tropical", userPayload)
      ]);
      
      astrologyData.userChart = userChartRes;
      astrologyData.planetaryData.user = userPlanetsRes.reduce((acc, planet) => {
        const planetName = planet.name.toLowerCase();
        if (['sun', 'moon', 'venus', 'mars', 'ascendant'].includes(planetName)) {
          acc[planetName] = {
            sign: planet.sign,
            house: planet.house,
            degree: planet.degree,
            retrograde: planet.retrograde
          };
        }
        return acc;
      }, {});
    } catch (err) {
      console.error('[API] Error fetching user data:', err.message);
      throw new Error('Failed to analyze your birth chart');
    }

    // Get partner's data if available

if (partnerPayload) {
  try {
    console.log('[API] Getting synastry horoscope for full compatibility');
    const synastryRes = await axios.post(
      "https://json.astrologyapi.com/v1/synastry_horoscope/tropical",
      {
        profile1: {
          ...userPayload,
          name: f.yourName
        },
        profile2: {
          ...partnerPayload,
          name: f.partnerName
        }
      },
      { auth, timeout: 15000 }
    );

    astrologyData.compatibility = {
      synastry: synastryRes.data,
      aspects: synastryRes.data?.aspects || [],
      score: synastryRes.data?.compatibility_score || null,
      strengths: synastryRes.data?.strengths || [],
      challenges: synastryRes.data?.challenges || []
    };

    console.log('[API] Synastry report received:', {
      score: astrologyData.compatibility.score,
      aspectCount: astrologyData.compatibility.aspects.length
    });

  } catch (err) {
    console.error('[API] Synastry error:', err.message);
    // Fallback to basic compatibility if synastry fails
    astrologyData.compatibility = {
      zodiac: {
        compatibility_report: generateBasicCompatibility(
          astrologyData.zodiacSigns.user,
          astrologyData.zodiacSigns.partner
        ),
        isFallback: true
      }
    };
  }
}

    // 6. Prepare optimized GPT-4 prompt with token management
    const systemContent = `
You are Amoura, a love psychic. Create a personalized response using the astrological data.
Follow these guidelines:
1. Start by addressing the user by name
2. Clearly state both zodiac signs
3. Highlight 3 key compatibility points
4. Mention any challenging aspects
5. Keep response under 300 words
6. Use simple, compassionate language
7. End with an encouraging note

User Details:
- Name: ${f.yourName}
- Zodiac: ${astrologyData.zodiacSigns.user || 'Unknown'}

${f.partnerName ? `
Partner Details:
- Name: ${f.partnerName}
- Zodiac: ${astrologyData.zodiacSigns.partner || 'Unknown'}
` : ''}

Key Compatibility Factors:
${astrologyData.compatibility.zodiac ? astrologyData.compatibility.zodiac.compatibility_report : 'No compatibility data available'}

User Question: "${message}"
`.trim();

    const messagesForAI = [
      { role: "system", content: systemContent },
      ...chat.messages.slice(-2).map(msg => ({
        role: msg.sender === "user" ? "user" : "assistant",
        content: msg.text.length > 300 ? msg.text.substring(0, 300) + '...' : msg.text
      }))
    ];

    // 7. Call GPT-4 with careful token management
    console.log('[OpenAI] Creating optimized response...');
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: messagesForAI,
      temperature: 0.7,
      max_tokens: 300
    });

    let formattedResponse = completion.choices[0].message.content;
    
    // Add disclaimer if using calculated compatibility
    if (astrologyData.compatibility.zodiac?.source === 'calculated') {
      formattedResponse += "\n\nNote: This analysis was calculated from your planetary positions rather than a full compatibility report.";
    }

    // 8. Save and return response
    chat.messages.push({ 
      sender: "ai", 
      text: formattedResponse,
      metadata: {
        zodiacSigns: {
          user: astrologyData.zodiacSigns.user,
          partner: astrologyData.zodiacSigns.partner
        }
      }
    });
    await chat.save();

    return res.status(200).json({
      success: true,
      reply: formattedResponse,
      messages: chat.messages
    });

  } catch (err) {
    console.error('[Error] Details:', err);
    
    const fallbackText = `Dear ${f.yourName}, I'm having trouble analyzing your chart right now. ` +
      `Please try again later or provide more complete birth information.`;
    
    chat.messages.push({ sender: "ai", text: fallbackText });
    await chat.save();
    
    return res.status(200).json({
      success: true,
      reply: fallbackText,
      messages: chat.messages
    });
  }
}

// Helper Functions
function getSignFromDate(dateString) {
  const date = new Date(dateString);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  
  if ((month === 3 && day >= 21) || (month === 4 && day <= 19)) return 'Aries';
  if ((month === 4 && day >= 20) || (month === 5 && day <= 20)) return 'Taurus';
  if ((month === 5 && day >= 21) || (month === 6 && day <= 20)) return 'Gemini';
  if ((month === 6 && day >= 21) || (month === 7 && day <= 22)) return 'Cancer';
  if ((month === 7 && day >= 23) || (month === 8 && day <= 22)) return 'Leo';
  if ((month === 8 && day >= 23) || (month === 9 && day <= 22)) return 'Virgo';
  if ((month === 9 && day >= 23) || (month === 10 && day <= 22)) return 'Libra';
  if ((month === 10 && day >= 23) || (month === 11 && day <= 21)) return 'Scorpio';
  if ((month === 11 && day >= 22) || (month === 12 && day <= 21)) return 'Sagittarius';
  if ((month === 12 && day >= 22) || (month === 1 && day <= 19)) return 'Capricorn';
  if ((month === 1 && day >= 20) || (month === 2 && day <= 18)) return 'Aquarius';
  if ((month === 2 && day >= 19) || (month === 3 && day <= 20)) return 'Pisces';
  return null;
}

async function generateCompatibilityFromCharts(userPlanets, partnerPlanets, userSign, partnerSign) {
  // This would analyze planetary aspects between the two charts
  let report = `Compatibility Analysis for ${userSign} and ${partnerSign}:\n\n`;
  
  // Sun Sign Compatibility
  report += `Sun Signs (Core Personality):\n`;
  report += `${userSign} and ${partnerSign} ${getSunCompatibility(userSign, partnerSign)}\n\n`;
  
  // Moon Sign Compatibility
  if (userPlanets.moon && partnerPlanets.moon) {
    report += `Moon Signs (Emotional Needs):\n`;
    report += `${userPlanets.moon.sign} and ${partnerPlanets.moon.sign} ${getMoonCompatibility(userPlanets.moon.sign, partnerPlanets.moon.sign)}\n\n`;
  }
  
  // Venus-Mars Aspects
  if (userPlanets.venus && partnerPlanets.mars) {
    report += `Romantic Chemistry:\n`;
    report += `Venus in ${userPlanets.venus.sign} with Mars in ${partnerPlanets.mars.sign} ${getVenusMarsCompatibility(userPlanets.venus, partnerPlanets.mars)}\n\n`;
  }
  
  report += `Overall, this pairing shows ${getOverallCompatibility(userSign, partnerSign)} potential.`;
  
  return report;
}

function getSunCompatibility(sign1, sign2) {
  const compatibility = {
    'Pisces': {
      'Cancer': 'have excellent compatibility as both are water signs, creating deep emotional understanding',
      // [Add other sign combinations...]
    }
    // [Add other signs...]
  };
  return compatibility[sign1]?.[sign2] || 'show interesting potential that requires understanding and compromise';
}

// Helper function to format planet data for prompt
function formatEssentialPlanetDataForPrompt(planetaryData, prefix = '') {
  if (!planetaryData || Object.keys(planetaryData).length === 0) {
    return `${prefix}: No planetary data available`;
  }
  
  return Object.entries(planetaryData)
    .map(([planet, data]) => 
      `${prefix} ${planet.toUpperCase()}: ${data.sign} (House ${data.house || 'N/A'}) at ${data.degree}°` +
      `${data.retrograde ? ' (Retrograde)' : ''}`
    )
    .join('\n');
}

// Helper function to generate basic compatibility when API fails
function generateBasicCompatibility(userSign, partnerSign) {
  if (!userSign || !partnerSign) return 'Insufficient data for compatibility analysis';
  
  const compatibilityKeywords = {
    'Aries': { good: ['Leo', 'Sagittarius', 'Gemini'], challenging: ['Cancer', 'Capricorn'] },
    'Taurus': { good: ['Virgo', 'Capricorn', 'Cancer'], challenging: ['Leo', 'Aquarius'] },
    // Add all other signs...
    'Pisces': { good: ['Cancer', 'Scorpio', 'Taurus'], challenging: ['Gemini', 'Sagittarius'] }
  };
  
  const userCompat = compatibilityKeywords[userSign] || {};
  const compatibility = userCompat.good?.includes(partnerSign) ? 'good' :
                       userCompat.challenging?.includes(partnerSign) ? 'challenging' : 'neutral';
  
  return `Basic compatibility between ${userSign} and ${partnerSign} shows ${compatibility} potential. ` +
         `For deeper insights, a full birth chart analysis is recommended.`;
}

// Helper function to get active data sources
function getActiveDataSources(astrologyData) {
  const sources = [];
  
  if (astrologyData.userChart) sources.push('Western Chart');
  if (astrologyData.planetaryData.user) sources.push('Planetary Positions');
  
  if (astrologyData.compatibility.zodiac) sources.push('Zodiac Compatibility');
  if (astrologyData.partnerChart) sources.push('Partner Chart');
  
  sources.push('GPT-4 Formatting');
  return sources;
}
// Helper function to format essential planet data concisely
function formatEssentialPlanetData(planetaryData) {
  if (!planetaryData) return 'No planetary data available';
  
  return Object.entries(planetaryData)
    .map(([planet, data]) => 
      `• ${planet.toUpperCase()}: ${data.sign} (House ${data.house || 'N/A'})`
    )
    .join('\n');
}

// Helper function to format planet data
function formatPlanetData(planetaryData, reports) {
  return Object.entries(planetaryData).map(([planet, data]) => {
    const report = reports[planet] ? 
      `\n  - ${reports[planet].report || JSON.stringify(reports[planet])}` : '';
    return `• ${planet.charAt(0).toUpperCase() + planet.slice(1)}: 
  - Sign: ${data.sign} 
  - House: ${data.house || 'N/A'}
  - Degree: ${data.degree}°${report}`;
  }).join('\n');
}

// Helper function to get active data sources
function getActiveDataSources(astrologyData) {
  const sources = [];
  
  if (astrologyData.userChart) sources.push('Western Chart');
  if (astrologyData.planetaryData.user) sources.push('Planetary Positions');
  
  if (astrologyData.compatibility.romantic) sources.push('Romantic Profile');
  if (astrologyData.compatibility.zodiac) sources.push('Zodiac Compatibility');
  if (astrologyData.compatibility.matchMaking) sources.push('Match Making');
  if (astrologyData.compatibility.synastry) sources.push('Synastry Report');
  
  sources.push('GPT-4 Formatting');
  return sources;
}

 if (type === "Numerology") {
  try {
    console.log('[Numerology] Starting process for:', f.yourName, f.birthDate);

    // 1. Validate name and date
    const nameRegex = /^[a-zA-Z\s]+$/;
    if (!f.yourName || !nameRegex.test(f.yourName.trim())) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid name (letters only).'
      });
    }

    if (!f.birthDate || isNaN(new Date(f.birthDate))) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or missing birth date'
      });
    }

    f.yourName = f.yourName.trim().replace(/\s+/g, ' ');

    // 2. Calculate numerology values
    const numerologyData = calculateManualNumbers(f.yourName, f.birthDate);
console.log('[ManualCalculation] Numerology data:', numerologyData);

    // 3. Handle basic info/profile request
    const lowerMessage = message.toLowerCase().trim();
    if (
      lowerMessage.includes('my info') ||
      lowerMessage.includes('my profile') ||
      lowerMessage.includes('numerology profile')
    ) {
      const profileResponse = `
🔮 Your Numerology Profile:
• Life Path Number: ${numerologyData.lifePath}
• Soul Urge Number: ${numerologyData.soulUrge}
• Personality Number: ${numerologyData.personality}
• Expression Number: ${numerologyData.expression}
${numerologyData.karmicLessons?.length ? `• Karmic Lessons: ${numerologyData.karmicLessons.join(', ')}` : ''}
${numerologyData.challenges?.length ? `• Challenges: ${formatChallenges(numerologyData.challenges)}` : ''}

You can now ask: "What does my Life Path number mean?" or "Why is my Soul Urge number 6?"
Chat with Numara for deeper readings — first minute free.
      `.trim();

      chat.messages.push({ sender: "ai", text: profileResponse, metadata: { numerologyData } });
      await chat.save();

      return res.status(200).json({
        success: true,
        reply: profileResponse,
        messages: chat.messages,
        numerologyData: {
          ...numerologyData,
          source: 'ManualCalculation'
        }
      });
    }

    // 4. Let GPT answer based on numerologyData + current message
    const systemPrompt = `
You are Numara, a professional numerologist. Analyze the user's numerology profile and respond to their question using ONLY the information below.

Client Name: ${f.yourName}
Birth Date: ${f.birthDate}

🔢 Core Numbers:
- Life Path: ${numerologyData.lifePath}
- Soul Urge: ${numerologyData.soulUrge}
- Personality: ${numerologyData.personality}
- Expression: ${numerologyData.expression}
${numerologyData.karmicLessons?.length ? `- Karmic Lessons: ${numerologyData.karmicLessons.join(', ')}` : ''}
${numerologyData.challenges?.length ? `- Challenges: ${formatChallenges(numerologyData.challenges)}` : ''}

💬 User's Message: "${message}"

Respond clearly, professionally, and in a helpful tone. Avoid repeating the profile unless asked. Keep it under 350 words.
    `.trim();

    const messagesForAI = [
      { role: "system", content: systemPrompt },
      { role: "user", content: message }
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: messagesForAI,
      temperature: 0.6,
      max_tokens: 400
    });

    const aiText = completion.choices[0].message.content;

    // 5. Save and respond
    chat.messages.push({ sender: "ai", text: aiText, metadata: { numerologyData } });
    await chat.save();

    return res.status(200).json({
      success: true,
      reply: aiText,
      messages: chat.messages,
      numerologyData: {
        ...numerologyData,
        source: 'ManualCalculation + GPT-4'
      }
    });

  } catch (err) {
    console.error('[Numerology Error]', {
      message: err.message,
      stack: err.stack,
      response: err.response?.data
    });

    const fallbackText = `🔮 Numerology Insight for ${f.yourName || 'you'}:\nWe’re preparing your reading. Please ask your question to begin.\n\nChat with Numara for detailed guidance — first minute free.`;

    chat.messages.push({ sender: "ai", text: fallbackText });
    await chat.save();

    return res.status(200).json({
      success: true,
      reply: fallbackText,
      messages: chat.messages
    });
  }
}


// Helper functions
function formatChallenges(challenges) {
  if (!challenges) return '';
  if (typeof challenges === 'object') {
    return Object.entries(challenges)
      .map(([key, value]) => `${key}: ${value}`)
      .join(', ');
  }
  return challenges.toString();
}

function calculateManualNumbers(name, birthDate) {
  return {
    lifePath: calculateLifePathNumber(birthDate),
    soulUrge: calculateSoulUrgeNumber(name),
    personality: calculatePersonalityNumber(name),
    expression: calculateExpressionNumber(name),
    challenges: calculateChallengeNumbers(birthDate),
    karmicLessons: calculateKarmicLessons(name)
  };
}


function getNumberValue(data, possibleKeys) {
  if (!data) return null;
  for (const key of possibleKeys) {
    if (data[key] !== undefined) return data[key];
  }
  return null;
}

function calculateManualNumbers(name, birthDate) {
  return {
    lifePath: calculateLifePathNumber(birthDate),
    soulUrge: calculateSoulUrgeNumber(name),
    personality: calculatePersonalityNumber(name),
    expression: calculateExpressionNumber(name),
    challenges: calculateChallengeNumbers(birthDate),
    karmicLessons: calculateKarmicLessons(name)
  };
}

function calculateLifePathNumber(birthDate) {
  const date = new Date(birthDate);
  let day = date.getDate();
  let month = date.getMonth() + 1;
  let year = date.getFullYear();

  day = reduceToSingleDigit(day);
  month = reduceToSingleDigit(month);
  year = reduceToSingleDigit(year);

  return reduceToSingleDigit(day + month + year);
}

function calculateExpressionNumber(name) {
  const letterValues = {
    'a': 1, 'j': 1, 's': 1,
    'b': 2, 'k': 2, 't': 2,
    'c': 3, 'l': 3, 'u': 3,
    'd': 4, 'm': 4, 'v': 4,
    'e': 5, 'n': 5, 'w': 5,
    'f': 6, 'o': 6, 'x': 6,
    'g': 7, 'p': 7, 'y': 7,
    'h': 8, 'q': 8, 'z': 8,
    'i': 9, 'r': 9
  };

  let sum = 0;
  name.toLowerCase().split('').forEach(char => {
    if (letterValues[char]) sum += letterValues[char];
  });

  return reduceToSingleDigit(sum);
}

function calculateSoulUrgeNumber(name) {
  const vowelValues = { 'a': 1, 'e': 5, 'i': 9, 'o': 6, 'u': 3 };
  let sum = 0;
  
  name.toLowerCase().split('').forEach(char => {
    if (vowelValues[char]) sum += vowelValues[char];
  });

  return reduceToSingleDigit(sum);
}

function calculatePersonalityNumber(name) {
  const consonantValues = {
    'b': 2, 'c': 3, 'd': 4, 'f': 6, 'g': 7, 
    'h': 8, 'j': 1, 'k': 2, 'l': 3, 'm': 4,
    'n': 5, 'p': 7, 'q': 8, 'r': 9, 's': 1,
    't': 2, 'v': 4, 'w': 5, 'x': 6, 'y': 7, 'z': 8
  };
  
  let sum = 0;
  name.toLowerCase().split('').forEach(char => {
    if (consonantValues[char]) sum += consonantValues[char];
  });

  return reduceToSingleDigit(sum);
}

function calculateChallengeNumbers(birthDate) {
  const date = new Date(birthDate);
  const day = reduceToSingleDigit(date.getDate());
  const month = reduceToSingleDigit(date.getMonth() + 1);
  const year = reduceToSingleDigit(date.getFullYear());
  
  return {
    firstChallenge: Math.abs(month - day),
    secondChallenge: Math.abs(day - year),
    thirdChallenge: Math.abs(month - year),
    fourthChallenge: Math.abs(month - day - year)
  };
}

function calculateKarmicLessons(name) {
  const allNumbers = [1,2,3,4,5,6,7,8,9];
  const presentNumbers = new Set();
  
  name.toLowerCase().split('').forEach(char => {
    if (char.match(/[a-z]/)) {
      const num = char.charCodeAt(0) - 96;
      presentNumbers.add(reduceToSingleDigit(num));
    }
  });

  return allNumbers.filter(num => !presentNumbers.has(num));
}

function reduceToSingleDigit(num) {
  if (num === 11 || num === 22) return num; // Master numbers
  
  while (num > 9) {
    num = num.toString().split('').reduce((sum, digit) => sum + parseInt(digit), 0);
  }
  
  return num;
}



 if (type === "Tarot") {
  try {
    console.log('[Tarot] Starting Tarot reading...');
    
    const tarotSystemPrompt = `
You are Mystara, a deeply intuitive Tarot reader. The user is seeking guidance through the Tarot.

Respond with a spiritual and empowering message. You may pull imaginary cards like The Lovers, The Tower, The Star, etc., and interpret them for the user. Guide them with insight and compassion.
`.trim();

    const messagesForAI = [
      { role: "system", content: tarotSystemPrompt },
      ...chat.messages.map(msg => ({
        role: msg.sender === "user" ? "user" : "assistant",
        content: msg.text
      }))
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: messagesForAI,
      temperature: 0.8
    });

    const aiText = completion.choices[0].message.content;
    chat.messages.push({ sender: "ai", text: aiText });
    await chat.save();

    return res.status(200).json({
      success: true,
      reply: aiText,
      messages: chat.messages,
      source: "GPT-4 Tarot"
    });

  } catch (err) {
    console.error("[Tarot Error]", {
      message: err.message,
      stack: err.stack
    });

    const fallback = `🔮 Mystara here... I feel a strong energy around your question. Let's begin your Tarot reading now. Ask what’s on your heart.`;
    chat.messages.push({ sender: "ai", text: fallback });
    await chat.save();

    return res.status(200).json({
      success: true,
      reply: fallback,
      messages: chat.messages,
      source: "Tarot fallback"
    });
  }
}


  } catch (err) {
    console.error("Chat Error:", err?.response?.data || err.message || err);
    res.status(500).json({ success: false, message: "Internal server error", error: err.message });
  }
};



const getChatHistory = async (req, res) => {
  try {
    const userId = req.user._id;
    const { psychicId } = req.params;

    // ✅ 1. Find psychic and its type
    const psychic = await AiPsychic.findById(psychicId);
    if (!psychic) {
      return res.status(404).json({ success: false, message: "Psychic not found" });
    }

    const { type } = psychic;

    // ✅ 2. Get required fields for that type
    const requiredFields = getRequiredFieldsByType(type);
let form = null;
let f = {};

if (type !== "Tarot") {
  const requiredFields = getRequiredFieldsByType(type);
  form = await AiFormData.findOne({ userId, type });

  if (!form?.formData) {
    return res.status(400).json({ 
      success: false, 
      message: `Please fill the required ${type} form.` 
    });
  }

  f = form.formData;
  const missingFields = requiredFields.filter(field => !f[field]);

  if (missingFields.length > 0) {
    return res.status(400).json({ 
      success: false, 
      message: `Missing fields: ${missingFields.join(", ")}` 
    });
  }
}

    // ✅ 3. If form is required, fetch it by userId and type
    let formData = null;
    if (requiredFields.length > 0) {
      const form = await AiFormData.findOne({ userId, type });
      if (form?.formData) {
        formData = {};
        requiredFields.forEach((field) => {
          formData[field] = form.formData[field] || "N/A";
        });
      }
    }

    // ✅ 4. Get chat history
    const chat = await ChatMessage.findOne({ userId, psychicId });

    return res.status(200).json({
      success: true,
      messages: chat?.messages.map(msg => ({
        ...msg.toObject(),
        id: msg._id,
        createdAt: msg.createdAt || new Date(),
      })) || [],
      formData: formData || null, // include form data if present
      psychicType: type,
    });

  } catch (error) {
    console.error("Error fetching chat history:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};


// controllers/chatController.js






// controllers/chatController.js
const getAllUserChats = async (req, res) => {
  try {
    const chats = await ChatMessage.find()
      .populate("userId", "username image")       // Populate user fields
      .populate("psychicId", "name image")        // Populate advisor fields
      .sort({ createdAt: -1 });

    const formatted = chats.map(chat => ({
      id: chat._id,
      user: chat.userId,
      advisor: chat.psychicId,
      credits: Math.floor(Math.random() * 200 + 20), // Dummy credits for now
      createdAt: chat.createdAt
    }));

    res.status(200).json({ success: true, chats: formatted });
  } catch (error) {
    console.error("❌ getAllUserChats error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch chats" });
  }
};
const getChatMessagesById = async (req, res) => {
  try {
    const chatId = req.params.chatId;

    const chat = await ChatMessage.findById(chatId)
      .populate("userId", "username image")
      .populate("psychicId", "name image");

    if (!chat) {
      return res.status(404).json({ success: false, message: "Chat not found" });
    }

    res.status(200).json({
      success: true,
      chat: {
        id: chat._id,
        user: {
          id: chat.userId._id,
          username: chat.userId.username,
          image: chat.userId.image,
        },
        advisor: {
          id: chat.psychicId._id,
          name: chat.psychicId.name,
          image: chat.psychicId.image,
        },
        messages: chat.messages.map(msg => ({
          id: msg._id,
          sender: msg.sender, // 'user' or 'ai'
          text: msg.text,
          timestamp: msg.timestamp,
        })),
      },
    });
  } catch (error) {
    console.error("❌ getChatMessagesById error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

module.exports = {
  chatWithPsychic,
  getAllUserChats,
  getChatHistory,
  getChatMessagesById
};
