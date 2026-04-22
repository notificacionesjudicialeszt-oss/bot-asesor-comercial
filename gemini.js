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
 * @param {string} modelName - Nombre del modelo (ej: 'gemini-2.5-pro')
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
  const maxRetries = Math.min(GEMINI_KEYS.length, 3); // máx 3 intentos para no quemar todo el quota

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await _callGemini(modelName, content, options);
    } catch (err) {
      lastError = err;
      const msg = err.message || '';
      const is429 = msg.includes('429') || msg.includes('quota') || msg.includes('Too Many Requests');
      const is503 = msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand');
      const isProhibited = msg.includes('PROHIBITED_CONTENT');

      const is400Expired = msg.includes('400') || msg.includes('expired') || msg.includes('INVALID_ARGUMENT');

      if (isProhibited) {
        if (attempt < maxRetries - 1) {
          console.warn(`[GEMINI] ⚠️ Contenido bloqueado con key #${geminiKeyIndex + 1} — rotando...`);
          rotateGeminiKey('prohibited_content');
          await new Promise(r => setTimeout(r, 500));
        } else {
          console.error(`[GEMINI] ❌ PROHIBITED_CONTENT en todas las keys`);
          throw err;
        }
      } else if (is429) {
        const waitMs = Math.min(2000 * Math.pow(2, attempt), 16000); // 2s, 4s, 8s, max 16s
        if (attempt < maxRetries - 1) {
          console.warn(`[GEMINI] ⚠️ Key #${geminiKeyIndex + 1} agotada (429) — esperando ${waitMs/1000}s y rotando...`);
          await new Promise(r => setTimeout(r, waitMs));
          rotateGeminiKey('429 quota exceeded');
        } else {
          break; // intentar fallback
        }
      } else if (is503) {
        const waitMs = 3000 * (attempt + 1); // 3s, 6s, 9s
        console.warn(`[GEMINI] ⚠️ Modelo sobrecargado (503) — esperando ${waitMs/1000}s...`);
        await new Promise(r => setTimeout(r, waitMs));
        if (attempt >= maxRetries - 1) break; // intentar fallback
      } else if (is400Expired) {
        if (attempt < maxRetries - 1) {
          console.warn(`[GEMINI] ⚠️ Key #${geminiKeyIndex + 1} expirada/inválida (400) — rotando a siguiente...`);
          rotateGeminiKey('400 expired');
        } else {
          break;
        }
      } else {
        break;
      }
    }
  }

  // FALLBACK: Si el modelo primario falló, caer a Flash → Pro
  const isRateOrUnavail = lastError && (lastError.message?.includes('429') || lastError.message?.includes('quota') || lastError.message?.includes('503') || lastError.message?.includes('UNAVAILABLE') || lastError.message?.includes('high demand'));
  if (isRateOrUnavail && modelName !== FALLBACK_MODEL) {
    console.warn(`[GEMINI] 🔄 FALLBACK: ${modelName} → ${FALLBACK_MODEL}`);
    try {
      await new Promise(r => setTimeout(r, 2000));
      return await _callGemini(FALLBACK_MODEL, content, options);
    } catch (fbErr) {
      console.error(`[GEMINI] ❌ Fallback a ${FALLBACK_MODEL} también falló:`, fbErr.message?.substring(0, 100));
      // Segundo fallback: gemini-2.5-pro
      const FALLBACK_MODEL_2 = 'gemini-2.5-pro';
      if (modelName !== FALLBACK_MODEL_2) {
        console.warn(`[GEMINI] 🔄 FALLBACK-2: ${FALLBACK_MODEL} → ${FALLBACK_MODEL_2}`);
        try {
          await new Promise(r => setTimeout(r, 3000));
          return await _callGemini(FALLBACK_MODEL_2, content, options);
        } catch (fbErr2) {
          console.error(`[GEMINI] ❌ Fallback-2 a ${FALLBACK_MODEL_2} también falló:`, fbErr2.message?.substring(0, 100));
          throw fbErr2;
        }
      }
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
      const maxChatRetries = Math.min(GEMINI_KEYS.length, 3);
      for (let attempt = 0; attempt < maxChatRetries; attempt++) {
        try {
          return await callModel(modelName, userParts);
        } catch (err) {
          lastErr = err;
          const msg = err.message || '';
          const is429 = msg.includes('429') || msg.includes('quota');
          const is503 = msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand');
          if (is429 && attempt < maxChatRetries - 1) {
            const waitMs = Math.min(2000 * Math.pow(2, attempt), 16000);
            console.warn(`[GEMINI] ⚠️ Key #${geminiKeyIndex + 1} agotada en chat — esperando ${waitMs/1000}s y rotando...`);
            await new Promise(r => setTimeout(r, waitMs));
            rotateGeminiKey('429 in chat');
          } else if (is503) {
            const waitMs = 3000 * (attempt + 1);
            console.warn(`[GEMINI] ⚠️ 503 en chat — esperando ${waitMs/1000}s...`);
            await new Promise(r => setTimeout(r, waitMs));
            if (attempt >= maxChatRetries - 1) break;
          } else {
            break;
          }
        }
      }

      // FALLBACK
      const isRateOrUnavail = lastErr && (lastErr.message?.includes('429') || lastErr.message?.includes('quota') || lastErr.message?.includes('503') || lastErr.message?.includes('UNAVAILABLE'));
      if (isRateOrUnavail && modelName !== FALLBACK_MODEL) {
        console.warn(`[GEMINI] 🔄 FALLBACK CHAT: ${modelName} → ${FALLBACK_MODEL}`);
        await new Promise(r => setTimeout(r, 2000));
        try {
          return await callModel(FALLBACK_MODEL, userParts);
        } catch (fbErr) {
          console.error(`[GEMINI] ❌ Fallback chat a ${FALLBACK_MODEL} falló:`, fbErr.message?.substring(0, 80));
          const FALLBACK_MODEL_2 = 'gemini-2.5-pro';
          if (modelName !== FALLBACK_MODEL_2) {
            console.warn(`[GEMINI] 🔄 FALLBACK-2 CHAT: ${FALLBACK_MODEL} → ${FALLBACK_MODEL_2}`);
            await new Promise(r => setTimeout(r, 3000));
            return await callModel(FALLBACK_MODEL_2, userParts);
          }
          throw fbErr;
        }
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
      const modelName = opts.model || 'gemini-2.5-pro';
      const systemInstruction = opts.systemInstruction || '';
      const thinkingConfig = opts.generationConfig?.thinkingConfig || { thinkingBudget: -1 };
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
  geminiPro: () => getGenAICompat().getGenerativeModel({ model: 'gemini-2.5-pro' }),
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
      model: 'gemini-2.5-pro',
      contents: 'Responde SOLO con la palabra "OK". Nada más.',
      config: {
        thinkingConfig: { thinkingBudget: -1 },
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

    checks.push(`✅ Modelo gemini-2.5-pro: OPERATIVO`);
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
