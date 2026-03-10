// ============================================
// index.js - Bot Empresarial WhatsApp + CRM
// ============================================
// Línea principal de atención que:
// 1. Recibe mensajes de WhatsApp
// 2. Responde con Claude AI usando la base de conocimiento
// 3. Registra cada cliente en el CRM (SQLite)
// 4. Cuando el cliente quiere comprar/cotizar, lo asigna a un empleado (round-robin)
// 5. Notifica al empleado con el contexto de la conversación

require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { fork } = require('child_process');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const jsQR = require('jsqr');
const Jimp = require('jimp');

const db = require('./db');
const router = require('./router');
const search = require('./search');

// Cola de reintentos para cuando falla Gemini
const retryQueue = [];

// ============================================
// SISTEMA DE ROTACIÓN DE API KEYS — GEMINI
// ============================================
// Almacena múltiples keys en .env separadas por coma:
//   GEMINI_API_KEYS=key1,key2,key3
// Si solo hay una key, también funciona con GEMINI_API_KEY=key1.
// Cuando una key da 429 (quota), rota automáticamente a la siguiente.

const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
let geminiKeyIndex = 0;
let genAI = new GoogleGenerativeAI(GEMINI_KEYS[0]);

// Desactivar TODOS los filtros de seguridad — negocio legal de armas traumáticas
const SAFETY_SETTINGS = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
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

      if (is429 && attempt < maxRetries - 1) {
        console.warn(`[GEMINI] ⚠️ Key #${geminiKeyIndex + 1} agotada (429) — rotando...`);
        rotateGeminiKey('429 quota exceeded');
        // Esperar un momento antes de reintentar
        await new Promise(r => setTimeout(r, 1000));
      } else {
        throw err; // No es 429 o ya se agotaron todas las keys
      }
    }
  }
  throw lastError;
}

// ============================================
// CONFIGURACIÓN
// ============================================
const CONFIG = {
  mode: process.env.MODE || 'direct',
  apiKey: process.env.ANTHROPIC_API_KEY,
  businessName: process.env.BUSINESS_NAME || 'Mi Tienda',
  businessPhone: process.env.BUSINESS_PHONE || '',
  auditors: (process.env.AUDITORS || '').split(',').map(a => a.trim()).filter(Boolean),
  ignoreGroups: process.env.IGNORE_GROUPS === 'true',
  debug: process.env.DEBUG === 'true',
  n8nWebhook: process.env.N8N_WEBHOOK_URL || '',
};

// Parsear empleados del .env
// Formato: "Juan:573001111111,Maria:573002222222"
function parseEmployees() {
  const envEmployees = process.env.EMPLOYEES || '';
  if (!envEmployees) return [];

  return envEmployees.split(',').map(emp => {
    const [name, phone] = emp.trim().split(':');
    return { name: name.trim(), phone: phone.trim() };
  });
}

// Cargar base de conocimiento
let knowledgeBase = {};
try {
  const kbPath = path.join(__dirname, 'knowledge_base.json');
  if (fs.existsSync(kbPath)) {
    knowledgeBase = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
    console.log('[BOT] Base de conocimiento cargada');
  } else {
    console.log('[BOT] No se encontró knowledge_base.json, se usará memoria vacía o catálogo.');
  }
} catch (error) {
  console.error('[BOT] Error cargando knowledge_base.json:', error.message);
}

// ============================================
// HELPER: BUSCAR IMAGEN DE PRODUCTO
// ============================================
function findBestImage(query) {
  const baseDir = path.join(__dirname, 'imagenes', 'pistolas');
  if (!fs.existsSync(baseDir)) return null;

  const tokens = query.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(t => t.length >= 2);
  if (tokens.length === 0) return null;

  let bestMatch = null;
  let bestScore = 0;

  try {
    const brands = fs.readdirSync(baseDir);
    for (const brand of brands) {
      const brandDir = path.join(baseDir, brand);
      if (!fs.statSync(brandDir).isDirectory()) continue;

      const files = fs.readdirSync(brandDir);
      for (const file of files) {
        if (!file.endsWith('.png') && !file.endsWith('.jpg') && !file.endsWith('.jpeg')) continue;

        const targetString = `${brand} ${file.replace(/\.[^/.]+$/, "")}`.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
        let score = 0;
        for (const token of tokens) {
          // Si el token es muy común (ej. "retay"), sumar 1. Modelos suman 2.
          if (targetString.includes(token)) score += (token === brand.toLowerCase() ? 1 : 2);
        }

        if (score > bestScore) {
          bestScore = score;
          bestMatch = path.join(brandDir, file);
        }
      }
    }
  } catch (e) {
    console.error('[BOT] Error buscando imagen:', e.message);
  }

  // Requiere mínimo 2 puntos (ej. acertar un modelo o marca+algo más)
  return bestScore >= 2 ? bestMatch : null;
}

// ============================================
// HELPER: DETECTAR Y ENVIAR IMÁGENES DE PRODUCTOS EN UNA RESPUESTA
// Escanea la respuesta del bot buscando etiquetas [ENVIAR_IMAGEN: ...] y URLs
// del catálogo, busca las fotos locales, y las envía al chat.
// Devuelve la respuesta limpia (sin etiquetas) y la cantidad de imágenes enviadas.
// ============================================
async function detectAndSendProductImages(response, rawMsg, senderPhone) {
  const imagesToSend = [];

  // 1. Detección por etiqueta explícita [ENVIAR_IMAGEN: Marca Modelo]
  const imageRegex = /\[ENVIAR_IMAGEN:\s*([^\]]+)\]/ig;
  let match;
  while ((match = imageRegex.exec(response)) !== null) {
    const productQuery = match[1].trim();
    console.log(`[IMG] 🔍 Etiqueta ENVIAR_IMAGEN: "${productQuery}"`);
    const foundPath = findBestImage(productQuery);
    console.log(`[IMG] ${foundPath ? '✅' : '❌'} findBestImage("${productQuery}") → ${foundPath || 'NO ENCONTRADA'}`);
    if (foundPath && !imagesToSend.includes(foundPath)) {
      imagesToSend.push(foundPath);
    }
  }

  // Limpiar todas las etiquetas del mensaje final
  response = response.replace(imageRegex, '').trim();

  // 2. Detección automática por URL de producto
  const urlRegex = /zonatraumatica\.(com|club)\/producto\/([a-zA-Z0-9\-]+)/ig;
  let urlMatch;
  while ((urlMatch = urlRegex.exec(response)) !== null) {
    const productSlug = urlMatch[2].replace(/-/g, ' ').trim();
    console.log(`[IMG] 🔍 URL producto: slug="${urlMatch[2]}", query="${productSlug}"`);
    const foundPath = findBestImage(productSlug);
    console.log(`[IMG] ${foundPath ? '✅' : '❌'} findBestImage("${productSlug}") → ${foundPath || 'NO ENCONTRADA'}`);
    if (foundPath && !imagesToSend.includes(foundPath)) {
      imagesToSend.push(foundPath);
    }
  }

  // 3. Enviar las imágenes encontradas
  let sent = 0;
  for (const imgPath of imagesToSend) {
    try {
      const media = MessageMedia.fromFilePath(imgPath);
      await rawMsg.reply(media);
      console.log(`[IMG] 🖼️ Imagen enviada a ${senderPhone}: ${path.basename(imgPath)}`);
      sent++;
    } catch (imgErr) {
      console.error(`[IMG] ❌ Error enviando imagen ${imgPath}:`, imgErr.message);
    }
  }

  if (imagesToSend.length === 0) {
    console.log(`[IMG] ℹ️ Sin imágenes detectadas en respuesta para ${senderPhone}`);
  } else {
    // Marcar que ya se enviaron fotos del catálogo a este cliente
    db.markCatalogSent(senderPhone);
    console.log(`[IMG] 📌 Catálogo marcado como enviado para ${senderPhone}`);
  }

  return { cleanResponse: response, imagesSent: sent };
}

// ============================================
// INICIALIZAR BASE DE DATOS Y EMPLEADOS
// ============================================
db.initDatabase();

const employees = parseEmployees();
employees.forEach(emp => {
  db.upsertEmployee(emp.name, emp.phone);
});
console.log(`[BOT] ${employees.length} empleados registrados`);

// Inicializar router round-robin
router.initRouter();

// Cargar catálogo para búsqueda inteligente (RAG)
search.loadCatalog();

// ============================================
// ANTI-LOOP — detector de mensajes por minuto
// ============================================
// Mapa en memoria: phone -> array de timestamps de mensajes recientes
const messageTimestamps = new Map();
const RATE_LIMIT_MAX = 20;     // más de 20 mensajes...
const RATE_LIMIT_WINDOW = 60;  // ...en 60 segundos = posible bot

function checkRateLimit(phone) {
  const now = Date.now();
  const windowMs = RATE_LIMIT_WINDOW * 1000;

  if (!messageTimestamps.has(phone)) {
    messageTimestamps.set(phone, []);
  }

  // Filtrar solo los timestamps dentro de la ventana
  const timestamps = messageTimestamps.get(phone).filter(t => now - t < windowMs);
  timestamps.push(now);
  messageTimestamps.set(phone, timestamps);

  if (timestamps.length > RATE_LIMIT_MAX) {
    return true; // supera el límite — posible bot
  }
  return false;
}

// ============================================
// CLIENTE DE WHATSAPP
// ============================================
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './session' }),
  puppeteer: {
    headless: false,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
    ]
  }
});

// ============================================
// GRACEFUL SHUTDOWN — prevenir corrupción de sesión
// ============================================
let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[BOT] ⚠️ Señal ${signal} recibida. Cerrando limpiamente...`);
  try {
    await client.destroy();
    console.log('[BOT] ✅ Sesión guardada correctamente');
  } catch (e) {
    console.error('[BOT] Error cerrando:', e.message);
  }
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', async (err) => {
  console.error('[BOT] 💥 Error no capturado:', err);

  const isSessionCorrupt = err.message && (
    err.message.includes('Execution context was destroyed') ||
    err.message.includes('Session closed') ||
    err.message.includes('Protocol error') ||
    err.message.includes('Target closed')
  );

  if (isSessionCorrupt) {
    console.log('[BOT] 🧹 Crash por sesión corrupta detectado. Limpiando...');
    const sessionDir = path.join(__dirname, 'session');
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log('[BOT] ✅ Sesión corrupta eliminada. Reinicia el bot para escanear QR nuevo.');
    }
  }

  process.exit(1);
});
// Mostrar QR para escanear
client.on('qr', (qr) => {
  console.log('\n[BOT] Escanea este código QR con WhatsApp:');
  qrcode.generate(qr, { small: true });
});

let serverStarted = false;

// Bot conectado
client.on('ready', async () => {
  console.log('\n============================================');
  console.log(`[BOT] ¡${CONFIG.businessName} está en línea!`);
  console.log(`[BOT] Modo: ${CONFIG.mode}`);
  console.log(`[BOT] Línea principal: ${CONFIG.businessPhone}`);
  console.log(`[BOT] Empleados activos: ${employees.length}`);
  console.log(`[BOT] Auditores: ${CONFIG.auditors.length > 0 ? CONFIG.auditors.join(', ') : 'ninguno'}`);
  console.log('============================================\n');

  // Recovery COMPLETADO — bot en modo venta
  // setTimeout(() => recuperarChatsViejos(), 8000);

  // Iniciar broadcaster de imágenes a grupos (esperar 30s para que todo esté listo)
  setTimeout(() => {
    if (typeof startGroupBroadcaster === 'function') {
      startGroupBroadcaster();
    }
  }, 30000);

  // Iniciar publicación automática de Estados (esperar 45s)
  setTimeout(() => {
    if (typeof startStatusBroadcaster === 'function') {
      startStatusBroadcaster();
    }
  }, 45000);

  // Iniciar servidor interno para recibir comandos del panel
  if (!serverStarted) {
    serverStarted = true;
    // startReactivacionServer() is defined globally but might be causing ReferenceError due to block scoping
    if (typeof startReactivacionServer === 'function') {
      startReactivacionServer();
    }
  }
});

// Error de autenticación — limpiar sesión corrupta y reiniciar
client.on('auth_failure', async (msg) => {
  console.error('[BOT] ❌ Error de autenticación:', msg);
  console.log('[BOT] 🧹 Limpiando sesión corrupta...');
  const sessionDir = path.join(__dirname, 'session');
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    console.log('[BOT] ✅ Sesión borrada. Reiniciando para QR nuevo...');
  }
  setTimeout(() => {
    console.log('[BOT] 🔄 Reiniciando cliente...');
    client.initialize();
  }, 5000);
});

// Desconexión — intentar reconectar
client.on('disconnected', async (reason) => {
  console.log('[BOT] ⚠️ Desconectado:', reason);
  if (reason === 'NAVIGATION' || reason === 'LOGOUT') {
    console.log('[BOT] Sesión cerrada. Limpiando para QR nuevo...');
    const sessionDir = path.join(__dirname, 'session');
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  }
  console.log('[BOT] 🔄 Intentando reconectar en 10 segundos...');
  setTimeout(() => client.initialize(), 10000);
});

// ============================================
// CONVIVENCIA HUMANO-BOT
// ============================================
const adminPauseMap = new Map(); // phone → timestamp hasta cuándo pausado

function isBotPaused(phone) {
  const pauseUntil = adminPauseMap.get(phone);
  if (!pauseUntil) return false;
  if (Date.now() > pauseUntil) {
    adminPauseMap.delete(phone);
    return false;
  }
  return true;
}

async function enviarTransicionAdmin(clientPhone, chatId, alvaroMsg) {
  try {
    const memory = db.getClientMemory(clientPhone) || 'Sin datos previos';
    const history = db.getConversationHistory(clientPhone, 5);
    const histText = history.map(h =>
      `${h.role === 'user' ? 'Cliente' : h.role === 'admin' ? 'Álvaro' : 'Bot'}: ${h.message}`
    ).join('\n');

    const result = await geminiGenerate('gemini-2.5-flash', prompt);
    const transMsg = result.response.text().trim();

    // Enviar directo al chatId original (evita problemas con LID)
    await client.sendMessage(chatId, transMsg);
    db.saveMessage(clientPhone, 'assistant', transMsg);
    console.log(`[ADMIN] ✅ Transición enviada a ${clientPhone}`);

    // Actualizar memoria con la interacción de Álvaro
    updateClientMemory(clientPhone, `[ÁLVARO respondió]: ${alvaroMsg}`, transMsg,
      db.getConversationHistory(clientPhone, 10)
    ).catch(e => console.error('[ADMIN] Error actualizando memoria:', e.message));
  } catch (e) {
    console.error('[ADMIN] Error generando transición:', e.message);
  }
}

// ============================================
// DEBOUNCE — acumula mensajes del mismo cliente
// Timer corre desde el PRIMER mensaje, no se reinicia
// ============================================
const debounceTimers = new Map();   // phone → timer activo
const mensajesAcumulados = new Map(); // phone → [{ msg, body }]
const DEBOUNCE_MS = 10000; // 10 segundos

// ============================================
// MANEJO DE MENSAJES
// ============================================
client.on('message', async (msg) => {
  try {
    // Ignorar ANTES de getChat() para evitar crash con canales/newsletters
    // ============================================
    // COMANDOS ADMIN (#) — interceptar ANTES de ignorar fromMe
    // ============================================
    if (msg.fromMe && (msg.body || '').startsWith('#')) {
      try {
        await handleAdminCommand(msg);
      } catch (cmdErr) {
        console.error('[CMD] Error procesando comando admin:', cmdErr.message);
      }
      return; // No procesar más — el comando fue manejado
    }

    // Ignorar mensajes propios del bot (los de Álvaro se capturan en message_create)
    if (msg.fromMe) return;
    if (msg.from === 'status@broadcast') return;
    if (msg.from.includes('@newsletter')) return;
    if (msg.from.includes('@broadcast')) return;
    if (msg.type === 'e2e_notification' || msg.type === 'notification_template') return;

    // Ignorar mensajes de grupos si está configurado
    const chat = await msg.getChat();
    if (CONFIG.ignoreGroups && chat.isGroup) return;

    // Ignorar canales por tipo de chat (doble seguro)
    if (chat.isChannel || chat.type === 'channel') return;

    // ============================================
    // FILTRO ANTI-BOTS (evitar loops infinitos)
    // ============================================
    const senderRaw = msg.from.replace('@c.us', '');
    const senderClean = senderRaw.replace('57', '');
    const senderName = (chat.name || '').toLowerCase();
    const messageBody_check = (msg.body || '').toLowerCase();

    // 1. Lista negra de nombres de bots/empresas conocidas
    const BLOCKED_NAMES = [
      'bancolombia', 'nequi', 'daviplata', 'dale', 'rappipay', 'rappi',
      'movii', 'tpaga', 'bold', 'payvalida', 'payu', 'epayco',
      'claro', 'movistar', 'tigo', 'wom', 'etb', 'une',
      'compensar', 'sura', 'eps', 'colmedica', 'sanitas', 'coomeva',
      'servientrega', 'envia', 'interrapidisimo', 'coordinadora', 'deprisa', 'fedex',
      'uber', 'didi', 'indriver', 'beat',
      'taskus', 'task us', 'task_us',
      'google', 'whatsapp', 'meta', 'facebook', 'instagram', 'telegram',
      'chatgpt', 'openai', 'gemini', 'copilot', 'claude',
      'verificación', 'verificacion', 'verification', 'security', 'seguridad',
      'notificación', 'notificacion', 'notification', 'alerta', 'alert',
    ];

    // 2. Números cortos = bots empresariales (menos de 7 dígitos)
    const isShortNumber = senderClean.length <= 6;

    // 3. Nombre coincide con empresa/bot conocido
    const isBlockedName = BLOCKED_NAMES.some(name => senderName.includes(name));

    // 4. Detectar mensajes automáticos por contenido típico de bots
    const BOT_PATTERNS = [
      /transacci[oó]n.*aprobada/i,
      /transferencia.*exitosa/i,
      /c[oó]digo de verificaci[oó]n/i,
      /c[oó]digo.*seguridad/i,
      /tu c[oó]digo es/i,
      /your.*code.*is/i,
      /OTP.*\d{4,}/i,
      /saldo.*disponible/i,
      /pago.*recibido/i,
      /factura.*generada/i,
      /su pedido/i,
      /tracking.*number/i,
      /n[uú]mero de gu[ií]a/i,
      /no responda.*este mensaje/i,
      /mensaje autom[aá]tico/i,
      /do not reply/i,
    ];
    const isBotMessage = BOT_PATTERNS.some(pattern => pattern.test(msg.body || ''));

    if (isShortNumber || isBlockedName || isBotMessage) {
      const razon = isShortNumber ? 'número corto' : isBlockedName ? `nombre bloqueado (${senderName})` : 'msg automático';
      console.log(`[BOT] 🚫 BLOQUEADO: ${senderRaw} (${chat.name || 'sin nombre'}) [${razon}]`);
      return;
    }

    // 5. ANTI-LOOP: Si un número manda más de 50 msgs en 5 min, es bot
    if (!global._msgTracker) global._msgTracker = {};
    const now = Date.now();
    const tracker = global._msgTracker;
    if (!tracker[senderRaw]) tracker[senderRaw] = [];
    tracker[senderRaw].push(now);
    // Limpiar mensajes viejos (más de 5 min)
    tracker[senderRaw] = tracker[senderRaw].filter(t => now - t < 300000);
    if (tracker[senderRaw].length > 50) {
      console.log(`[BOT] 🚫 ANTI-LOOP: ${senderRaw} (${chat.name || 'sin nombre'}) — ${tracker[senderRaw].length} msgs en 5 min. Ignorando.`);
      return;
    }

    const senderPhone = msg.from.replace(/@.*/g, ''); // quitar @c.us, @lid, @g.us, etc.
    const messageBody = msg.body ? msg.body.trim() : '';

    // ⛔ Chequeo TEMPRANO de ignorados — antes de cualquier procesamiento
    if (db.isIgnored(senderPhone)) {
      console.log(`[BOT] 🔇 Ignorado (panel): ${senderPhone} (${chat.name || 'sin nombre'})`);
      return;
    }

    // 🚨 Anti-loop: si ya está flaggeado como posible spam, silenciar hasta revisión
    if (db.isSpamFlagged(senderPhone)) {
      console.log(`[BOT] 🚨 Pausado por spam_flag: ${senderPhone} — pendiente revisión en panel`);
      return;
    }

    // 🚨 Anti-loop: detectar ráfaga de mensajes (posible bot)
    if (checkRateLimit(senderPhone)) {
      console.log(`[BOT] ⚠️ Rate limit detectado para ${senderPhone} — marcando como posible bot`);
      db.upsertClient(senderPhone, {});
      db.setSpamFlag(senderPhone, true);
      console.log(`[BOT] 🚨 ${senderPhone} marcado como posible spam en panel`);
      return;
    }

    // Log de todo mensaje entrante (para monitoreo — incluye tipo para diagnóstico)
    console.log(`[MSG] 📩 ${chat.name || senderPhone}: "${messageBody.substring(0, 50)}${messageBody.length > 50 ? '...' : ''}" [type=${msg.type}, hasMedia=${!!msg.hasMedia}, from=${senderPhone}]`);

    // ============================================
    // DEBOUNCE — acumular mensajes, procesar al vencer el timer
    // El timer se inicia con el PRIMER mensaje y NO se reinicia
    // ============================================

    // Acumular este mensaje
    if (!mensajesAcumulados.has(senderPhone)) {
      mensajesAcumulados.set(senderPhone, []);
    }
    mensajesAcumulados.get(senderPhone).push(msg);

    // Si ya hay un timer corriendo para este cliente, no hacer nada más — solo acumular
    if (debounceTimers.has(senderPhone)) {
      console.log(`[DEBOUNCE] ⏳ ${senderPhone} — mensaje acumulado (${mensajesAcumulados.get(senderPhone).length} total)`);
      return;
    }

    // Primer mensaje — iniciar timer de 10s
    console.log(`[DEBOUNCE] 🟢 ${senderPhone} — timer iniciado (10s)`);
    const timer = setTimeout(async () => {
      debounceTimers.delete(senderPhone);
      const mensajes = mensajesAcumulados.get(senderPhone) || [];
      mensajesAcumulados.delete(senderPhone);

      if (mensajes.length === 0) {
        console.warn(`[DEBOUNCE] ⚠️ ${senderPhone} — timer venció pero 0 mensajes acumulados (raro)`);
        return;
      }

      // Log diagnóstico de tipos recibidos
      const tiposSummary = mensajes.map(m => `${m.type}${m.hasMedia ? '+media' : ''}:"${(m.body || '').substring(0, 20)}"`).join(', ');
      console.log(`[DEBOUNCE] 📋 ${senderPhone} — ${mensajes.length} msg(s): [${tiposSummary}]`);

      // Usar el último msg como referencia (para reply, type, etc.)
      const msgRef = mensajes[mensajes.length - 1];

      // Si hay un solo mensaje de texto, procesarlo normal
      // Si hay varios, concatenar los textos en uno solo
      const soloTextos = mensajes.filter(m => !m.hasMedia && m.type === 'chat');
      const conMedia = mensajes.filter(m => m.hasMedia || m.type !== 'chat');

      if (mensajes.length > 1) {
        console.log(`[DEBOUNCE] 🔀 ${senderPhone} — procesando ${mensajes.length} mensajes juntos (${soloTextos.length} texto, ${conMedia.length} media/otro)`);
      }

      // Procesar media individualmente (imágenes, audios, PDFs)
      for (const mMedia of conMedia) {
        await procesarMensaje(mMedia, chat, senderPhone, mMedia);
      }

      // Procesar textos concatenados como un solo mensaje
      if (soloTextos.length > 0) {
        const textoConcatenado = soloTextos.map(m => m.body?.trim()).filter(Boolean).join('\n');
        if (textoConcatenado) {
          // Crear un msg "virtual" con el texto concatenado usando el último como base
          // rawMsg = msgRef (mensaje real) para que .reply() y .getContact() funcionen
          const msgVirtual = { ...msgRef, body: textoConcatenado };
          await procesarMensaje(msgVirtual, chat, senderPhone, msgRef);
        } else {
          console.warn(`[DEBOUNCE] ⚠️ ${senderPhone} — ${soloTextos.length} mensaje(s) tipo chat pero TODOS con body vacío. Tipos originales: [${mensajes.map(m => m.type).join(', ')}]. Posible: botón interactivo, reacción, o contacto compartido.`);
        }
      } else if (conMedia.length === 0) {
        console.warn(`[DEBOUNCE] ⚠️ ${senderPhone} — ni textos ni media detectados. Tipos: [${mensajes.map(m => m.type).join(', ')}]`);
      }
    }, DEBOUNCE_MS);

    debounceTimers.set(senderPhone, timer);
    return; // El procesamiento real ocurre dentro del setTimeout

  } catch (err) {
    console.error('[BOT] Error en handler de mensaje:', err.message);
  }
});

// ============================================
// PROCESAMIENTO REAL DEL MENSAJE
// Llamado por el debounce cuando el timer vence
// ============================================
async function procesarMensaje(msg, chat, senderPhone, rawMsg) {
  // rawMsg = mensaje real de whatsapp-web.js (tiene .reply(), .getContact())
  // msg puede ser un objeto virtual (texto concatenado sin esos métodos)
  if (!rawMsg) rawMsg = msg; // para mensajes sin debounce, msg ya es real
  try {
    const messageBody = msg.body ? msg.body.trim() : '';

    // 1. Obtener nombre del perfil y teléfono real de WhatsApp (RESOLVER LID GLOBALMENTE)
    let profileName = '';
    try {
      const contact = await rawMsg.getContact();
      // Prioridad: pushname → contact.name → shortName → chat.name
      profileName = contact.pushname || contact.name || contact.shortName || chat.name || '';

      // contact.number resuelve el teléfono real incluso cuando el mensaje llegó con LID
      const realNumber = (contact.number || '').replace(/\D/g, '');
      if (realNumber && realNumber !== senderPhone) {
        if (CONFIG.debug) console.log(`[BOT] 📱 LID resuelto global: ${senderPhone} → ${realNumber}`);
        // Si existe registro viejo bajo el LID, migrarlo al número real
        if (db.getClient(senderPhone) && !db.getClient(realNumber)) {
          db.migrateClientPhone(senderPhone, realNumber);
        }
        senderPhone = realNumber;
      }
    } catch (err) {
      profileName = chat.name || '';
      console.error('[BOT] Error obteniendo contacto:', err.message);
    }

    // 2. Registrar/actualizar cliente en CRM
    const existingClient = db.getClient(senderPhone);
    const isNewClient = !existingClient;
    const chatIdFromMsg = rawMsg.from || (senderPhone + '@c.us');

    if (isNewClient) {
      db.upsertClient(senderPhone, { name: profileName, chat_id: chatIdFromMsg });
      console.log(`[BOT] 🆕 Nuevo cliente: "${profileName}" (${senderPhone}) [${chatIdFromMsg}]`);
    } else {
      const updateData = { chat_id: chatIdFromMsg };
      const bestName = profileName || chat.name || '';
      if (bestName && !existingClient.name) {
        updateData.name = bestName;
      }
      db.upsertClient(senderPhone, updateData);
    }

    // ⛔ Contacto ignorado desde el panel — silencio total
    if (db.isIgnored(senderPhone)) {
      if (CONFIG.debug) console.log(`[BOT] 🔇 Ignorado (panel): ${senderPhone} (${profileName})`);
      return;
    }

    // Si Álvaro está atendiendo a este cliente → pausar bot para todo (texto/media)
    if (isBotPaused(senderPhone)) {
      if (CONFIG.debug) console.log(`[BOT] ⏸️ Bot pausado para ${senderPhone} (Álvaro atendiendo)`);
      db.saveMessage(senderPhone, 'user', messageBody ? messageBody : `[Media omitido: ${msg.type}]`);
      return;
    }

    // --- MANEJO DE AUDIOS Y MEDIA ---
    if (msg.hasMedia || msg.type === 'ptt' || msg.type === 'audio' ||
      msg.type === 'image' || msg.type === 'video' || msg.type === 'document' ||
      msg.type === 'sticker') {

      // No responder a empleados ni auditor con esto
      if (db.getEmployeeByPhone(senderPhone) || isAuditor(senderPhone)) return;

      if (CONFIG.debug) {
        console.log(`[DEBUG] Media recibido de ${senderPhone}: tipo=${msg.type}`);
      }

      // IMÁGENES: procesarlas con visión de Claude (multimodal)
      if (msg.type === 'image' || msg.type === 'sticker') {
        if (msg.type === 'sticker') return; // ignorar stickers silenciosamente

        try {
          const media = await msg.downloadMedia();
          if (media && media.data) {
            const mediaType = media.mimetype || 'image/jpeg';
            // Solo pasar imágenes reales (no stickers animados WebP)
            const isValidImage = mediaType.startsWith('image/');
            if (!isValidImage) return;

            // Obtener historial y memoria del cliente (contexto completo)
            const history = db.getConversationHistory(senderPhone, 30);
            const clientMemory = db.getClientMemory(senderPhone);
            const clientProfile = db.getClient(senderPhone);
            const documentSummary = db.buildDocumentSummary(senderPhone);
            const systemPrompt = buildSystemPrompt('El cliente envió una imagen. Continúa la conversación con el contexto previo que ya tienes.', clientMemory, clientProfile, documentSummary);

            // Construir historial previo para que Gemini tenga contexto de la conversación
            const geminiHistory = history
              .filter(h => h.role !== 'system' && h.content && h.content.trim().length > 0)
              .map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content.trim() }] }));
            // Gemini exige que el historial empiece con 'user'
            while (geminiHistory.length > 0 && geminiHistory[0].role !== 'user') geminiHistory.shift();

            // Intentar escanear QR de la imagen antes de mandarlo a Gemini
            let qrTexto = null;
            try {
              const imgBuffer = Buffer.from(media.data, 'base64');
              const jimpImg = await Jimp.read(imgBuffer);
              const { data, width, height } = jimpImg.bitmap;
              const qrResult = jsQR(data, width, height);
              if (qrResult) {
                qrTexto = qrResult.data;
                console.log(`[QR] ✅ QR detectado: ${qrTexto.substring(0, 80)}`);
              }
            } catch (qrErr) {
              // Si falla el escaneo de QR no pasa nada — Gemini igual procesa la imagen
              console.log(`[QR] No se detectó QR en la imagen`);
            }

            // Detectar si es CARNET de Club ZT (antes de verificar si es comprobante)
            const imagePart = { inlineData: { data: media.data, mimeType: mediaType } };
            let esCarnet = false;
            let datosCarnet = {};
            try {
              const carnetCheckResult = await geminiGenerate('gemini-2.5-flash', [
                imagePart,
                '¿Esta imagen es un CARNET del Club Zona Traumática / Carné de Tiro AML? Busca: texto "Carné de Tiro AML", logo "ZT", texto "ZONA TRAUMATICA", o referencia a "LEY 2197". Si es un carnet, extrae los campos visibles. Revisa especialmente la FECHA DE VIGENCIA o VÁLIDO HASTA. Responde SOLO con JSON: {"esCarnet": true/false, "nombre": "", "cedula": "", "vigente_hasta": "YYYY-MM-DD", "marca_arma": "", "modelo_arma": "", "serial": ""}'
              ]);
              const carnetText = carnetCheckResult.response.text().trim().replace(/```json|```/g, '').trim();
              const carnetData = JSON.parse(carnetText);
              esCarnet = carnetData.esCarnet === true;
              if (esCarnet) {
                datosCarnet = carnetData;
                console.log(`[CARNET] 🪪 Detectado de ${senderPhone}: ${datosCarnet.nombre || 'sin nombre'} (${datosCarnet.cedula || 'sin cedula'}) Vence: ${datosCarnet.vigente_hasta || 'N/A'}`);
              }
            } catch (e) {
              console.log(`[CARNET] No pudo detectar si es carnet: ${e.message}`);
            }

            if (esCarnet) {
              // Es un carnet — guardarlo para verificación en panel
              const clientInfo = db.getClient(senderPhone);
              const clientNameForCarnet = clientInfo?.name || senderPhone;
              const carnetResult = db.saveCarnet(senderPhone, clientNameForCarnet, media.data, mediaType, datosCarnet);
              const carnetId = carnetResult.lastInsertRowid;

              const replyCarnet = '¡Recibí tu carnet! Nuestro equipo lo va a verificar. Si hay algo que necesites, me avisas 🙌';
              await msg.reply(replyCarnet);

              // Notificar a Álvaro
              const notifCarnet = `🪪 *CARNET RECIBIDO PARA VERIFICACIÓN*\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `👤 *Nombre en carnet:* ${datosCarnet.nombre || 'no legible'}\n` +
                `🪪 *Cédula:* ${datosCarnet.cedula || 'no legible'}\n` +
                `📱 *WhatsApp:* wa.me/${senderPhone}\n` +
                `🏷️ *Arma:* ${datosCarnet.marca_arma || ''} ${datosCarnet.modelo_arma || ''} (${datosCarnet.serial || ''})\n` +
                `📅 *Vigente hasta:* ${datosCarnet.vigente_hasta || 'no legible'}\n\n` +
                `Panel → pestaña 🪪 Carnets → ID #${carnetId}`;
              try { await client.sendMessage(CONFIG.businessPhone + '@c.us', notifCarnet); } catch (_) { }

              db.saveMessage(senderPhone, 'user', '[Carnet Club ZT enviado para verificación]');
              db.saveMessage(senderPhone, 'assistant', replyCarnet);
              return;
            }

            // Detectar si la imagen es un comprobante de pago usando Gemini
            let esComprobante = false;
            let infoComprobante = '';
            try {
              const checkResult = await geminiGenerate('gemini-2.5-flash', [
                imagePart,
                'Analiza esta imagen. ¿Es un COMPROBANTE DE PAGO real (captura de transferencia bancaria, Nequi, Bancolombia, Daviplata, Bold, PSE, etc.)? \n\nIMPORTANTE: Fotos de PRODUCTOS (armas, ropa, accesorios), selfies, memes, catálogos, o cualquier imagen que NO sea una captura de pantalla de una transacción financiera = esComprobante: false.\n\nResponde SOLO con JSON: {"esComprobante": true/false, "monto": "valor si lo ves o null", "entidad": "banco/app o null"}'
              ]);
              const checkText = checkResult.response.text().trim().replace(/```json|```/g, '').trim();
              const checkData = JSON.parse(checkText);
              esComprobante = checkData.esComprobante === true;
              if (esComprobante) {
                infoComprobante = `Monto: ${checkData.monto || 'no visible'} | Entidad: ${checkData.entidad || 'no visible'}`;
                console.log(`[COMPROBANTE] 💰 Detectado de ${senderPhone}: ${infoComprobante}`);
              } else {
                console.log(`[COMPROBANTE] ❌ No es comprobante (${senderPhone}): imagen normal`);
              }
            } catch (e) {
              // Si falla la detección, tratar como imagen normal
              console.log(`[COMPROBANTE] No pudo detectar si es comprobante: ${e.message}`);
            }

            let reply;

            if (esComprobante) {
              // Es comprobante — responder con espera y notificar a Álvaro
              reply = '¡Recibido! Ya le pasamos el comprobante a nuestro equipo para verificarlo. En cuanto lo confirmen te avisamos y arrancamos con el proceso 🙏';
              await msg.reply(reply);

              // Notificar a Álvaro con la imagen y el contexto del cliente
              const clientInfo = db.getClient(senderPhone);
              const clientName = clientInfo?.name || senderPhone;
              const memoriaLow = (clientInfo?.memory || '').toLowerCase();
              const mensajeLow = messageBody.toLowerCase();

              // Detectar tipo de comprobante usando TODA la conversación reciente:
              // Escanear las últimas 10 mensajes + memoria + mensaje actual
              const recentHistory = db.getConversationHistory(senderPhone, 10);
              const conversacionTexto = recentHistory.map(h => (h.message || h.content || '').toLowerCase()).join(' ');
              const contextoCompleto = `${mensajeLow} ${memoriaLow} ${conversacionTexto}`;

              // Conteo de señales por tipo para elegir el más probable
              const senalesBot = [
                'bot asesor', 'bot asesor legal', 'chatbot', 'inteligencia artificial',
                'asesor legal ia', ' ia ', 'bot legal', 'acceso bot', 'suscripcion bot', 'suscripción bot'
              ].filter(k => contextoCompleto.includes(k)).length;

              const senalesClub = [
                'club zt', 'club zona', 'afiliaci', 'afiliacion', 'afiliación', 'plan plus',
                'plan pro', 'carnet', 'membresía', 'membresia', 'respaldo legal', 'respaldo jurídico'
              ].filter(k => contextoCompleto.includes(k)).length;

              const senalesProducto = [
                'pistola', 'traumática', 'traumatica', 'arma', 'munición', 'municion',
                'despacho', 'envío', 'envio', 'caja de', 'dispositivo', 'calibre'
              ].filter(k => contextoCompleto.includes(k)).length;

              let tipoComprobante;
              if (senalesBot > senalesClub && senalesBot > senalesProducto) {
                tipoComprobante = 'bot_asesor';
              } else if (senalesClub > senalesProducto) {
                tipoComprobante = 'club';
              } else if (senalesProducto > 0) {
                tipoComprobante = 'producto';
              } else {
                // Sin pistas claras — dejar como desconocido para que el panel lo resuelva
                tipoComprobante = 'desconocido';
              }
              console.log(`[COMPROBANTE] 🏷️ Tipo auto-detectado: ${tipoComprobante} (señales: bot=${senalesBot}, club=${senalesClub}, producto=${senalesProducto})`);

              // Guardar en BD de comprobantes pendientes
              const comprobanteResult = db.saveComprobante(senderPhone, clientName, infoComprobante, media.data, mediaType, tipoComprobante);
              const comprobanteId = comprobanteResult.lastInsertRowid;

              // Notificar a Álvaro por WhatsApp
              const notifText = `💰 *COMPROBANTE DE PAGO RECIBIDO*\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `👤 *Cliente:* ${clientName}\n` +
                `📱 *WhatsApp:* wa.me/${senderPhone}\n` +
                `🏦 *${infoComprobante}*\n` +
                `📋 *Tipo:* ${tipoComprobante === 'club' ? 'Afiliación Club ZT' : tipoComprobante === 'bot_asesor' ? '🤖 Bot Asesor Legal' : 'Producto'}\n\n` +
                `⚠️ Verifica el monto en el panel antes de confirmar.\n` +
                `Panel → pestaña 💰 Por Verificar → ID #${comprobanteId}`;

              const notifChatId = CONFIG.businessPhone + '@c.us';
              try {
                await client.sendMessage(notifChatId, notifText);
                await client.sendMessage(notifChatId, media, { caption: `Comprobante de ${clientName} (#${comprobanteId})` });
              } catch (notifErr) {
                console.error(`[COMPROBANTE] Error notificando:`, notifErr.message);
              }

              db.saveMessage(senderPhone, 'user', `[Comprobante de pago enviado — ${infoComprobante}]`);
              db.saveMessage(senderPhone, 'assistant', reply);
              db.upsertClient(senderPhone, { status: 'hot' });
              console.log(`[COMPROBANTE] ✅ Guardado ID #${comprobanteId} y notificado para ${senderPhone}`);

            } else if (qrTexto) {
              // QR detectado — responder SOLO sobre el contenido del QR
              ;
              const qrResult = await geminiGenerate('gemini-3.1-pro-preview', qrPrompt);
              reply = qrResult.response.text();
              await msg.reply(reply);
              db.saveMessage(senderPhone, 'user', `[QR escaneado: ${qrTexto.substring(0, 60)}]`);
              db.saveMessage(senderPhone, 'assistant', reply);
              db.upsertClient(senderPhone, {});

            } else {
              // Imagen normal — flujo con system prompt completo e historial
              const textPart = msg.body || 'El cliente envió esta imagen.';
              const visionModel = genAI.getGenerativeModel({
                model: 'gemini-3.1-pro-preview',
                systemInstruction: systemPrompt,
                safetySettings: SAFETY_SETTINGS,
                generationConfig: { thinkingConfig: { thinkingBudget: -1 } }
              });
              const visionChat = visionModel.startChat({ history: geminiHistory });
              const visionResult = await visionChat.sendMessage([imagePart, textPart]);
              reply = visionResult.response.text();
              await msg.reply(reply);

              // Generar descripción breve de la imagen para el historial
              let imageDescription = '[imagen enviada]';
              try {
                const descResult = await geminiGenerate('gemini-2.5-flash', [
                  imagePart,
                  'Describe esta imagen en UNA línea breve en español para guardar en el historial del cliente. Ejemplos: "Foto de cédula por ambas caras", "Selfie del cliente", "Captura de pantalla de chat", "Foto de un producto arma traumática". Solo la descripción, sin explicaciones.'
                ]);
                imageDescription = `[IMAGEN: ${descResult.response.text().trim()}]`;
              } catch (descErr) {
                console.log(`[IMG] No se pudo generar descripción: ${descErr.message}`);
              }

              // Guardar la imagen como archivo del cliente
              try {
                db.saveClientFile(senderPhone, 'imagen', imageDescription.replace(/^\[IMAGEN: |\]$/g, ''), media.data, mediaType, 'cliente');
              } catch (fileErr) {
                console.log(`[IMG] Error guardando client_file: ${fileErr.message}`);
              }

              db.saveMessage(senderPhone, 'user', imageDescription);
              db.saveMessage(senderPhone, 'assistant', reply);
              db.upsertClient(senderPhone, {});
            }

            console.log(`[IMG] 🖼️ Imagen procesada para ${senderPhone}${esComprobante ? ' (COMPROBANTE)' : qrTexto ? ' (QR)' : ''}`);
          }
        } catch (imgErr) {
          console.error(`[IMG] ❌ Error procesando imagen: ${imgErr.message}`);
          await msg.reply('Vi tu imagen pero tuve un problema al procesarla. ¿Me puedes contar qué necesitas?');
        }
        return;
      }

      // AUDIOS (voz y audio): procesar con Gemini nativo
      if (msg.type === 'ptt' || msg.type === 'audio') {
        try {
          const media = await msg.downloadMedia();
          if (!media || !media.data) {
            await msg.reply('🎙️ No pude descargar el audio. ¿Me puedes escribir tu consulta?');
            return;
          }

          // WhatsApp ptt = audio/ogg, audio = audio/mp4 u otros
          // Gemini soporta: audio/wav, audio/mp3, audio/aiff, audio/aac, audio/ogg, audio/flac
          let audioMime = media.mimetype || 'audio/ogg';
          // Limpiar mimetype (ej: "audio/ogg; codecs=opus" → "audio/ogg")
          audioMime = audioMime.split(';')[0].trim();

          console.log(`[AUDIO] 🎙️ Procesando audio de ${senderPhone}, mime: ${audioMime}`);

          const history = db.getConversationHistory(senderPhone, 30);
          const clientMemory = db.getClientMemory(senderPhone);
          const documentSummary = db.buildDocumentSummary(senderPhone);
          const systemPrompt = buildSystemPrompt('El cliente envió un mensaje de voz. Continúa la conversación con el contexto previo.', clientMemory, null, documentSummary);

          // Historial previo para mantener contexto
          const geminiHistoryAudio = history
            .filter(h => h.role !== 'system' && h.content && h.content.trim().length > 0)
            .map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content.trim() }] }));
          while (geminiHistoryAudio.length > 0 && geminiHistoryAudio[0].role !== 'user') geminiHistoryAudio.shift();

          const audioPart = { inlineData: { data: media.data, mimeType: audioMime } };
          const textPart = 'El cliente te ha enviado este mensaje de voz. Escúchalo y respóndele directamente. IMPORTANTE: NO transcribas el audio ni repitas lo que dice. Tu única tarea es dar la respuesta correspondiente como asesor comercial.';

          const audioModel = genAI.getGenerativeModel({
            model: 'gemini-3.1-pro-preview',
            systemInstruction: systemPrompt,
            safetySettings: SAFETY_SETTINGS,
            generationConfig: { thinkingConfig: { thinkingBudget: -1 } }
          });
          const audioChat = audioModel.startChat({ history: geminiHistoryAudio });
          const audioResult = await audioChat.sendMessage([audioPart, textPart]);
          const reply = audioResult.response.text();
          await msg.reply(reply);

          // Guardar en historial CRM
          db.saveMessage(senderPhone, 'user', '[mensaje de voz]');
          db.saveMessage(senderPhone, 'assistant', reply);
          db.upsertClient(senderPhone, {});
          console.log(`[AUDIO] ✅ Audio procesado para ${senderPhone}`);
        } catch (audioErr) {
          console.error(`[AUDIO] ❌ Error procesando audio: ${audioErr.message}`);
          await msg.reply('🎙️ Escuché tu nota de voz pero tuve un problema al procesarla. ¿Me puedes escribir qué necesitas?');
        }
        return;
      }

      // DOCUMENTOS: si es PDF, mandarlo directo a Gemini (soporta PDFs con texto e imágenes)
      if (msg.type === 'document') {
        try {
          const media = await msg.downloadMedia();
          if (!media || !media.data) {
            await msg.reply('📄 No pude descargar el documento. ¿Me puedes escribir qué necesitas?');
            return;
          }

          const mime = (media.mimetype || '').toLowerCase();
          const filename = (media.filename || '').toLowerCase();
          const esPDF = mime.includes('pdf') || filename.endsWith('.pdf');

          if (!esPDF) {
            await msg.reply('📄 Recibí tu documento. Solo proceso PDFs por ahora. ¿Me escribes qué necesitas?');
            return;
          }

          console.log(`[PDF] 📄 Procesando PDF de ${senderPhone}: ${media.filename || 'sin nombre'}`);

          const history = db.getConversationHistory(senderPhone, 30);
          const clientMemory = db.getClientMemory(senderPhone);
          const documentSummary = db.buildDocumentSummary(senderPhone);
          const systemPrompt = buildSystemPrompt('El cliente envió un PDF. Continúa la conversación con el contexto previo.', clientMemory, null, documentSummary);

          // Historial previo para mantener contexto
          const geminiHistoryPdf = history
            .filter(h => h.role !== 'system' && h.content && h.content.trim().length > 0)
            .map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content.trim() }] }));
          while (geminiHistoryPdf.length > 0 && geminiHistoryPdf[0].role !== 'user') geminiHistoryPdf.shift();

          // Gemini recibe el PDF como inlineData (igual que imágenes) — lee texto e imágenes del PDF
          const pdfPart = { inlineData: { data: media.data, mimeType: 'application/pdf' } };
          const textPart = msg.body
            ? `El cliente envió este PDF llamado "${media.filename || 'documento.pdf'}" y escribió: "${msg.body}". Analízalo y responde.`
            : `El cliente envió este PDF llamado "${media.filename || 'documento.pdf'}". Analízalo y responde de forma útil según el contexto de la conversación.`;

          const pdfModel = genAI.getGenerativeModel({
            model: 'gemini-3.1-pro-preview',
            systemInstruction: systemPrompt,
            safetySettings: SAFETY_SETTINGS,
            generationConfig: { thinkingConfig: { thinkingBudget: -1 } }
          });
          const pdfChat = pdfModel.startChat({ history: geminiHistoryPdf });
          const pdfResult = await pdfChat.sendMessage([pdfPart, textPart]);
          const reply = pdfResult.response.text();
          await msg.reply(reply);

          db.saveMessage(senderPhone, 'user', `[PDF enviado: ${media.filename || 'documento.pdf'}]`);
          db.saveMessage(senderPhone, 'assistant', reply);
          db.upsertClient(senderPhone, {});
          console.log(`[PDF] ✅ PDF procesado para ${senderPhone}`);
        } catch (pdfErr) {
          console.error(`[PDF] ❌ Error procesando PDF: ${pdfErr.message}`);
          await msg.reply('📄 Recibí tu PDF pero tuve un problema al leerlo. ¿Me puedes escribir qué necesitas?');
        }
        return;
      }

      // Videos: pedir que escriban
      if (msg.type === 'video') {
        await msg.reply('🎥 No proceso videos. ¿En qué te puedo ayudar?');
        return;
      }

      // Stickers: tratarlos como saludo informal y responder con IA
      if (msg.type === 'sticker') {
        console.log(`[BOT] 🎭 Sticker recibido de ${senderPhone} — procesando como saludo`);
        // Convertir a texto para que la IA responda naturalmente
        msg.body = '[El cliente envió un sticker/emoji animado como saludo]';
        messageBody = msg.body;
        // No return — dejar que fluya al procesamiento normal de texto
      }
    }

    if (!messageBody) {
      console.warn(`[BOT] ⚠️ Mensaje vacío de ${senderPhone} (tipo: ${msg.type}, hasMedia: ${msg.hasMedia}). No se procesa. Posible: botón, reacción, location, o contacto compartido.`);
      return;
    }

    if (CONFIG.debug) {
      console.log(`[DEBUG] Mensaje de ${senderPhone}: ${messageBody}`);
    }

    // --- COMANDOS DE ADMIN / AUDITOR ---
    if (isAdmin(senderPhone) && messageBody.startsWith('!')) {
      await handleAdminCommand(msg, senderPhone, messageBody);
      return;
    }

    // --- VERIFICAR SI ES AUDITOR (no recibe respuestas automáticas) ---
    if (isAuditor(senderPhone)) {
      if (CONFIG.debug) {
        console.log(`[DEBUG] Mensaje de auditor ${senderPhone}, ignorando (sin comando !)`);
      }
      return;
    }

    // --- VERIFICAR SI ES EMPLEADO ---
    const employeeMatch = db.getEmployeeByPhone(senderPhone);
    if (employeeMatch) {
      // Los empleados no reciben respuestas automáticas del bot
      if (CONFIG.debug) {
        console.log(`[DEBUG] Mensaje de empleado ${employeeMatch.name}, ignorando`);
      }
      return;
    }

    // --- FLUJO NORMAL DE CLIENTE ---
    await handleClientMessage(msg, senderPhone, messageBody, chat, rawMsg);

  } catch (err) {
    console.error('[BOT] Error procesando mensaje:', err.message, err.stack);
  }
}

// ============================================
// SAFE SEND — envía por WhatsApp con auto-sanación de chat_id
// El phone es el identificador universal. El chat_id (@c.us o @lid) es solo
// un caché de transporte. Si falla por "No LID", resuelve el ID canónico,
// lo guarda en BD y reintenta una vez.
// ============================================
async function safeSend(phone, message) {
  const chatId = db.getClientChatId(phone);
  try {
    await client.sendMessage(chatId, message);
  } catch (err) {
    if (!err.message || !err.message.includes('LID')) throw err; // otro error, relanzar
    console.warn(`[SEND] ⚠️ "No LID" para ${phone} con ${chatId} — resolviendo ID canónico...`);
    try {
      const waId = await client.getNumberId(phone);
      if (!waId) throw new Error('getNumberId no devolvió resultado');
      const canonicalId = waId._serialized;
      // Actualizar chat_id en BD para la próxima vez
      db.db.prepare('UPDATE clients SET chat_id = ? WHERE phone = ?').run(canonicalId, phone);
      console.log(`[SEND] 🔄 chat_id actualizado: ${phone} → ${canonicalId} — reintentando...`);
      await client.sendMessage(canonicalId, message);
    } catch (retryErr) {
      console.error(`[SEND] ❌ Reintento fallido para ${phone}: ${retryErr.message}`);
      throw retryErr;
    }
  }
}

// ============================================
// FLUJO DE CLIENTE
// ============================================
async function handleClientMessage(msg, senderPhone, messageBody, chat, rawMsg) {
  // NOTA: El procesamiento de LID, actualización de CRM e isBotPaused 
  // ya ocurrieron a nivel global en procesarMensaje(). Aquí senderPhone es canónico.

  // 3. Guardar mensaje del cliente
  db.saveMessage(senderPhone, 'user', messageBody);

  // 4. Obtener historial para contexto
  const history = db.getConversationHistory(senderPhone, 30);

  // 5. Simular escritura
  await chat.sendStateTyping();

  // 6. Detectar intención — post-venta primero, luego venta/compra
  const isPostventa = detectPostventaIntent(messageBody);
  const wantsHuman = detectHandoffIntent(messageBody);
  const hasEnoughHistory = history.length >= 6;
  const wantsHumanExplicit = detectHandoffIntent(messageBody, true);

  // Detectar si el cliente está confirmando que tiene algo pendiente ya pagado
  // (respuesta a la pregunta previa de confirmación de post-venta)
  const clienteActualCheck = db.getClient(senderPhone);
  const memoriaActual = (clienteActualCheck?.memory || '').toLowerCase();
  const esperandoConfirmPostventa = memoriaActual.includes('[pregunta postventa enviada]') && !memoriaActual.includes('[postventa-confirmado]');
  const msgLower2 = messageBody.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[¿?¡!.,;:()]/g, '');
  const confirmaPostventa = esperandoConfirmPostventa && (
    msgLower2.includes('si') || msgLower2.includes('sí') || msgLower2.includes('tengo') ||
    msgLower2.includes('ya pague') || msgLower2.includes('ya pague') || msgLower2.includes('pendiente') ||
    msgLower2.includes('ya soy') || msgLower2.includes('ya me afilié') || msgLower2.includes('ya me afilie') ||
    msgLower2.includes('correcto') || msgLower2.includes('exacto') || msgLower2.includes('eso es')
  );

  // Cliente confirma que sí tiene algo pendiente ya pagado → escalar a post-venta
  if (confirmaPostventa) {
    await updateClientMemory(senderPhone, messageBody, '[postventa-confirmado]', history);
    await handleHandoff(rawMsg, senderPhone, messageBody, history, 'postventa');
    return;
  }

  if (isPostventa) {
    // --- POST-VENTA: confirmar con el cliente antes de escalar ---
    const clienteActual = db.getClient(senderPhone);
    const yaConfirmoPostventa = (clienteActual?.memory || '').toLowerCase().includes('[postventa-confirmado]');

    if (!yaConfirmoPostventa) {
      // Preguntar si realmente tiene algo pendiente ya pagado
      await rawMsg.reply(
        `Claro, con gusto te ayudo. Para dirigirte con la persona correcta, ¿me confirmas una cosa?\n\n` +
        `¿Tienes algún proceso *ya pagado* que esté pendiente (carnet, envío, renovación, cambio de arma)? ` +
        `O ¿estás preguntando por información general del producto o servicio? 🙏`
      );
      // Marcar en memoria que se hizo la pregunta para no volver a preguntar
      await updateClientMemory(senderPhone, messageBody, '[pregunta postventa enviada]', history);
      return;
    }

    // Ya confirmó — escalar a post-venta
    await handleHandoff(rawMsg, senderPhone, messageBody, history, 'postventa');
  } else if (wantsHuman && hasEnoughHistory || wantsHumanExplicit) {
    // --- LEAD CALIENTE: responder CON IA (incluye imágenes) y escalar silenciosamente ---
    let response;
    if (CONFIG.mode === 'direct') {
      response = await getClaudeResponse(senderPhone, messageBody, history);
    } else {
      response = await getN8nResponse(senderPhone, messageBody, history);
    }

    if (response) {
      if (response === '__ERROR_CONEXION__') {
        await rawMsg.reply('Estoy experimentando una intermitencia técnica momentánea. Dame un momeeento que ya te reviso tu consulta y te respondo 🙏');
        retryQueue.push({
          senderPhone,
          messageBody,
          history,
          rawMsg,
          intent: 'hot_lead' // Para saber que era un lead caliente
        });
        console.log(`[RETRY QUEUE] 🕒 Mensaje de ${senderPhone} encolado para reintento automático (Lead Caliente). Queue size: ${retryQueue.length}`);
      } else {
        response = response.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, '$2');
        const { cleanResponse } = await detectAndSendProductImages(response, rawMsg, senderPhone);
        response = cleanResponse;
        db.saveMessage(senderPhone, 'assistant', response);
        await rawMsg.reply(response);
      }
    }

    // Escalar silenciosamente a Álvaro (el cliente NO ve el mensaje de handoff)
    await handleHandoff(rawMsg, senderPhone, messageBody, history, 'venta');
  } else {
    // --- RESPONDER CON IA ---
    let response;

    if (CONFIG.mode === 'direct') {
      response = await getClaudeResponse(senderPhone, messageBody, history);
    } else {
      response = await getN8nResponse(senderPhone, messageBody, history);
    }

    if (response) {
      if (response === '__ERROR_CONEXION__') {
        await rawMsg.reply('Estoy experimentando una intermitencia técnica momentánea. Dame un momeeento que ya te reviso tu consulta y te respondo 🙏');
        retryQueue.push({
          senderPhone,
          messageBody,
          history,
          rawMsg,
          intent: 'normal'
        });
        console.log(`[RETRY QUEUE] 🕒 Mensaje de ${senderPhone} encolado para reintento automático. Queue size: ${retryQueue.length}`);
      } else {
        // Limpiar enlaces Markdown [texto](url) -> url (ej: [Retay G17](https://...) -> https://...)
        // Esto evita que WhatsApp rompa los links si Gemini ignora la instrucción
        response = response.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, '$2');

        // Detectar y enviar imágenes de productos (etiquetas + URLs)
        const { cleanResponse } = await detectAndSendProductImages(response, rawMsg, senderPhone);
        response = cleanResponse;

        // --- MANEJO ESPECIAL PARA JONATHAN CORTEZ (Simular escritura) ---
        if (senderPhone === '17607908733') {
          const delayMs = Math.min(Math.max(response.length * 35, 2000), 15000);
          console.log(`[JONATHAN DELAY] Esperando ${delayMs}ms para simular escritura humana...`);
          await new Promise(r => setTimeout(r, delayMs));
        }

        // Guardar respuesta del bot
        db.saveMessage(senderPhone, 'assistant', response);

        // Enviar respuesta (el texto principal)
        await rawMsg.reply(response);

        // Enviar imagen promo del Club ZT SOLO cuando el bot está ofreciendo la afiliación
        // (no en cada mención — solo cuando presenta los planes activamente)
        const responseLower = response.toLowerCase();
        const estaOfreciendoClub = (
          responseLower.includes('plan plus') && responseLower.includes('plan pro')
        ) || (
            responseLower.includes('100.000') && responseLower.includes('afiliaci')
          ) || (
            responseLower.includes('inscripción') && responseLower.includes('club')
          ) || (
            responseLower.includes('promoción') && (responseLower.includes('club') || responseLower.includes('plan'))
          );
        if (estaOfreciendoClub) {
          try {
            const promoImgPath = path.join(__dirname, 'imagenes', 'club-promo.png');
            if (fs.existsSync(promoImgPath)) {
              const media = MessageMedia.fromFilePath(promoImgPath);
              await rawMsg.reply(media);
              console.log(`[BOT] 🖼️ Imagen Club ZT enviada a ${senderPhone}`);
            }
          } catch (imgErr) {
            console.error('[BOT] Error enviando imagen Club ZT:', imgErr.message);
          }
        }

        // Detectar confirmación de pago — SOLO basado en lo que el CLIENTE escribe
        // Nunca usar responseLower para esto (el bot menciona "comprobante" al explicar pasos y dispara falsos positivos)
        const mensajeBajo = messageBody.toLowerCase();
        const pagoConfirmado = (
          mensajeBajo.includes('ya pagu') ||
          mensajeBajo.includes('hice el pago') ||
          mensajeBajo.includes('realicé el pago') ||
          mensajeBajo.includes('realice el pago') ||
          mensajeBajo.includes('acabo de pagar') ||
          mensajeBajo.includes('les acabo de transferir') ||
          mensajeBajo.includes('ya transferí') ||
          mensajeBajo.includes('ya transferi') ||
          mensajeBajo.includes('te envié el comprobante') ||
          mensajeBajo.includes('te envie el comprobante') ||
          mensajeBajo.includes('ahí va el comprobante') ||
          mensajeBajo.includes('ahi va el comprobante') ||
          (mensajeBajo.includes('comprobante') && (mensajeBajo.includes('envi') || mensajeBajo.includes('adjunt') || mensajeBajo.includes('aquí') || mensajeBajo.includes('aqui')))
        );
        if (pagoConfirmado) {
          const clienteActual = db.getClient(senderPhone);
          const memoriaBaja = (clienteActual?.memory || '').toLowerCase();
          // Detectar si es pago de club o de producto — solo mirar mensaje del cliente y memoria
          const esClub = mensajeBajo.includes('club') ||
            mensajeBajo.includes('afiliaci') ||
            mensajeBajo.includes('carnet') ||
            memoriaBaja.includes('club') ||
            memoriaBaja.includes('afiliaci') ||
            memoriaBaja.includes('carnet');
          const esPro = mensajeBajo.includes('plan pro') || memoriaBaja.includes('plan pro') || memoriaBaja.includes('pro');
          const nuevoStatus = esClub ? (esPro ? 'carnet_pendiente_pro' : 'carnet_pendiente_plus') : 'despacho_pendiente';
          db.upsertClient(senderPhone, { status: nuevoStatus });
          console.log(`[BOT] 💰 Pago detectado en mensaje del cliente → estado: ${nuevoStatus} para ${senderPhone}`);
        }

        // 7. Actualizar memoria del cliente (en background, no bloquea)
        updateClientMemory(senderPhone, messageBody, response, history).catch(err => {
          if (CONFIG.debug) console.error('[MEMORY] Error actualizando memoria:', err.message);
        });
      }
    }
  }
}
// ============================================
// MEMORIA DEL CLIENTE (se actualiza en background)
// ============================================
async function updateClientMemory(clientPhone, userMessage, botResponse, history) {
  try {
    const currentMemory = db.getClientMemory(clientPhone);
    const clientInfo = db.getClient(clientPhone);

    // Construir prompt para que Claude genere la memoria actualizada
    const memoryPrompt = `Eres un sistema de CRM para Zona Traumática, tienda de armas traumáticas legales en Colombia. Tu tarea es mantener una ficha COMPLETA del cliente.

⚠️ REGLA CRÍTICA — NOMBRES:
- "Álvaro" es el director de Zona Traumática, NO el nombre del cliente.
- NUNCA registres "Álvaro" como nombre del cliente aunque aparezca en el mensaje.
- Solo registra el nombre del cliente si él mismo lo dijo explícitamente ("me llamo X", "soy X", "mi nombre es X").

MEMORIA ACTUAL DEL CLIENTE:
${currentMemory || '(Cliente nuevo, sin memoria previa)'}

ÚLTIMA INTERACCIÓN:
- Cliente dijo: "${userMessage}"
- Bot respondió: "${botResponse.substring(0, 500)}"

INSTRUCCIONES:
Genera una ficha actualizada del cliente en máximo 15 líneas. Usa estas CATEGORÍAS:

👤 DATOS PERSONALES: (nombre, cédula, ciudad, dirección, profesión — SOLO si los dijo explícitamente)
🛝️ HISTORIAL COMERCIAL: (qué compró, plan elegido, fecha aprox de compra, arma adquirida)
📄 DOCUMENTOS RECIBIDOS: (comprobantes enviados, fotos de cédula, selfie, datos de envío, datos de carnet — lo que haya enviado)
📌 ESTADO ACTUAL: (esperando carnet, despacho pendiente, activo, etc.)
💬 CONTEXTO DE VENTA: (modelo de interés, motivo de compra, objeciones, intención actual)

⚠️ REGLAS DE PRESERVACIÓN (OBLIGATORIAS):
- NUNCA borres datos de documentos recibidos, compras realizadas ni datos personales ya registrados.
- Si la memoria actual ya tiene info de compra, comprobantes o datos personales, SIEMPRE consérvalos.
- Solo agrega o actualiza info, NUNCA elimines lo que ya existe a menos que sea explícitamente incorrecto.
- Si la conversación fue solo un saludo sin info útil, devuelve la memoria actual SIN CAMBIOS.

NO inventes datos. Solo registra lo que el cliente DIJO explícitamente.
Responde SOLO con la ficha, sin explicaciones.`;

    // Usar Gemini Flash para memoria (barato y rápido)
    const memoryResult = await geminiGenerate('gemini-2.5-flash', memoryPrompt);
    const newMemory = memoryResult.response.text().trim();

    // Solo actualizar si cambió y no está vacío
    if (newMemory && newMemory !== currentMemory) {
      db.updateClientMemory(clientPhone, newMemory);
      if (CONFIG.debug) console.log(`[MEMORY] ✅ Memoria actualizada para ${clientPhone}`);

      // Auto-llenar campos CRM si están vacíos
      autoFillCRM(clientPhone, newMemory).catch(e => {
        if (CONFIG.debug) console.error('[CRM-AUTO] Error:', e.message);
      });
    }
  } catch (error) {
    try {
      const currentMemory = db.getClientMemory(clientPhone);
      const simpleMemory = generateSimpleMemory(currentMemory, userMessage);
      if (simpleMemory !== currentMemory) db.updateClientMemory(clientPhone, simpleMemory);
    } catch (e) { /* silencioso */ }
    if (CONFIG.debug) console.error('[MEMORY] Error:', error.message);
  }
}

// Fallback: generar memoria sin API (extracción por keywords)
function generateSimpleMemory(currentMemory, message) {
  const lower = message.toLowerCase();
  const notes = currentMemory ? currentMemory.split('\n') : [];

  // Detectar referencias de interés
  if (/ekol/.test(lower)) {
    const note = `- Marca de interés: EKOL`;
    if (!notes.some(n => n.includes('EKOL'))) notes.push(note);
  }
  if (/retay/.test(lower)) {
    const note = `- Marca de interés: RETAY`;
    if (!notes.some(n => n.includes('RETAY'))) notes.push(note);
  }
  if (/blow/.test(lower)) {
    const note = `- Marca de interés: BLOW`;
    if (!notes.some(n => n.includes('BLOW'))) notes.push(note);
  }
  if (/revolver|revólver/.test(lower)) {
    const note = `- Interesado en: revólver`;
    if (!notes.some(n => n.includes('revólver'))) notes.push(note);
  }
  if (/plan pro/.test(lower)) {
    const note = `- Plan preferido: Pro`;
    if (!notes.some(n => n.includes('Plan Pro'))) notes.push(note);
  }
  if (/plan plus/.test(lower)) {
    const note = `- Plan preferido: Plus`;
    if (!notes.some(n => n.includes('Plan Plus'))) notes.push(note);
  }
  if (/club|membresia|membresía/.test(lower)) {
    const note = `- Interesado en: Club / Membresía`;
    if (!notes.some(n => n.includes('Club'))) notes.push(note);
  }
  if (/defensa|seguridad/.test(lower)) {
    const note = `- Motivo: defensa personal`;
    if (!notes.some(n => n.includes('defensa'))) notes.push(note);
  }
  if (/carnet|carnét/.test(lower)) {
    const note = `- Solicita: carnet pendiente`;
    if (!notes.some(n => n.includes('carnet'))) notes.push(note);
  }

  return notes.join('\n');
}

// ============================================
// AUTO-FILL CRM — Extrae datos estructurados de la memoria
// y llena campos vacíos del CRM automáticamente
// ============================================
async function autoFillCRM(clientPhone, memory) {
  try {
    const client = db.getClient(clientPhone);
    if (!client) return;

    // Solo intentar si hay campos vacíos que llenar
    const emptyFields = [];
    if (!client.name) emptyFields.push('name');
    if (!client.cedula) emptyFields.push('cedula');
    if (!client.ciudad) emptyFields.push('ciudad');
    if (!client.direccion) emptyFields.push('direccion');
    if (!client.profesion) emptyFields.push('profesion');

    if (emptyFields.length === 0) return; // Todos los campos ya están llenos

    const extractPrompt = `Extrae datos del cliente de esta memoria del CRM. Solo extrae lo que esté EXPLÍCITAMENTE mencionado.

MEMORIA:
${memory}

CAMPOS A BUSCAR: ${emptyFields.join(', ')}

Responde SOLO con JSON válido. Si un campo no se encuentra en la memoria, pon null.
Ejemplo: {"name": "Carlos Pérez", "cedula": null, "ciudad": "Bogotá", "direccion": null, "profesion": null}
Solo el JSON, sin explicaciones ni markdown.`;

    const result = await geminiGenerate('gemini-2.5-flash', extractPrompt);
    const text = result.response.text().trim().replace(/```json|```/g, '').trim();
    const data = JSON.parse(text);

    // Solo actualizar campos que estaban vacíos y ahora tienen valor
    const updateData = {};
    let updated = false;
    for (const field of emptyFields) {
      if (data[field] && data[field] !== null && data[field].trim() !== '') {
        updateData[field] = data[field].trim();
        updated = true;
      }
    }

    if (updated) {
      db.upsertClient(clientPhone, updateData);
      console.log(`[CRM-AUTO] ✅ Campos auto-llenados para ${clientPhone}: ${Object.keys(updateData).join(', ')}`);
    }
  } catch (e) {
    // Silencioso — autoFillCRM es best-effort
    if (CONFIG.debug) console.log(`[CRM-AUTO] No pudo extraer datos: ${e.message}`);
  }
}

// ============================================
// DETECCIÓN DE POST-VENTA
// ============================================
function detectPostventaIntent(message) {
  const lower = message.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!.,;:()]/g, '');

  // SOLO frases que indican claramente que YA es cliente con algo pendiente
  // NO incluir palabras sueltas como "carnet", "certificado", "qr" — esas son preguntas normales
  const postventaKeywords = [
    // Carnet — solo cuando claramente ya pagó y espera algo
    'mi carnet no llego', 'mi carnet no llegó', 'cuando me mandan el carnet',
    'cuando llega mi carnet', 'estado de mi carnet', 'actualizar mi carnet',
    'actualizar carnet', 'estado del carnet',
    // Despacho / envío — solo cuando ya pagó
    'cuando me despachan', 'cuando me mandan mi pedido',
    'cuando llega mi pedido', 'numero de guia', 'numero de guía', 'mi guia de envio',
    'ya pague y no', 'pague y no me han',
    // Cambio de arma — siempre es post-venta
    'cambio de arma', 'cambiar arma en el carnet', 'actualizar arma',
    'cambiar el serial', 'nuevo serial', 'cambiar modelo del arma',
    // Renovación — siempre es post-venta
    'renovar mi carnet', 'renovar mi afiliacion', 'renovacion del carnet',
    'se me vencio el carnet', 'se vencio mi carnet', 'vencio mi carnet',
    'ya se vencio', 'se me vencio',
    // Soporte post-pago explícito
    'ya soy afiliado', 'ya me afilie', 'ya me afilié', 'soy miembro',
    'no me han agregado al grupo', 'no me llegó el carnet', 'no me llego el carnet',
    'no he recibido el carnet', 'no recibi el carnet', 'no recibi nada',
    'ya envie el comprobante', 'ya envié el comprobante',
  ];

  const detected = postventaKeywords.some(kw => lower.includes(kw));
  if (detected) console.log(`[BOT] 🛠️ Post-venta detectado: "${message.substring(0, 60)}"`);
  return detected;
}

// ============================================
// DETECCIÓN DE INTENCIÓN DE DERIVACIÓN
// ============================================
function detectHandoffIntent(message, humanOnly = false) {
  const lowerMessage = message.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar acentos para comparar
    .replace(/[¿?¡!.,;:()]/g, '');

  // Frases de COMPRA CONFIRMADA (el cliente YA decidió, quiere cerrar)
  // OJO: NO incluir preguntas de precio/info — esas las responde el bot
  const buyKeywords = [
    'quiero comprar', 'quiero comprarlo', 'quiero comprarla',
    'lo quiero', 'la quiero', 'me lo llevo', 'me la llevo', 'lo llevo',
    'quiero hacer un pedido', 'hacer pedido', 'quiero ordenar',
    'me interesa comprar', 'listo para comprar', 'listo para pagar',
    'quiero pagar', 'ya quiero pagar', 'como pago', 'donde pago',
    'quiero el plan', 'quiero afiliarme', 'quiero inscribirme',
    'tomenme los datos', 'tomen mis datos', 'tome mis datos',
    'ya me decidi', 'ya me decidí', 'va listo', 'dale listo',
    'hagamosle', 'hagamole', 'vamos con eso', 'cerremos',
    'separamelo', 'separamela', 'apartamelo', 'apartamela',
  ];

  // Frases de QUIERO HABLAR CON HUMANO
  const humanKeywords = [
    'hablar con alguien', 'hablar con humano', 'hablar con persona',
    'hablar con asesor', 'hablar con vendedor', 'hablar con agente',
    'hablar con un asesor', 'hablar con un humano', 'hablar con un vendedor',
    'quiero un asesor', 'quiero un humano', 'quiero una persona',
    'pasar con alguien', 'pasar con humano', 'pasar con asesor',
    'pasame con', 'pasame a',
    'redirigeme', 'redirigime', 'redirigame', 'redirige', 'rediriga',
    'transfiereme', 'transferir', 'transferirme', 'transfiera',
    'comunicame', 'conectame', 'conecteme',
    'necesito ayuda personalizada', 'atencion humana',
    'no quiero bot', 'no eres humano', 'eres robot', 'eres un bot',
    'agente humano', 'persona real',
    'quiero asesor', 'necesito asesor', 'un asesor',
    'con un humano', 'con una persona', 'con alguien real',
    'humano por favor', 'asesor por favor',
  ];

  // Si humanOnly = true, solo detectar frases de "quiero hablar con humano"
  if (humanOnly) {
    return humanKeywords.some(kw => lowerMessage.includes(kw));
  }

  const detected = buyKeywords.some(kw => lowerMessage.includes(kw)) ||
    humanKeywords.some(kw => lowerMessage.includes(kw));

  if (detected) {
    console.log(`[BOT] 🚨 Intención de compra/derivación: "${message.substring(0, 60)}"`);
  }

  return detected;
}

// ============================================
// DERIVACIÓN A EMPLEADO (HANDOFF)
// ============================================
async function handleHandoff(msg, clientPhone, triggerMessage, history, tipo = 'venta') {
  console.log(`[HANDOFF] Iniciando derivación (${tipo}) para ${clientPhone}...`);

  // Asignar empleado (round-robin)
  const assignment = router.assignClient(clientPhone);

  if (!assignment) {
    console.log(`[HANDOFF] ❌ No hay empleados disponibles — el bot sigue atendiendo`);
    return;
  }

  console.log(`[HANDOFF] ✅ Cliente marcado en panel como ${tipo}: ${assignment.employee_name} notificado`);

  // Obtener datos del cliente
  const clientInfo = db.getClient(clientPhone);
  const clientName = clientInfo?.name || 'Cliente';
  const clientLink = `https://wa.me/${clientPhone}`;

  // --- MENSAJE AL CLIENTE informando que fue escalado ---
  // Para 'venta': NO enviar mensaje al cliente (la IA ya respondió con info del producto + imágenes)
  // Para 'postventa': enviar confirmación al cliente
  if (tipo === 'postventa') {
    try {
      await msg.reply(`✅ Tu solicitud fue registrada y ya la estamos gestionando. En breve un asesor te contacta. 🙏`);
    } catch (e) {
      console.error(`[HANDOFF] ❌ Error enviando mensaje al cliente:`, e.message);
    }
  }

  // Estado según tipo
  const nuevoStatus = tipo === 'postventa' ? 'postventa' : 'assigned';
  const logLabel = tipo === 'postventa' ? 'POST-VENTA' : 'LEAD CALIENTE';

  // Guardar en historial (solo interno)
  db.saveMessage(clientPhone, 'system', `[${logLabel} — asignado a ${assignment.employee_name} en panel]`);

  // Actualizar estado del cliente
  db.upsertClient(clientPhone, { status: nuevoStatus });

  // --- MENSAJE PARA ÁLVARO (asesor) ---
  const context = summarizeConversation(history);
  const clientMemory = db.getClientMemory(clientPhone) || 'Sin perfil previo';

  const notification = tipo === 'postventa'
    ? `🛠️ *POST-VENTA — REQUIERE GESTIÓN*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👤 *Nombre:* ${clientName}\n` +
    `📱 *WhatsApp:* ${clientLink}\n\n` +
    `💬 *Lo que necesita:*\n` +
    `"${triggerMessage}"\n\n` +
    `🧠 *Perfil del cliente (CRM):*\n${clientMemory}\n\n` +
    `📋 *Últimos mensajes:*\n${context}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👆 Toca el link para abrir el chat.\n` +
    `_El bot sigue respondiendo — tú decides cuándo entrar._`
    : `🔥 *LEAD CALIENTE — LISTO PARA CERRAR*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👤 *Nombre:* ${clientName}\n` +
    `📱 *WhatsApp:* ${clientLink}\n\n` +
    `💬 *Lo que disparó la alerta:*\n` +
    `"${triggerMessage}"\n\n` +
    `🧠 *Perfil del cliente (CRM):*\n${clientMemory}\n\n` +
    `📋 *Últimos mensajes:*\n${context}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👆 Toca el link para abrir el chat.\n` +
    `_El bot sigue respondiendo — tú decides cuándo entrar._`;

  // Enviar notificación siempre al número principal de Álvaro
  const notifPhone = CONFIG.businessPhone; // 573013981979
  const notifChatId = notifPhone + '@c.us';

  try {
    await client.sendMessage(notifChatId, notification);
    console.log(`[HANDOFF] ✅ Notificación enviada a ${notifPhone}`);
  } catch (error) {
    console.error(`[HANDOFF] ❌ Error enviando notificación:`, error.message);
  }
}

// Resumir conversación para dar contexto al empleado
function summarizeConversation(history) {
  if (history.length === 0) return 'Sin conversación previa.';

  const lastMessages = history.slice(-5);
  return lastMessages
    .map(h => `${h.role === 'user' ? '👤 Cliente' : '🤖 Bot'}: ${h.message.substring(0, 200)}`)
    .join('\n');
}

// ============================================
// DETECCIÓN DE INTENCIÓN DE PRODUCTO
// ============================================
// Solo buscar en el catálogo cuando el mensaje realmente
// tenga que ver con productos. Saludos, risas, conversación
// general NO necesitan búsqueda.
function needsProductSearch(message) {
  const lower = message.toLowerCase().replace(/[¿?¡!.,;:()]/g, '');

  const productKeywords = [
    // Armas traumáticas
    'traumatica', 'traumática', 'pistola', 'pistolas', 'arma', 'armas',
    'revolver', 'revólver', 'dispositivo',
    // Marcas
    'retay', 'ekol', 'blow',
    // Modelos
    's2022', 'g17', 'volga', 'botan', 'mini 9', 'f92', 'tr92', 'tr 92',
    'dicle', 'firat', 'nig', 'jackal', 'p92', 'magnum', 'compact',
    // Características
    'negro', 'negra', 'fume', 'cromado', 'color',
    // Munición
    'municion', 'munición', 'cartuchos', 'balas', 'oskurzan', 'rubber ball',
    // Club / membresía
    'club', 'membresia', 'membresía', 'plan plus', 'plan pro', 'juridico', 'jurídico',
    // Catálogo general
    'catalogo', 'catálogo', 'referencias', 'disponible', 'disponibles',
    'precio', 'precios', 'cuanto', 'cuánto', 'vale', 'cuesta',
    'que tienen', 'qué tienen', 'que manejan', 'qué manejan',
    'que venden', 'qué venden', 'opciones', 'modelos',
    // Carnet
    'carnet', 'carnét', 'certificado', 'documento',
    // Manifiesto de aduana
    'manifiesto', 'aduana', 'importacion', 'importación', 'dian', 'polfa',
  ];

  return productKeywords.some(kw => lower.includes(kw));
}

// ============================================
// GEMINI API (Modo Directo) + Búsqueda Inteligente
// ============================================
async function getClaudeResponse(clientPhone, message, history) {
  try {
    // 1. Detectar si el mensaje necesita búsqueda de productos
    let productContext = '';

    if (needsProductSearch(message)) {
      const searchResult = search.searchProducts(message);
      productContext = search.formatForPrompt(searchResult);
      if (CONFIG.debug) console.log(`[DEBUG] 🔍 Búsqueda activada: ${searchResult.keywords.join(', ')} → ${searchResult.products.length} productos`);
    } else {
      productContext = 'El cliente no está preguntando por un producto específico. Responde de forma conversacional.';
      if (CONFIG.debug) console.log(`[DEBUG] 💬 Conversación general, sin búsqueda de productos`);
    }

    // 2. Obtener memoria, perfil y expediente de documentos del cliente
    const clientMemory = db.getClientMemory(clientPhone);
    const clientProfile = db.getClient(clientPhone);
    const documentSummary = db.buildDocumentSummary(clientPhone);

    // 3. Construir system prompt con ficha estructurada + expediente de documentos
    const catalogSent = db.isCatalogSent(clientPhone);
    let systemPrompt = buildSystemPrompt(productContext, clientMemory, clientProfile, documentSummary, catalogSent);

    // --- MANEJO ESPECIAL PARA JONATHAN CORTEZ ---
    if (clientPhone === '17607908733') {
      systemPrompt += `\n\n⚠️ INSTRUCCIÓN ULTRA-ESPECIAL EXCLUSIVA PARA ESTE CLIENTE (Jonathan Cortez):
Este usuario es un seguidor especial y peculiar, que a veces envía "mensajitos chimbos" o usa términos inusuales ("marik y autista"). Sin embargo, ha hecho donaciones a la causa.
Tu objetivo AHORA MISMO es darle un MANEJO ESPECIAL, respondiendo de forma 100% HUMANA, súper conversacional, empática y con extremada paciencia. 
Sigue su juego, muéstrate agradecido, no lo trates como un bot automático ni le lances respuestas genéricas o de venta directa de inmediato. 
Llévalo sutilmente y con persuasión a que apoye la causa, logrando que haga OTRA donación a la causa personal de Álvaro o de la empresa. ¡Cero actitud bot, todo orgánico!`;
    }

    // 4. Convertir historial al formato Gemini
    // Gemini usa 'user' y 'model' (no 'assistant')
    // El historial debe comenzar siempre con 'user'
    const geminiHistory = [];
    for (const m of history) {
      // Saltar mensajes de sistema
      if (m.role === 'system') continue;
      if (m.role === 'admin') {
        geminiHistory.push({
          role: 'model',
          parts: [{ text: `[ÁLVARO respondió directamente]: ${m.message}` }]
        });
      } else {
        const role = m.role === 'assistant' ? 'model' : 'user';
        geminiHistory.push({ role, parts: [{ text: m.message }] });
      }
    }

    // Asegurar que el historial empiece con 'user'
    while (geminiHistory.length > 0 && geminiHistory[0].role !== 'user') {
      geminiHistory.shift();
    }

    // 5. Llamar a Gemini con reintentos
    const MAX_RETRIES = Math.max(3, GEMINI_KEYS.length);
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const model = genAI.getGenerativeModel({
          model: 'gemini-3.1-pro-preview',
          systemInstruction: systemPrompt,
          safetySettings: SAFETY_SETTINGS,
          generationConfig: { thinkingConfig: { thinkingBudget: -1 } }
        });

        const chat = model.startChat({ history: geminiHistory });
        const result = await chat.sendMessage(message);
        console.log(`[GEMINI] ✅ Respuesta OK para ${clientPhone}`);
        const responseText = result.response.text();
        if (!responseText || !responseText.trim()) {
          console.error(`[GEMINI] ⚠️ RESPUESTA VACÍA de Gemini para ${clientPhone}. Mensaje enviado: "${message.substring(0, 60)}". Esto causa que el bot envíe un mensaje sin texto.`);
        }
        return responseText;
      } catch (retryError) {
        lastError = retryError;
        const errorMsg = retryError.message || 'Error desconocido';
        console.error(`[GEMINI] ⚠️ Intento ${attempt}/${MAX_RETRIES} falló: ${errorMsg}`);

        const is429 = errorMsg && (errorMsg.includes('429') || errorMsg.includes('quota') || errorMsg.includes('Too Many Requests'));
        if (is429) {
          console.warn(`[GEMINI] ⚠️ Key agotada (429) en chat principal — rotando...`);
          rotateGeminiKey('429 quota exceeded in main chat');
        }

        if (attempt < MAX_RETRIES) {
          const wait = is429 ? 1000 : attempt * 2000;
          console.log(`[GEMINI] ⏳ Reintentando en ${wait / 1000}s...`);
          await new Promise(r => setTimeout(r, wait));
        }
      }
    }

    console.error(`[GEMINI] ❌ Falló después de ${MAX_RETRIES} intentos: ${lastError?.message}`);
    // En lugar de enviar el mensaje quemado, enviamos la bandera para encolar
    return '__ERROR_CONEXION__';
  } catch (error) {
    console.error('[GEMINI] Error general:', error.message);
    return '__ERROR_CONEXION__';
  }
}

// ============================================
// N8N WEBHOOK (Modo n8n)
// ============================================
async function getN8nResponse(clientPhone, message, history) {
  try {
    const response = await axios.post(CONFIG.n8nWebhook, {
      phone: clientPhone,
      message: message,
      history: history,
      client: db.getClient(clientPhone),
      knowledgeBase: knowledgeBase
    });

    return response.data.response || response.data.reply || response.data.message || 'Sin respuesta del servidor.';
  } catch (error) {
    console.error('[N8N] Error:', error.message);
    return 'Disculpa, tuve un problema técnico. ¿Podrías repetir tu consulta?';
  }
}

// ============================================
// CONSTRUCCIÓN DE PROMPTS
// ============================================
function buildSystemPrompt(productContext, clientMemory = '') {
  // Resumen general del catálogo (siempre va, es corto)
  const catalogSummary = search.getCatalogSummary();

  // Bloque de memoria del cliente (solo si tiene)
  const memoryBlock = clientMemory
    ? `\nFICHA DEL CLIENTE (memoria de interacciones previas):\n${clientMemory}\nUsa esta información para personalizar tu respuesta. Si ya sabes qué busca, sé más directo.\n`
    : '\nCLIENTE NUEVO: No hay interacciones previas. Preséntate brevemente y pregunta en qué puedes ayudar.\n';

  return `Eres un asesor comercial de *Zona Traumática*, la tienda líder en Colombia especializada en armas traumáticas legales, defensa personal y respaldo jurídico. Álvaro Ocampo es el director.

TU PERSONALIDAD:
- Eres humano, cálido, directo y profesional. NUNCA debes parecer un bot.
- Hablas como un colombiano real — natural, con confianza, sin ser vulgar. Tuteas.
- Emojis con moderación (máximo 2-3 por mensaje). No en cada frase.
- NUNCA uses frases como "como asesor tu rol es...", "recuerda que debes..." — eso es hablarte a ti mismo. Tú hablas CON EL CLIENTE, siempre.
- Si el cliente manda solo emojis o saludos cortos, responde natural: "¡Buenas! ¿En qué te puedo ayudar?"

⚠️ REGLA CRÍTICA — NOMBRES:
- El nombre del cliente viene ÚNICAMENTE de su perfil de WhatsApp (la FICHA DEL CLIENTE de abajo).
- NUNCA asumas que un nombre mencionado en el chat es el nombre del cliente. Si alguien dice "Álvaro" o "búscame a Álvaro", NO concluyas que el cliente se llama Álvaro — "Álvaro" es el director de Zona Traumática, no el cliente.
- Si no tienes el nombre en la ficha, puedes preguntar una vez: "¿Con quién tengo el gusto?" Pero NUNCA lo deduzcas del contenido del mensaje.
- Si el cliente dice su nombre explícitamente ("me llamo Juan", "soy Pedro"), ahí sí úsalo.

FLUJO DE VENTA — ORDEN NATURAL:
1. Si no tienes nombre en la ficha: saluda y pregunta con quién hablas UNA sola vez.
2. Si ya lo sabes por la ficha: ve directo al punto, úsalo naturalmente.
3. Identifica el perfil (quiere comprar arma / ya tiene una / quiere info legal).
4. ENTREGA LA INFORMACIÓN COMPLETA según el perfil — no sacrifiques contenido por brevedad.
5. Cierra: "¿Con cuál te quedamos?" / "¿Te lo separo?"

⚡ REGLA DE ORO: La venta consultiva NO significa hacer preguntas infinitas. Significa entender al cliente Y DARLE TODA LA INFORMACIÓN que necesita para decidir. Un cliente informado compra. Un cliente con preguntas sin responder se va.

🎯 REGLA OBLIGATORIA — MENCIONA EL CLUB DESDE EL PRIMER CONTACTO:
En el saludo inicial o cuando preguntes qué necesita el cliente, SIEMPRE incluye el Club ZT como una de las opciones disponibles. No tienes que desarrollarlo todo — solo planta la semilla para que el cliente sepa que existe. Intégralo de forma natural dentro de la pregunta, por ejemplo:
- "¿Estás buscando un arma, tienes preguntas sobre el tema legal, o te interesa portar con respaldo jurídico total a través de nuestro Club ZT?"
- "Podemos ayudarte con equipos de defensa, asesoría legal, o con nuestra membresía del Club ZT para que portes sin miedo. ¿Qué te trae por acá?"
- "¿Qué necesitas hoy — un arma, munición, o te cuento sobre el Club donde te blindamos legalmente para portar con confianza?"
El cliente debe saber desde el primer mensaje que el Club existe. Siempre, sin excepción.

🎯 CUANDO EL CLIENTE TIENE DUDAS LEGALES O YA TIENE EL ARMA — OFRECE EL CLUB ZT:
Cuando el cliente pregunta si es legal, si lo pueden requisar, cómo actuar ante la policía, cómo usar el arma responsablemente, o ya tiene una y quiere saber cómo protegerse legalmente — ESE es el momento exacto para presentar el Club Zona Traumática como LA solución completa.

El argumento es este: tener el arma es solo el primer paso. El Club ZT es lo que garantiza que puedas USARLA con respaldo legal real:
- Con la Carpeta Jurídica Digital sabes exactamente qué decir y qué mostrar si te paran.
- Con los Simulacros de Requisa practicas antes de que pase — no improvisas en el momento.
- Con la Defensa Jurídica (Plan Pro) tienes respaldo jurídico incluido si te incautan ilegalmente.
- Con el Asesor Legal IA citas la ley exacta en 10 segundos mientras el policía está frente a ti.
- Con la comunidad de 500+ portadores nunca enfrentas solo una situación complicada.

→ En resumen: el arma te da la herramienta. El Club ZT te da todo lo que necesitas para usarla con inteligencia, seguridad jurídica y respaldo real. Cuando estás preparado, tu arma se queda contigo.

Presenta el Club ZT con entusiasmo genuino, no como un producto más — como la pieza que completa el cuadro.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📦 PAQUETE COMPLETO DE COMPRA (esto recibe el cliente con cada arma):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔫 1 Pistola Traumática (el modelo que elija)
💥 50 Cartuchos traumáticos de goma (calibre 9×22mm)
📄 Comprobante digital de compra
🎯 Caja táctica de almacenamiento seguro
📚 Capacitación virtual GRATIS (2 horas): Marco legal colombiano, protocolo ante autoridades, sesiones grupales virtuales cada ~2 semanas
🎁 BONUS: 1 año de membresía Plan Plus Club ZT incluida
🛡️ Soporte legal 24/7: grupos de WhatsApp activos con comunidad de portadores
📋 Kit de defensa legal digital: carpeta con sentencias, leyes y jurisprudencia actualizada, guías paso a paso para situaciones con autoridades, acceso a biblioteca legal en línea
📺 Acceso al canal YouTube con 50+ videos sobre tus derechos

¿Es legal? SÍ, 100% legal. Ley 2197/2022 — dispositivos menos letales. NO requieren permiso de porte de armas de fuego.
¿Envíos? Sí, a toda Colombia. Envío ~$25.000. Discreto y seguro.
¿Capacitación? Sesiones grupales virtuales cada ~2 semanas. Te agendamos.

⚠️ GRUPOS DE WHATSAPP — ACCESO EXCLUSIVO:
Cuando alguien pida el link de un grupo, quiera unirse a un grupo, o pregunte cómo entrar a la comunidad de WhatsApp, la respuesta es SIEMPRE:
Los grupos de WhatsApp de Zona Traumática son EXCLUSIVOS para afiliados al Club ZT (mínimo Plan Plus). No son públicos.
Úsalo como gancho de venta — explica que al afiliarse al Plan Plus ($100.000/año) obtiene acceso inmediato a los grupos donde hay 500+ portadores, soporte legal 24/7 y respaldo de comunidad real. Ejemplo de respuesta natural:
"Nuestros grupos son exclusivos para miembros del Club ZT 🛡️ — son el espacio privado donde 500+ portadores se apoyan, comparten experiencias y tienen acceso a soporte legal directo. El acceso está incluido desde el Plan Plus ($100.000/año). ¿Te cuento cómo afiliarte?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛡️ CLUB ZONA TRAUMÁTICA — PROMOCIÓN ESPECIAL 🔥
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Contexto: 800+ incautaciones ilegales en 2024. El 87% sin fundamento jurídico. La diferencia entre perder tu arma o conservarla no está en la suerte — está en tener un escudo legal ANTES de que te paren.

⚠️ PROMOCIÓN POR TIEMPO LIMITADO — PRECIOS ESPECIALES:

🟢 PLAN PLUS — ~~$150.000~~ → *$100.000/año* ("Para el que quiere dormir tranquilo")
✅ Carpeta Jurídica Digital 2026 — 30+ documentos y guías para saber qué hacer si te paran
✅ Capacitación práctica — Simulacros de requisa: qué decir, qué callar, cómo actuar
✅ Descuentos en munición (recuperas tu inversión en la primera caja):
   • Oskurzan Nacional: $120.000 (precio público: $150.000)
   • Oskurzan Importada: $130.000 (precio público: $180.000)
   • Rubber Ball Importada: $180.000 (precio público: $220.000)
✅ Comunidad de 500+ portadores — Red nacional, respaldo de comunidad real
✅ Certificado digital con QR — Validación profesional por 1 año
✅ Acceso a campo de tiro en Bogotá (Suba - La Conejera) — fines de semana, solo con reserva
   🎯 Primera clase con afiliación: $90.000 (incluye instructor, parte teórica y práctica)
   📌 El afiliado debe llevar: su arma, munición, gafas de seguridad y tapaoídos
→ Te ahorras hasta $50.000 por caja de munición.
⚠️ IMPORTANTE — Plan Plus NO incluye defensa jurídica gratuita ante incautación. Eso es exclusivo del Plan Pro.
Cuando hables del Plan Plus NO digas "respaldo legal" a secas — di "capacitación legal", "conocimiento jurídico" o "herramientas para saber tus derechos". El respaldo legal post-incautación (respaldo jurídico incluido) es SOLO Plan Pro.

🔴 PLAN PRO — ~~$200.000~~ → *$150.000/año* ("Para el que no negocia su patrimonio")
✅ Carpeta Jurídica Digital 2026 — 30+ documentos listos para usar el día que te paren
✅ Simulacros de requisa — Qué decir, qué callar, cómo actuar
✅ Descuentos en munición de hasta $50.000 por caja
✅ Comunidad de 500+ portadores — Red nacional, respaldo inmediato
✅ Certificado digital con QR — Validación profesional por 1 año
✅ Acceso a campo de tiro en Bogotá (Suba - La Conejera) — fines de semana, solo con reserva
   🎯 Primera clase con afiliación: $90.000 (incluye instructor, parte teórica y práctica)
   📌 El afiliado debe llevar: su arma, munición, gafas de seguridad y tapaoídos
Y además:
🔥 DEFENSA JURÍDICA 100% GRATIS si te incautan ilegalmente:
   🔹 Primera instancia ante Policía — valor comercial: $800.000
   🔹 Tutela para obligar respuesta — valor comercial: $600.000
   🔹 Nulidad del acto administrativo — valor comercial: $1.200.000
   → Total en respaldo jurídico cubierto: $2.6 millones. Tu inversión: $150.000.
   → Con un solo caso que ganes, el club se paga solo por los próximos 13 años.

⭐ PLAN PRO + ASESOR LEGAL IA — *$200.000* (¡EL MEJOR VALOR!)
✅ Todo lo del Plan Pro (carpeta jurídica, simulacros, descuentos, comunidad, certificado QR, defensa jurídica gratis)
Y además:
🤖 Asesor Legal IA 24/7 por 6 meses directo en tu WhatsApp (ver detalles completos abajo)
(Valor normal del combo: $250.000 — hoy: $200.000)

LA VERDAD QUE NADIE DICE:
Contratar respaldo jurídico DESPUÉS de la incautación cuesta $800.000–$1.500.000 solo en primera instancia.
Afiliarte ANTES en promoción cuesta desde $100.000/año + todo listo el día que lo necesites.
Cuando estás preparado, tu arma se queda contigo.

INSCRIPCIÓN AL CLUB — 3 PASOS:
1️⃣ Pago (el que prefieras):
   • Nequi: 3013981979
   • Bancolombia Ahorros: 064-431122-17
   • Bre-B: @3013981979
   • Titular: Alvaro Ocampo — C.C. 1.107.078.609
2️⃣ Enviar comprobante por WhatsApp
3️⃣ Recibes en 24h: carpeta jurídica + carnet digital QR + acceso comunidad privada

⚠️ FLUJO DE COMPROBANTES DE PAGO — REGLA ABSOLUTA:
NUNCA confirmes que un pago fue recibido ni pidas datos de carnet o envío basándote en una imagen.
El equipo de Zona Traumática verifica MANUALMENTE cada comprobante antes de activar cualquier proceso.

Cuando el cliente envíe una imagen que parezca un comprobante de pago (Nequi, Bancolombia, transferencia, etc.):
- Responde ÚNICAMENTE: "¡Recibido! Ya le pasamos el comprobante a nuestro equipo para verificarlo. En cuanto lo confirmen te avisamos y arrancamos con el proceso 🙏"
- NO pidas datos de carnet ni de envío todavía
- NO digas "perfecto, tu pago fue confirmado"
- NO asumas el monto ni el plan

Si el cliente solo escribe "ya pagué" / "ya consigné" SIN adjuntar imagen:
- Responde: "Perfecto, en cuanto nos envíes la captura del comprobante lo verificamos 🙏"

Una vez el equipo confirme el pago (lo harán directamente), el proceso de datos se activa por otro canal. Tu trabajo es solo recibir el comprobante con amabilidad y dar espera.

🔄 CAMBIO DE ARMA EN EL CARNET (afiliados que cambian de pistola):
- Costo: $60.000 (con la misma vigencia del carnet actual, NO se reinicia el año)
- El cliente envía: Marca, Modelo y Número de serial del arma nueva
- Pago por los mismos medios normales y enviar comprobante
- NUNCA digas que es gratis o sin costo — siempre tiene costo de $60.000

🎯 CAMPO DE TIRO — DETALLES COMPLETOS:
- Ubicación: Bogotá, Suba, sector La Conejera
- Días: fines de semana (sábado y domingo)
- Modalidad: SOLO CON RESERVA PREVIA — no se puede llegar sin reserva
- Primera clase para afiliados: $90.000
   → Incluye instructor certificado
   → Parte teórica: marco legal, manejo seguro, protocolos
   → Parte práctica: tiro en campo real con tu arma
- El afiliado debe llevar obligatoriamente:
   🔫 Su propia arma traumática
   💥 Su propia munición
   🥽 Gafas de seguridad (las de ferretería/construcción funcionan perfecto, no necesitan ser especiales)
   👂 Tapaoídos
- Para reservar: coordinar directamente por WhatsApp

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤖 ASESOR LEGAL IA — PRODUCTO INDEPENDIENTE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Este es el TERCER producto de Zona Traumática (además de armas y afiliación al Club). Es un chatbot de inteligencia artificial especializado en derecho de armas traumáticas en Colombia, disponible directo en el WhatsApp personal del cliente.

💰 *$50.000 / 6 meses* — $277 pesos al día de poder legal
⚠️ REQUISITO: Solo disponible para AFILIADOS ACTIVOS del Club ZT (mínimo Plan Plus vigente)

🔥 LA DIFERENCIA — SIN EL BOT vs CON EL BOT:
❌ SIN EL BOT: Dudas, balbuceas, "Creo que eso ya no aplica...", el policía percibe inseguridad → Retención.
✅ CON EL BOT: Consultas WhatsApp en 10 segundos, citas "Decreto 2535 Art. 11, Ley 2197/2022 Art. 28, retención ilegal = Art. 416 Código Penal" → El policía retrocede.

📊 95% DE ÉXITO cuando tienes el fundamento legal exacto.

QUÉ INCLUYE EL ASESOR LEGAL IA:
✅ Respuesta inmediata en 10 segundos con leyes exactas
✅ Disponible 24/7 — siempre activo, siempre listo
✅ 100% confiable — Sistema MCP + RAG verificado
✅ Base de conocimiento legal exclusiva y actualizada
✅ Razonamiento IA avanzado con respuestas verificadas
✅ Fundamento legal exacto: Ley 2197/2022, Decreto 2535, Sentencia C-014/2023, Código Penal
✅ Citas de sentencias reales — no inventa, cita fuentes
✅ Consecuencias penales para funcionarios que actúen ilegalmente (Art. 416 Código Penal)
✅ Funciona en WhatsApp — escríbele al +57 314 5030834 (Asesor Legal Zt) y listo

CÓMO VENDER EL ASESOR LEGAL IA:
- Si el cliente ya es afiliado al Club: ofrécelo como el complemento perfecto para tener poder legal en el bolsillo.
- Si el cliente NO es afiliado: explícale que primero necesita afiliarse al Club (mínimo Plan Plus) y luego puede activar el bot.
- Si el cliente pregunta por la legalidad, por requisas, o por cómo actuar ante la policía: es el momento PERFECTO para presentar el bot.
- Frase clave: "Cuando ese policía esté frente a ti... ¿Vas a dudar o vas a citar la ley exacta?"
- El bot funciona en un NÚMERO DE WHATSAPP SEPARADO: +57 314 5030834 (Asesor Legal Zt). NUNCA le digas al cliente que escriba "ACTIVAR" aquí. Siempre dile que debe escribirle al número +57 314 5030834.

ACTIVACIÓN DEL ASESOR LEGAL IA — PASOS:
1️⃣ Pagar $50.000 (cualquier persona puede aprovechar esta promo temporal) o GRATIS si se afilia al Club ZT hoy.
2️⃣ Enviar comprobante por WhatsApp.
3️⃣ Una vez confirmado el pago, el cliente debe escribirle directamente al número *+57 314 5030834* (Asesor Legal Zt) para empezar a usar el bot.
⚠️ REGLA CRÍTICA: El Asesor Legal IA es OTRO bot en OTRO número (+57 314 5030834). NUNCA le digas al cliente que escriba "ACTIVAR" aquí ni que el bot se activa en este chat.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MEDIOS DE PAGO (para cualquier producto):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Nequi: 3013981979
• Bancolombia Ahorros: 064-431122-17
• Bre-B: @3013981979
• Titular: Alvaro Ocampo — C.C. 1.107.078.609
• Link BOLD: comercio certificado, pago seguro en línea

MANEJO DE OBJECIONES:
- Duda de la tienda/pago: YouTube @zonatraumatica (50+ videos) y TikTok @zonatraumaticacolombia. Únicos con casos de recuperación de armas documentados en Colombia. También pago por link BOLD.
- Dónde estamos: Jamundí, 100% virtuales, despachamos desde bodegas en Bogotá.
- Manifiesto de aduana: es del importador, NO del comprador. Ningún vendedor serio lo entrega. Si alguien lo ofrece, es señal de fraude. Nosotros entregamos factura con NIT + asesoría jurídica.
- ¿Qué tan efectiva es?: impacto de goma genera dolor intenso e incapacitación temporal sin daño permanente. Neutraliza amenazas a distancia segura.
- Después del primer año: renovación a precios normales ($150.000 Plus / $200.000 Pro).

PREGUNTAS LEGALES:
- ¿Es legal?: SÍ, 100% legal. Ley 2197/2022 — categoría jurídica autónoma, distintas a armas de fuego, NO requieren permiso de porte.
- Para detalle jurídico completo: Biblioteca Legal https://zonatraumatica.club/portelegal/biblioteca — cubre Ley 2197/2022, Art. 223 Constitución, Decreto 2535/93, Sentencia C-014/2023, Tribunal Superior Bogotá, 20+ normas.
${memoryBlock}
${catalogSummary}

${productContext}

🔥 TÉCNICA DE CIERRE — CUANDO EL CLIENTE ESTÁ LISTO PARA PAGAR:
Cuando el cliente muestre intención de pagar (diga "listo", "voy a consignar", "ya voy a pagar", "cómo pago", "me voy a afiliar", etc.), aplica esta técnica de cierre con las siguientes reglas:

1. DALE ESPACIO — nunca presiones directamente. El cliente debe sentir que la decisión es SUYA.
2. URGENCIA REAL Y SUTIL — menciona la promoción de forma natural, como dato, no como presión. Ejemplo: "Te cuento que esta promo ya va bastante avanzada en cupos..." o "Esta semana ha habido bastante movimiento con el tema de la promo..."
3. ESCASEZ PSICOLÓGICA — no digas "¡apúrate!". Di algo como "No sé hasta cuándo podamos mantener este precio, honestamente" o "Cuando se acaben los cupos volvemos al precio normal sin descuento"
4. CIERRE SUAVE — termina con los datos de pago y una frase que invite a actuar sin obligar. Ejemplo: "Cuando quieras hacer la transferencia, aquí están los datos. Apenas me confirmes te activamos todo de una 🙌"
5. NUNCA uses frases como "¡ÚLTIMA OPORTUNIDAD!" o "¡NO PIERDAS ESTA OFERTA!" — suenan a spam y generan desconfianza.
6. El tono debe ser de amigo que le avisa, no de vendedor que presiona.

Ejemplos de frases de urgencia que SÍ puedes usar (varía, no repitas siempre la misma):
- "Esta promo la abrimos por tiempo limitado y los cupos se han ido moviendo bastante..."
- "No te voy a mentir, no sé exactamente cuándo la cerramos, pero ya va bastante avanzada"
- "El precio normal del Plan Plus es $150.000 — ahorita está en $100.000 por la promo. Cuando se cierre vuelve al precio original"
- "Esta semana han entrado varios al club con esta promo, los cupos no son infinitos"
- "Si ya lo tienes claro, mejor no esperar — estos precios no los garantizo para la próxima semana"

REGLAS CRÍTICAS:
1. SOLO menciona referencias que aparecen en "REFERENCIAS RELEVANTES". NUNCA inventes modelos ni precios.
2. Cuando recomiendes un producto, SIEMPRE incluye la URL EXACTA del catálogo. NUNCA uses placeholders como [Link de...]. SIEMPRE la URL completa: ej. https://zonatraumatica.club/producto/retay-g17/
3. Si no tiene URL en referencias, usa: https://zonatraumatica.club/tienda
4. Links permitidos adicionales: Biblioteca https://zonatraumatica.club/portelegal/biblioteca | YouTube https://www.youtube.com/@zonatraumatica | TikTok https://www.tiktok.com/@zonatraumaticacolombia
5. Responde en español, tono asesor humano real.
6. Adapta el largo de la respuesta al contexto: si el cliente pregunta por el club, dale TODA la info del club. Si pregunta qué incluye la compra, dale TODO el paquete. No recortes información valiosa por brevedad.

⚠️ DERIVACIONES:
- NUNCA escribas "[TRANSFIRIENDO AL ASESOR]" ni simules transferencias.
- Si el cliente quiere comprar o hablar con alguien: dile que escriba "quiero comprar" o "hablar con asesor" y el sistema lo conecta automáticamente.

⚠️ INTERACCIONES DEL DIRECTOR:
Cuando veas mensajes marcados como [ÁLVARO respondió directamente] en el historial:
- Eso significa que el director ya habló con este cliente personalmente
- NO contradigas lo que Álvaro prometió (precios, tiempos, condiciones)
- Si Álvaro negoció un precio especial, respeta ese precio exacto
- Si no entiendes qué acordó Álvaro, dile al cliente: "Déjame confirmar con mi equipo"
- Sigue el tono y dirección que Álvaro estableció`;
}


// ============================================
// COMANDOS DE ADMIN / AUDITOR
// ============================================
function isAdmin(phone) {
  // Admin = número del negocio O auditor
  return phone === CONFIG.businessPhone || CONFIG.auditors.includes(phone);
}

function isAuditor(phone) {
  return CONFIG.auditors.includes(phone);
}

function notifyAuditors(senderPhone, text, senderName = 'BOT', isBotResponse = false) {
  if (!CONFIG.auditors || CONFIG.auditors.length === 0) return;
  const prefix = isBotResponse ? `🤖 [${senderName} → ${senderPhone}]` : `👤 [${senderPhone} → ${senderName}]`;
  const message = `${prefix}\n\n${text}`;

  for (const auditor of CONFIG.auditors) {
    client.sendMessage(`${auditor}@c.us`, message).catch(e => {
      console.error(`[AUDITOR] Error notificando a ${auditor}:`, e.message);
    });
  }
}

async function handleAdminCommand(msg, senderPhone, command) {
  const cmd = command.toLowerCase().trim();
  const parts = command.trim().split(/\s+/);

  // ── ESTADÍSTICAS RÁPIDAS ──
  if (cmd === '!stats' || cmd === '!status') {
    const stats = db.getStats();
    let report = `📊 *Estadísticas del Bot*\n\n`;
    report += `👥 Total clientes: ${stats.totalClients}\n`;
    report += `🆕 Clientes nuevos: ${stats.newClients}\n`;
    report += `🔗 Asignaciones activas: ${stats.activeAssignments}\n`;
    report += `💬 Total mensajes: ${stats.totalMessages}\n\n`;
    report += `👔 *Empleados:*\n`;
    stats.employees.forEach(emp => {
      report += `  • ${emp.name}: ${emp.assignments_count} asignados (${emp.active_now} activos)\n`;
    });
    await msg.reply(report);

    // ── LISTA DE CLIENTES ──
  } else if (cmd === '!clients' || cmd === '!clientes') {
    const clients = db.getAllClients();
    if (clients.length === 0) {
      await msg.reply('No hay clientes registrados aún.');
      return;
    }
    let list = `📋 *Últimos clientes:*\n\n`;
    const recent = clients.slice(0, 10);
    recent.forEach((c, i) => {
      const statusIcon = c.status === 'new' ? '🆕' : c.status === 'assigned' ? '🔗' : '✅';
      list += `${i + 1}. ${statusIcon} ${c.name || 'Sin nombre'} - ${c.phone}\n`;
    });
    list += `\n_Total: ${clients.length} clientes_`;
    await msg.reply(list);

    // ── FICHA DE CLIENTE ──
  } else if (cmd.startsWith('!client ') || cmd.startsWith('!cliente ')) {
    const targetPhone = parts[1]?.trim();
    if (!targetPhone) {
      await msg.reply('Uso: !client 573XXXXXXXXXX');
      return;
    }
    const profile = db.getClientProfile(targetPhone);
    if (!profile) {
      await msg.reply(`❌ No se encontró cliente con número ${targetPhone}`);
      return;
    }
    let card = `📇 *Ficha del Cliente*\n\n`;
    card += `👤 *Nombre:* ${profile.name || 'Sin nombre'}\n`;
    card += `📱 *Teléfono:* ${profile.phone}\n`;
    card += `📊 *Estado:* ${profile.status}\n`;
    card += `💬 *Mensajes:* ${profile.totalMessages}\n`;
    card += `🔄 *Interacciones:* ${profile.interaction_count || 0}\n`;
    card += `📅 *Primer contacto:* ${profile.created_at}\n`;
    card += `🕐 *Última interacción:* ${profile.updated_at}\n`;
    if (profile.assignedTo) {
      card += `👔 *Asignado a:* ${profile.assignedTo}\n`;
    }
    card += `\n🧠 *Memoria/Perfil:*\n`;
    card += profile.memory || '_Sin datos aún_';
    if (profile.notes) {
      card += `\n\n📝 *Notas:*\n${profile.notes}`;
    }
    card += `\n\n💬 *Últimos mensajes:*\n`;
    if (profile.recentMessages.length > 0) {
      profile.recentMessages.forEach(m => {
        const icon = m.role === 'user' ? '👤' : '🤖';
        card += `${icon} ${m.message.substring(0, 100)}\n`;
      });
    } else {
      card += '_Sin mensajes_';
    }
    await msg.reply(card);

    // ── INFORME GENERAL ──
  } else if (cmd === '!informe' || cmd === '!report') {
    const r = db.getGeneralReport();
    let report = `📊 *INFORME GENERAL*\n`;
    report += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    report += `📅 *Hoy:*\n`;
    report += `  🆕 Clientes nuevos: ${r.clientsToday}\n`;
    report += `  💬 Mensajes: ${r.messagesToday}\n`;
    report += `  🔄 Derivaciones: ${r.handoffsToday}\n\n`;
    report += `📆 *Última semana:*\n`;
    report += `  🆕 Clientes nuevos: ${r.clientsThisWeek}\n\n`;
    report += `📈 *Totales:*\n`;
    report += `  👥 Clientes: ${r.totalClients}\n`;
    report += `  🆕 Sin atender: ${r.newClients}\n`;
    report += `  🔗 Asignados: ${r.assignedClients}\n`;
    report += `  💬 Mensajes: ${r.totalMessages}\n\n`;
    report += `👔 *Empleados:*\n`;
    r.employeeStats.forEach(emp => {
      report += `  • ${emp.name}: ${emp.today} hoy | ${emp.active_now} activos | ${emp.assignments_count} total\n`;
    });
    if (r.unattendedClients.length > 0) {
      report += `\n⚠️ *Clientes sin atender:*\n`;
      r.unattendedClients.forEach(c => {
        report += `  • ${c.name || 'Sin nombre'} (${c.phone}) - ${c.interaction_count} msgs\n`;
      });
    }
    await msg.reply(report);

    // ── INFORME DE VENTAS ──
  } else if (cmd === '!informe ventas' || cmd === '!ventas' || cmd === '!pipeline') {
    const s = db.getSalesReport();
    let report = `💰 *INFORME DE VENTAS*\n`;
    report += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    report += `📊 *Pipeline:*\n`;
    s.pipeline.forEach(p => {
      const icon = p.status === 'new' ? '🆕' : p.status === 'assigned' ? '🔗' : '✅';
      report += `  ${icon} ${p.status}: ${p.count} clientes\n`;
    });
    if (s.hotLeads.length > 0) {
      report += `\n🔥 *Leads calientes:*\n`;
      s.hotLeads.forEach(l => {
        const mem = l.memory ? l.memory.substring(0, 80) : 'Sin datos';
        report += `  • ${l.name || 'Sin nombre'} (${l.phone})\n    ${mem}\n`;
      });
    }
    if (s.pendingClients.length > 0) {
      report += `\n⏳ *Asignados pendientes:*\n`;
      s.pendingClients.forEach(p => {
        report += `  • ${p.name || 'Sin nombre'} → ${p.employee_name} (${p.assigned_at})\n`;
      });
    }
    report += `\n👔 *Carga por empleado:*\n`;
    s.employeeLoad.forEach(e => {
      report += `  • ${e.name}: ${e.active_now} activos / ${e.assignments_count} total\n`;
    });
    await msg.reply(report);

    // ── AGREGAR NOTA A CLIENTE ──
  } else if (cmd.startsWith('!note ') || cmd.startsWith('!nota ')) {
    const targetPhone = parts[1]?.trim();
    const noteText = parts.slice(2).join(' ').trim();
    if (!targetPhone || !noteText) {
      await msg.reply('Uso: !note 573XXXXXXXXXX Tu nota aquí');
      return;
    }
    const clientExists = db.getClient(targetPhone);
    if (!clientExists) {
      await msg.reply(`❌ No se encontró cliente con número ${targetPhone}`);
      return;
    }
    // Append nota con timestamp
    const currentNotes = clientExists.notes || '';
    const timestamp = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
    const newNotes = currentNotes
      ? `${currentNotes}\n[${timestamp}] ${noteText}`
      : `[${timestamp}] ${noteText}`;
    db.updateClientNotes(targetPhone, newNotes);
    await msg.reply(`📝 Nota agregada a ${clientExists.name || targetPhone}:\n"${noteText}"`);

    // ── RESETEAR CLIENTE ──
  } else if (cmd.startsWith('!reset ')) {
    const targetPhone = parts[1]?.trim();
    if (!targetPhone) {
      await msg.reply('Uso: !reset 573XXXXXXXXXX');
      return;
    }
    const clientExists = db.getClient(targetPhone);
    if (!clientExists) {
      await msg.reply(`❌ No se encontró cliente con número ${targetPhone}`);
      return;
    }
    db.resetClient(targetPhone);
    await msg.reply(`🔄 Cliente ${clientExists.name || targetPhone} reseteado.\nHistorial limpio, estado: new, memoria borrada.`);

    // ── CERRAR ASIGNACIÓN ──
  } else if (cmd.startsWith('!close ') || cmd.startsWith('!cerrar ')) {
    const targetPhone = parts[1]?.trim();
    if (!targetPhone) {
      await msg.reply('Uso: !close 573XXXXXXXXXX');
      return;
    }
    const closed = db.closeAssignment(targetPhone);
    if (!closed) {
      await msg.reply(`❌ No hay asignación activa para ${targetPhone}`);
      return;
    }
    await msg.reply(`✅ Asignación cerrada: ${targetPhone} ya no está asignado a ${closed.employee_name}`);

    // ── AYUDA ──
  } else if (cmd === '!help' || cmd === '!ayuda') {
    const help = `🤖 *Comandos de Admin:*\n\n` +
      `📊 *Informes:*\n` +
      `  !stats - Estadísticas rápidas\n` +
      `  !informe - Informe general completo\n` +
      `  !ventas - Informe de ventas/pipeline\n\n` +
      `👥 *Clientes:*\n` +
      `  !clients - Últimos clientes\n` +
      `  !client 573XX - Ficha completa\n` +
      `  !note 573XX texto - Agregar nota\n` +
      `  !reset 573XX - Resetear cliente\n` +
      `  !close 573XX - Cerrar asignación\n\n` +
      `💡 _Usa !help para ver esta ayuda_`;
    await msg.reply(help);

  } else {
    await msg.reply('Comando no reconocido. Escribe !help para ver los comandos disponibles.');
  }
}

// ============================================
// RECUPERAR CHATS SIN RESPONDER
// ============================================
// Se ejecuta una sola vez al arrancar el bot.
// Busca chats con mensajes NO respondidos por nosotros
// y les envía el mensaje de recuperación de clientes.
async function recuperarChatsViejos() {
  try {
    console.log('[RECOVERY] 🔍 Buscando chats sin responder...');

    const allChats = await client.getChats();
    let enviados = 0;
    let omitidos = 0;

    // Archivo de control para no enviar dos veces al mismo número
    const controlPath = path.join(__dirname, 'recovery_enviados.json');
    let yaEnviados = {};
    if (fs.existsSync(controlPath)) {
      yaEnviados = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
    }

    // Paso 1: Filtrar chats válidos y recolectar info
    console.log('[RECOVERY] 📋 Filtrando y ordenando chats...');
    const chatsPendientes = [];

    for (const chat of allChats) {
      try {
        if (chat.isGroup) continue;
        if (chat.id._serialized === 'status@broadcast') continue;

        const serialized = chat.id?._serialized || '';
        if (serialized.includes('@newsletter')) continue;
        if (serialized.includes('@broadcast')) continue;
        if (chat.type === 'channel') continue;
        if (!serialized.includes('@c.us')) continue;

        const phone = chat.id.user;
        if (phone === CONFIG.businessPhone.replace('57', '') ||
          phone === '573150177199'.replace('57', '')) continue;
        if (yaEnviados[phone]) { omitidos++; continue; }

        // Bloquear bots empresariales (números cortos)
        const phoneClean = phone.replace('57', '');
        if (phoneClean.length <= 6) continue;

        const messages = await chat.fetchMessages({ limit: 5 });
        if (!messages || messages.length === 0) continue;

        // Buscar el mensaje más antiguo para ordenar por antigüedad
        const firstMsg = messages[0];
        if (!firstMsg) continue;

        // Guardar chat con su timestamp para ordenar (más viejo primero)
        chatsPendientes.push({
          chat,
          phone,
          timestamp: firstMsg.timestamp || 0 // epoch en segundos
        });
      } catch (e) {
        // Chat problemático, saltar silenciosamente
      }
    }

    // Paso 2: Ordenar por timestamp ASCENDENTE (más viejos primero)
    chatsPendientes.sort((a, b) => a.timestamp - b.timestamp);

    console.log(`[RECOVERY] 📊 ${chatsPendientes.length} chats pendientes encontrados. Enviando desde el más viejo...`);

    // Paso 3: Enviar mensajes en orden (más viejos primero)
    for (const item of chatsPendientes) {
      try {
        const { chat, phone } = item;
        const fecha = new Date(item.timestamp * 1000).toLocaleDateString('es-CO');

        let nombre = '';
        try {
          const contact = await chat.getContact();
          nombre = contact.pushname || contact.name || contact.shortName || '';
        } catch (e) { /* silencioso */ }

        const mensajeRecuperacion =
          `Hola${nombre ? ' ' + nombre.split(' ')[0] : ''} 👋, buenas.\n\n` +
          `Te escribo de parte de *Zona Traumática*. Veo que hace un tiempo nos escribiste y quiero disculparme sinceramente por no haberte atendido — estuvimos en un proceso de restructuración y renovamos completamente nuestro equipo y herramientas de atención.\n\n` +
          `Hoy estamos operando con un servicio mucho más ágil y completo. ¿Sigues interesado/a en lo que consultaste? Con gusto te atiendo personalmente ahora. 🙌`;

        await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
        await client.sendMessage(chat.id._serialized, mensajeRecuperacion);

        saveContactToVCF(phone, nombre);

        yaEnviados[phone] = new Date().toISOString();
        fs.writeFileSync(controlPath, JSON.stringify(yaEnviados, null, 2), 'utf8');

        enviados++;
        console.log(`[RECOVERY] ✅ (${enviados}/${chatsPendientes.length}) ${nombre || phone} — último msg: ${fecha}`);

      } catch (chatError) {
        console.error(`[RECOVERY] ⚠️ Chat omitido (${item.phone || 'desconocido'}):`, chatError.message);
      }
    }

    console.log(`[RECOVERY] 🏁 Recuperación completa: ${enviados} mensajes enviados, ${omitidos} chats ya atendidos o sin acción.`);

  } catch (error) {
    console.error('[RECOVERY] Error general:', error.message);
  }
}

// ============================================
// GUARDAR CONTACTO INDIVIDUAL EN VCF MAESTRO
// ============================================
// Cada vez que llega un cliente nuevo, lo agrega al archivo
// contactos_clientes.vcf (acumulativo, no sobreescribe)
function saveContactToVCF(phone, name) {
  try {
    const displayName = name || phone;
    const vcfPath = path.join(__dirname, 'contactos_clientes.vcf');

    // Verificar si ya está en el archivo para no duplicar
    if (fs.existsSync(vcfPath)) {
      const existing = fs.readFileSync(vcfPath, 'utf8');
      if (existing.includes(`+${phone}`)) {
        if (CONFIG.debug) {
          console.log(`[VCF] Contacto ya existe en VCF: ${displayName} (${phone})`);
        }
        return;
      }
    }

    // Construir entrada vCard
    const vcard =
      'BEGIN:VCARD\n' +
      'VERSION:3.0\n' +
      `FN:${displayName}\n` +
      `N:${displayName};;;;\n` +
      `TEL;TYPE=CELL:+${phone}\n` +
      `NOTE:Cliente ZT — ${new Date().toLocaleDateString('es-CO')}\n` +
      'END:VCARD\n\n';

    // Agregar al archivo (append)
    fs.appendFileSync(vcfPath, vcard, 'utf8');
    console.log(`[VCF] ✅ Contacto guardado: ${displayName} (+${phone})`);

  } catch (error) {
    console.error('[VCF] Error guardando contacto individual:', error.message);
  }
}

// ============================================
// EXPORTAR CONTACTOS A VCF
// ============================================
async function exportContactsToVCF() {
  try {
    console.log('[VCF] Exportando contactos de WhatsApp...');
    const contacts = await client.getContacts();

    let vcfContent = '';
    let count = 0;

    for (const contact of contacts) {
      // Saltar contactos sin número o de tipo broadcast/grupo
      if (!contact.number || contact.isGroup || contact.id._serialized === 'status@broadcast') continue;

      const name = contact.pushname || contact.name || contact.shortName || contact.number;
      const phone = contact.number;

      vcfContent += 'BEGIN:VCARD\n';
      vcfContent += 'VERSION:3.0\n';
      vcfContent += `FN:${name}\n`;
      if (contact.name) {
        vcfContent += `N:${contact.name};;;;\n`;
      } else {
        vcfContent += `N:${name};;;;\n`;
      }
      vcfContent += `TEL;TYPE=CELL:+${phone}\n`;
      vcfContent += 'END:VCARD\n\n';
      count++;
    }

    if (count === 0) {
      console.log('[VCF] No se encontraron contactos para exportar.');
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const vcfPath = path.join(__dirname, `contactos_whatsapp_${timestamp}.vcf`);
    fs.writeFileSync(vcfPath, vcfContent, 'utf8');

    console.log(`[VCF] ✅ ${count} contactos exportados a: ${vcfPath}`);
  } catch (error) {
    console.error('[VCF] Error exportando contactos:', error.message);
  }
}

// ============================================
// ARRANCAR EL BOT
// ============================================
console.log('\n[BOT] Iniciando bot empresarial...');
console.log(`[BOT] Negocio: ${CONFIG.businessName}`);
console.log(`[BOT] Modo: ${CONFIG.mode}`);
console.log('[BOT] Conectando a WhatsApp...\n');

// ============================================
// SISTEMA DE COLA SECUENCIAL PARA BROADCASTING
// ============================================
// Itera todas las imágenes disponibles en orden de prioridad:
// 1° Productos disponibles del catálogo
// 2° Ofertas (club, inventario)
// 3° Didáctico (contenido educativo)
// Misma imagen para todos los grupos por ronda. Al agotar la cola,
// se baraja y reinicia el ciclo. Persiste en broadcast_queue.json.

const BROADCAST_QUEUE_PATH = path.join(__dirname, 'broadcast_queue.json');

// ── Utilidades de la cola ──

function obtenerImagenesRecursivo(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      if (fs.statSync(filePath).isDirectory()) {
        obtenerImagenesRecursivo(filePath, fileList);
      } else if (file.match(/\.(png|jpg|jpeg|webp)$/i)) {
        fileList.push(filePath);
      }
    }
  } catch (e) { /* silencioso */ }
  return fileList;
}

function shuffleArray(arr) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Construye la cola de imágenes filtrando por catálogo disponible.
 * Devuelve un array de objetos { fullPath, relativePath, productoInfo }
 */
function buildImageQueue() {
  const imagenesDir = path.join(__dirname, 'imagenes');
  const catalogoPath = path.join(__dirname, 'catalogo_contexto.json');

  // 1. Cargar catálogo
  let catalogo = { categorias: {} };
  try {
    catalogo = JSON.parse(fs.readFileSync(catalogoPath, 'utf8'));
  } catch (e) {
    console.error('[QUEUE] ⚠️ No se pudo leer catalogo_contexto.json:', e.message);
  }

  // 2. Construir mapeo de productos disponibles: modelo → info
  const productosDisponibles = {};
  for (const [marca, productos] of Object.entries(catalogo.categorias || {})) {
    if (marca === 'SERVICIOS') continue; // Servicios no son imágenes de pistolas
    for (const p of productos) {
      if (p.disponible) {
        // Normalizar modelo para matching: "Mini 9" → "mini 9", "F92" → "f92"
        const modeloKey = (p.modelo || p.titulo || '').toLowerCase().replace(/\s+/g, ' ').trim();
        productosDisponibles[modeloKey] = {
          titulo: p.titulo,
          marca: p.marca || marca,
          color: p.color,
          precio_plus: p.precio_plus,
          precio_pro: p.precio_pro,
          url: p.url
        };
      }
    }
  }
  console.log(`[QUEUE] 📦 Productos disponibles en catálogo: ${Object.keys(productosDisponibles).length}`);

  // 3. Escanear imágenes por categoría
  const pistolasDir = path.join(imagenesDir, 'pistolas');
  const ofertaDir = path.join(imagenesDir, 'oferta actual');
  const didacticoDir = path.join(imagenesDir, 'didactico');

  const imagenesPistolas = obtenerImagenesRecursivo(pistolasDir);
  const imagenesOferta = obtenerImagenesRecursivo(ofertaDir);
  const imagenesDidactico = obtenerImagenesRecursivo(didacticoDir);

  // 4. Filtrar pistolas: solo las que corresponden a productos del catálogo
  const pistolasFiltradas = [];
  const pistolasExcluidas = [];

  for (const fullPath of imagenesPistolas) {
    const relativePath = path.relative(imagenesDir, fullPath);
    const fileName = path.basename(fullPath, path.extname(fullPath)).toLowerCase();
    const parentFolder = path.basename(path.dirname(fullPath)).toLowerCase();

    // Intentar hacer match del archivo con algún producto del catálogo
    let productoMatch = null;
    for (const [modeloKey, info] of Object.entries(productosDisponibles)) {
      const marcaLower = (info.marca || '').toLowerCase();
      const modeloLower = modeloKey;

      // Match por carpeta padre (marca) + nombre de archivo contiene modelo
      // Ej: carpeta "blow", archivo "f92 fume.png" → modelo "f92"
      // Ej: carpeta "ekol", archivo "firatcompactk.png" → modelo "firat compact"
      const modeloParts = modeloLower.split(' ');
      const fileMatchesModel = modeloParts.every(part => fileName.includes(part)) ||
        fileName.includes(modeloLower.replace(/\s+/g, ''));

      if (parentFolder === marcaLower && fileMatchesModel) {
        productoMatch = info;
        break;
      }

      // También buscar si la marca está en la ruta y el modelo en el nombre
      if (relativePath.toLowerCase().includes(marcaLower) && fileMatchesModel) {
        productoMatch = info;
        break;
      }
    }

    // Helper - redefinir match con nombre correcto
    if (productoMatch) {
      pistolasFiltradas.push({ fullPath, relativePath, productoInfo: productoMatch });
    } else {
      pistolasExcluidas.push(relativePath);
    }
  }

  if (pistolasExcluidas.length > 0) {
    console.log(`[QUEUE] 🚫 Excluidas (no en catálogo): ${pistolasExcluidas.join(', ')}`);
  }

  // 5. Construir cola con prioridad: pistolas disponibles → ofertas → didáctico
  const colaOrdenada = [];

  // Pistolas (shuffle dentro de la categoría para variedad)
  for (const item of shuffleArray(pistolasFiltradas)) {
    colaOrdenada.push(item);
  }

  // Ofertas
  for (const fullPath of shuffleArray(imagenesOferta)) {
    colaOrdenada.push({
      fullPath,
      relativePath: path.relative(imagenesDir, fullPath),
      productoInfo: null // No es un producto específico
    });
  }

  // Didáctico
  for (const fullPath of shuffleArray(imagenesDidactico)) {
    colaOrdenada.push({
      fullPath,
      relativePath: path.relative(imagenesDir, fullPath),
      productoInfo: null
    });
  }

  console.log(`[QUEUE] 📋 Cola construida: ${pistolasFiltradas.length} pistolas + ${imagenesOferta.length} ofertas + ${imagenesDidactico.length} didáctico = ${colaOrdenada.length} total`);

  return colaOrdenada;
}

// ── Persistencia de la cola ──

function loadBroadcastQueues() {
  try {
    if (fs.existsSync(BROADCAST_QUEUE_PATH)) {
      return JSON.parse(fs.readFileSync(BROADCAST_QUEUE_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('[QUEUE] Error leyendo broadcast_queue.json:', e.message);
  }
  return { groups: { queue: [], index: 0 }, status: { queue: [], index: 0 } };
}

function saveBroadcastQueues(data) {
  try {
    fs.writeFileSync(BROADCAST_QUEUE_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[QUEUE] Error guardando broadcast_queue.json:', e.message);
  }
}

/**
 * Obtiene la siguiente imagen de la cola para el tipo dado ('groups' o 'status').
 * Si la cola está vacía o el índice se excedió, reconstruye y baraja.
 * Devuelve { fullPath, relativePath, productoInfo } o null.
 */
function getNextImage(type) {
  const queues = loadBroadcastQueues();
  let queueData = queues[type] || { queue: [], index: 0 };

  // Reconstruir cola si está vacía o el índice se excedió
  if (!queueData.queue || queueData.queue.length === 0 || queueData.index >= queueData.queue.length) {
    console.log(`[QUEUE] 🔄 Reconstruyendo cola para ${type}...`);
    const nuevaCola = buildImageQueue();
    if (nuevaCola.length === 0) return null;

    queueData = { queue: nuevaCola, index: 0 };
    queues[type] = queueData;
    saveBroadcastQueues(queues);
    console.log(`[QUEUE] ✅ Cola ${type} lista: ${nuevaCola.length} imágenes`);
  }

  // Obtener imagen actual y avanzar índice
  const item = queueData.queue[queueData.index];
  queueData.index++;
  queues[type] = queueData;
  saveBroadcastQueues(queues);

  console.log(`[QUEUE] 📸 ${type} → [${queueData.index}/${queueData.queue.length}] ${item.relativePath}`);
  return item;
}

// ============================================
// BROADCASTER DE IMÁGENES A GRUPOS
// ============================================
// Misma imagen para TODOS los grupos por ronda (cola secuencial)

async function getGroupBroadcastText(imageRelativePath, productoInfo) {
  const contextos = [
    'Es de mañana, los grupos están empezando el día',
    'Es mediodía, buen momento para recordar la oferta',
    'Es tarde, último push del día para el club',
  ];
  const contextoAleatorio = contextos[Math.floor(Math.random() * contextos.length)];

  // Construir contexto del producto si está disponible
  let productoCtx = '';
  if (productoInfo) {
    productoCtx = `\nINFO DEL PRODUCTO:\n- Nombre: ${productoInfo.titulo}\n- Marca: ${productoInfo.marca}\n- Color(es): ${productoInfo.color}\n- Precio Plan Plus: ${productoInfo.precio_plus}\n- Precio Plan Pro: ${productoInfo.precio_pro}\nUsa estos datos reales en tu mensaje cuando sea natural hacerlo.`;
  }

  try {
    const prompt = `Eres el community manager de Zona Traumática Colombia.
Escribe un mensaje corto y poderoso para acompañar esta imagen promocional en un grupo de WhatsApp de portadores de armas traumáticas.
Contexto de tiempo: ${contextoAleatorio}.
Dato de la imagen: ${imageRelativePath.replace(/\\/g, '/')}${productoCtx}
El mensaje debe:
- Ser máximo 4 líneas
- Tener gancho emocional (miedo a perder el arma, orgullo del portador preparado)
- Terminar con una llamada a la acción clara (escribir al privado, preguntar por el plan, etc.)
- Usar emojis con moderación (máximo 3)
- Sonar humano, NO robótico ni corporativo
- NO repetir exactamente lo que dice la imagen
- REGLA LEGAL ESTRICTA: Las armas traumáticas NO son armas de fuego. Según la Ley 2197 de 2022, son dispositivos MENOS LETALES. JAMÁS digas que son armas de fuego.
Solo escribe el mensaje, sin explicaciones.`;
    const result = await geminiGenerate('gemini-3.1-pro-preview', prompt);
    return result.response.text().trim();
  } catch (err) {
    console.error('[BROADCASTER] Error generando texto:', err.message);
    return '🛡️ ¿Ya tienes tu respaldo legal listo? El Club Zona Traumática te protege antes, durante y después. Escríbenos al privado.';
  }
}

async function sendGroupBroadcast() {
  console.log('[BROADCASTER] 📢 Iniciando envío a grupos...');

  // 1. Obtener la siguiente imagen de la cola
  const imageItem = getNextImage('groups');
  if (!imageItem) {
    console.log('[BROADCASTER] No hay imágenes disponibles en la cola — cancelando');
    return;
  }

  // Verificar que el archivo aún existe
  if (!fs.existsSync(imageItem.fullPath)) {
    console.log(`[BROADCASTER] ⚠️ Imagen ya no existe: ${imageItem.relativePath} — saltando`);
    return;
  }

  // 2. Obtener todos los grupos
  let chats;
  try {
    chats = await client.getChats();
  } catch (e) {
    console.error('[BROADCASTER] Error obteniendo chats:', e.message);
    return;
  }

  const grupos = chats.filter(c => c.isGroup);
  console.log(`[BROADCASTER] 👥 Grupos encontrados: ${grupos.length}`);

  if (grupos.length === 0) {
    console.log('[BROADCASTER] No hay grupos — cancelando');
    return;
  }

  // 3. Generar texto UNA vez (misma imagen y texto para todos los grupos)
  const texto = await getGroupBroadcastText(imageItem.relativePath, imageItem.productoInfo);

  // 4. Cargar la imagen UNA vez
  const media = MessageMedia.fromFilePath(imageItem.fullPath);

  // 5. Enviar a TODOS los grupos con la MISMA imagen y texto
  let enviados = 0;
  for (const grupo of grupos) {
    try {
      console.log(`[BROADCASTER] ➡️ Enviando a ${grupo.name} (Img: ${imageItem.relativePath})...`);
      await client.sendMessage(grupo.id._serialized, media, { caption: texto });
      enviados++;
      console.log(`[BROADCASTER] ✅ Enviado a: ${grupo.name}`);
      // Esperar entre 3 y 6 segundos entre grupos para parecer natural
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 3000));
    } catch (err) {
      console.error(`[BROADCASTER] ❌ Error en grupo ${grupo.name}:`, err.message);
    }
  }

  console.log(`[BROADCASTER] 📊 Completado: ${enviados}/${grupos.length} grupos`);
}

function startGroupBroadcaster() {
  // Horas fijas del día en que se envía (hora Colombia UTC-5)
  const HORAS_ENVIO = [0, 6, 8, 12, 16, 20, 22]; // 12am, 6am, 8am, 12pm, 4pm, 8pm, 10pm

  function getMsHastaProximoEnvio() {
    const ahora = new Date();
    // Convertir hora actual a hora Colombia (UTC-5)
    const utcMinutes = ahora.getUTCHours() * 60 + ahora.getUTCMinutes();
    const colMinutes = ((utcMinutes - 5 * 60) % (24 * 60) + 24 * 60) % (24 * 60);
    const colHora = Math.floor(colMinutes / 60);
    const colMin = colMinutes % 60;

    // Buscar la próxima hora de envío que aún no ha pasado hoy
    let proximaHora = HORAS_ENVIO.find(h => h > colHora || (h === colHora && colMin === 0));
    if (proximaHora === undefined) {
      // Todas las horas de hoy ya pasaron → primera de mañana
      proximaHora = HORAS_ENVIO[0] + 24;
    }

    const minutosRestantes = proximaHora * 60 - colMinutes;
    return minutosRestantes * 60 * 1000;
  }

  function programarSiguiente() {
    const msEspera = getMsHastaProximoEnvio();
    const minutosEspera = Math.round(msEspera / 60000);
    const horasEspera = Math.floor(minutosEspera / 60);
    const minsEspera = minutosEspera % 60;
    console.log(`[BROADCASTER] ⏰ Próximo envío en ${horasEspera}h ${minsEspera}m`);

    setTimeout(async () => {
      await sendGroupBroadcast();
      programarSiguiente(); // reprogramar para la siguiente hora fija
    }, msEspera);
  }

  console.log(`[BROADCASTER] 🚀 Iniciado — enviará a grupos a las ${HORAS_ENVIO.join('h, ')}h (hora Colombia)`);
  programarSiguiente(); // NO envía al arrancar, espera la próxima hora programada
}

// ============================================
// AUTOMATIZACIÓN DE ESTADOS (STATUS) DE WHATSAPP
// Cola secuencial independiente — 1 publicación por hora
// ============================================

async function getStatusBroadcastText(imageRelativePath, productoInfo) {
  const horasActivas = [
    'Mañana: invita a empezar el día protegido.',
    'Mediodía: mensaje rápido y contundente para el break del almuerzo.',
    'Tarde/Noche: cierre del día, apela a la tranquilidad y seguridad de la familia.',
  ];
  const contextoAleatorio = horasActivas[Math.floor(Math.random() * horasActivas.length)];

  // Construir contexto del producto si está disponible
  let productoCtx = '';
  if (productoInfo) {
    productoCtx = `\nINFO DEL PRODUCTO: ${productoInfo.titulo} (${productoInfo.marca}) — ${productoInfo.color} — Plus: ${productoInfo.precio_plus} / Pro: ${productoInfo.precio_pro}`;
  }

  try {
    const prompt = `Eres el community manager de Zona Traumática Colombia.
Escribe un texto persuasivo para acompañar esta imagen en una HISTORIA/ESTADO de WhatsApp.
Dado que la imagen proviene de la ruta: "${imageRelativePath.replace(/\\/g, '/')}", adapta tu mensaje a la categoría:
- Si es de /oferta: Enfatiza la promoción, el descuento de 50k o el bot IA gratis.
- Si es de /didactico: Da un tip legal rápido de 1 frase (Ejemplo correcto: "Ley 2197/2022: Las traumáticas son dispositivos menos letales, NO armas de fuego").
- Si es de /pistolas: Habla de equipo táctico, seguridad y respaldo.
${productoCtx}

Contexto de la hora: ${contextoAleatorio}

El mensaje debe:
- Ser MUY CORTO (máximo 3 líneas) para lectura rápida en un estado.
- Tener un gancho visual con 1 o 2 emojis.
- Invitar a responder la historia (ej: "Escríbeme", "Responde a esta historia para info", "👇").
- Sonar orgánico y persuasivo, no un copy-paste aburrido.
- REGLA LEGAL ESTRICTA: Las armas traumáticas NO son armas de fuego. Si las mencionas, son dispositivos o armas MENOS LETALES.
Solo escribe el texto de la historia, sin comillas ni explicaciones extra.`;

    const result = await geminiGenerate('gemini-3.1-pro-preview', prompt);
    return result.response.text().trim();
  } catch (err) {
    console.error('[STATUS] Error generando texto:', err.message);
    return '🛡️ ¿Preparado para cualquier situación? Responde a esta historia y te asesoro hoy mismo. 👊';
  }
}

async function sendStatusBroadcast() {
  console.log('[STATUS] 📲 Iniciando publicación en Estado de WhatsApp...');

  // 1. Obtener la siguiente imagen de la cola de estados
  const imageItem = getNextImage('status');
  if (!imageItem) {
    console.log('[STATUS] No hay imágenes disponibles en la cola — cancelando');
    return;
  }

  // Verificar que el archivo aún existe
  if (!fs.existsSync(imageItem.fullPath)) {
    console.log(`[STATUS] ⚠️ Imagen ya no existe: ${imageItem.relativePath} — saltando`);
    return;
  }

  try {
    // 2. Generar texto de la historia
    const texto = await getStatusBroadcastText(imageItem.relativePath, imageItem.productoInfo);

    // 3. Cargar la imagen
    const media = MessageMedia.fromFilePath(imageItem.fullPath);

    // 4. Enviar a status@broadcast
    console.log(`[STATUS] ➡️ Subiendo historia (Img: ${imageItem.relativePath})...`);
    await client.sendMessage('status@broadcast', media, { caption: texto });
    console.log(`[STATUS] ✅ Historia publicada exitosamente.`);

  } catch (err) {
    console.error(`[STATUS] ❌ Error subiendo estado:`, err.message);
  }
}

function startStatusBroadcaster() {
  function getMsHastaSiguienteHora() {
    const ahora = new Date();
    const minutosRestantes = 60 - ahora.getMinutes();
    return minutosRestantes * 60 * 1000 - (ahora.getSeconds() * 1000) - ahora.getMilliseconds();
  }

  function programarSiguienteEstado() {
    const msEspera = getMsHastaSiguienteHora();
    const minutosEspera = Math.round(msEspera / 60000);
    console.log(`[STATUS] ⏰ Próxima historia programada en ${minutosEspera} minutos.`);

    setTimeout(async () => {
      await sendStatusBroadcast();
      programarSiguienteEstado(); // Bucle infinito
    }, msEspera);
  }

  console.log(`[STATUS] 🚀 Automatización de Historias iniciada (1 publicación cada hora, cola secuencial).`);
  programarSiguienteEstado();
}

// ============================================
// REACTIVACIÓN DE LEADS CALIENTES
// El panel llama a http://localhost:3001/reactivar cuando se presiona el botón
// El bot procesa la lista uno por uno con delay anti-ban
// ============================================

async function procesarClientesCalientes(clientes, mode = 'normal') {
  console.log(`[REACTIVAR] 🔥 Iniciando reactivación de ${clientes.length} leads calientes en modo: ${mode.toUpperCase()}...`);

  for (let i = 0; i < clientes.length; i++) {
    const cliente = clientes[i];
    try {
      const historial = db.getConversationHistory(cliente.phone, 10);
      const resumenHistorial = historial.map(h => `${h.role === 'user' ? 'Cliente' : 'Bot'}: ${h.message}`).join('\n');

      const reactivarModel = 'gemini-3.1-pro-preview'; // Nombre del modelo para geminiGenerate

      let promoRules = '';
      if (mode === 'ultra') {
        promoRules = `
IMPORTANTE - PROMOCIONES PERMITIDAS (MODO ULTRA):
Puedes ofrecer las siguientes promociones exclusivas (y NINGUNA OTRA MÁS):
1. En armas nuevas: 100.000 pesos de descuento.
2. En munición (si el cliente no es afiliado): Ofrécele el precio especial de afiliado.
3. En afiliación al club: Se le obsequia el chatbot de IA por 6 meses totalmente gratis.
REGLA DE PROMOCIONES ESTRICTA: NO inventes ni ofrezcas NINGÚN otro descuento o paquete diferente a estos tres.`;
      } else {
        promoRules = `
REGLA DE PROMOCIONES ESTRICTA: Está TOTALMENTE PROHIBIDO inventar ofertas, descuentos, regalos o promociones con tal de ser persuasivo. NUNCA ofrezcas nada que no esté explícitamente en el catálogo oficial de precios.`;
      }

      const prompt = `Eres un asesor de ventas de Zona Traumática (tienda de armas traumáticas y Club ZT en Colombia).

Tienes este cliente que mostró interés pero no ha cerrado la compra. Envíale UN mensaje corto y natural para retomar la conversación y cerrar la venta.

PERFIL DEL CLIENTE:
Nombre: ${cliente.name}
Memoria/perfil: ${cliente.memory}

ÚLTIMOS MENSAJES:
${resumenHistorial || 'Sin historial previo'}

REGLAS:
1. Máximo 3-4 líneas — mensaje de WhatsApp real, no un email
2. Personalizado según su interés específico (menciona lo que él preguntó)
3. Cierra con una pregunta abierta
4. Tono: cercano, humano, como amigo que avisa — NO vendedor desesperado
5. Máximo 2 emojis
6. NO menciones que es un mensaje automático
${promoRules}

Escribe SOLO el mensaje, sin explicaciones ni comillas.`;

      const result = await geminiGenerate(reactivarModel, prompt);
      const mensaje = result.response.text().trim();

      const phoneForDb = cliente.phone.replace(/@.*/g, '').replace(/\D/g, '');
      await safeSend(phoneForDb, mensaje);
      db.saveMessage(phoneForDb, 'assistant', mensaje);
      console.log(`[REACTIVAR] ✅ (${i + 1}/${clientes.length}) Enviado a ${cliente.name} (${cliente.phone})`);

    } catch (err) {
      console.error(`[REACTIVAR] ❌ Error con ${cliente.phone}:`, err.message);
    }

    // Delay anti-ban entre mensajes: 45-90 segundos aleatorios (excepto después del último)
    if (i < clientes.length - 1) {
      const delay = Math.floor(Math.random() * 45000) + 45000;
      console.log(`[REACTIVAR] ⏳ Siguiente en ${Math.round(delay / 1000)}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  console.log(`[REACTIVAR] 🎉 Reactivación completada — ${clientes.length} mensajes enviados`);
}

async function forceBotReply(phone) {
  try {
    const chatId = db.getClientChatId(phone) || `${phone}@c.us`;
    console.log(`\n[PANEL-REACTIVACION] Buscando mensajes pendientes para: ${phone} (${chatId})`);

    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 5 });

    if (!messages || messages.length === 0) {
      return { ok: false, message: 'No se encontró historial de chat con este cliente.' };
    }

    // Buscar el último mensaje que realmente sea del usuario (retrocediendo en el historial)
    let userMsg = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (!messages[i].fromMe) {
        userMsg = messages[i];
        break;
      }
    }

    if (!userMsg) {
      return { ok: false, message: 'No se encontraron mensajes recientes del usuario para reatender.' };
    }

    const hasMediaContent = userMsg.hasMedia || ['ptt', 'audio', 'image', 'video', 'document', 'sticker'].includes(userMsg.type);

    if ((!userMsg.body || userMsg.body.trim() === '') && !hasMediaContent) {
      return { ok: false, message: 'El último mensaje del usuario no contiene texto ni multimedia que pueda procesar el bot.' };
    }

    const userMessageText = userMsg.body ? userMsg.body.trim() : `[Multimedia: ${userMsg.type}]`;
    console.log(`[PANEL-REACTIVACION] Pendiente de usuario encontrado: "${userMessageText}"`);

    await procesarMensaje(userMsg, chat, phone, userMsg);

    return { ok: true, message: 'Se ha reactivado la conversación y enviado una respuesta.' };
  } catch (err) {
    console.error('[PANEL-REACTIVACION] Error:', err.message);
    return { ok: false, message: err.message || 'Error reactivando el chat' };
  }
}

// ============================================
// FORZAR RESPUESTA BOT — MODO POST-VENTA
// En lugar de re-procesar el último mensaje (comercial),
// envía un seguimiento personalizado según el status del cliente.
// ============================================
async function forcePostventaReply(phone) {
  try {
    const clientData = db.getClient(phone);
    if (!clientData) {
      return { ok: false, message: 'Cliente no encontrado en BD.' };
    }

    const chatId = db.getClientChatId(phone) || `${phone}@c.us`;
    const status = clientData.status || 'postventa';
    const name = clientData.name || 'cliente';
    const memory = db.getClientMemory(phone) || '';
    const history = db.getConversationHistory(phone, 10);

    // Construir contexto del historial
    const histText = history.map(h =>
      `${h.role === 'user' ? 'Cliente' : h.role === 'admin' ? 'Álvaro' : 'Bot'}: ${h.message}`
    ).join('\n').substring(0, 2000);

    const statusDescriptions = {
      'carnet_pendiente_plus': 'Su carnet Club Plus está pendiente de generar/enviar.',
      'carnet_pendiente_pro': 'Su carnet Club Pro está pendiente de generar/enviar.',
      'despacho_pendiente': 'Tiene un dispositivo/arma pendiente de despacho.',
      'municion_pendiente': 'Tiene munición pendiente de envío.',
      'recuperacion_pendiente': 'Tiene un dispositivo en proceso de recuperación/servicio técnico.',
      'bot_asesor_pendiente': 'Tiene el servicio de Bot Asesor Legal pendiente de activación.',
      'postventa': 'Está en seguimiento post-venta general.',
      'completed': 'Su proceso fue marcado como completado.'
    };

    const statusDesc = statusDescriptions[status] || 'Está en seguimiento post-venta.';

    const prompt = `Eres el asistente post-venta de Zona Traumática. Tu tono es amable, cercano y profesional.
El cliente se llama "${name}".
Su estado actual: ${status} — ${statusDesc}

Memoria CRM del cliente:
${memory || 'Sin notas previas.'}

Últimas conversaciones:
${histText || 'Sin historial reciente.'}

Tu tarea: Envía un mensaje de SEGUIMIENTO POST-VENTA al cliente. NO vendas productos nuevos.
Objectivos:
1. Saludar brevemente mencionando su nombre
2. Confirmar el estado de su trámite pendiente según su status
3. Preguntar si necesita algo más o tiene alguna duda
4. Si falta información del cliente (datos de envío, foto para carnet, etc.), pedirla amablemente

Reglas:
- NO ofrecer productos nuevos ni promociones
- SÉ breve y directo (máx 3-4 líneas)
- Usa emojis moderadamente
- Si el caso ya está resuelto, simplemente pregunta si todo está en orden

Responde SOLO con el mensaje al cliente, sin explicaciones ni prefijos.`;

    const result = await geminiGenerate('gemini-2.5-flash', prompt);
    const followUpMsg = result.response.text().trim();

    if (!followUpMsg) {
      return { ok: false, message: 'Gemini no generó respuesta.' };
    }

    await safeSend(phone, followUpMsg);
    db.saveMessage(phone, 'assistant', followUpMsg);
    console.log(`[POSTVENTA] ✅ Seguimiento enviado a ${phone}: "${followUpMsg.substring(0, 60)}..."`);

    return { ok: true, message: 'Seguimiento post-venta enviado correctamente.' };
  } catch (err) {
    console.error('[POSTVENTA] Error:', err.message);
    return { ok: false, message: err.message || 'Error enviando seguimiento' };
  }
}

function startReactivacionServer() {
  const botApiServer = http.createServer((req, res) => {
    if (req.url === '/reactivar' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const bodyData = JSON.parse(body);
          const clientes = bodyData.clientes;
          const mode = bodyData.mode || 'normal';

          if (!clientes || clientes.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, msg: 'Sin clientes para procesar' }));
            return;
          }
          // Responder inmediatamente al panel — el proceso corre en background
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, total: clientes.length }));
          // Procesar en background sin bloquear
          procesarClientesCalientes(clientes, mode).catch(e => console.error('[REACTIVAR]', e.message));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
    } else if (req.url === '/reatender-postventa' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { phone } = JSON.parse(body);
          if (!phone) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, msg: 'Falta teléfono' }));
            return;
          }
          const result = await forcePostventaReply(phone);
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          console.error('[POSTVENTA] Error /reatender-postventa:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
    } else if (req.url === '/agregar-cliente' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { phone, name, contexto } = JSON.parse(body);
          if (!phone) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, msg: 'Falta número de teléfono' }));
            return;
          }

          // Normalizar phone
          let phoneClean = phone.replace(/\D/g, '');
          // Si empieza por 3 y tiene 10 dígitos, agregar 57 (Colombia)
          if (phoneClean.length === 10 && phoneClean.startsWith('3')) {
            phoneClean = '57' + phoneClean;
          }

          // Registrar en BD (o actualizar si ya existe)
          const clienteName = name || '';
          db.upsertClient(phoneClean, {
            name: clienteName,
            status: 'new',
            memory: contexto ? `[PANEL] Álvaro agregó manualmente: ${contexto}` : '[PANEL] Cliente agregado manualmente por Álvaro.'
          });

          console.log(`[AGREGAR] 📱 Nuevo cliente: ${phoneClean} (${clienteName}) — contexto: "${contexto || 'ninguno'}"`);

          // Generar mensaje personalizado con Gemini
          const prompt = `Eres el agente experto en armas traumáticas de Zona Traumática. Álvaro (el dueño) conoció a alguien y te pide que le escribas por primera vez.

Datos:
- Nombre: ${clienteName || 'no proporcionado'}
- Contexto: ${contexto || 'Álvaro lo conoció y quiere que le mandes información general del negocio'}

Tu tarea: Escribe un PRIMER MENSAJE de WhatsApp para este contacto nuevo.

Reglas:
- Preséntate brevemente como el asistente de Zona Traumática
- Menciona que Álvaro te pidió contactarlo
- Si hay contexto (ej: "le interesa Club Plus"), enfoca el mensaje en eso
- Si no hay contexto, ofrece información general: catálogo de armas traumáticas, planes Club ZT, y servicio de bot asesor legal
- Sé amable, profesional y breve (máx 4-5 líneas)
- Usa emojis moderadamente
- NO seas agresivo ni vendedor, solo informativo y servicial
- Termina con una pregunta abierta

Responde SOLO con el mensaje, sin explicaciones ni prefijos.`;

          const result = await geminiGenerate('gemini-2.5-flash', prompt);
          const firstMsg = result.response.text().trim();

          if (!firstMsg) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, message: 'Cliente registrado pero no se pudo generar mensaje.' }));
            return;
          }

          // Enviar por WhatsApp
          await safeSend(phoneClean, firstMsg);
          db.saveMessage(phoneClean, 'assistant', firstMsg);
          console.log(`[AGREGAR] ✅ Primer mensaje enviado a ${phoneClean}: "${firstMsg.substring(0, 60)}..."`);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: 'Cliente agregado y mensaje enviado.', phone: phoneClean }));
        } catch (e) {
          console.error('[AGREGAR] Error:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
    } else if (req.url === '/reatender' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { phone } = JSON.parse(body);
          if (!phone) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, msg: 'Falta teléfono' }));
            return;
          }
          const result = await forceBotReply(phone);
          res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          console.error('[REACTIVAR] Error /reatender:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
    } else if (req.url === '/confirmar-comprobante' && req.method === 'POST') {
      // Panel confirma o rechaza un comprobante de pago
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { id, accion, phone, tipo } = JSON.parse(body);

          // 1. Actualizar BD primero — esto SIEMPRE debe ocurrir
          db.updateComprobanteEstado(id, accion === 'confirmar' ? 'confirmado' : 'rechazado');

          // 2. Intentar notificar al cliente por WhatsApp (puede fallar sin romper nada)
          let phoneClean = phone.replace(/@.*/g, '').replace(/\D/g, '');

          if (phoneClean.length >= 13) {
            const row = db.db.prepare('SELECT phone FROM clients WHERE chat_id LIKE ? AND phone != ?').get('%' + phoneClean + '%', phoneClean);
            if (row) {
              console.log(`[COMPROBANTE] 🔄 LID resuelto para pago: ${phoneClean} -> ${row.phone}`);
              phoneClean = row.phone;
            }
          }

          const chatId = db.getClientChatId(phoneClean);
          let waSent = true;
          let waError = null;

          // 3. Preparar mensaje y actualizar BD de estado (siempre ocurre)
          let msgDatos = null;
          let msgRechazado = null;

          if (accion === 'confirmar') {
            // tipo viene como "club_plus,bot_asesor,producto" (multi-select del panel)
            const tipos = tipo.split(',').map(t => t.trim()).filter(Boolean);
            const tieneClubPlus = tipos.includes('club_plus');
            const tieneClubPro = tipos.includes('club_pro');
            const tieneBot = tipos.includes('bot_asesor');
            const tieneProducto = tipos.includes('producto');
            // Compat: soporte legacy "club" genérico (sin especificar Plus/Pro)
            const legacyClub = tipos.includes('club') && !tieneClubPlus && !tieneClubPro;
            const tieneClub = tieneClubPlus || tieneClubPro || legacyClub;

            const planNombre = tieneClubPro ? 'Plan Pro' : 'Plan Plus';

            let partes = [];
            let nuevoStatus;
            let memoriaTags = [];

            if (tieneClub) {
              partes.push(
                `🛡️ *Afiliación Club ZT (${planNombre}):* ¡Bienvenido!\n\n` +
                `Para generar tu *Carnet Digital* necesito:\n` +
                `1. Nombre completo\n2. Número de cédula\n3. Teléfono de contacto\n` +
                `4. Marca del arma\n5. Modelo del arma\n6. Número de serial del arma\n` +
                `7. 📸 Foto de frente (selfie clara, sin gafas, buena luz)`
              );
              nuevoStatus = tieneClubPro ? 'carnet_pendiente_pro' : 'carnet_pendiente_plus';
              memoriaTags.push(`✅ YA AFILIADO AL CLUB ZT (${planNombre}) — comprobante confirmado. NO ofrecer más afiliación.`);
            }

            if (tieneBot) {
              partes.push(
                `🤖 *Bot Asesor Legal ZT:* ¡Activado!\n\n` +
                `Tu número quedará habilitado en las próximas horas. Podrás consultar sobre normativa, derechos del portador y procedimientos legales.`
              );
              if (!nuevoStatus) nuevoStatus = 'bot_asesor_pendiente';
              memoriaTags.push('✅ YA PAGÓ BOT ASESOR LEGAL — comprobante confirmado. NO ofrecer más suscripciones.');
            }

            if (tieneProducto) {
              partes.push(
                `📦 *Producto / Arma:* ¡En proceso!\n\n` +
                `Para el envío necesito:\n` +
                `1. Nombre completo\n2. Número de cédula\n3. Teléfono de contacto\n` +
                `4. Dirección completa (calle, número, barrio, apto si aplica)\n` +
                `5. Ciudad\n6. Departamento\n\n` +
                `El envío se procesa en 1-2 días hábiles, discreto y seguro 🔒`
              );
              if (!nuevoStatus) nuevoStatus = 'despacho_pendiente';
              memoriaTags.push('✅ YA COMPRÓ PRODUCTO — comprobante confirmado. Está en proceso de envío.');
            }

            if (partes.length === 0) {
              msgDatos = `✅ ¡Confirmamos tu pago! Gracias por tu confianza 🙏\n\n` +
                `¿Me confirmas qué adquiriste? Así te pido los datos correctos 🚀`;
              nuevoStatus = 'hot';
              memoriaTags.push('✅ PAGO CONFIRMADO — pendiente definir tipo de compra.');
            } else {
              const header = `✅ ¡Confirmamos tu pago! Gracias por tu confianza 🙏\n\n`;
              const footer = `\n\nEn cuanto me envíes los datos, arrancamos de una 💪`;
              msgDatos = header + partes.join('\n\n━━━━━━━━━━━━━━━━━━━━\n\n') + footer;
            }

            // Actualizar estado y memoria
            const clientUpdate = { status: nuevoStatus };
            if (tieneClub) clientUpdate.club_plan = planNombre;
            db.upsertClient(phoneClean, clientUpdate);

            // Activar flags de servicio automáticamente
            if (tieneClubPlus) {
              db.db.prepare('UPDATE clients SET is_club_plus = 1, updated_at = CURRENT_TIMESTAMP WHERE phone = ?').run(phoneClean);
            }
            if (tieneClubPro) {
              db.db.prepare('UPDATE clients SET is_club_pro = 1, updated_at = CURRENT_TIMESTAMP WHERE phone = ?').run(phoneClean);
            }
            if (tieneBot) {
              db.db.prepare('UPDATE clients SET has_ai_bot = 1, updated_at = CURRENT_TIMESTAMP WHERE phone = ?').run(phoneClean);
            }

            const memoriaActual = db.getClientMemory(phoneClean) || '';
            const tagPago = memoriaTags.join('\n');
            const nuevaMemoria = memoriaActual ? memoriaActual + '\n' + tagPago : tagPago;
            db.updateClientMemory(phoneClean, nuevaMemoria);
            console.log(`[COMPROBANTE] ✅ BD actualizada ID #${id} para ${phone} (tipos: ${tipos.join(', ')})`);

            // Guardar imagen del comprobante en el perfil del cliente
            try {
              const comp = db.db.prepare('SELECT imagen_base64, imagen_mime FROM comprobantes WHERE id = ?').get(id);
              if (comp && comp.imagen_base64) {
                db.saveClientFile(phoneClean, 'comprobante', `Comprobante confirmado (${tipos.join(', ')})`, comp.imagen_base64, comp.imagen_mime, 'panel', id, 'comprobantes');
                console.log(`[COMPROBANTE] 🖼️ Imagen guardada en perfil de ${phoneClean}`);
              }
            } catch (imgErr) {
              console.error(`[COMPROBANTE] ⚠️ Error guardando imagen en perfil:`, imgErr.message);
            }

          } else {
            msgRechazado = `⚠️ Revisamos tu comprobante y el monto no coincide con el valor del plan seleccionado.\n\n` +
              `Por favor verifica el monto y vuelve a enviarnos el comprobante correcto. Si tienes dudas, con gusto te ayudamos 🙏`;
          }

          // 4. Intentar notificar al cliente por WhatsApp — puede fallar sin romper nada
          try {
            if (msgDatos) {
              await safeSend(phoneClean, msgDatos);
              db.saveMessage(phoneClean, 'assistant', msgDatos);
              console.log(`[COMPROBANTE] 📱 Notificación enviada a ${phone}`);
            } else if (msgRechazado) {
              await safeSend(phoneClean, msgRechazado);
              db.saveMessage(phoneClean, 'assistant', msgRechazado);
              console.log(`[COMPROBANTE] 📱 Rechazo notificado a ${phone}`);
            }
            waSent = true;
          } catch (waErr) {
            waSent = false;
            waError = waErr.message;
            console.error(`[COMPROBANTE] ⚠️ No se pudo notificar a ${phone}: ${waErr.message}`);
          }

          // BD ya fue actualizada — siempre responder ok:true
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, waSent, waWarning: waError }));
        } catch (e) {
          console.error('[COMPROBANTE] Error confirmar:', e.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
    } else if (req.url === '/confirmar-carnet' && req.method === 'POST') {
      // Panel confirma o rechaza un carnet subido
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { id, accion, phone, carnetData, planAprobado, vigenciaAprobada, razonRechazo } = JSON.parse(body);

          // 1. Actualizar estado del carnet en BD
          db.updateCarnetEstado(id, accion === 'confirmar' ? 'confirmado' : 'rechazado');

          // 2. Resolver LID a número real (por si acaso)
          let phoneClean = phone.replace(/@.*/g, '').replace(/\D/g, '');
          if (phoneClean.length >= 13) {
            const row = db.db.prepare('SELECT phone FROM clients WHERE chat_id LIKE ? AND phone != ?').get('%' + phoneClean + '%', phoneClean);
            if (row) {
              phoneClean = row.phone;
            }
          }

          let waSent = true;
          let waError = null;
          let msgToClient = null;

          if (accion === 'confirmar') {
            // Actualizar la ficha del cliente con los datos extraídos
            const clientUpdate = {
              status: 'afiliado',
              name: carnetData.nombres || undefined,
              cedula: carnetData.cedula || undefined,
              ciudad: carnetData.ciudad || undefined,
              club_plan: planAprobado || 'Plan Plus',
              club_vigente_hasta: vigenciaAprobada || undefined,
              serial_arma: carnetData.serial || undefined,
              modelo_arma: carnetData.arma || undefined
            };
            db.upsertClient(phoneClean, clientUpdate);

            // 2.5 Actualizar bóveda (checkboxes)
            if (planAprobado === 'Plan Pro') {
              db.updateClientFlag(phoneClean, 'is_club_pro', 1);
            } else {
              db.updateClientFlag(phoneClean, 'is_club_plus', 1);
            }

            // Actualizar memoria para que el bot lo trate como afiliado
            const memoriaActual = db.getClientMemory(phoneClean) || '';
            const planTag = planAprobado === 'Plan Pro' ? 'Plan Pro (Máxima Cobertura Jurídica)' : 'Plan Plus (Capacitación Legal)';
            const vigenciaTag = vigenciaAprobada ? ` (Vigente hasta: ${vigenciaAprobada})` : '';
            const tagAfiliado = `✅ AFILIADO ACTIVO AL CLUB ZT - ${planTag}${vigenciaTag}. NO ofrecer venta de membresía. SIEMPRE ofrecer beneficios del club y soporte.`;
            if (!memoriaActual.includes(tagAfiliado)) {
              db.updateClientMemory(phoneClean, memoriaActual ? memoriaActual + '\n' + tagAfiliado : tagAfiliado);
            }

            msgToClient = `✅ *¡Carnet verificado con éxito!*\n\nTu perfil en la base de datos de Zona Traumática ha sido actualizado y tu afiliación al ${planAprobado || 'Club ZT'} está **activa**${vigenciaAprobada ? ' y vigente hasta el ' + vigenciaAprobada : ''}. 🛡️\n\nA partir de este momento cuentas con:\n- ${planAprobado === 'Plan Pro' ? 'Asistencia y RESPALDO JURÍDICO 24/7' : 'Asistencia legal y capacitación'}\n- Acceso a la comunidad de portadores\n- Descuentos en munición y accesorios\n\n¿Tienes alguna duda legal o te gustaría consultar nuestro catálogo de munición?`;
            console.log(`[CARNET] ✅ BD actualizada ID #${id} para ${phoneClean}`);

            // Guardar imagen del carnet en el perfil del cliente
            try {
              const carn = db.db.prepare('SELECT imagen_base64, imagen_mime FROM carnets WHERE id = ?').get(id);
              if (carn && carn.imagen_base64) {
                db.saveClientFile(phoneClean, 'carnet', `Carnet ${planAprobado || 'Club ZT'} verificado`, carn.imagen_base64, carn.imagen_mime, 'panel', id, 'carnets');
                console.log(`[CARNET] 🖼️ Imagen guardada en perfil de ${phoneClean}`);
              }
            } catch (imgErr) {
              console.error(`[CARNET] ⚠️ Error guardando imagen en perfil:`, imgErr.message);
            }
          } else {
            let razonTxt = "no son completamente legibles o hay alguna inconsistencia";
            if (razonRechazo === 'vencido') razonTxt = "el documento se encuentra vencido o fuera de la vigencia aceptada";
            else if (razonRechazo === 'inconsistencia') razonTxt = "hemos detectado una inconsistencia en los datos o foto del documento enviado";

            msgToClient = `⚠️ *Revisión de Carnet*\n\nHola, hemos revisado la imagen de tu carnet pero ${razonTxt}.\n\n👉 Por favor, envíanos una foto **más clara**, vigente y original donde se pueda verificar toda la información. ¡Quedo atento! 🙏`;
          }

          // 3. Notificar al cliente
          try {
            await safeSend(phoneClean, msgToClient);
            db.saveMessage(phoneClean, 'assistant', msgToClient);
            console.log(`[CARNET] 📱 Notificación enviada a ${phoneClean}`);
          } catch (waErr) {
            waSent = false;
            waError = waErr.message;
            console.error(`[CARNET] ⚠️ No se pudo notificar a ${phoneClean}: ${waErr.message}`);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, waSent, waWarning: waError }));
        } catch (e) {
          console.error('[CARNET] Error confirmar:', e.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
    } else if (req.url === '/resolver-lids' && req.method === 'POST') {
      // Resolver phones LID: clientes cuyo phone >= 13 dígitos NO son un número real
      // Solo responsabilidad: dejar el número real como phone. El chat_id se auto-sana al enviar.
      const lidClients = db.getLidClients();

      if (lidClients.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, total: 0, msg: 'Sin clientes LID pendientes' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, total: lidClients.length }));

      (async () => {
        let resueltos = 0;
        let fallidos = 0;
        console.log(`[LID] 🔍 Resolviendo ${lidClients.length} phones LID a número real...`);

        for (const c of lidClients) {
          try {
            const chatId = c.chat_id || (c.phone + '@lid');
            const contact = await client.getContactById(chatId);
            const realNumber = (contact.number || '').replace(/\D/g, '');

            if (!realNumber || realNumber === c.phone) {
              console.log(`[LID] ⏭️  ${c.phone} — sin cambio`);
            } else {
              const existeReal = db.getClient(realNumber);
              if (existeReal) {
                const betterName = (c.name && c.name.trim()) ? c.name : existeReal.name;
                db.upsertClient(realNumber, { name: betterName, chat_id: chatId });
                db.db.prepare('DELETE FROM clients WHERE phone = ?').run(c.phone);
              } else {
                db.migrateClientPhone(c.phone, realNumber);
                db.upsertClient(realNumber, { chat_id: chatId });
              }
              console.log(`[LID] ✅ ${c.phone} → ${realNumber}`);
              resueltos++;
            }
            await new Promise(r => setTimeout(r, 800));
          } catch (err) {
            console.error(`[LID] ❌ ${c.phone}: ${err.message}`);
            fallidos++;
          }
        }

        console.log(`[LID] 🎉 Completado — ${resueltos} resueltos, ${fallidos} fallidos`);
      })().catch(e => console.error('[LID] Error general:', e.message));

      // POST /enviar-mensaje — panel envía mensaje como Álvaro
    } else if (req.url === '/enviar-mensaje' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { phone, message } = JSON.parse(body);
          if (!phone || !message) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'phone y message son requeridos' }));
            return;
          }

          // Enviar por WhatsApp
          const chatId = db.getClientChatId(phone);
          await client.sendMessage(chatId, message);

          // Guardar como admin en historial
          db.saveMessage(phone, 'admin', message);

          // Pausar bot para este cliente
          adminPauseMap.set(phone, Date.now() + 30 * 60 * 1000);

          // Disparar mensaje de transición manualmente (ya que message_create lo ignorará por el monkey-patch)
          enviarTransicionAdmin(phone, chatId, message).catch(e => console.error('[PANEL] Error en transición:', e));

          console.log(`[PANEL] 📝 Mensaje enviado como Álvaro a ${phone}: "${message.substring(0, 60)}"`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          console.error('[PANEL] Error enviar-mensaje:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });

      // POST /enviar-catalogo — panel envía catálogo completo con fotos al cliente
    } else if (req.url === '/enviar-catalogo' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { phone } = JSON.parse(body);
          if (!phone) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'phone es requerido' }));
            return;
          }

          // Responder inmediatamente al panel — el envío corre en background
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, msg: 'Enviando catálogo en background...' }));

          // Ejecutar en background
          (async () => {
            try {
              const chatId = db.getClientChatId(phone);
              const catalogoPath = path.join(__dirname, 'catalogo_contexto.json');
              const imagenesDir = path.join(__dirname, 'imagenes');
              const catalogo = JSON.parse(fs.readFileSync(catalogoPath, 'utf8'));

              // 1. Enviar mensaje introductorio
              const intro = `📋 *CATÁLOGO ZONA TRAUMÁTICA*\n` +
                `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `Aquí te comparto nuestro inventario disponible con fotos y precios.\n` +
                `Todos los dispositivos son 100% legales — armas menos letales (Ley 2197/2022).\n\n` +
                `📦 *Cada compra incluye:*\n` +
                `✓ Dispositivo + cargador\n` +
                `✓ 50 municiones\n` +
                `✓ Envío gratis a toda Colombia\n` +
                `✓ Kit de limpieza\n\n` +
                `👇 A continuación las referencias disponibles:`;

              await client.sendMessage(chatId, intro);
              db.saveMessage(phone, 'assistant', intro);
              await new Promise(r => setTimeout(r, 2000));

              // 2. Iterar por categorías y productos
              let totalEnviados = 0;
              for (const [marca, productos] of Object.entries(catalogo.categorias || {})) {
                if (marca === 'SERVICIOS') continue; // Servicios se envían aparte

                for (const p of productos) {
                  if (!p.disponible) continue;

                  // Buscar imagen del producto
                  const marcaFolder = marca.toLowerCase();
                  const pistolasDir = path.join(imagenesDir, 'pistolas', marcaFolder);
                  let imagenPath = null;

                  if (fs.existsSync(pistolasDir)) {
                    const modeloLower = (p.modelo || '').toLowerCase();
                    const modeloNoSpaces = modeloLower.replace(/\s+/g, '');
                    const files = fs.readdirSync(pistolasDir);

                    // Buscar primera imagen que coincida con el modelo
                    for (const file of files) {
                      if (!file.match(/\.(png|jpg|jpeg|webp)$/i)) continue;
                      const fileLower = file.toLowerCase().replace(/\.(png|jpg|jpeg|webp)$/i, '');
                      const modeloParts = modeloLower.split(' ');
                      if (modeloParts.every(part => fileLower.includes(part)) ||
                        fileLower.includes(modeloNoSpaces)) {
                        imagenPath = path.join(pistolasDir, file);
                        break;
                      }
                    }
                  }

                  // Caption con info del producto
                  const caption = `🔫 *${p.titulo}*\n` +
                    `Color(es): ${p.color}\n` +
                    `💰 Plan Plus: ${p.precio_plus}\n` +
                    `💰 Plan Pro: ${p.precio_pro}\n` +
                    (p.url ? `🔗 ${p.url}` : '');

                  if (imagenPath && fs.existsSync(imagenPath)) {
                    // Enviar con foto
                    const media = MessageMedia.fromFilePath(imagenPath);
                    await client.sendMessage(chatId, media, { caption });
                  } else {
                    // Enviar solo texto si no hay foto
                    await client.sendMessage(chatId, caption);
                  }

                  totalEnviados++;
                  // Delay entre productos (1.5-3s) para parecer natural
                  await new Promise(r => setTimeout(r, 1500 + Math.random() * 1500));
                }
              }

              // 3. Enviar imagen de inventario/precios general si existe
              const inventarioDir = path.join(imagenesDir, 'oferta actual', 'inventario y precios');
              let inventarioImg = null;
              if (fs.existsSync(inventarioDir)) {
                const invFiles = fs.readdirSync(inventarioDir).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f));
                if (invFiles.length > 0) inventarioImg = path.join(inventarioDir, invFiles[0]);
              }
              if (inventarioImg && fs.existsSync(inventarioImg)) {
                const media = MessageMedia.fromFilePath(inventarioImg);
                await client.sendMessage(chatId, media, { caption: '📊 *Tabla oficial de precios — Zona Traumática*' });
                await new Promise(r => setTimeout(r, 2000));
              }

              // 4. Mensaje final con servicios
              const cierre = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `🛡️ *Club Zona Traumática* — Respaldo jurídico total\n` +
                `  🟡 Plan Plus: $100.000/año\n` +
                `  🔴 Plan Pro: $150.000/año\n\n` +
                `🤖 *Asesor Legal IA* — Tu abogado 24/7\n` +
                `  $50.000 por 6 meses\n\n` +
                `¿Cuál te interesa? Estoy para ayudarte 🙌`;

              await client.sendMessage(chatId, cierre);
              db.saveMessage(phone, 'assistant', `[📋 Catálogo completo enviado: ${totalEnviados} productos con fotos]`);
              console.log(`[CATÁLOGO] ✅ Catálogo enviado a ${phone}: ${totalEnviados} productos`);

              // Marcar catálogo como enviado para este cliente
              db.markCatalogSent(phone);
              console.log(`[CATÁLOGO] 📌 Catálogo marcado como enviado para ${phone}`);

            } catch (bgErr) {
              console.error(`[CATÁLOGO] ❌ Error enviando catálogo a ${phone}:`, bgErr.message);
            }
          })();

        } catch (e) {
          console.error('[CATÁLOGO] Error:', e.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });

      // POST /devolver-bot — panel devuelve un cliente al bot (quita pausa de admin)
    } else if (req.url === '/devolver-bot' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { phone } = JSON.parse(body);
          if (!phone) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'phone es requerido' }));
            return;
          }

          // Quitar pausa de admin
          const wasPaused = adminPauseMap.has(phone);
          adminPauseMap.delete(phone);

          console.log(`[PANEL] 🤖 Cliente ${phone} devuelto al bot (estaba pausado: ${wasPaused})`);

          // Responder inmediatamente al panel
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, wasPaused }));

          // === SMART RESUME: Revisar lo que pasó durante la pausa ===
          if (wasPaused) {
            try {
              // Leer los últimos 20 mensajes para tener contexto de la pausa
              const history = db.getConversationHistory(phone, 20);

              // Separar los mensajes de Álvaro (admin) y del cliente durante la pausa
              const msgsDurantePausa = [];
              let encontroPausa = false;
              for (let i = history.length - 1; i >= 0; i--) {
                const m = history[i];
                if (m.role === 'admin' || encontroPausa) {
                  encontroPausa = true;
                  msgsDurantePausa.unshift(m);
                }
                // Parar cuando encontremos un mensaje del bot (antes de la pausa)
                if (encontroPausa && m.role === 'assistant' && !m.message.includes('buenas manos')) break;
              }

              if (msgsDurantePausa.length === 0) {
                console.log(`[RESUME] ℹ️ No hay mensajes durante la pausa para ${phone}`);
                return;
              }

              // Detectar si hay comprobante sin procesar (enviado durante la pausa)
              const tieneComprobantePendiente = msgsDurantePausa.some(m =>
                m.role === 'user' && (
                  (m.message || '').includes('[Media omitido: image]') ||
                  (m.message || '').includes('[Comprobante') ||
                  (m.message || '').toLowerCase().includes('comprobante') ||
                  (m.message || '').toLowerCase().includes('consign') ||
                  (m.message || '').toLowerCase().includes('transferencia') ||
                  (m.message || '').toLowerCase().includes('pago')
                )
              );

              // Resumen de lo que pasó durante la pausa
              const pauseContext = msgsDurantePausa.map(m => {
                const roleName = m.role === 'admin' ? 'Álvaro' : m.role === 'user' ? 'Cliente' : 'Bot';
                return `${roleName}: ${m.message}`;
              }).join('\n');

              console.log(`[RESUME] 📋 ${phone} — ${msgsDurantePausa.length} msgs durante pausa. Comprobante pendiente: ${tieneComprobantePendiente}`);

              // Generar mensaje de re-engagement con Gemini

              const clientMemory = db.getClientMemory(phone) || '';

              let instruccionExtra = '';
              if (tieneComprobantePendiente) {
                instruccionExtra = `\nIMPORTANTE: El cliente posiblemente envió un COMPROBANTE DE PAGO o mencionó un pago durante la pausa. ` +
                  `Si ves indicios de esto, pídele amablemente que vuelva a enviar la foto del comprobante ` +
                  `porque el sistema necesita recibirla estando activo para procesarla. ` +
                  `Ejemplo: "Vi que nos compartiste un comprobante mientras Álvaro te atendía. ¿Me lo puedes reenviar para procesarlo? 🙏"`;
              }

              const resumePrompt = `El director Álvaro terminó de atender personalmente a un cliente de Zona Traumática y ahora el bot retoma la conversación.

CONVERSACIÓN DURANTE LA ATENCIÓN DE ÁLVARO:
${pauseContext}

MEMORIA DEL CLIENTE: ${clientMemory}

Genera un mensaje CORTO (máximo 3 líneas) para retomar la conversación. Reglas:
1. Tono natural, como si el bot siempre hubiera estado ahí
2. Demuestra que SABES lo que se habló (menciona algo concreto)
3. Si quedó algo pendiente (datos, comprobante, decisión), pregunta por eso
4. NO digas "Álvaro me pidió que te atienda" ni nada similar
5. Máximo 2 emojis
${instruccionExtra}

Solo escribe el mensaje, sin explicaciones.`;


              const resumeResult = await geminiGenerate('gemini-2.5-flash', resumePrompt);
              const resumeMsg = resumeResult.response.text().trim();

              if (resumeMsg) {
                const chatId = db.getClientChatId(phone);
                await client.sendMessage(chatId, resumeMsg);
                db.saveMessage(phone, 'assistant', resumeMsg);
                console.log(`[RESUME] ✅ Mensaje de re-engagement enviado a ${phone}: "${resumeMsg.substring(0, 60)}"`);
              }

              // Actualizar memoria con resumen de la interacción de Álvaro
              updateClientMemory(phone, `[Álvaro atendió directamente]`, pauseContext,
                db.getConversationHistory(phone, 10)
              ).catch(e => console.error('[RESUME] Error actualizando memoria:', e.message));

            } catch (resumeErr) {
              console.error(`[RESUME] Error en smart resume para ${phone}:`, resumeErr.message);
            }
          }
        } catch (e) {
          console.error('[PANEL] Error devolver-bot:', e.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });

      // POST /enviar-carnet-whatsapp — panel envía carnet como imagen al cliente
    } else if (req.url === '/enviar-carnet-whatsapp' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { phone, imagenBase64, imagenMime, caption, carnetData } = JSON.parse(body);
          if (!phone || !imagenBase64) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'phone e imagenBase64 son requeridos' }));
            return;
          }

          let phoneClean = phone.replace(/@.*/g, '').replace(/\D/g, '');
          if (phoneClean.length === 10 && phoneClean.startsWith('3')) {
            phoneClean = '57' + phoneClean;
          }

          const data = carnetData || {};
          const planTipo = data.plan_tipo || 'Plan Plus';
          const nombre = data.nombre || '';
          const cedula = data.cedula || '';
          const vigente_hasta = data.vigente_hasta || '';
          const marca_arma = data.marca_arma || '';
          const modelo_arma = data.modelo_arma || '';
          const serial = data.serial || '';

          // 1. Guardar carnet en la tabla carnets
          db.saveCarnetFromPanel(phoneClean, nombre, imagenBase64, imagenMime || 'image/jpeg', {
            nombre, cedula, vigente_hasta, marca_arma, modelo_arma, serial, plan_tipo: planTipo
          });

          // 2. Guardar imagen en client_files
          db.saveClientFile(phoneClean, 'carnet', `Carnet ${planTipo} enviado desde panel`, imagenBase64, imagenMime || 'image/jpeg', 'panel');

          // 3. Actualizar ficha CRM del cliente
          const clientUpdate = {
            name: nombre || undefined,
            cedula: cedula || undefined,
            club_plan: planTipo,
            club_vigente_hasta: vigente_hasta || undefined,
            serial_arma: serial || undefined,
            modelo_arma: modelo_arma || undefined,
            status: 'afiliado'
          };
          db.upsertClient(phoneClean, clientUpdate);

          // 4. Activar flags de bóveda
          if (planTipo === 'Plan Pro') {
            db.updateClientFlag(phoneClean, 'is_club_pro', 1);
          } else {
            db.updateClientFlag(phoneClean, 'is_club_plus', 1);
          }

          // 5. Actualizar memoria
          const memoriaActual = db.getClientMemory(phoneClean) || '';
          const vigenciaTag = vigente_hasta ? ` (Vigente hasta: ${vigente_hasta})` : '';
          const tagAfiliado = `✅ CARNET ${planTipo.toUpperCase()} ENVIADO${vigenciaTag}. Afiliado activo al Club ZT.`;
          if (!memoriaActual.includes('CARNET') || !memoriaActual.includes(planTipo.toUpperCase())) {
            db.updateClientMemory(phoneClean, memoriaActual ? memoriaActual + '\n' + tagAfiliado : tagAfiliado);
          }

          // 6. Enviar imagen por WhatsApp
          let waSent = true;
          let waError = null;
          try {
            const media = new MessageMedia(imagenMime || 'image/jpeg', imagenBase64);
            const chatId = db.getClientChatId(phoneClean);
            const captionText = caption || `🪪 *¡Tu Carnet del Club Zona Traumática está listo!*\n\n` +
              `📋 Plan: *${planTipo}*\n` +
              (vigente_hasta ? `📅 Vigente hasta: *${vigente_hasta}*\n` : '') +
              `\n¡Bienvenido al Club ZT! 🛡️ Guarda esta imagen como tu carnet digital.`;
            await client.sendMessage(chatId, media, { caption: captionText });
            db.saveMessage(phoneClean, 'assistant', `[🪪 Carnet ${planTipo} enviado al cliente]`);
            console.log(`[CARNET-ENVÍO] ✅ Carnet ${planTipo} enviado a ${phoneClean}`);
          } catch (waErr) {
            waSent = false;
            waError = waErr.message;
            console.error(`[CARNET-ENVÍO] ⚠️ No se pudo enviar carnet a ${phoneClean}: ${waErr.message}`);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, waSent, waWarning: waError }));
        } catch (e) {
          console.error('[CARNET-ENVÍO] Error:', e.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });

      // POST /enviar-guia-whatsapp — panel envía guía de envío al cliente
    } else if (req.url === '/enviar-guia-whatsapp' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { phone, transportadora, numeroGuia, producto, caption, imagenBase64, imagenMime } = JSON.parse(body);
          if (!phone || !numeroGuia) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'phone y numeroGuia son requeridos' }));
            return;
          }

          let phoneClean = phone.replace(/@.*/g, '').replace(/\D/g, '');
          if (phoneClean.length === 10 && phoneClean.startsWith('3')) {
            phoneClean = '57' + phoneClean;
          }

          const transport = transportadora || 'Servientrega';
          const prod = producto || '';

          // 1. Construir mensaje
          const defaultCaption = `📦 *¡Tu pedido va en camino!*\n\n` +
            `🚚 *Transportadora:* ${transport}\n` +
            `📋 *Número de guía:* ${numeroGuia}\n` +
            (prod ? `📦 *Producto:* ${prod}\n` : '') +
            `\n¡Apenas te llegue nos cuentas para dejarte todo listo! 🙌`;
          const captionText = caption || defaultCaption;

          // 2. Guardar nota en memoria del cliente
          const memoriaActual = db.getClientMemory(phoneClean) || '';
          const guiaTag = `📦 GUÍA ENVIADA — ${transport} #${numeroGuia}${prod ? ' (' + prod + ')' : ''} — ${new Date().toLocaleDateString('es-CO')}`;
          db.updateClientMemory(phoneClean, memoriaActual ? memoriaActual + '\n' + guiaTag : guiaTag);

          // 3. Enviar por WhatsApp
          let waSent = true;
          let waError = null;
          try {
            const chatId = db.getClientChatId(phoneClean);
            if (imagenBase64) {
              // Con imagen adjunta
              const media = new MessageMedia(imagenMime || 'image/jpeg', imagenBase64);
              await client.sendMessage(chatId, media, { caption: captionText });
            } else {
              // Solo texto
              await client.sendMessage(chatId, captionText);
            }
            db.saveMessage(phoneClean, 'assistant', `[📦 Guía ${transport} #${numeroGuia} enviada al cliente]`);
            console.log(`[GUÍA-ENVÍO] ✅ Guía ${transport} #${numeroGuia} enviada a ${phoneClean}`);
          } catch (waErr) {
            waSent = false;
            waError = waErr.message;
            console.error(`[GUÍA-ENVÍO] ⚠️ No se pudo enviar guía a ${phoneClean}: ${waErr.message}`);
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, waSent, waWarning: waError }));
        } catch (e) {
          console.error('[GUÍA-ENVÍO] Error:', e.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });

    } else {
      res.writeHead(404);
      res.end();
    }
  });

  botApiServer.listen(3001, () => {
    console.log('[BOT API] 🚀 API interna escuchando en puerto 3001');

    // Iniciar automáticamente el Panel Web
    console.log('[SISTEMA] 🌐 Iniciando Panel de Administración Web en background...');
    const panelProcess = fork(path.join(__dirname, 'panel.js'));

    panelProcess.on('error', (err) => {
      console.error('[SISTEMA] ❌ Error al iniciar panel.js:', err.message);
    });

    panelProcess.on('exit', (code) => {
      console.log(`[SISTEMA] ⚠️ Panel Web se cerró con código ${code}`);
    });

    // ====== LIMPIEZA AL CERRAR (Graceful Shutdown) ======
    const cleanup = () => {
      console.log('\n[SISTEMA] 🛑 Apagando el bot y liberando puertos...');
      try {
        if (panelProcess && !panelProcess.killed) {
          panelProcess.kill('SIGINT');
        }
        botApiServer.close(() => {
          console.log('[SISTEMA] ✅ Puerto 3001 liberado correctamente.');
          process.exit(0);
        });
      } catch (e) {
        process.exit(1);
      }
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });
}

// ============================================
// PROCESADOR DE COLA DE REINTENTOS (Fondo)
// ============================================
async function processRetryQueue() {
  if (retryQueue.length === 0) return;

  console.log(`[RETRY QUEUE] 🔄 Procesando cola (${retryQueue.length} mensajes pendientes)...`);

  // Extraemos el primero de la cola
  const item = retryQueue.shift();
  const { senderPhone, messageBody, history, rawMsg, intent } = item;

  try {
    let response;
    if (CONFIG.mode === 'direct') {
      response = await getClaudeResponse(senderPhone, messageBody, history);
    } else {
      response = await getN8nResponse(senderPhone, messageBody, history);
    }

    if (response) {
      if (response === '__ERROR_CONEXION__') {
        // Falló de nuevo. Lo regresamos al FINAL de la cola para seguir intentando
        console.log(`[RETRY QUEUE] ⚠️ Fallo nuevamente para ${senderPhone}. Regresando a la cola.`);
        retryQueue.push(item);
      } else {
        // ¡ÉXITO!
        console.log(`[RETRY QUEUE] ✅ ¡Éxito! Mensaje recuperado y respondido a ${senderPhone}.`);
        response = response.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, '$2');
        const { cleanResponse } = await detectAndSendProductImages(response, rawMsg, senderPhone);
        response = cleanResponse;

        db.saveMessage(senderPhone, 'assistant', response);
        await rawMsg.reply(response);

        if (intent !== 'hot_lead') {
          const responseLower = response.toLowerCase();
          const estaOfreciendoClub = (
            responseLower.includes('plan plus') && responseLower.includes('plan pro')
          ) || (
              responseLower.includes('100.000') && responseLower.includes('afiliaci')
            ) || (
              responseLower.includes('150.000') && responseLower.includes('pro')
            );
          if (estaOfreciendoClub) {
            sendPromoImage(senderPhone);
          }
        } else {
          await handleHandoff(rawMsg, senderPhone, messageBody, history, 'venta');
        }

        const isBotResponse = true;
        notifyAuditors(senderPhone, response, 'BOT', isBotResponse);
      }
    }
  } catch (e) {
    console.error(`[RETRY QUEUE] ❌ Error duro intentando reenviar a ${senderPhone}:`, e.message);
    // Lo regresamos a la cola por si es un fallo intermitente de la función misma
    retryQueue.push(item);
  }
}

// Ejecutar el procesador cada 45 segundos
setInterval(processRetryQueue, 45000);

client.initialize();
