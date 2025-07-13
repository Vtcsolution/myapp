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

// ❤️ Love Psychic (Amoura) - Strict Package Compliance
else if (type === "Love") {
  try {
    console.log('[Love Psychic] Starting love reading process...');
    
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

    // 2. Validate required fields for astrological reading
    const requiredFields = ['yourName', 'yourBirthDate', 'yourBirthTime', 'yourBirthPlace'];
    const missingFields = requiredFields.filter(field => !f[field]);
    if (missingFields.length > 0) {
      console.log('[Validation] Missing fields:', missingFields);
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missingFields.join(', ')}`
      });
    }

    // 3. Get zodiac signs (manual calculation from user form data)
    console.log('[Zodiac] Calculating signs from user form data...');
    const userSign = getSignFromDate(f.yourBirthDate) || 'Unknown';
    const partnerSign = f.partnerBirthDate ? getSignFromDate(f.partnerBirthDate) : 'Unknown';
    console.log(`[Zodiac] Signs calculated - User: ${userSign}, Partner: ${partnerSign}`);

    // 4. Get coordinates for both users
    console.log('[Geocode] Getting coordinates...');
    let userCoords, partnerCoords;
    try {
      userCoords = await getCoordinatesFromCity(f.yourBirthPlace);
      partnerCoords = f.partnerPlaceOfBirth ? await getCoordinatesFromCity(f.partnerPlaceOfBirth) : null;
      console.log(`[Geocode] Coordinates - User: ${JSON.stringify(userCoords)}, Partner: ${JSON.stringify(partnerCoords)}`);
    } catch (geoError) {
      console.warn('[Geocode] Error getting coordinates:', geoError.message);
      userCoords = { latitude: 0, longitude: 0 };
      partnerCoords = { latitude: 0, longitude: 0 };
    }

    // 5. Prepare astrology data payloads
    const buildPayload = (dateStr, timeStr, coords) => {
      const date = new Date(dateStr);
      const [hour = 12, min = 0] = timeStr?.split(':').map(Number) || [];
      
      return {
        day: date.getDate(),
        month: date.getMonth() + 1,
        year: date.getFullYear(),
        hour: Math.min(23, Math.max(0, hour)),
        min: Math.min(59, Math.max(0, min)),
        lat: coords.latitude || 0,
        lon: coords.longitude || 0,
        tzone: 5.0
      };
    };

    const userPayload = buildPayload(f.yourBirthDate, f.yourBirthTime, userCoords);
    const partnerPayload = f.partnerBirthDate ? 
      buildPayload(f.partnerBirthDate, f.partnerBirthTime, partnerCoords || userCoords) : null;

    // 6. Prepare astrology data
    const astrologyData = {
      signs: { user: userSign, partner: partnerSign },
      romantic: null,
      synastry: null,
      source: 'Zodiac signs (manual calculation)'
    };

    // 7. Get romantic personality from AstrologyAPI
    console.log('[AstrologyAPI] Attempting romantic personality report...');
    try {
      const romanticRes = await axios.post(
        "https://json.astrologyapi.com/v1/romantic_personality_report/tropical",
        userPayload,
        { auth, timeout: 8000 }
      );
      
      astrologyData.romantic = romanticRes.data?.personality || romanticRes.data?.report || null;
      astrologyData.source = 'AstrologyAPI + Zodiac signs';
      console.log('[AstrologyAPI] Successfully received romantic personality data');
    } catch (err) {
      console.warn('[AstrologyAPI] Failed to get romantic personality:', err.message);
    }

    // 8. Get synastry report if partner data exists
    if (partnerPayload) {
      console.log('[AstrologyAPI] Attempting synastry report...');
      try {
        const synastryRes = await axios.post(
          "https://json.astrologyapi.com/v1/synastry_horoscope",
          {
            m_day: userPayload.day,
            m_month: userPayload.month,
            m_year: userPayload.year,
            m_hour: userPayload.hour,
            m_min: userPayload.min,
            m_lat: userPayload.lat,
            m_lon: userPayload.lon,
            m_tzone: userPayload.tzone,
            f_day: partnerPayload.day,
            f_month: partnerPayload.month,
            f_year: partnerPayload.year,
            f_hour: partnerPayload.hour,
            f_min: partnerPayload.min,
            f_lat: partnerPayload.lat,
            f_lon: partnerPayload.lon,
            f_tzone: partnerPayload.tzone
          },
          { auth, timeout: 10000 }
        );
        astrologyData.synastry = synastryRes.data?.synastry_report || null;
        if (astrologyData.synastry) {
          astrologyData.source = 'AstrologyAPI (Romantic+Synastry) + Zodiac signs';
        }
        console.log('[AstrologyAPI] Synastry report received');
      } catch (err) {
        console.warn('[AstrologyAPI] Failed to get synastry report:', err.message);
      }
    }

    // 9. Prepare OpenAI request
    console.log('[OpenAI] Preparing system message with astrology data...');
    const systemContent = `
You are Amoura, a professional love psychic. Provide insights based on:

❤️ Couple Information:
• ${f.yourName} (${userSign}) - Born ${f.yourBirthDate} in ${f.yourBirthPlace}
• ${f.partnerName || 'Partner'} (${partnerSign}) - Born ${f.partnerBirthDate || 'unknown'} in ${f.partnerPlaceOfBirth || 'unknown'}

${astrologyData.romantic ? `💖 Romantic Profile:
${astrologyData.romantic}\n` : ''}

${astrologyData.synastry ? `💫 Relationship Dynamics:
${astrologyData.synastry}\n` : ''}

Provide a detailed analysis focusing on:
1. Core compatibility based on zodiac signs (${userSign} & ${partnerSign})
2. Emotional connection patterns
3. Communication strengths and challenges
4. Recommendations for relationship growth

End with: "Start chat with Amoura for deeper love reading — first minute free."
`.trim();

    console.log('[OpenAI] System message prepared with astrology data');

    const messagesForAI = [
      { role: "system", content: systemContent },
      ...chat.messages.map(msg => ({
        role: msg.sender === "user" ? "user" : "assistant",
        content: msg.text
      }))
    ];

    // 10. Call OpenAI
    console.log('[OpenAI] Sending request to GPT-4...');
    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: messagesForAI,
      temperature: 0.7
    });

    const aiText = completion.choices[0].message.content;
    console.log('[OpenAI] Received response');
    
    // 11. Save and return response
    chat.messages.push({ sender: "ai", text: aiText });
    await chat.save();
    console.log('[Database] Chat message saved');

    console.log('[Success] Response generated with data from:', astrologyData.source);
    return res.status(200).json({
      success: true,
      reply: aiText,
      messages: chat.messages,
      astrologyData: {
        signs: astrologyData.signs,
        romantic: astrologyData.romantic ? true : false,
        synastry: astrologyData.synastry ? true : false
      },
      dataSources: astrologyData.source
    });

  } catch (err) {
    console.error('[Error] Full error details:', {
      message: err.message,
      stack: err.stack,
      response: err.response?.data
    });
    
    // Fallback with basic zodiac info
    const userSign = getSignFromDate(f.yourBirthDate) || 'Unknown';
    const fallbackText = `Hello dear ${f.yourName}! As a ${userSign}, your love profile shows...\n\nStart chat with Amoura for deeper love reading — first minute free.`;
    
    chat.messages.push({ sender: "ai", text: fallbackText });
    await chat.save();
    console.log('[Fallback] Using zodiac-only response');
    
    return res.status(200).json({
      success: true,
      reply: fallbackText,
      messages: chat.messages,
      dataSources: 'Zodiac signs (fallback mode)'
    });
  }
}
else if (type === "Numerology") {
  try {
    console.log('[Numerology] Starting process for:', f.yourName, f.birthDate);
    
    // 1. Validate required fields
    if (!f.yourName || !f.birthDate) {
      return res.status(400).json({
        success: false,
        message: 'Missing name or birth date'
      });
    }

    // 2. Calculate numbers manually (since API endpoints are returning 404)
    const numerologyData = calculateManualNumbers(f.yourName, f.birthDate);
    
    // 3. Handle "my info" request
    const lowerMessage = message.toLowerCase().trim();
    if (lowerMessage.includes('my info') || lowerMessage.includes('profile')) {
      const profileResponse = `
🔮 Your Numerology Profile:
• Life Path Number: ${numerologyData.lifePath}
• Soul Urge Number: ${numerologyData.soulUrge}
• Personality Number: ${numerologyData.personality}
• Expression Number: ${numerologyData.expression}

Chat with Numara for detailed guidance — first minute free.
      `.trim();
      
      chat.messages.push({ sender: "ai", text: profileResponse });
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

    // 4. Prepare for GPT-4 analysis when chat starts
    const systemContent = `
You are Numara, a professional numerologist. Analyze this profile:

🧑 Client: ${f.yourName}
📅 Born: ${f.birthDate}

🔢 Core Numbers:
1. Life Path ${numerologyData.lifePath} - Destiny path
2. Soul Urge ${numerologyData.soulUrge} - Inner desires
3. Personality ${numerologyData.personality} - Outer persona
4. Expression ${numerologyData.expression} - Life purpose

${numerologyData.challenges ? `⚡ Challenges: ${formatChallenges(numerologyData.challenges)}\n` : ''}
${numerologyData.karmicLessons ? `🌀 Karmic Lessons: ${numerologyData.karmicLessons.join(', ')}\n` : ''}

Provide a concise 4-part reading:
1. Life Path meaning
2. Soul's deepest desires
3. How others perceive you
4. Your life purpose

Close with: "Chat with Numara for detailed guidance — first minute free."
    `.trim();

    const messagesForAI = [
      { role: "system", content: systemContent },
      { role: "user", content: message }
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: messagesForAI,
      temperature: 0.7,
      max_tokens: 350
    });

    const aiText = completion.choices[0].message.content;
    chat.messages.push({ sender: "ai", text: aiText });
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
    
    const fallbackText = `🔮 Numerology Insight for ${f.yourName}:\nWe're preparing your reading. Please ask your question to begin.\n\nChat with Numara for detailed guidance — first minute free.`;
    
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