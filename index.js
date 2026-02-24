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
const { GoogleGenerativeAI } = require('@google/generative-ai');
const jsQR = require('jsqr');
const Jimp = require('jimp');

const db = require('./db');
const router = require('./router');
const search = require('./search');

// Inicializar Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiPro = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });


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
  knowledgeBase = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
  console.log('[BOT] Base de conocimiento cargada');
} catch (error) {
  console.error('[BOT] Error cargando knowledge_base.json:', error.message);
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
    const sessionDir = path.join(__dirname, 'session', 'session-client-one');
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
  setTimeout(() => startGroupBroadcaster(), 30000);

  // Iniciar servidor interno para recibir comandos del panel
  startReactivacionServer();
});

// Error de autenticación — limpiar sesión corrupta y reiniciar
client.on('auth_failure', async (msg) => {
  console.error('[BOT] ❌ Error de autenticación:', msg);
  console.log('[BOT] 🧹 Limpiando sesión corrupta...');
  const sessionDir = path.join(__dirname, 'session', 'session-client-one');
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
    const sessionDir = path.join(__dirname, 'session', 'session-client-one');
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  }
  console.log('[BOT] 🔄 Intentando reconectar en 10 segundos...');
  setTimeout(() => client.initialize(), 10000);
});

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
      'chatgpt', 'openai', 'gemini', 'copilot', 'claude', 'bot',
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
      console.log(`[BOT] 🚫 BLOQUEADO: ${senderRaw} (${chat.name || 'sin nombre'})${isBotMessage ? ' [msg automático]' : ''}`);
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

    // Log de todo mensaje entrante (para monitoreo)
    console.log(`[MSG] 📩 ${chat.name || senderPhone}: "${messageBody.substring(0, 50)}${messageBody.length > 50 ? '...' : ''}"`);

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

      if (mensajes.length === 0) return;

      // Usar el último msg como referencia (para reply, type, etc.)
      const msgRef = mensajes[mensajes.length - 1];

      // Si hay un solo mensaje de texto, procesarlo normal
      // Si hay varios, concatenar los textos en uno solo
      const soloTextos = mensajes.filter(m => !m.hasMedia && m.type === 'chat');
      const conMedia = mensajes.filter(m => m.hasMedia || m.type !== 'chat');

      if (mensajes.length > 1) {
        console.log(`[DEBOUNCE] 🔀 ${senderPhone} — procesando ${mensajes.length} mensajes juntos`);
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
        }
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
            const history = db.getConversationHistory(senderPhone, 10);
            const clientMemory = db.getClientMemory(senderPhone);
            const systemPrompt = buildSystemPrompt('El cliente envió una imagen. Continúa la conversación con el contexto previo que ya tienes.', clientMemory);

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

            // Detectar si la imagen es un comprobante de pago usando Gemini
            const imagePart = { inlineData: { data: media.data, mimeType: mediaType } };
            let esComprobante = false;
            let infoComprobante = '';
            try {
              const checkModel = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });
              const checkResult = await checkModel.generateContent([
                imagePart,
                'Esta imagen, ¿es un comprobante de pago (transferencia bancaria, Nequi, Bancolombia, Daviplata, Bold, etc.)? Responde SOLO con JSON: {"esComprobante": true/false, "monto": "valor si lo ves o null", "entidad": "banco/app o null"}'
              ]);
              const checkText = checkResult.response.text().trim().replace(/```json|```/g, '').trim();
              const checkData = JSON.parse(checkText);
              esComprobante = checkData.esComprobante === true;
              if (esComprobante) {
                infoComprobante = `Monto: ${checkData.monto || 'no visible'} | Entidad: ${checkData.entidad || 'no visible'}`;
                console.log(`[COMPROBANTE] 💰 Detectado de ${senderPhone}: ${infoComprobante}`);
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

              // Detectar tipo de comprobante:
              // 1. Bot asesor: cliente menciona "bot", "asesor legal", "ia", "inteligencia" o su status ya es afiliado
              // 2. Club ZT: primera afiliación al club
              // 3. Producto: dispositivo, munición, etc.
              let tipoComprobante;
              if (
                mensajeLow.includes('bot') || mensajeLow.includes('asesor legal') ||
                mensajeLow.includes('inteligencia') || mensajeLow.includes(' ia ') ||
                memoriaLow.includes('bot asesor') || memoriaLow.includes('acceso bot') ||
                memoriaLow.includes('suscripcion bot') || memoriaLow.includes('suscripción bot')
              ) {
                tipoComprobante = 'bot_asesor';
              } else if (
                memoriaLow.includes('club') || memoriaLow.includes('afiliaci') ||
                mensajeLow.includes('club') || mensajeLow.includes('afiliaci') || mensajeLow.includes('carnet')
              ) {
                tipoComprobante = 'club';
              } else {
                tipoComprobante = 'producto';
              }

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
              const qrModel = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });
              const qrPrompt = `Eres un asesor de Zona Traumática (tienda de armas traumáticas y Club ZT en Colombia).
Un cliente te envió una imagen con un código QR. El contenido escaneado del QR es:

"${qrTexto}"

${msg.body ? `El cliente también escribió: "${msg.body}"` : ''}

Analiza qué tipo de QR es (carnet, link, documento, etc.) e informa al cliente de forma clara y útil qué contiene. Sé breve y directo.`;
              const qrResult = await qrModel.generateContent(qrPrompt);
              reply = qrResult.response.text();
              await msg.reply(reply);
              db.saveMessage(senderPhone, 'user', `[QR escaneado: ${qrTexto.substring(0, 60)}]`);
              db.saveMessage(senderPhone, 'assistant', reply);
              db.upsertClient(senderPhone, {});

            } else {
              // Imagen normal — flujo con system prompt completo e historial
              const textPart = msg.body || 'El cliente envió esta imagen.';
              const visionModel = genAI.getGenerativeModel({
                model: 'gemini-2.5-pro',
                systemInstruction: systemPrompt,
                generationConfig: { thinkingConfig: { thinkingBudget: -1 } }
              });
              const visionChat = visionModel.startChat({ history: geminiHistory });
              const visionResult = await visionChat.sendMessage([imagePart, textPart]);
              reply = visionResult.response.text();
              await msg.reply(reply);
              db.saveMessage(senderPhone, 'user', '[imagen enviada]');
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

          const history = db.getConversationHistory(senderPhone, 10);
          const clientMemory = db.getClientMemory(senderPhone);
          const systemPrompt = buildSystemPrompt('El cliente envió un mensaje de voz. Continúa la conversación con el contexto previo.', clientMemory);

          // Historial previo para mantener contexto
          const geminiHistoryAudio = history
            .filter(h => h.role !== 'system' && h.content && h.content.trim().length > 0)
            .map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content.trim() }] }));
          while (geminiHistoryAudio.length > 0 && geminiHistoryAudio[0].role !== 'user') geminiHistoryAudio.shift();

          const audioPart = { inlineData: { data: media.data, mimeType: audioMime } };
          const textPart = 'El cliente envió este mensaje de voz. Transcríbelo, entiéndelo y responde como si fuera texto normal. No menciones que fue un audio.';

          const audioModel = genAI.getGenerativeModel({
            model: 'gemini-2.5-pro',
            systemInstruction: systemPrompt,
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

          const history = db.getConversationHistory(senderPhone, 10);
          const clientMemory = db.getClientMemory(senderPhone);
          const systemPrompt = buildSystemPrompt('El cliente envió un PDF. Continúa la conversación con el contexto previo.', clientMemory);

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
            model: 'gemini-2.5-pro',
            systemInstruction: systemPrompt,
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
    }

    if (!messageBody) return;

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
  // 1. Obtener nombre del perfil y teléfono real de WhatsApp
  let profileName = '';
  try {
    const contact = await rawMsg.getContact();
    profileName = contact.pushname || contact.name || contact.shortName || '';

    // contact.number resuelve el teléfono real incluso cuando el mensaje llegó con LID
    const realNumber = (contact.number || '').replace(/\D/g, '');
    if (realNumber && realNumber !== senderPhone) {
      console.log(`[BOT] 📱 LID resuelto: ${senderPhone} → ${realNumber}`);
      // Si existe registro viejo bajo el LID, migrarlo al número real
      if (db.getClient(senderPhone) && !db.getClient(realNumber)) {
        db.migrateClientPhone(senderPhone, realNumber);
      }
      senderPhone = realNumber;
    }

    if (CONFIG.debug) {
      console.log(`[DEBUG] Perfil WhatsApp: "${profileName}" (${senderPhone})`);
    }
  } catch (err) {
    console.error('[BOT] Error obteniendo contacto:', err.message);
  }

  // 2. Registrar/actualizar cliente en CRM (con nombre de perfil)
  const existingClient = db.getClient(senderPhone);
  const isNewClient = !existingClient;

  // chat_id = msg.from completo (puede ser @c.us o @lid) — guardarlo siempre
  const chatIdFromMsg = rawMsg.from || (senderPhone + '@c.us');

  if (isNewClient) {
    // Cliente nuevo → crear con nombre de perfil y chat_id real
    db.upsertClient(senderPhone, { name: profileName, chat_id: chatIdFromMsg });
    console.log(`[BOT] 🆕 Nuevo cliente: "${profileName}" (${senderPhone}) [${chatIdFromMsg}]`);
    saveContactToVCF(senderPhone, profileName);

  } else {
    // Cliente existente → actualizar chat_id siempre (puede cambiar de @c.us a @lid)
    const updateData = { chat_id: chatIdFromMsg };
    if (profileName && !existingClient.name) updateData.name = profileName;
    db.upsertClient(senderPhone, updateData);
    if (profileName && !existingClient.name) saveContactToVCF(senderPhone, profileName);
  }

  // ⛔ Contacto ignorado desde el panel — silencio total
  if (db.isIgnored(senderPhone)) {
    console.log(`[BOT] 🔇 Ignorado (panel): ${senderPhone} (${profileName})`);
    return;
  }

  // 3. Guardar mensaje del cliente
  db.saveMessage(senderPhone, 'user', messageBody);

  // 4. Obtener historial para contexto
  const history = db.getConversationHistory(senderPhone, 10);

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
    // --- LEAD CALIENTE: marcar en panel silenciosamente y seguir con IA ---
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
      // Guardar respuesta del bot
      db.saveMessage(senderPhone, 'assistant', response);

      // Enviar respuesta
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
        const nuevoStatus = esClub ? 'carnet_pendiente' : 'despacho_pendiente';
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

// ============================================
// MEMORIA DEL CLIENTE (se actualiza en background)
// ============================================
async function updateClientMemory(clientPhone, userMessage, botResponse, history) {
  try {
    const currentMemory = db.getClientMemory(clientPhone);
    const clientInfo = db.getClient(clientPhone);

    // Construir prompt para que Claude genere la memoria actualizada
    const memoryPrompt = `Eres un sistema de CRM para Zona Traumática, tienda de armas traumáticas legales en Colombia. Tu tarea es mantener una ficha breve del cliente.

⚠️ REGLA CRÍTICA — NOMBRES:
- "Álvaro" es el director de Zona Traumática, NO el nombre del cliente.
- NUNCA registres "Álvaro" como nombre del cliente aunque aparezca en el mensaje.
- Solo registra el nombre del cliente si él mismo lo dijo explícitamente ("me llamo X", "soy X", "mi nombre es X").
- Si el cliente saluda a alguien llamado "Álvaro" o menciona ese nombre en otro contexto, ignóralo para el campo nombre.

MEMORIA ACTUAL DEL CLIENTE:
${currentMemory || '(Cliente nuevo, sin memoria previa)'}

ÚLTIMA INTERACCIÓN:
- Cliente dijo: "${userMessage}"
- Bot respondió: "${botResponse.substring(0, 300)}"

INSTRUCCIONES:
Genera una ficha actualizada del cliente en máximo 6 líneas. Incluye SOLO datos útiles para ventas:
- Nombre del cliente (SOLO si él mismo lo dijo explícitamente: "me llamo X", "soy X". NUNCA si solo saludó a alguien)
- Ciudad o departamento (si lo mencionó)
- Referencia o modelo de interés (si mencionó alguno)
- Plan preferido (Plus o Pro, si lo indicó)
- Motivo de compra (defensa personal, colección, regalo, etc.)
- Intención (solo consultando, interesado, listo para comprar)
- Objeciones detectadas (duda del pago virtual, no tiene presupuesto, etc.)
- Si ya compró: qué compró y si tiene carnet pendiente o dispositivo pendiente

Si la conversación fue solo un saludo sin info útil, devuelve la memoria actual sin cambios.
NO inventes datos. Solo registra lo que el cliente DIJO explícitamente.
Responde SOLO con la ficha, sin explicaciones.`;

    // Usar Gemini Flash para memoria (barato y rápido)
    const memoryModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const memoryResult = await memoryModel.generateContent(memoryPrompt);
    const newMemory = memoryResult.response.text().trim();

    // Solo actualizar si cambió y no está vacío
    if (newMemory && newMemory !== currentMemory) {
      db.updateClientMemory(clientPhone, newMemory);
      if (CONFIG.debug) console.log(`[MEMORY] ✅ Memoria actualizada para ${clientPhone}`);
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
  const msgCliente = tipo === 'postventa'
    ? `✅ Tu solicitud fue registrada y ya la estamos gestionando. En breve un asesor te contacta. 🙏`
    : `✅ ¡Perfecto! Ya te conecté con un asesor que te va a acompañar en el proceso. En breve te contacta. 💪`;
  try {
    await msg.reply(msgCliente);
  } catch (e) {
    console.error(`[HANDOFF] ❌ Error enviando mensaje al cliente:`, e.message);
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

    // 2. Obtener memoria del cliente
    const clientMemory = db.getClientMemory(clientPhone);

    // 3. Construir system prompt
    const systemPrompt = buildSystemPrompt(productContext, clientMemory);

    // 4. Convertir historial al formato Gemini
    // Gemini usa 'user' y 'model' (no 'assistant')
    // El historial debe comenzar siempre con 'user'
    const geminiHistory = [];
    for (const m of history) {
      const role = m.role === 'assistant' ? 'model' : 'user';
      // Saltar mensajes de sistema
      if (m.role === 'system') continue;
      geminiHistory.push({ role, parts: [{ text: m.message }] });
    }

    // Asegurar que el historial empiece con 'user'
    while (geminiHistory.length > 0 && geminiHistory[0].role !== 'user') {
      geminiHistory.shift();
    }

    // 5. Llamar a Gemini con reintentos
    const MAX_RETRIES = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const model = genAI.getGenerativeModel({
          model: 'gemini-2.5-pro',
          systemInstruction: systemPrompt,
          generationConfig: { thinkingConfig: { thinkingBudget: -1 } }
        });

        const chat = model.startChat({ history: geminiHistory });
        const result = await chat.sendMessage(message);
        console.log(`[GEMINI] ✅ Respuesta OK para ${clientPhone}`);
        return result.response.text();
      } catch (retryError) {
        lastError = retryError;
        const errorMsg = retryError.message || 'Error desconocido';
        console.error(`[GEMINI] ⚠️ Intento ${attempt}/${MAX_RETRIES} falló: ${errorMsg}`);

        if (attempt < MAX_RETRIES) {
          const wait = attempt * 2000;
          console.log(`[GEMINI] ⏳ Reintentando en ${wait / 1000}s...`);
          await new Promise(r => setTimeout(r, wait));
        }
      }
    }

    console.error(`[GEMINI] ❌ Falló después de ${MAX_RETRIES} intentos: ${lastError?.message}`);
    return 'Disculpa, estoy teniendo un problema momentáneo. Dame unos segundos e inténtalo de nuevo. 🙏';
  } catch (error) {
    console.error('[GEMINI] Error general:', error.message);
    return 'Disculpa, tuve un inconveniente. ¿Podrías repetir tu consulta?';
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
- Con la Defensa Jurídica (Plan Pro) tienes abogado gratis si te incautan ilegalmente.
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
Cuando hables del Plan Plus NO digas "respaldo legal" a secas — di "capacitación legal", "conocimiento jurídico" o "herramientas para saber tus derechos". El respaldo legal post-incautación (abogado incluido) es SOLO Plan Pro.

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
   → Total en abogados cubierto: $2.6 millones. Tu inversión: $150.000.
   → Con un solo caso que ganes, el club se paga solo por los próximos 13 años.

⭐ PLAN PRO + ASESOR LEGAL IA — *$200.000* (¡EL MEJOR VALOR!)
✅ Todo lo del Plan Pro (carpeta jurídica, simulacros, descuentos, comunidad, certificado QR, defensa jurídica gratis)
Y además:
🤖 Asesor Legal IA 24/7 por 6 meses directo en tu WhatsApp (ver detalles completos abajo)
(Valor normal del combo: $250.000 — hoy: $200.000)

LA VERDAD QUE NADIE DICE:
Contratar abogado DESPUÉS de la incautación cuesta $800.000–$1.500.000 solo en primera instancia.
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
✅ Directo en tu WhatsApp personal — no necesitas app ni plataforma aparte

CÓMO VENDER EL ASESOR LEGAL IA:
- Si el cliente ya es afiliado al Club: ofrécelo como el complemento perfecto para tener poder legal en el bolsillo.
- Si el cliente NO es afiliado: explícale que primero necesita afiliarse al Club (mínimo Plan Plus) y luego puede activar el bot.
- Si el cliente pregunta por la legalidad, por requisas, o por cómo actuar ante la policía: es el momento PERFECTO para presentar el bot.
- Frase clave: "Cuando ese policía esté frente a ti... ¿Vas a dudar o vas a citar la ley exacta?"
- El bot se activa respondiendo "ACTIVAR" al número 3013981979.

ACTIVACIÓN DEL ASESOR LEGAL IA — PASOS:
1️⃣ Ser afiliado activo del Club ZT (Plan Plus o Pro vigente)
2️⃣ Pagar $50.000 por los medios habituales
3️⃣ Enviar comprobante por WhatsApp
4️⃣ Se activa en 24h directo en tu WhatsApp personal por 6 meses

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
- Si el cliente quiere comprar o hablar con alguien: dile que escriba "quiero comprar" o "hablar con asesor" y el sistema lo conecta automáticamente.`;
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
// BROADCASTER DE IMÁGENES A GRUPOS
// ============================================
// Envía imágenes rotativas a todos los grupos cada 4 horas
// con texto generado por Claude (diferente cada vez)

let broadcasterImageIndex = 0; // índice rotativo de imágenes

async function getGroupBroadcastText(imageName) {
  const contextos = [
    'Es de mañana, los grupos están empezando el día',
    'Es mediodía, buen momento para recordar la oferta',
    'Es tarde, último push del día para el club',
  ];
  const contextoAleatorio = contextos[Math.floor(Math.random() * contextos.length)];

  try {
    const broadcastModel = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });
    const prompt = `Eres el community manager de Zona Traumática Colombia.
Escribe un mensaje corto y poderoso para acompañar esta imagen promocional del Club ZT en un grupo de WhatsApp de portadores de armas traumáticas.
Contexto: ${contextoAleatorio}.
Imagen: ${imageName}.
El mensaje debe:
- Ser máximo 4 líneas
- Tener gancho emocional (miedo a perder el arma, orgullo del portador preparado)
- Terminar con una llamada a la acción clara (escribir al privado, preguntar por el plan, etc.)
- Usar emojis con moderación (máximo 3)
- Sonar humano, NO robótico ni corporativo
- NO repetir exactamente lo que dice la imagen
Solo escribe el mensaje, sin explicaciones.`;
    const result = await broadcastModel.generateContent(prompt);
    return result.response.text().trim();
  } catch (err) {
    console.error('[BROADCASTER] Error generando texto:', err.message);
    return '🛡️ ¿Ya tienes tu respaldo legal listo? El Club Zona Traumática te protege antes, durante y después. Escríbenos al privado.';
  }
}

async function sendGroupBroadcast() {
  console.log('[BROADCASTER] 📢 Iniciando envío a grupos...');

  // Obtener todas las imágenes disponibles en /imagenes
  const imagenesDir = path.join(__dirname, 'imagenes');
  let imagenes = [];
  try {
    imagenes = fs.readdirSync(imagenesDir).filter(f =>
      f.match(/\.(png|jpg|jpeg|webp)$/i)
    );
  } catch (e) {
    console.error('[BROADCASTER] No se pudo leer carpeta imagenes:', e.message);
    return;
  }

  if (imagenes.length === 0) {
    console.log('[BROADCASTER] No hay imágenes en /imagenes — cancelando');
    return;
  }

  // Seleccionar imagen rotativa
  const imagenActual = imagenes[broadcasterImageIndex % imagenes.length];
  broadcasterImageIndex++;
  const imagenPath = path.join(imagenesDir, imagenActual);

  console.log(`[BROADCASTER] 🖼️ Imagen: ${imagenActual} (${broadcasterImageIndex}/${imagenes.length})`);

  // Generar texto con Claude
  const texto = await getGroupBroadcastText(imagenActual);
  console.log(`[BROADCASTER] 📝 Texto: ${texto.substring(0, 80)}...`);

  // Obtener todos los grupos
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

  // Cargar imagen
  let media;
  try {
    media = MessageMedia.fromFilePath(imagenPath);
  } catch (e) {
    console.error('[BROADCASTER] Error cargando imagen:', e.message);
    return;
  }

  // Enviar a cada grupo con delay entre envíos para no saturar
  let enviados = 0;
  for (const grupo of grupos) {
    try {
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
  const HORAS_ENVIO = [8, 12, 16, 20]; // 8am, 12pm, 4pm, 8pm

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
// REACTIVACIÓN DE LEADS CALIENTES
// El panel llama a http://localhost:3001/reactivar cuando se presiona el botón
// El bot procesa la lista uno por uno con delay anti-ban
// ============================================
const http = require('http');

async function procesarClientesCalientes(clientes) {
  console.log(`[REACTIVAR] 🔥 Iniciando reactivación de ${clientes.length} leads calientes...`);

  for (let i = 0; i < clientes.length; i++) {
    const cliente = clientes[i];
    try {
      const historial = db.getConversationHistory(cliente.phone, 10);
      const resumenHistorial = historial.map(h => `${h.role === 'user' ? 'Cliente' : 'Bot'}: ${h.message}`).join('\n');

      const reactivarModel = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });
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
3. Urgencia sutil de la promoción por tiempo limitado — como dato, no como presión
4. Cierra con una pregunta abierta
5. Tono: cercano, humano, como amigo que avisa — NO vendedor desesperado
6. Máximo 2 emojis
7. NO menciones que es un mensaje automático

Escribe SOLO el mensaje, sin explicaciones ni comillas.`;

      const result = await reactivarModel.generateContent(prompt);
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

function startReactivacionServer() {
  const botApiServer = http.createServer((req, res) => {
    if (req.url === '/reactivar' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const { clientes } = JSON.parse(body);
          if (!clientes || clientes.length === 0) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, msg: 'Sin clientes para procesar' }));
            return;
          }
          // Responder inmediatamente al panel — el proceso corre en background
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, total: clientes.length }));
          // Procesar en background sin bloquear
          procesarClientesCalientes(clientes).catch(e => console.error('[REACTIVAR]', e.message));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
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
          const phoneClean = phone.replace(/@.*/g, '').replace(/\D/g, '');
          const chatId = db.getClientChatId(phoneClean);
          let waSent = true;
          let waError = null;

          // 3. Preparar mensaje y actualizar BD de estado (siempre ocurre)
          let msgDatos = null;
          let msgRechazado = null;

          if (accion === 'confirmar') {
            let nuevoStatus;
            if (tipo === 'club') {
              msgDatos = `✅ ¡Confirmamos tu pago! Bienvenido al Club ZT 🛡️\n\nPara generar tu carnet digital necesito estos datos:\n\n` +
                `📋 *Datos para tu Carnet Digital Club ZT:*\n` +
                `1. Nombre completo\n2. Número de cédula\n3. Teléfono de contacto\n` +
                `4. Marca del arma\n5. Modelo del arma\n6. Número de serial del arma\n` +
                `7. 📸 Foto de frente (selfie clara, sin gafas de sol, buena iluminación)\n\n` +
                `En cuanto me envíes todo, tu carnet estará listo en menos de 24 horas 💪`;
              nuevoStatus = 'carnet_pendiente';
            } else if (tipo === 'bot_asesor') {
              msgDatos = `✅ ¡Confirmamos tu pago! Ya tienes acceso al *Bot Asesor Legal ZT* 🤖⚖️\n\n` +
                `Tu número quedará activado en las próximas horas. A partir de ese momento podrás consultarle directamente al bot sobre:\n\n` +
                `• Normativa vigente de armas traumáticas\n` +
                `• Derechos y deberes como portador\n` +
                `• Procedimientos legales en caso de uso\n` +
                `• Y mucho más 💪\n\n` +
                `Te avisamos cuando esté activo. ¡Gracias por tu confianza! 🙏`;
              nuevoStatus = 'bot_asesor_pendiente';
            } else {
              msgDatos = `✅ ¡Confirmamos tu pago! Ya estamos procesando tu pedido 📦\n\nPara el envío necesito estos datos:\n\n` +
                `📦 *Datos de envío:*\n` +
                `1. Nombre completo\n2. Número de cédula\n3. Teléfono de contacto\n` +
                `4. Dirección completa (calle, número, barrio, apartamento si aplica)\n` +
                `5. Ciudad\n6. Departamento\n\n` +
                `El envío se procesa en 1-2 días hábiles, es discreto y seguro 🔒`;
              nuevoStatus = 'despacho_pendiente';
            }

            // Actualizar estado y memoria — operaciones BD, siempre deben ocurrir
            db.upsertClient(phoneClean, { status: nuevoStatus });
            const memoriaActual = db.getClientMemory(phoneClean) || '';
            const tagPago = tipo === 'club'
              ? '✅ YA AFILIADO AL CLUB ZT — comprobante confirmado. NO ofrecer más productos de club.'
              : tipo === 'bot_asesor'
                ? '✅ YA PAGÓ BOT ASESOR LEGAL — comprobante confirmado. NO ofrecer más suscripciones.'
                : '✅ YA COMPRÓ PRODUCTO — comprobante confirmado. NO ofrecer más ventas, está en proceso de envío.';
            const nuevaMemoria = memoriaActual ? memoriaActual + '\n' + tagPago : tagPago;
            db.updateClientMemory(phoneClean, nuevaMemoria);
            console.log(`[COMPROBANTE] ✅ BD actualizada ID #${id} para ${phone}`);

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

    } else {
      res.writeHead(404);
      res.end();
    }
  });

  botApiServer.listen(3001, () => {
    console.log('[BOT API] 🚀 API interna escuchando en puerto 3001');
  });
}

client.initialize();
