// ============================================
// gemini.js — Sistema de Rotación de API Keys + Wrapper Gemini
// ============================================
require('dotenv').config();
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
let geminiKeyIndex = 0;
let genAI = new GoogleGenerativeAI(GEMINI_KEYS[0]);

// Desactivar TODOS los filtros de seguridad — negocio legal de armas traumáticas
const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.BLOCK_NONE },
];

let geminiPro = genAI.getGenerativeModel({ model: 'gemini-3.1-pro-preview', safetySettings: SAFETY_SETTINGS });

console.log(`[GEMINI] 🔑 ${GEMINI_KEYS.length} API key(s) cargadas — activa: #1`);

function rotateGeminiKey(reason = '') {
  if (GEMINI_KEYS.length <= 1) {
    console.error('[GEMINI] ⚠️ Solo hay 1 API key — no se puede rotar. Agrega más keys a GEMINI_API_KEYS en .env');
    return false;
  }
  const oldIndex = geminiKeyIndex;
  geminiKeyIndex = (geminiKeyIndex + 1) % GEMINI_KEYS.length;
  genAI = new GoogleGenerativeAI(GEMINI_KEYS[geminiKeyIndex]);
  geminiPro = genAI.getGenerativeModel({ model: 'gemini-3.1-pro-preview', safetySettings: SAFETY_SETTINGS });
  console.log(`[GEMINI] 🔄 Rotación de API key: #${oldIndex + 1} → #${geminiKeyIndex + 1} ${reason ? '(' + reason + ')' : ''}`);
  return true;
}

/**
 * Wrapper para llamadas a Gemini con rotación automática de keys en caso de 429.
 * Uso: const result = await geminiGenerate(model, content, options);
 * @param {string} modelName - Nombre del modelo (ej: 'gemini-2.5-flash')
 * @param {any} content - Contenido para generateContent
 * @param {object} options - Opciones adicionales del modelo (opcional)
 * @returns {object} Resultado de generateContent
 */
async function geminiGenerate(modelName, content, options = {}) {
  let lastError;
  const maxRetries = GEMINI_KEYS.length;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName, safetySettings: SAFETY_SETTINGS, ...options });
      const result = await model.generateContent(content);
      return result;
    } catch (err) {
      lastError = err;
      const is429 = err.message && (err.message.includes('429') || err.message.includes('quota') || err.message.includes('Too Many Requests'));
      const isProhibited = err.message && err.message.includes('PROHIBITED_CONTENT');

      if ((is429 || isProhibited) && attempt < maxRetries - 1) {
        if (is429) console.warn(`[GEMINI] ⚠️ Key #${geminiKeyIndex + 1} agotada (429) — rotando...`);
        if (isProhibited) console.warn(`[GEMINI] ⚠️ Contenido bloqueado (PROHIBITED_CONTENT) con key #${geminiKeyIndex + 1} — rotando key...`);
        rotateGeminiKey(is429 ? '429 quota exceeded' : 'prohibited_content');
        await new Promise(r => setTimeout(r, 1000));
      } else if (isProhibited) {
        console.error(`[GEMINI] ❌ PROHIBITED_CONTENT en todas las keys — revisar safetySettings o el prompt`);
        throw err;
      } else {
        throw err;
      }
    }
  }
  throw lastError;
}

module.exports = { geminiGenerate, SAFETY_SETTINGS, genAI: () => genAI, geminiPro: () => geminiPro, rotateGeminiKey };
