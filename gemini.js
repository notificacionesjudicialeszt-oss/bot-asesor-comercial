// ============================================
// gemini.js — Sistema de Rotación de API Keys + Wrapper Gemini
// Migrado al SDK nuevo @google/genai para soporte de thinkingConfig
// ============================================
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
let geminiKeyIndex = 0;
let ai = new GoogleGenAI({ apiKey: GEMINI_KEYS[0] });

// Safety settings para el SDK nuevo (strings, no enums)
const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
];

console.log(`[GEMINI] 🔑 ${GEMINI_KEYS.length} API key(s) cargadas — activa: #1 (SDK: @google/genai)`);

/**
 * Rota a la siguiente API key de Gemini.
 * Se llama automáticamente en caso de error 429 (quota exceeded).
 * @param {string} reason - Razón de la rotación (para logging)
 * @returns {boolean} true si se pudo rotar, false si solo hay 1 key
 */
function rotateGeminiKey(reason = '') {
  if (GEMINI_KEYS.length <= 1) {
    console.error('[GEMINI] ⚠️ Solo hay 1 API key — no se puede rotar. Agrega más keys a GEMINI_API_KEYS en .env');
    return false;
  }
  const oldIndex = geminiKeyIndex;
  geminiKeyIndex = (geminiKeyIndex + 1) % GEMINI_KEYS.length;
  ai = new GoogleGenAI({ apiKey: GEMINI_KEYS[geminiKeyIndex] });
  console.log(`[GEMINI] 🔄 Rotación de API key: #${oldIndex + 1} → #${geminiKeyIndex + 1} ${reason ? '(' + reason + ')' : ''}`);
  return true;
}

/**
 * Wrapper para llamadas a Gemini con rotación automática de keys en caso de 429.
 * Compatible con la API anterior: devuelve { response: { text: () => string } }
 * 
 * @param {string} modelName - Nombre del modelo (ej: 'gemini-3.1-pro-preview')
 * @param {any} content - Contenido para generateContent (string, array, o array con inlineData)
 * @param {object} options - Opciones adicionales (opcional)
 * @returns {object} Resultado con .response.text() para retrocompatibilidad
 */
const FALLBACK_MODEL = 'gemini-2.5-flash';

async function _callGemini(modelName, content, options = {}) {
  // thinkingLevel solo para Gemini 3.x
  // thinkingBudget: -1 (dinámico) para Gemini 2.5-pro
  // gemini-2.5-flash NO soporta thinking
  let thinkingCfg = {};
  if (modelName.includes('gemini-3')) {
    thinkingCfg = { thinkingConfig: { thinkingLevel: 'HIGH' } };
  } else if (modelName.includes('gemini-2.5-pro')) {
    thinkingCfg = { thinkingConfig: { thinkingBudget: -1 } };
  }

  const result = await ai.models.generateContent({
    model: modelName,
    contents: content,
    config: {
      safetySettings: SAFETY_SETTINGS,
      ...thinkingCfg,
      ...(options.generationConfig || {}),
      ...(options.config || {})
    }
  });

  const responseText = result.text || '';
  return {
    response: { text: () => responseText },
    _raw: result
  };
}

async function geminiGenerate(modelName, content, options = {}) {
  let lastError;
  const maxRetries = GEMINI_KEYS.length;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await _callGemini(modelName, content, options);
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
        console.error(`[GEMINI] ❌ PROHIBITED_CONTENT en todas las keys`);
        throw err;
      } else {
        break; // Salir del loop para intentar fallback
      }
    }
  }

  // FALLBACK: Si todas las keys fallaron con 429 y el modelo es Pro, caer a Flash
  const is429 = lastError && lastError.message && (lastError.message.includes('429') || lastError.message.includes('quota'));
  if (is429 && modelName !== FALLBACK_MODEL && modelName.includes('pro')) {
    console.warn(`[GEMINI] 🔄 FALLBACK: ${modelName} agotado en todas las keys → usando ${FALLBACK_MODEL}`);
    try {
      return await _callGemini(FALLBACK_MODEL, content, options);
    } catch (fbErr) {
      console.error(`[GEMINI] ❌ Fallback a ${FALLBACK_MODEL} también falló:`, fbErr.message?.substring(0, 100));
      throw fbErr;
    }
  }

  throw lastError;
}

/**
 * Crear un chat con historial (reemplazo de model.startChat del SDK viejo).
 * Devuelve un objeto chat con .sendMessage() que retorna { response: { text: () => string } }
 * 
 * @param {string} modelName - Nombre del modelo
 * @param {object} options - Opciones: { systemInstruction, history, safetySettings, thinkingConfig }
 * @returns {object} Chat object con .sendMessage(message)
 */
function createChat(modelName, options = {}) {
  const { systemInstruction, history = [], thinkingConfig } = options;

  // Convertir historial del formato viejo (parts: [{text}]) al nuevo (text simple)
  const convertedHistory = history.map(h => ({
    role: h.role,
    parts: h.parts || [{ text: h.text || '' }]
  }));

  // Helper para construir userParts desde string o array multimodal
  function buildUserParts(message) {
    if (typeof message === 'string') return [{ text: message }];
    if (Array.isArray(message)) {
      return message.map(part => typeof part === 'string' ? { text: part } : part);
    }
    return [message];
  }

  // Helper para hacer la llamada a un modelo específico
  async function callModel(model, userParts) {
    let thinkCfg = undefined;
    if (model.includes('gemini-3')) {
      thinkCfg = thinkingConfig || { thinkingLevel: 'HIGH' };
    } else if (model.includes('gemini-2.5-pro')) {
      thinkCfg = thinkingConfig || { thinkingBudget: -1 };
    }

    const result = await ai.models.generateContent({
      model: model,
      contents: [
        ...convertedHistory,
        { role: 'user', parts: userParts }
      ],
      config: {
        systemInstruction: systemInstruction || undefined,
        safetySettings: SAFETY_SETTINGS,
        ...(thinkCfg ? { thinkingConfig: thinkCfg } : {}),
      }
    });

    return {
      response: { text: () => result.text || '' },
      _raw: result
    };
  }

  return {
    sendMessage: async (message) => {
      const userParts = buildUserParts(message);

      // Intentar con todas las keys
      let lastErr;
      for (let attempt = 0; attempt < GEMINI_KEYS.length; attempt++) {
        try {
          return await callModel(modelName, userParts);
        } catch (err) {
          lastErr = err;
          const is429 = err.message && (err.message.includes('429') || err.message.includes('quota'));
          if (is429 && attempt < GEMINI_KEYS.length - 1) {
            console.warn(`[GEMINI] ⚠️ Key #${geminiKeyIndex + 1} agotada en chat → rotando...`);
            rotateGeminiKey('429 in chat');
            await new Promise(r => setTimeout(r, 500));
          } else {
            break;
          }
        }
      }

      // FALLBACK: Si Pro agotado, caer a Flash
      const is429 = lastErr && lastErr.message && (lastErr.message.includes('429') || lastErr.message.includes('quota'));
      if (is429 && modelName !== FALLBACK_MODEL && modelName.includes('pro')) {
        console.warn(`[GEMINI] 🔄 FALLBACK CHAT: ${modelName} → ${FALLBACK_MODEL}`);
        return await callModel(FALLBACK_MODEL, userParts);
      }

      throw lastErr;
    }
  };
}

// Retrocompatibilidad: getGenAI() — exponer un objeto con getGenerativeModel
// que internamente usa createChat
function getGenAICompat() {
  return {
    getGenerativeModel: (opts) => {
      const modelName = opts.model || 'gemini-3.1-pro-preview';
      const systemInstruction = opts.systemInstruction || '';
      const thinkingConfig = opts.generationConfig?.thinkingConfig || { thinkingLevel: 'HIGH' };
      return {
        startChat: (chatOpts = {}) => {
          return createChat(modelName, {
            systemInstruction,
            history: chatOpts.history || [],
            thinkingConfig
          });
        },
        generateContent: async (content) => {
          return await geminiGenerate(modelName, content);
        }
      };
    }
  };
}

module.exports = {
  geminiGenerate,
  SAFETY_SETTINGS,
  genAI: getGenAICompat,
  geminiPro: () => getGenAICompat().getGenerativeModel({ model: 'gemini-3.1-pro-preview' }),
  rotateGeminiKey,
  createChat,
  runDiagnostic
};

/**
 * Autodiagnóstico de Gemini — se ejecuta al arrancar el bot.
 * Verifica: API key funcional, modelo disponible, thinking activo.
 * Si algo falla, log con WARNING visible para Álvaro.
 */
async function runDiagnostic() {
  console.log('\n[DIAGNÓSTICO] 🏥 Verificando estado de Gemini...');
  const checks = [];

  // 1. Verificar que hay API keys
  if (GEMINI_KEYS.length === 0) {
    console.error('[DIAGNÓSTICO] ❌ NO HAY API KEYS CONFIGURADAS — el bot no podrá responder');
    return;
  }
  checks.push(`✅ ${GEMINI_KEYS.length} API key(s) cargadas`);

  // 2. Verificar SDK correcto
  try {
    const pkg = require('@google/genai/package.json');
    checks.push(`✅ SDK: @google/genai v${pkg.version} (nuevo, soporta thinking)`);
  } catch (e) {
    checks.push(`⚠️ No se pudo verificar versión del SDK`);
  }

  // 3. Hacer una llamada real con thinking para verificar que funciona
  try {
    const testResult = await ai.models.generateContent({
      model: 'gemini-3.1-pro-preview',
      contents: 'Responde SOLO con la palabra "OK". Nada más.',
      config: {
        thinkingConfig: { thinkingLevel: 'HIGH' },
        safetySettings: SAFETY_SETTINGS,
      }
    });

    const responseText = testResult.text || '';
    
    // Verificar si hubo pensamiento extendido en la respuesta
    const candidates = testResult.candidates || [];
    const parts = candidates[0]?.content?.parts || [];
    const hasThought = parts.some(p => p.thought === true);

    if (hasThought) {
      checks.push(`✅ Pensamiento extendido: ACTIVO (thinkingLevel: HIGH) — el bot PIENSA antes de responder`);
    } else if (responseText) {
      checks.push(`⚠️ Pensamiento extendido: respuesta OK pero no se detectó thought (puede ser normal en respuestas cortas)`);
    } else {
      checks.push(`❌ Pensamiento extendido: respuesta VACÍA — revisar configuración`);
    }

    checks.push(`✅ Modelo gemini-3.1-pro-preview: OPERATIVO`);
    checks.push(`✅ API key #1: FUNCIONAL`);
  } catch (e) {
    const msg = e.message || '';
    if (msg.includes('429') || msg.includes('quota')) {
      checks.push(`⚠️ API key #1 agotada (429) — rotación automática activa`);
    } else {
      checks.push(`❌ Error contactando Gemini: ${msg.substring(0, 100)}`);
    }
  }

  // 4. Mostrar resultado
  console.log('[DIAGNÓSTICO] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  checks.forEach(c => console.log(`[DIAGNÓSTICO]   ${c}`));
  console.log('[DIAGNÓSTICO] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}
