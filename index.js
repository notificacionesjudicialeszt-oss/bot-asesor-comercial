﻿// ============================================
// index.js - Bot Empresarial WhatsApp + CRM
// ============================================
// LÃ­nea principal de atenciÃ³n que:
// 1. Recibe mensajes de WhatsApp
// 2. Responde con Claude AI usando la base de conocimiento
// 3. Registra cada cliente en el CRM (SQLite)
// 4. Cuando el cliente quiere comprar/cotizar, lo asigna a un empleado (round-robin)
// 5. Notifica al empleado con el contexto de la conversaciÃ³n

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
// CONFIGURACIÃ“N
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

// Cargar catÃ¡logo para bÃºsqueda inteligente (RAG)
search.loadCatalog();

// ============================================
// ANTI-LOOP â€” detector de mensajes por minuto
// ============================================
// Mapa en memoria: phone -> array de timestamps de mensajes recientes
const messageTimestamps = new Map();
const RATE_LIMIT_MAX = 20;     // mÃ¡s de 20 mensajes...
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
    return true; // supera el lÃ­mite â€” posible bot
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
// GRACEFUL SHUTDOWN â€” prevenir corrupciÃ³n de sesiÃ³n
// ============================================
let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[BOT] âš ï¸ SeÃ±al ${signal} recibida. Cerrando limpiamente...`);
  try {
    await client.destroy();
    console.log('[BOT] âœ… SesiÃ³n guardada correctamente');
  } catch (e) {
    console.error('[BOT] Error cerrando:', e.message);
  }
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', async (err) => {
  console.error('[BOT] ðŸ’¥ Error no capturado:', err);

  const isSessionCorrupt = err.message && (
    err.message.includes('Execution context was destroyed') ||
    err.message.includes('Session closed') ||
    err.message.includes('Protocol error') ||
    err.message.includes('Target closed')
  );

  if (isSessionCorrupt) {
    console.log('[BOT] ðŸ§¹ Crash por sesiÃ³n corrupta detectado. Limpiando...');
    const sessionDir = path.join(__dirname, 'session', 'session-client-one');
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log('[BOT] âœ… SesiÃ³n corrupta eliminada. Reinicia el bot para escanear QR nuevo.');
    }
  }

  process.exit(1);
});
// Mostrar QR para escanear
client.on('qr', (qr) => {
  console.log('\n[BOT] Escanea este cÃ³digo QR con WhatsApp:');
  qrcode.generate(qr, { small: true });
});

// Bot conectado
client.on('ready', async () => {
  console.log('\n============================================');
  console.log(`[BOT] Â¡${CONFIG.businessName} estÃ¡ en lÃ­nea!`);
  console.log(`[BOT] Modo: ${CONFIG.mode}`);
  console.log(`[BOT] LÃ­nea principal: ${CONFIG.businessPhone}`);
  console.log(`[BOT] Empleados activos: ${employees.length}`);
  console.log(`[BOT] Auditores: ${CONFIG.auditors.length > 0 ? CONFIG.auditors.join(', ') : 'ninguno'}`);
  console.log('============================================\n');

  // Recovery COMPLETADO â€” bot en modo venta
  // setTimeout(() => recuperarChatsViejos(), 8000);

  // Iniciar broadcaster de imÃ¡genes a grupos (esperar 30s para que todo estÃ© listo)
  setTimeout(() => startGroupBroadcaster(), 30000);

  // Iniciar servidor interno para recibir comandos del panel
  startReactivacionServer();
});

// Error de autenticaciÃ³n â€” limpiar sesiÃ³n corrupta y reiniciar
client.on('auth_failure', async (msg) => {
  console.error('[BOT] âŒ Error de autenticaciÃ³n:', msg);
  console.log('[BOT] ðŸ§¹ Limpiando sesiÃ³n corrupta...');
  const sessionDir = path.join(__dirname, 'session', 'session-client-one');
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    console.log('[BOT] âœ… SesiÃ³n borrada. Reiniciando para QR nuevo...');
  }
  setTimeout(() => {
    console.log('[BOT] ðŸ”„ Reiniciando cliente...');
    client.initialize();
  }, 5000);
});

// DesconexiÃ³n â€” intentar reconectar
client.on('disconnected', async (reason) => {
  console.log('[BOT] âš ï¸ Desconectado:', reason);
  if (reason === 'NAVIGATION' || reason === 'LOGOUT') {
    console.log('[BOT] SesiÃ³n cerrada. Limpiando para QR nuevo...');
    const sessionDir = path.join(__dirname, 'session', 'session-client-one');
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  }
  console.log('[BOT] ðŸ”„ Intentando reconectar en 10 segundos...');
  setTimeout(() => client.initialize(), 10000);
});

// ============================================
// CONVIVENCIA HUMANO-BOT
// ============================================
const adminPauseMap = new Map(); // phone → timestamp hasta cuándo pausado
const panelSendingTo = new Set(); // phones que están siendo escritos DESDE EL PANEL
// Regla: Solo los mensajes enviados desde el panel cuentan como "Álvaro respondió".
// Todo otro mensaje fromMe (respuestas del bot, transiciones, broadcasts) se ignora en message_create.

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
      `${h.role === 'user' ? 'Cliente' : h.role === 'admin' ? 'Ãlvaro' : 'Bot'}: ${h.message}`
    ).join('\n');

    const transModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = `El director Ãlvaro acaba de escribirle directamente a un cliente de Zona TraumÃ¡tica.

MENSAJE DE ÃLVARO: "${alvaroMsg}"

CONTEXTO DEL CLIENTE:
${histText}

MEMORIA: ${memory}

Genera un mensaje MUY CORTO (mÃ¡ximo 2 lÃ­neas) que el bot enviarÃ¡ al mismo chat para:
1. Confirmar al cliente que ahora estÃ¡ siendo atendido directamente por el director
2. Tono cÃ¡lido y natural, como "Â¡EstÃ¡s en buenas manos! Ãlvaro te atiende personalmente"
3. NO repetir lo que Ãlvaro dijo
4. MÃ¡ximo 1 emoji

Solo escribe el mensaje, sin explicaciones.`;

    const result = await transModel.generateContent(prompt);
    const transMsg = result.response.text().trim();

    // Enviar directo al chatId original (evita problemas con LID)
    await client.sendMessage(chatId, transMsg);
    db.saveMessage(clientPhone, 'assistant', transMsg);
    console.log(`[ADMIN] âœ… TransiciÃ³n enviada a ${clientPhone}`);

    // Actualizar memoria con la interacciÃ³n de Ãlvaro
    updateClientMemory(clientPhone, `[ÃLVARO respondiÃ³]: ${alvaroMsg}`, transMsg,
      db.getConversationHistory(clientPhone, 10)
    ).catch(e => console.error('[ADMIN] Error actualizando memoria:', e.message));
  } catch (e) {
    console.error('[ADMIN] Error generando transiciÃ³n:', e.message);
  }
}

// ============================================
// DEBOUNCE â€” acumula mensajes del mismo cliente
// Timer corre desde el PRIMER mensaje, no se reinicia
// ============================================
const debounceTimers = new Map();   // phone â†’ timer activo
const mensajesAcumulados = new Map(); // phone â†’ [{ msg, body }]
const DEBOUNCE_MS = 10000; // 10 segundos

// ============================================
// MANEJO DE MENSAJES
// ============================================
client.on('message', async (msg) => {
  try {
    // Ignorar ANTES de getChat() para evitar crash con canales/newsletters
    // Ignorar mensajes propios del bot (los de Ãlvaro se capturan en message_create)
    if (msg.fromMe) return;
    if (msg.from === 'status@broadcast') return;
    if (msg.from.includes('@newsletter')) return;
    if (msg.from.includes('@broadcast')) return;
    if (msg.type === 'e2e_notification' || msg.type === 'notification_template') return;

    // Ignorar mensajes de grupos si estÃ¡ configurado
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
      'verificaciÃ³n', 'verificacion', 'verification', 'security', 'seguridad',
      'notificaciÃ³n', 'notificacion', 'notification', 'alerta', 'alert',
    ];

    // 2. NÃºmeros cortos = bots empresariales (menos de 7 dÃ­gitos)
    const isShortNumber = senderClean.length <= 6;

    // 3. Nombre coincide con empresa/bot conocido
    const isBlockedName = BLOCKED_NAMES.some(name => senderName.includes(name));

    // 4. Detectar mensajes automÃ¡ticos por contenido tÃ­pico de bots
    const BOT_PATTERNS = [
      /transacci[oÃ³]n.*aprobada/i,
      /transferencia.*exitosa/i,
      /c[oÃ³]digo de verificaci[oÃ³]n/i,
      /c[oÃ³]digo.*seguridad/i,
      /tu c[oÃ³]digo es/i,
      /your.*code.*is/i,
      /OTP.*\d{4,}/i,
      /saldo.*disponible/i,
      /pago.*recibido/i,
      /factura.*generada/i,
      /su pedido/i,
      /tracking.*number/i,
      /n[uÃº]mero de gu[iÃ­]a/i,
      /no responda.*este mensaje/i,
      /mensaje autom[aÃ¡]tico/i,
      /do not reply/i,
    ];
    const isBotMessage = BOT_PATTERNS.some(pattern => pattern.test(msg.body || ''));

    if (isShortNumber || isBlockedName || isBotMessage) {
      const razon = isShortNumber ? 'nÃºmero corto' : isBlockedName ? `nombre bloqueado (${senderName})` : 'msg automÃ¡tico';
      console.log(`[BOT] ðŸš« BLOQUEADO: ${senderRaw} (${chat.name || 'sin nombre'}) [${razon}]`);
      return;
    }

    // 5. ANTI-LOOP: Si un nÃºmero manda mÃ¡s de 50 msgs en 5 min, es bot
    if (!global._msgTracker) global._msgTracker = {};
    const now = Date.now();
    const tracker = global._msgTracker;
    if (!tracker[senderRaw]) tracker[senderRaw] = [];
    tracker[senderRaw].push(now);
    // Limpiar mensajes viejos (mÃ¡s de 5 min)
    tracker[senderRaw] = tracker[senderRaw].filter(t => now - t < 300000);
    if (tracker[senderRaw].length > 50) {
      console.log(`[BOT] ðŸš« ANTI-LOOP: ${senderRaw} (${chat.name || 'sin nombre'}) â€” ${tracker[senderRaw].length} msgs en 5 min. Ignorando.`);
      return;
    }

    const senderPhone = msg.from.replace(/@.*/g, ''); // quitar @c.us, @lid, @g.us, etc.
    const messageBody = msg.body ? msg.body.trim() : '';

    // â›” Chequeo TEMPRANO de ignorados â€” antes de cualquier procesamiento
    if (db.isIgnored(senderPhone)) {
      console.log(`[BOT] ðŸ”‡ Ignorado (panel): ${senderPhone} (${chat.name || 'sin nombre'})`);
      return;
    }

    // ðŸš¨ Anti-loop: si ya estÃ¡ flaggeado como posible spam, silenciar hasta revisiÃ³n
    if (db.isSpamFlagged(senderPhone)) {
      console.log(`[BOT] ðŸš¨ Pausado por spam_flag: ${senderPhone} â€” pendiente revisiÃ³n en panel`);
      return;
    }

    // ðŸš¨ Anti-loop: detectar rÃ¡faga de mensajes (posible bot)
    if (checkRateLimit(senderPhone)) {
      console.log(`[BOT] âš ï¸ Rate limit detectado para ${senderPhone} â€” marcando como posible bot`);
      db.upsertClient(senderPhone, {});
      db.setSpamFlag(senderPhone, true);
      console.log(`[BOT] ðŸš¨ ${senderPhone} marcado como posible spam en panel`);
      return;
    }

    // Log de todo mensaje entrante (para monitoreo)
    console.log(`[MSG] ðŸ“© ${chat.name || senderPhone}: "${messageBody.substring(0, 50)}${messageBody.length > 50 ? '...' : ''}"`);

    // ============================================
    // DEBOUNCE â€” acumular mensajes, procesar al vencer el timer
    // El timer se inicia con el PRIMER mensaje y NO se reinicia
    // ============================================

    // Acumular este mensaje
    if (!mensajesAcumulados.has(senderPhone)) {
      mensajesAcumulados.set(senderPhone, []);
    }
    mensajesAcumulados.get(senderPhone).push(msg);

    // Si ya hay un timer corriendo para este cliente, no hacer nada mÃ¡s â€” solo acumular
    if (debounceTimers.has(senderPhone)) {
      console.log(`[DEBOUNCE] â³ ${senderPhone} â€” mensaje acumulado (${mensajesAcumulados.get(senderPhone).length} total)`);
      return;
    }

    // Primer mensaje â€” iniciar timer de 10s
    console.log(`[DEBOUNCE] ðŸŸ¢ ${senderPhone} â€” timer iniciado (10s)`);
    const timer = setTimeout(async () => {
      debounceTimers.delete(senderPhone);
      const mensajes = mensajesAcumulados.get(senderPhone) || [];
      mensajesAcumulados.delete(senderPhone);

      if (mensajes.length === 0) return;

      // Usar el Ãºltimo msg como referencia (para reply, type, etc.)
      const msgRef = mensajes[mensajes.length - 1];

      // Si hay un solo mensaje de texto, procesarlo normal
      // Si hay varios, concatenar los textos en uno solo
      const soloTextos = mensajes.filter(m => !m.hasMedia && m.type === 'chat');
      const conMedia = mensajes.filter(m => m.hasMedia || m.type !== 'chat');

      if (mensajes.length > 1) {
        console.log(`[DEBOUNCE] ðŸ”€ ${senderPhone} â€” procesando ${mensajes.length} mensajes juntos`);
      }

      // Procesar media individualmente (imÃ¡genes, audios, PDFs)
      for (const mMedia of conMedia) {
        await procesarMensaje(mMedia, chat, senderPhone, mMedia);
      }

      // Procesar textos concatenados como un solo mensaje
      if (soloTextos.length > 0) {
        const textoConcatenado = soloTextos.map(m => m.body?.trim()).filter(Boolean).join('\n');
        if (textoConcatenado) {
          // Crear un msg "virtual" con el texto concatenado usando el Ãºltimo como base
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
  // msg puede ser un objeto virtual (texto concatenado sin esos mÃ©todos)
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

      // IMÃGENES: procesarlas con visiÃ³n de Claude (multimodal)
      if (msg.type === 'image' || msg.type === 'sticker') {
        if (msg.type === 'sticker') return; // ignorar stickers silenciosamente

        try {
          const media = await msg.downloadMedia();
          if (media && media.data) {
            const mediaType = media.mimetype || 'image/jpeg';
            // Solo pasar imÃ¡genes reales (no stickers animados WebP)
            const isValidImage = mediaType.startsWith('image/');
            if (!isValidImage) return;

            // Obtener historial y memoria del cliente (contexto completo)
            const history = db.getConversationHistory(senderPhone, 10);
            const clientMemory = db.getClientMemory(senderPhone);
            const systemPrompt = buildSystemPrompt('El cliente enviÃ³ una imagen. ContinÃºa la conversaciÃ³n con el contexto previo que ya tienes.', clientMemory);

            // Construir historial previo para que Gemini tenga contexto de la conversaciÃ³n
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
                console.log(`[QR] âœ… QR detectado: ${qrTexto.substring(0, 80)}`);
              }
            } catch (qrErr) {
              // Si falla el escaneo de QR no pasa nada â€” Gemini igual procesa la imagen
              console.log(`[QR] No se detectÃ³ QR en la imagen`);
            }

            // Detectar si la imagen es un comprobante de pago usando Gemini
            const imagePart = { inlineData: { data: media.data, mimeType: mediaType } };
            let esComprobante = false;
            let infoComprobante = '';
            try {
              const checkModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
              const checkResult = await checkModel.generateContent([
                imagePart,
                'Analiza esta imagen. Â¿Es un COMPROBANTE DE PAGO real (captura de transferencia bancaria, Nequi, Bancolombia, Daviplata, Bold, PSE, etc.)? \n\nIMPORTANTE: Fotos de PRODUCTOS (armas, ropa, accesorios), selfies, memes, catÃ¡logos, o cualquier imagen que NO sea una captura de pantalla de una transacciÃ³n financiera = esComprobante: false.\n\nResponde SOLO con JSON: {"esComprobante": true/false, "monto": "valor si lo ves o null", "entidad": "banco/app o null"}'
              ]);
              const checkText = checkResult.response.text().trim().replace(/```json|```/g, '').trim();
              const checkData = JSON.parse(checkText);
              esComprobante = checkData.esComprobante === true;
              if (esComprobante) {
                infoComprobante = `Monto: ${checkData.monto || 'no visible'} | Entidad: ${checkData.entidad || 'no visible'}`;
                console.log(`[COMPROBANTE] ðŸ’° Detectado de ${senderPhone}: ${infoComprobante}`);
              } else {
                console.log(`[COMPROBANTE] âŒ No es comprobante (${senderPhone}): imagen normal`);
              }
            } catch (e) {
              // Si falla la detecciÃ³n, tratar como imagen normal
              console.log(`[COMPROBANTE] No pudo detectar si es comprobante: ${e.message}`);
            }

            let reply;

            if (esComprobante) {
              // Es comprobante â€” responder con espera y notificar a Ãlvaro
              reply = 'Â¡Recibido! Ya le pasamos el comprobante a nuestro equipo para verificarlo. En cuanto lo confirmen te avisamos y arrancamos con el proceso ðŸ™';
              await msg.reply(reply);

              // Notificar a Ãlvaro con la imagen y el contexto del cliente
              const clientInfo = db.getClient(senderPhone);
              const clientName = clientInfo?.name || senderPhone;
              const memoriaLow = (clientInfo?.memory || '').toLowerCase();
              const mensajeLow = messageBody.toLowerCase();

              // Detectar tipo de comprobante:
              // 1. Bot asesor: cliente menciona "bot", "asesor legal", "ia", "inteligencia" o su status ya es afiliado
              // 2. Club ZT: primera afiliaciÃ³n al club
              // 3. Producto: dispositivo, municiÃ³n, etc.
              let tipoComprobante;
              if (
                mensajeLow.includes('bot') || mensajeLow.includes('asesor legal') ||
                mensajeLow.includes('inteligencia') || mensajeLow.includes(' ia ') ||
                memoriaLow.includes('bot asesor') || memoriaLow.includes('acceso bot') ||
                memoriaLow.includes('suscripcion bot') || memoriaLow.includes('suscripciÃ³n bot')
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

              // Notificar a Ãlvaro por WhatsApp
              const notifText = `ðŸ’° *COMPROBANTE DE PAGO RECIBIDO*\n` +
                `â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n` +
                `ðŸ‘¤ *Cliente:* ${clientName}\n` +
                `ðŸ“± *WhatsApp:* wa.me/${senderPhone}\n` +
                `ðŸ¦ *${infoComprobante}*\n` +
                `ðŸ“‹ *Tipo:* ${tipoComprobante === 'club' ? 'AfiliaciÃ³n Club ZT' : tipoComprobante === 'bot_asesor' ? 'ðŸ¤– Bot Asesor Legal' : 'Producto'}\n\n` +
                `âš ï¸ Verifica el monto en el panel antes de confirmar.\n` +
                `Panel â†’ pestaÃ±a ðŸ’° Por Verificar â†’ ID #${comprobanteId}`;

              const notifChatId = CONFIG.businessPhone + '@c.us';
              try {
                await client.sendMessage(notifChatId, notifText);
                await client.sendMessage(notifChatId, media, { caption: `Comprobante de ${clientName} (#${comprobanteId})` });
              } catch (notifErr) {
                console.error(`[COMPROBANTE] Error notificando:`, notifErr.message);
              }

              db.saveMessage(senderPhone, 'user', `[Comprobante de pago enviado â€” ${infoComprobante}]`);
              db.saveMessage(senderPhone, 'assistant', reply);
              db.upsertClient(senderPhone, { status: 'hot' });
              console.log(`[COMPROBANTE] âœ… Guardado ID #${comprobanteId} y notificado para ${senderPhone}`);

            } else if (qrTexto) {
              // QR detectado â€” responder SOLO sobre el contenido del QR
              const qrModel = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });
              const qrPrompt = `Eres un asesor de Zona TraumÃ¡tica (tienda de armas traumÃ¡ticas y Club ZT en Colombia).
Un cliente te enviÃ³ una imagen con un cÃ³digo QR. El contenido escaneado del QR es:

"${qrTexto}"

${msg.body ? `El cliente tambiÃ©n escribiÃ³: "${msg.body}"` : ''}

Analiza quÃ© tipo de QR es (carnet, link, documento, etc.) e informa al cliente de forma clara y Ãºtil quÃ© contiene. SÃ© breve y directo.`;
              const qrResult = await qrModel.generateContent(qrPrompt);
              reply = qrResult.response.text();
              await msg.reply(reply);
              db.saveMessage(senderPhone, 'user', `[QR escaneado: ${qrTexto.substring(0, 60)}]`);
              db.saveMessage(senderPhone, 'assistant', reply);
              db.upsertClient(senderPhone, {});

            } else {
              // Imagen normal â€” flujo con system prompt completo e historial
              const textPart = msg.body || 'El cliente enviÃ³ esta imagen.';
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

            console.log(`[IMG] ðŸ–¼ï¸ Imagen procesada para ${senderPhone}${esComprobante ? ' (COMPROBANTE)' : qrTexto ? ' (QR)' : ''}`);
          }
        } catch (imgErr) {
          console.error(`[IMG] âŒ Error procesando imagen: ${imgErr.message}`);
          await msg.reply('Vi tu imagen pero tuve un problema al procesarla. Â¿Me puedes contar quÃ© necesitas?');
        }
        return;
      }

      // AUDIOS (voz y audio): procesar con Gemini nativo
      if (msg.type === 'ptt' || msg.type === 'audio') {
        try {
          const media = await msg.downloadMedia();
          if (!media || !media.data) {
            await msg.reply('ðŸŽ™ï¸ No pude descargar el audio. Â¿Me puedes escribir tu consulta?');
            return;
          }

          // WhatsApp ptt = audio/ogg, audio = audio/mp4 u otros
          // Gemini soporta: audio/wav, audio/mp3, audio/aiff, audio/aac, audio/ogg, audio/flac
          let audioMime = media.mimetype || 'audio/ogg';
          // Limpiar mimetype (ej: "audio/ogg; codecs=opus" â†’ "audio/ogg")
          audioMime = audioMime.split(';')[0].trim();

          console.log(`[AUDIO] ðŸŽ™ï¸ Procesando audio de ${senderPhone}, mime: ${audioMime}`);

          const history = db.getConversationHistory(senderPhone, 10);
          const clientMemory = db.getClientMemory(senderPhone);
          const systemPrompt = buildSystemPrompt('El cliente enviÃ³ un mensaje de voz. ContinÃºa la conversaciÃ³n con el contexto previo.', clientMemory);

          // Historial previo para mantener contexto
          const geminiHistoryAudio = history
            .filter(h => h.role !== 'system' && h.content && h.content.trim().length > 0)
            .map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content.trim() }] }));
          while (geminiHistoryAudio.length > 0 && geminiHistoryAudio[0].role !== 'user') geminiHistoryAudio.shift();

          const audioPart = { inlineData: { data: media.data, mimeType: audioMime } };
          const textPart = 'El cliente enviÃ³ este mensaje de voz. TranscrÃ­belo, entiÃ©ndelo y responde como si fuera texto normal. No menciones que fue un audio.';

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
          console.log(`[AUDIO] âœ… Audio procesado para ${senderPhone}`);
        } catch (audioErr) {
          console.error(`[AUDIO] âŒ Error procesando audio: ${audioErr.message}`);
          await msg.reply('ðŸŽ™ï¸ EscuchÃ© tu nota de voz pero tuve un problema al procesarla. Â¿Me puedes escribir quÃ© necesitas?');
        }
        return;
      }

      // DOCUMENTOS: si es PDF, mandarlo directo a Gemini (soporta PDFs con texto e imÃ¡genes)
      if (msg.type === 'document') {
        try {
          const media = await msg.downloadMedia();
          if (!media || !media.data) {
            await msg.reply('ðŸ“„ No pude descargar el documento. Â¿Me puedes escribir quÃ© necesitas?');
            return;
          }

          const mime = (media.mimetype || '').toLowerCase();
          const filename = (media.filename || '').toLowerCase();
          const esPDF = mime.includes('pdf') || filename.endsWith('.pdf');

          if (!esPDF) {
            await msg.reply('ðŸ“„ RecibÃ­ tu documento. Solo proceso PDFs por ahora. Â¿Me escribes quÃ© necesitas?');
            return;
          }

          console.log(`[PDF] ðŸ“„ Procesando PDF de ${senderPhone}: ${media.filename || 'sin nombre'}`);

          const history = db.getConversationHistory(senderPhone, 10);
          const clientMemory = db.getClientMemory(senderPhone);
          const systemPrompt = buildSystemPrompt('El cliente enviÃ³ un PDF. ContinÃºa la conversaciÃ³n con el contexto previo.', clientMemory);

          // Historial previo para mantener contexto
          const geminiHistoryPdf = history
            .filter(h => h.role !== 'system' && h.content && h.content.trim().length > 0)
            .map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content.trim() }] }));
          while (geminiHistoryPdf.length > 0 && geminiHistoryPdf[0].role !== 'user') geminiHistoryPdf.shift();

          // Gemini recibe el PDF como inlineData (igual que imÃ¡genes) â€” lee texto e imÃ¡genes del PDF
          const pdfPart = { inlineData: { data: media.data, mimeType: 'application/pdf' } };
          const textPart = msg.body
            ? `El cliente enviÃ³ este PDF llamado "${media.filename || 'documento.pdf'}" y escribiÃ³: "${msg.body}". AnalÃ­zalo y responde.`
            : `El cliente enviÃ³ este PDF llamado "${media.filename || 'documento.pdf'}". AnalÃ­zalo y responde de forma Ãºtil segÃºn el contexto de la conversaciÃ³n.`;

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
          console.log(`[PDF] âœ… PDF procesado para ${senderPhone}`);
        } catch (pdfErr) {
          console.error(`[PDF] âŒ Error procesando PDF: ${pdfErr.message}`);
          await msg.reply('ðŸ“„ RecibÃ­ tu PDF pero tuve un problema al leerlo. Â¿Me puedes escribir quÃ© necesitas?');
        }
        return;
      }

      // Videos: pedir que escriban
      if (msg.type === 'video') {
        await msg.reply('ðŸŽ¥ No proceso videos. Â¿En quÃ© te puedo ayudar?');
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

    // --- VERIFICAR SI ES AUDITOR (no recibe respuestas automÃ¡ticas) ---
    if (isAuditor(senderPhone)) {
      if (CONFIG.debug) {
        console.log(`[DEBUG] Mensaje de auditor ${senderPhone}, ignorando (sin comando !)`);
      }
      return;
    }

    // --- VERIFICAR SI ES EMPLEADO ---
    const employeeMatch = db.getEmployeeByPhone(senderPhone);
    if (employeeMatch) {
      // Los empleados no reciben respuestas automÃ¡ticas del bot
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
// CAPTURA DE MENSAJES DE ÁLVARO (message_create)
// Solo reacciona a mensajes enviados desde el PANEL (marcados en panelSendingTo).
// Todos los demás fromMe (bot, transiciones, broadcasts) se ignoran.
// ============================================
client.on('message_create', async (msg) => {
  try {
    if (!msg.fromMe) return;
    if (msg.to === 'status@broadcast') return;
    if (msg.to.includes('@g.us')) return;
    if (msg.to.includes('@newsletter')) return;
    if (msg.to.includes('@broadcast')) return;

    const clientPhone = msg.to.replace('@c.us', '').replace('@lid', '');

    // ¿Este mensaje fue enviado desde el panel?
    if (!panelSendingTo.has(clientPhone)) {
      return; // NO es del panel → es del bot → ignorar
    }

    // Limpiar la marca del panel
    panelSendingTo.delete(clientPhone);

    const body = msg.body || '';
    if (!body.trim()) return;

    // Guardar mensaje de Álvaro en historial
    db.saveMessage(clientPhone, 'admin', body);
    console.log(`[ADMIN] 📝 Álvaro respondió a ${clientPhone}: "${body.substring(0, 60)}"`);

    // Pausar el bot para este cliente (30 minutos)
    adminPauseMap.set(clientPhone, Date.now() + 30 * 60 * 1000);

    // Enviar mensaje de transición
    enviarTransicionAdmin(clientPhone, msg.to, body).catch(e =>
      console.error('[ADMIN] Error en transición:', e.message)
    );
  } catch (err) {
    console.error('[ADMIN] Error en message_create:', err.message);
  }
});

// ============================================
// SAFE SEND â€” envÃ­a por WhatsApp con auto-sanaciÃ³n de chat_id
// El phone es el identificador universal. El chat_id (@c.us o @lid) es solo
// un cachÃ© de transporte. Si falla por "No LID", resuelve el ID canÃ³nico,
// lo guarda en BD y reintenta una vez.
// ============================================
async function safeSend(phone, message) {
  const chatId = db.getClientChatId(phone);
  try {
    await client.sendMessage(chatId, message);
  } catch (err) {
    if (!err.message || !err.message.includes('LID')) throw err; // otro error, relanzar
    console.warn(`[SEND] âš ï¸ "No LID" para ${phone} con ${chatId} â€” resolviendo ID canÃ³nico...`);
    try {
      const waId = await client.getNumberId(phone);
      if (!waId) throw new Error('getNumberId no devolviÃ³ resultado');
      const canonicalId = waId._serialized;
      // Actualizar chat_id en BD para la prÃ³xima vez
      db.db.prepare('UPDATE clients SET chat_id = ? WHERE phone = ?').run(canonicalId, phone);
      console.log(`[SEND] ðŸ”„ chat_id actualizado: ${phone} â†’ ${canonicalId} â€” reintentando...`);
      await client.sendMessage(canonicalId, message);
    } catch (retryErr) {
      console.error(`[SEND] âŒ Reintento fallido para ${phone}: ${retryErr.message}`);
      throw retryErr;
    }
  }
}

// ============================================
// FLUJO DE CLIENTE
// ============================================
async function handleClientMessage(msg, senderPhone, messageBody, chat, rawMsg) {
  // Si Ãlvaro estÃ¡ atendiendo a este cliente â†’ no responder
  if (isBotPaused(senderPhone)) {
    console.log(`[BOT] â¸ï¸ Bot pausado para ${senderPhone} (Ãlvaro atendiendo)`);
    db.saveMessage(senderPhone, 'user', messageBody);
    return;
  }

  // 1. Obtener nombre del perfil y telÃ©fono real de WhatsApp
  let profileName = '';
  try {
    const contact = await rawMsg.getContact();
    // Prioridad: pushname → contact.name → shortName → chat.name (nombre guardado en celular)
    profileName = contact.pushname || contact.name || contact.shortName || chat.name || '';

    // contact.number resuelve el telÃ©fono real incluso cuando el mensaje llegÃ³ con LID
    const realNumber = (contact.number || '').replace(/\D/g, '');
    if (realNumber && realNumber !== senderPhone) {
      console.log(`[BOT] ðŸ“± LID resuelto: ${senderPhone} â†’ ${realNumber}`);
      // Si existe registro viejo bajo el LID, migrarlo al nÃºmero real
      if (db.getClient(senderPhone) && !db.getClient(realNumber)) {
        db.migrateClientPhone(senderPhone, realNumber);
      }
      senderPhone = realNumber;
    }

    if (CONFIG.debug) {
      console.log(`[DEBUG] Perfil WhatsApp: "${profileName}" (${senderPhone})`);
    }
  } catch (err) {
    // Si getContact() falla, usar chat.name como respaldo
    profileName = chat.name || '';
    console.error('[BOT] Error obteniendo contacto:', err.message);
  }

  // 2. Registrar/actualizar cliente en CRM (con nombre de perfil)
  const existingClient = db.getClient(senderPhone);
  const isNewClient = !existingClient;

  // chat_id = msg.from completo (puede ser @c.us o @lid) â€” guardarlo siempre
  const chatIdFromMsg = rawMsg.from || (senderPhone + '@c.us');

  if (isNewClient) {
    // Cliente nuevo â†’ crear con nombre de perfil y chat_id real
    db.upsertClient(senderPhone, { name: profileName, chat_id: chatIdFromMsg });
    console.log(`[BOT] ðŸ†• Nuevo cliente: "${profileName}" (${senderPhone}) [${chatIdFromMsg}]`);
    saveContactToVCF(senderPhone, profileName);

  } else {
    // Cliente existente â†’ actualizar chat_id siempre (puede cambiar de @c.us a @lid)
    const updateData = { chat_id: chatIdFromMsg };
    // Actualizar nombre si no tiene — prioridad: profileName, luego chat.name
    const bestName = profileName || chat.name || '';
    if (bestName && !existingClient.name) {
      updateData.name = bestName;
      saveContactToVCF(senderPhone, bestName);
    }
    db.upsertClient(senderPhone, updateData);
  }

  // â›” Contacto ignorado desde el panel â€” silencio total
  if (db.isIgnored(senderPhone)) {
    console.log(`[BOT] ðŸ”‡ Ignorado (panel): ${senderPhone} (${profileName})`);
    return;
  }

  // 3. Guardar mensaje del cliente
  db.saveMessage(senderPhone, 'user', messageBody);

  // 4. Obtener historial para contexto
  const history = db.getConversationHistory(senderPhone, 10);

  // 5. Simular escritura
  await chat.sendStateTyping();

  // 6. Detectar intenciÃ³n â€” post-venta primero, luego venta/compra
  const isPostventa = detectPostventaIntent(messageBody);
  const wantsHuman = detectHandoffIntent(messageBody);
  const hasEnoughHistory = history.length >= 6;
  const wantsHumanExplicit = detectHandoffIntent(messageBody, true);

  // Detectar si el cliente estÃ¡ confirmando que tiene algo pendiente ya pagado
  // (respuesta a la pregunta previa de confirmaciÃ³n de post-venta)
  const clienteActualCheck = db.getClient(senderPhone);
  const memoriaActual = (clienteActualCheck?.memory || '').toLowerCase();
  const esperandoConfirmPostventa = memoriaActual.includes('[pregunta postventa enviada]') && !memoriaActual.includes('[postventa-confirmado]');
  const msgLower2 = messageBody.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[Â¿?Â¡!.,;:()]/g, '');
  const confirmaPostventa = esperandoConfirmPostventa && (
    msgLower2.includes('si') || msgLower2.includes('sÃ­') || msgLower2.includes('tengo') ||
    msgLower2.includes('ya pague') || msgLower2.includes('ya pague') || msgLower2.includes('pendiente') ||
    msgLower2.includes('ya soy') || msgLower2.includes('ya me afiliÃ©') || msgLower2.includes('ya me afilie') ||
    msgLower2.includes('correcto') || msgLower2.includes('exacto') || msgLower2.includes('eso es')
  );

  // Cliente confirma que sÃ­ tiene algo pendiente ya pagado â†’ escalar a post-venta
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
        `Claro, con gusto te ayudo. Para dirigirte con la persona correcta, Â¿me confirmas una cosa?\n\n` +
        `Â¿Tienes algÃºn proceso *ya pagado* que estÃ© pendiente (carnet, envÃ­o, renovaciÃ³n, cambio de arma)? ` +
        `O Â¿estÃ¡s preguntando por informaciÃ³n general del producto o servicio? ðŸ™`
      );
      // Marcar en memoria que se hizo la pregunta para no volver a preguntar
      await updateClientMemory(senderPhone, messageBody, '[pregunta postventa enviada]', history);
      return;
    }

    // Ya confirmÃ³ â€” escalar a post-venta
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

      // Enviar imagen promo del Club ZT SOLO cuando el bot estÃ¡ ofreciendo la afiliaciÃ³n
      // (no en cada menciÃ³n â€” solo cuando presenta los planes activamente)
      const responseLower = response.toLowerCase();
      const estaOfreciendoClub = (
        responseLower.includes('plan plus') && responseLower.includes('plan pro')
      ) || (
          responseLower.includes('100.000') && responseLower.includes('afiliaci')
        ) || (
          responseLower.includes('inscripciÃ³n') && responseLower.includes('club')
        ) || (
          responseLower.includes('promociÃ³n') && (responseLower.includes('club') || responseLower.includes('plan'))
        );
      if (estaOfreciendoClub) {
        try {
          const promoImgPath = path.join(__dirname, 'imagenes', 'club-promo.png');
          if (fs.existsSync(promoImgPath)) {
            const media = MessageMedia.fromFilePath(promoImgPath);
            await rawMsg.reply(media);
            console.log(`[BOT] ðŸ–¼ï¸ Imagen Club ZT enviada a ${senderPhone}`);
          }
        } catch (imgErr) {
          console.error('[BOT] Error enviando imagen Club ZT:', imgErr.message);
        }
      }

      // Detectar confirmaciÃ³n de pago â€” SOLO basado en lo que el CLIENTE escribe
      // Nunca usar responseLower para esto (el bot menciona "comprobante" al explicar pasos y dispara falsos positivos)
      const mensajeBajo = messageBody.toLowerCase();
      const pagoConfirmado = (
        mensajeBajo.includes('ya pagu') ||
        mensajeBajo.includes('hice el pago') ||
        mensajeBajo.includes('realicÃ© el pago') ||
        mensajeBajo.includes('realice el pago') ||
        mensajeBajo.includes('acabo de pagar') ||
        mensajeBajo.includes('les acabo de transferir') ||
        mensajeBajo.includes('ya transferÃ­') ||
        mensajeBajo.includes('ya transferi') ||
        mensajeBajo.includes('te enviÃ© el comprobante') ||
        mensajeBajo.includes('te envie el comprobante') ||
        mensajeBajo.includes('ahÃ­ va el comprobante') ||
        mensajeBajo.includes('ahi va el comprobante') ||
        (mensajeBajo.includes('comprobante') && (mensajeBajo.includes('envi') || mensajeBajo.includes('adjunt') || mensajeBajo.includes('aquÃ­') || mensajeBajo.includes('aqui')))
      );
      if (pagoConfirmado) {
        const clienteActual = db.getClient(senderPhone);
        const memoriaBaja = (clienteActual?.memory || '').toLowerCase();
        // Detectar si es pago de club o de producto â€” solo mirar mensaje del cliente y memoria
        const esClub = mensajeBajo.includes('club') ||
          mensajeBajo.includes('afiliaci') ||
          mensajeBajo.includes('carnet') ||
          memoriaBaja.includes('club') ||
          memoriaBaja.includes('afiliaci') ||
          memoriaBaja.includes('carnet');
        const nuevoStatus = esClub ? 'carnet_pendiente' : 'despacho_pendiente';
        db.upsertClient(senderPhone, { status: nuevoStatus });
        console.log(`[BOT] ðŸ’° Pago detectado en mensaje del cliente â†’ estado: ${nuevoStatus} para ${senderPhone}`);
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
    const memoryPrompt = `Eres un sistema de CRM para Zona TraumÃ¡tica, tienda de armas traumÃ¡ticas legales en Colombia. Tu tarea es mantener una ficha breve del cliente.

âš ï¸ REGLA CRÃTICA â€” NOMBRES:
- "Ãlvaro" es el director de Zona TraumÃ¡tica, NO el nombre del cliente.
- NUNCA registres "Ãlvaro" como nombre del cliente aunque aparezca en el mensaje.
- Solo registra el nombre del cliente si Ã©l mismo lo dijo explÃ­citamente ("me llamo X", "soy X", "mi nombre es X").
- Si el cliente saluda a alguien llamado "Ãlvaro" o menciona ese nombre en otro contexto, ignÃ³ralo para el campo nombre.

MEMORIA ACTUAL DEL CLIENTE:
${currentMemory || '(Cliente nuevo, sin memoria previa)'}

ÃšLTIMA INTERACCIÃ“N:
- Cliente dijo: "${userMessage}"
- Bot respondiÃ³: "${botResponse.substring(0, 300)}"

INSTRUCCIONES:
Genera una ficha actualizada del cliente en mÃ¡ximo 6 lÃ­neas. Incluye SOLO datos Ãºtiles para ventas:
- Nombre del cliente (SOLO si Ã©l mismo lo dijo explÃ­citamente: "me llamo X", "soy X". NUNCA si solo saludÃ³ a alguien)
- Ciudad o departamento (si lo mencionÃ³)
- Referencia o modelo de interÃ©s (si mencionÃ³ alguno)
- Plan preferido (Plus o Pro, si lo indicÃ³)
- Motivo de compra (defensa personal, colecciÃ³n, regalo, etc.)
- IntenciÃ³n (solo consultando, interesado, listo para comprar)
- Objeciones detectadas (duda del pago virtual, no tiene presupuesto, etc.)
- Si ya comprÃ³: quÃ© comprÃ³ y si tiene carnet pendiente o dispositivo pendiente

Si la conversaciÃ³n fue solo un saludo sin info Ãºtil, devuelve la memoria actual sin cambios.
NO inventes datos. Solo registra lo que el cliente DIJO explÃ­citamente.
Responde SOLO con la ficha, sin explicaciones.`;

    // Usar Gemini Flash para memoria (barato y rÃ¡pido)
    const memoryModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const memoryResult = await memoryModel.generateContent(memoryPrompt);
    const newMemory = memoryResult.response.text().trim();

    // Solo actualizar si cambiÃ³ y no estÃ¡ vacÃ­o
    if (newMemory && newMemory !== currentMemory) {
      db.updateClientMemory(clientPhone, newMemory);
      if (CONFIG.debug) console.log(`[MEMORY] âœ… Memoria actualizada para ${clientPhone}`);
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

// Fallback: generar memoria sin API (extracciÃ³n por keywords)
function generateSimpleMemory(currentMemory, message) {
  const lower = message.toLowerCase();
  const notes = currentMemory ? currentMemory.split('\n') : [];

  // Detectar referencias de interÃ©s
  if (/ekol/.test(lower)) {
    const note = `- Marca de interÃ©s: EKOL`;
    if (!notes.some(n => n.includes('EKOL'))) notes.push(note);
  }
  if (/retay/.test(lower)) {
    const note = `- Marca de interÃ©s: RETAY`;
    if (!notes.some(n => n.includes('RETAY'))) notes.push(note);
  }
  if (/blow/.test(lower)) {
    const note = `- Marca de interÃ©s: BLOW`;
    if (!notes.some(n => n.includes('BLOW'))) notes.push(note);
  }
  if (/revolver|revÃ³lver/.test(lower)) {
    const note = `- Interesado en: revÃ³lver`;
    if (!notes.some(n => n.includes('revÃ³lver'))) notes.push(note);
  }
  if (/plan pro/.test(lower)) {
    const note = `- Plan preferido: Pro`;
    if (!notes.some(n => n.includes('Plan Pro'))) notes.push(note);
  }
  if (/plan plus/.test(lower)) {
    const note = `- Plan preferido: Plus`;
    if (!notes.some(n => n.includes('Plan Plus'))) notes.push(note);
  }
  if (/club|membresia|membresÃ­a/.test(lower)) {
    const note = `- Interesado en: Club / MembresÃ­a`;
    if (!notes.some(n => n.includes('Club'))) notes.push(note);
  }
  if (/defensa|seguridad/.test(lower)) {
    const note = `- Motivo: defensa personal`;
    if (!notes.some(n => n.includes('defensa'))) notes.push(note);
  }
  if (/carnet|carnÃ©t/.test(lower)) {
    const note = `- Solicita: carnet pendiente`;
    if (!notes.some(n => n.includes('carnet'))) notes.push(note);
  }

  return notes.join('\n');
}

// ============================================
// DETECCIÃ“N DE POST-VENTA
// ============================================
function detectPostventaIntent(message) {
  const lower = message.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[Â¿?Â¡!.,;:()]/g, '');

  // SOLO frases que indican claramente que YA es cliente con algo pendiente
  // NO incluir palabras sueltas como "carnet", "certificado", "qr" â€” esas son preguntas normales
  const postventaKeywords = [
    // Carnet â€” solo cuando claramente ya pagÃ³ y espera algo
    'mi carnet no llego', 'mi carnet no llegÃ³', 'cuando me mandan el carnet',
    'cuando llega mi carnet', 'estado de mi carnet', 'actualizar mi carnet',
    'actualizar carnet', 'estado del carnet',
    // Despacho / envÃ­o â€” solo cuando ya pagÃ³
    'cuando me despachan', 'cuando me mandan mi pedido',
    'cuando llega mi pedido', 'numero de guia', 'numero de guÃ­a', 'mi guia de envio',
    'ya pague y no', 'pague y no me han',
    // Cambio de arma â€” siempre es post-venta
    'cambio de arma', 'cambiar arma en el carnet', 'actualizar arma',
    'cambiar el serial', 'nuevo serial', 'cambiar modelo del arma',
    // RenovaciÃ³n â€” siempre es post-venta
    'renovar mi carnet', 'renovar mi afiliacion', 'renovacion del carnet',
    'se me vencio el carnet', 'se vencio mi carnet', 'vencio mi carnet',
    'ya se vencio', 'se me vencio',
    // Soporte post-pago explÃ­cito
    'ya soy afiliado', 'ya me afilie', 'ya me afiliÃ©', 'soy miembro',
    'no me han agregado al grupo', 'no me llegÃ³ el carnet', 'no me llego el carnet',
    'no he recibido el carnet', 'no recibi el carnet', 'no recibi nada',
    'ya envie el comprobante', 'ya enviÃ© el comprobante',
  ];

  const detected = postventaKeywords.some(kw => lower.includes(kw));
  if (detected) console.log(`[BOT] ðŸ› ï¸ Post-venta detectado: "${message.substring(0, 60)}"`);
  return detected;
}

// ============================================
// DETECCIÃ“N DE INTENCIÃ“N DE DERIVACIÃ“N
// ============================================
function detectHandoffIntent(message, humanOnly = false) {
  const lowerMessage = message.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar acentos para comparar
    .replace(/[Â¿?Â¡!.,;:()]/g, '');

  // Frases de COMPRA CONFIRMADA (el cliente YA decidiÃ³, quiere cerrar)
  // OJO: NO incluir preguntas de precio/info â€” esas las responde el bot
  const buyKeywords = [
    'quiero comprar', 'quiero comprarlo', 'quiero comprarla',
    'lo quiero', 'la quiero', 'me lo llevo', 'me la llevo', 'lo llevo',
    'quiero hacer un pedido', 'hacer pedido', 'quiero ordenar',
    'me interesa comprar', 'listo para comprar', 'listo para pagar',
    'quiero pagar', 'ya quiero pagar', 'como pago', 'donde pago',
    'quiero el plan', 'quiero afiliarme', 'quiero inscribirme',
    'tomenme los datos', 'tomen mis datos', 'tome mis datos',
    'ya me decidi', 'ya me decidÃ­', 'va listo', 'dale listo',
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
    console.log(`[BOT] ðŸš¨ IntenciÃ³n de compra/derivaciÃ³n: "${message.substring(0, 60)}"`);
  }

  return detected;
}

// ============================================
// DERIVACIÃ“N A EMPLEADO (HANDOFF)
// ============================================
async function handleHandoff(msg, clientPhone, triggerMessage, history, tipo = 'venta') {
  console.log(`[HANDOFF] Iniciando derivaciÃ³n (${tipo}) para ${clientPhone}...`);

  // Asignar empleado (round-robin)
  const assignment = router.assignClient(clientPhone);

  if (!assignment) {
    console.log(`[HANDOFF] âŒ No hay empleados disponibles â€” el bot sigue atendiendo`);
    return;
  }

  console.log(`[HANDOFF] âœ… Cliente marcado en panel como ${tipo}: ${assignment.employee_name} notificado`);

  // Obtener datos del cliente
  const clientInfo = db.getClient(clientPhone);
  const clientName = clientInfo?.name || 'Cliente';
  const clientLink = `https://wa.me/${clientPhone}`;

  // --- MENSAJE AL CLIENTE informando que fue escalado ---
  const msgCliente = tipo === 'postventa'
    ? `âœ… Tu solicitud fue registrada y ya la estamos gestionando. En breve un asesor te contacta. ðŸ™`
    : `âœ… Â¡Perfecto! Ya te conectÃ© con un asesor que te va a acompaÃ±ar en el proceso. En breve te contacta. ðŸ’ª`;
  try {
    await msg.reply(msgCliente);
  } catch (e) {
    console.error(`[HANDOFF] âŒ Error enviando mensaje al cliente:`, e.message);
  }

  // Estado segÃºn tipo
  const nuevoStatus = tipo === 'postventa' ? 'postventa' : 'assigned';
  const logLabel = tipo === 'postventa' ? 'POST-VENTA' : 'LEAD CALIENTE';

  // Guardar en historial (solo interno)
  db.saveMessage(clientPhone, 'system', `[${logLabel} â€” asignado a ${assignment.employee_name} en panel]`);

  // Actualizar estado del cliente
  db.upsertClient(clientPhone, { status: nuevoStatus });

  // --- MENSAJE PARA ÃLVARO (asesor) ---
  const context = summarizeConversation(history);
  const clientMemory = db.getClientMemory(clientPhone) || 'Sin perfil previo';

  const notification = tipo === 'postventa'
    ? `ðŸ› ï¸ *POST-VENTA â€” REQUIERE GESTIÃ“N*\n` +
    `â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\n` +
    `ðŸ‘¤ *Nombre:* ${clientName}\n` +
    `ðŸ“± *WhatsApp:* ${clientLink}\n\n` +
    `ðŸ’¬ *Lo que necesita:*\n` +
    `"${triggerMessage}"\n\n` +
    `ðŸ§  *Perfil del cliente (CRM):*\n${clientMemory}\n\n` +
    `ðŸ“‹ *Ãšltimos mensajes:*\n${context}\n\n` +
    `â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n` +
    `ðŸ‘† Toca el link para abrir el chat.\n` +
    `_El bot sigue respondiendo â€” tÃº decides cuÃ¡ndo entrar._`
    : `ðŸ”¥ *LEAD CALIENTE â€” LISTO PARA CERRAR*\n` +
    `â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\n` +
    `ðŸ‘¤ *Nombre:* ${clientName}\n` +
    `ðŸ“± *WhatsApp:* ${clientLink}\n\n` +
    `ðŸ’¬ *Lo que disparÃ³ la alerta:*\n` +
    `"${triggerMessage}"\n\n` +
    `ðŸ§  *Perfil del cliente (CRM):*\n${clientMemory}\n\n` +
    `ðŸ“‹ *Ãšltimos mensajes:*\n${context}\n\n` +
    `â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n` +
    `ðŸ‘† Toca el link para abrir el chat.\n` +
    `_El bot sigue respondiendo â€” tÃº decides cuÃ¡ndo entrar._`;

  // Enviar notificaciÃ³n siempre al nÃºmero principal de Ãlvaro
  const notifPhone = CONFIG.businessPhone; // 573013981979
  const notifChatId = notifPhone + '@c.us';

  try {
    await client.sendMessage(notifChatId, notification);
    console.log(`[HANDOFF] âœ… NotificaciÃ³n enviada a ${notifPhone}`);
  } catch (error) {
    console.error(`[HANDOFF] âŒ Error enviando notificaciÃ³n:`, error.message);
  }
}

// Resumir conversaciÃ³n para dar contexto al empleado
function summarizeConversation(history) {
  if (history.length === 0) return 'Sin conversaciÃ³n previa.';

  const lastMessages = history.slice(-5);
  return lastMessages
    .map(h => `${h.role === 'user' ? 'ðŸ‘¤ Cliente' : 'ðŸ¤– Bot'}: ${h.message.substring(0, 200)}`)
    .join('\n');
}

// ============================================
// DETECCIÃ“N DE INTENCIÃ“N DE PRODUCTO
// ============================================
// Solo buscar en el catÃ¡logo cuando el mensaje realmente
// tenga que ver con productos. Saludos, risas, conversaciÃ³n
// general NO necesitan bÃºsqueda.
function needsProductSearch(message) {
  const lower = message.toLowerCase().replace(/[Â¿?Â¡!.,;:()]/g, '');

  const productKeywords = [
    // Armas traumÃ¡ticas
    'traumatica', 'traumÃ¡tica', 'pistola', 'pistolas', 'arma', 'armas',
    'revolver', 'revÃ³lver', 'dispositivo',
    // Marcas
    'retay', 'ekol', 'blow',
    // Modelos
    's2022', 'g17', 'volga', 'botan', 'mini 9', 'f92', 'tr92', 'tr 92',
    'dicle', 'firat', 'nig', 'jackal', 'p92', 'magnum', 'compact',
    // CaracterÃ­sticas
    'negro', 'negra', 'fume', 'cromado', 'color',
    // MuniciÃ³n
    'municion', 'municiÃ³n', 'cartuchos', 'balas', 'oskurzan', 'rubber ball',
    // Club / membresÃ­a
    'club', 'membresia', 'membresÃ­a', 'plan plus', 'plan pro', 'juridico', 'jurÃ­dico',
    // CatÃ¡logo general
    'catalogo', 'catÃ¡logo', 'referencias', 'disponible', 'disponibles',
    'precio', 'precios', 'cuanto', 'cuÃ¡nto', 'vale', 'cuesta',
    'que tienen', 'quÃ© tienen', 'que manejan', 'quÃ© manejan',
    'que venden', 'quÃ© venden', 'opciones', 'modelos',
    // Carnet
    'carnet', 'carnÃ©t', 'certificado', 'documento',
    // Manifiesto de aduana
    'manifiesto', 'aduana', 'importacion', 'importaciÃ³n', 'dian', 'polfa',
  ];

  return productKeywords.some(kw => lower.includes(kw));
}

// ============================================
// GEMINI API (Modo Directo) + BÃºsqueda Inteligente
// ============================================
async function getClaudeResponse(clientPhone, message, history) {
  try {
    // 1. Detectar si el mensaje necesita bÃºsqueda de productos
    let productContext = '';

    if (needsProductSearch(message)) {
      const searchResult = search.searchProducts(message);
      productContext = search.formatForPrompt(searchResult);
      if (CONFIG.debug) console.log(`[DEBUG] ðŸ” BÃºsqueda activada: ${searchResult.keywords.join(', ')} â†’ ${searchResult.products.length} productos`);
    } else {
      productContext = 'El cliente no estÃ¡ preguntando por un producto especÃ­fico. Responde de forma conversacional.';
      if (CONFIG.debug) console.log(`[DEBUG] ðŸ’¬ ConversaciÃ³n general, sin bÃºsqueda de productos`);
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
      // Saltar mensajes de sistema
      if (m.role === 'system') continue;
      if (m.role === 'admin') {
        geminiHistory.push({
          role: 'model',
          parts: [{ text: `[ÃLVARO respondiÃ³ directamente]: ${m.message}` }]
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
        console.log(`[GEMINI] âœ… Respuesta OK para ${clientPhone}`);
        return result.response.text();
      } catch (retryError) {
        lastError = retryError;
        const errorMsg = retryError.message || 'Error desconocido';
        console.error(`[GEMINI] âš ï¸ Intento ${attempt}/${MAX_RETRIES} fallÃ³: ${errorMsg}`);

        if (attempt < MAX_RETRIES) {
          const wait = attempt * 2000;
          console.log(`[GEMINI] â³ Reintentando en ${wait / 1000}s...`);
          await new Promise(r => setTimeout(r, wait));
        }
      }
    }

    console.error(`[GEMINI] âŒ FallÃ³ despuÃ©s de ${MAX_RETRIES} intentos: ${lastError?.message}`);
    return 'Disculpa, estoy teniendo un problema momentÃ¡neo. Dame unos segundos e intÃ©ntalo de nuevo. ðŸ™';
  } catch (error) {
    console.error('[GEMINI] Error general:', error.message);
    return 'Disculpa, tuve un inconveniente. Â¿PodrÃ­as repetir tu consulta?';
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
    return 'Disculpa, tuve un problema tÃ©cnico. Â¿PodrÃ­as repetir tu consulta?';
  }
}

// ============================================
// CONSTRUCCIÃ“N DE PROMPTS (extraÃ­do a prompts.js)
// ============================================
const { buildSystemPrompt } = require('./prompts');



// ============================================
// COMANDOS DE ADMIN / AUDITOR
// ============================================
function isAdmin(phone) {
  // Admin = nÃºmero del negocio O auditor
  return phone === CONFIG.businessPhone || CONFIG.auditors.includes(phone);
}

function isAuditor(phone) {
  return CONFIG.auditors.includes(phone);
}

async function handleAdminCommand(msg, senderPhone, command) {
  const cmd = command.toLowerCase().trim();
  const parts = command.trim().split(/\s+/);

  // â”€â”€ ESTADÃSTICAS RÃPIDAS â”€â”€
  if (cmd === '!stats' || cmd === '!status') {
    const stats = db.getStats();
    let report = `ðŸ“Š * EstadÃ­sticas del Bot *\n\n`;
    report += `ðŸ‘¥ Total clientes: ${stats.totalClients} \n`;
    report += `ðŸ†• Clientes nuevos: ${stats.newClients} \n`;
    report += `ðŸ”— Asignaciones activas: ${stats.activeAssignments} \n`;
    report += `ðŸ’¬ Total mensajes: ${stats.totalMessages} \n\n`;
    report += `ðŸ‘” * Empleados:*\n`;
    stats.employees.forEach(emp => {
      report += `  â€¢ ${emp.name}: ${emp.assignments_count} asignados(${emp.active_now} activos) \n`;
    });
    await msg.reply(report);

    // â”€â”€ LISTA DE CLIENTES â”€â”€
  } else if (cmd === '!clients' || cmd === '!clientes') {
    const clients = db.getAllClients();
    if (clients.length === 0) {
      await msg.reply('No hay clientes registrados aÃºn.');
      return;
    }
    let list = `ðŸ“‹ * Ãšltimos clientes:*\n\n`;
    const recent = clients.slice(0, 10);
    recent.forEach((c, i) => {
      const statusIcon = c.status === 'new' ? 'ðŸ†•' : c.status === 'assigned' ? 'ðŸ”—' : 'âœ…';
      list += `${i + 1}. ${statusIcon} ${c.name || 'Sin nombre'} - ${c.phone} \n`;
    });
    list += `\n_Total: ${clients.length} clientes_`;
    await msg.reply(list);

    // â”€â”€ FICHA DE CLIENTE â”€â”€
  } else if (cmd.startsWith('!client ') || cmd.startsWith('!cliente ')) {
    const targetPhone = parts[1]?.trim();
    if (!targetPhone) {
      await msg.reply('Uso: !client 573XXXXXXXXXX');
      return;
    }
    const profile = db.getClientProfile(targetPhone);
    if (!profile) {
      await msg.reply(`âŒ No se encontrÃ³ cliente con nÃºmero ${targetPhone} `);
      return;
    }
    let card = `ðŸ“‡ * Ficha del Cliente *\n\n`;
    card += `ðŸ‘¤ * Nombre:* ${profile.name || 'Sin nombre'} \n`;
    card += `ðŸ“± * TelÃ©fono:* ${profile.phone} \n`;
    card += `ðŸ“Š * Estado:* ${profile.status} \n`;
    card += `ðŸ’¬ * Mensajes:* ${profile.totalMessages} \n`;
    card += `ðŸ”„ * Interacciones:* ${profile.interaction_count || 0} \n`;
    card += `ðŸ“… * Primer contacto:* ${profile.created_at} \n`;
    card += `ðŸ• * Ãšltima interacciÃ³n:* ${profile.updated_at} \n`;
    if (profile.assignedTo) {
      card += `ðŸ‘” * Asignado a:* ${profile.assignedTo} \n`;
    }
    card += `\nðŸ§  * Memoria / Perfil:*\n`;
    card += profile.memory || '_Sin datos aÃºn_';
    if (profile.notes) {
      card += `\n\nðŸ“ * Notas:*\n${profile.notes} `;
    }
    card += `\n\nðŸ’¬ * Ãšltimos mensajes:*\n`;
    if (profile.recentMessages.length > 0) {
      profile.recentMessages.forEach(m => {
        const icon = m.role === 'user' ? 'ðŸ‘¤' : 'ðŸ¤–';
        card += `${icon} ${m.message.substring(0, 100)} \n`;
      });
    } else {
      card += '_Sin mensajes_';
    }
    await msg.reply(card);

    // â”€â”€ INFORME GENERAL â”€â”€
  } else if (cmd === '!informe' || cmd === '!report') {
    const r = db.getGeneralReport();
    let report = `ðŸ“Š * INFORME GENERAL *\n`;
    report += `â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\n`;
    report += `ðŸ“… * Hoy:*\n`;
    report += `  ðŸ†• Clientes nuevos: ${r.clientsToday} \n`;
    report += `  ðŸ’¬ Mensajes: ${r.messagesToday} \n`;
    report += `  ðŸ”„ Derivaciones: ${r.handoffsToday} \n\n`;
    report += `ðŸ“† * Ãšltima semana:*\n`;
    report += `  ðŸ†• Clientes nuevos: ${r.clientsThisWeek} \n\n`;
    report += `ðŸ“ˆ * Totales:*\n`;
    report += `  ðŸ‘¥ Clientes: ${r.totalClients} \n`;
    report += `  ðŸ†• Sin atender: ${r.newClients} \n`;
    report += `  ðŸ”— Asignados: ${r.assignedClients} \n`;
    report += `  ðŸ’¬ Mensajes: ${r.totalMessages} \n\n`;
    report += `ðŸ‘” * Empleados:*\n`;
    r.employeeStats.forEach(emp => {
      report += `  â€¢ ${emp.name}: ${emp.today} hoy | ${emp.active_now} activos | ${emp.assignments_count} total\n`;
    });
    if (r.unattendedClients.length > 0) {
      report += `\nâš ï¸ * Clientes sin atender:*\n`;
      r.unattendedClients.forEach(c => {
        report += `  â€¢ ${c.name || 'Sin nombre'} (${c.phone}) - ${c.interaction_count} msgs\n`;
      });
    }
    await msg.reply(report);

    // â”€â”€ INFORME DE VENTAS â”€â”€
  } else if (cmd === '!informe ventas' || cmd === '!ventas' || cmd === '!pipeline') {
    const s = db.getSalesReport();
    let report = `ðŸ’° * INFORME DE VENTAS *\n`;
    report += `â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\n`;
    report += `ðŸ“Š * Pipeline:*\n`;
    s.pipeline.forEach(p => {
      const icon = p.status === 'new' ? 'ðŸ†•' : p.status === 'assigned' ? 'ðŸ”—' : 'âœ…';
      report += `  ${icon} ${p.status}: ${p.count} clientes\n`;
    });
    if (s.hotLeads.length > 0) {
      report += `\nðŸ”¥ * Leads calientes:*\n`;
      s.hotLeads.forEach(l => {
        const mem = l.memory ? l.memory.substring(0, 80) : 'Sin datos';
        report += `  â€¢ ${l.name || 'Sin nombre'} (${l.phone}) \n    ${mem} \n`;
      });
    }
    if (s.pendingClients.length > 0) {
      report += `\nâ³ * Asignados pendientes:*\n`;
      s.pendingClients.forEach(p => {
        report += `  â€¢ ${p.name || 'Sin nombre'} â†’ ${p.employee_name} (${p.assigned_at}) \n`;
      });
    }
    report += `\nðŸ‘” * Carga por empleado:*\n`;
    s.employeeLoad.forEach(e => {
      report += `  â€¢ ${e.name}: ${e.active_now} activos / ${e.assignments_count} total\n`;
    });
    await msg.reply(report);

    // â”€â”€ AGREGAR NOTA A CLIENTE â”€â”€
  } else if (cmd.startsWith('!note ') || cmd.startsWith('!nota ')) {
    const targetPhone = parts[1]?.trim();
    const noteText = parts.slice(2).join(' ').trim();
    if (!targetPhone || !noteText) {
      await msg.reply('Uso: !note 573XXXXXXXXXX Tu nota aquÃ­');
      return;
    }
    const clientExists = db.getClient(targetPhone);
    if (!clientExists) {
      await msg.reply(`âŒ No se encontrÃ³ cliente con nÃºmero ${targetPhone} `);
      return;
    }
    // Append nota con timestamp
    const currentNotes = clientExists.notes || '';
    const timestamp = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });
    const newNotes = currentNotes
      ? `${currentNotes} \n[${timestamp}] ${noteText} `
      : `[${timestamp}] ${noteText} `;
    db.updateClientNotes(targetPhone, newNotes);
    await msg.reply(`ðŸ“ Nota agregada a ${clientExists.name || targetPhone}: \n"${noteText}"`);

    // â”€â”€ RESETEAR CLIENTE â”€â”€
  } else if (cmd.startsWith('!reset ')) {
    const targetPhone = parts[1]?.trim();
    if (!targetPhone) {
      await msg.reply('Uso: !reset 573XXXXXXXXXX');
      return;
    }
    const clientExists = db.getClient(targetPhone);
    if (!clientExists) {
      await msg.reply(`âŒ No se encontrÃ³ cliente con nÃºmero ${targetPhone} `);
      return;
    }
    db.resetClient(targetPhone);
    await msg.reply(`ðŸ”„ Cliente ${clientExists.name || targetPhone} reseteado.\nHistorial limpio, estado: new, memoria borrada.`);

    // â”€â”€ CERRAR ASIGNACIÃ“N â”€â”€
  } else if (cmd.startsWith('!close ') || cmd.startsWith('!cerrar ')) {
    const targetPhone = parts[1]?.trim();
    if (!targetPhone) {
      await msg.reply('Uso: !close 573XXXXXXXXXX');
      return;
    }
    const closed = db.closeAssignment(targetPhone);
    if (!closed) {
      await msg.reply(`âŒ No hay asignaciÃ³n activa para ${targetPhone} `);
      return;
    }
    await msg.reply(`âœ… AsignaciÃ³n cerrada: ${targetPhone} ya no estÃ¡ asignado a ${closed.employee_name} `);

    // â”€â”€ AYUDA â”€â”€
  } else if (cmd === '!help' || cmd === '!ayuda') {
    const help = `ðŸ¤– * Comandos de Admin:*\n\n` +
      `ðŸ“Š * Informes:*\n` +
      `  !stats - EstadÃ­sticas rÃ¡pidas\n` +
      `  !informe - Informe general completo\n` +
      `  !ventas - Informe de ventas / pipeline\n\n` +
      `ðŸ‘¥ * Clientes:*\n` +
      `  !clients - Ãšltimos clientes\n` +
      `  !client 573XX - Ficha completa\n` +
      `  !note 573XX texto - Agregar nota\n` +
      `  !reset 573XX - Resetear cliente\n` +
      `  !close 573XX - Cerrar asignaciÃ³n\n\n` +
      `ðŸ’¡ _Usa!help para ver esta ayuda_`;
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
// y les envÃ­a el mensaje de recuperaciÃ³n de clientes.
async function recuperarChatsViejos() {
  try {
    console.log('[RECOVERY] ðŸ” Buscando chats sin responder...');

    const allChats = await client.getChats();
    let enviados = 0;
    let omitidos = 0;

    // Archivo de control para no enviar dos veces al mismo nÃºmero
    const controlPath = path.join(__dirname, 'recovery_enviados.json');
    let yaEnviados = {};
    if (fs.existsSync(controlPath)) {
      yaEnviados = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
    }

    // Paso 1: Filtrar chats vÃ¡lidos y recolectar info
    console.log('[RECOVERY] ðŸ“‹ Filtrando y ordenando chats...');
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

        // Bloquear bots empresariales (nÃºmeros cortos)
        const phoneClean = phone.replace('57', '');
        if (phoneClean.length <= 6) continue;

        const messages = await chat.fetchMessages({ limit: 5 });
        if (!messages || messages.length === 0) continue;

        // Buscar el mensaje mÃ¡s antiguo para ordenar por antigÃ¼edad
        const firstMsg = messages[0];
        if (!firstMsg) continue;

        // Guardar chat con su timestamp para ordenar (mÃ¡s viejo primero)
        chatsPendientes.push({
          chat,
          phone,
          timestamp: firstMsg.timestamp || 0 // epoch en segundos
        });
      } catch (e) {
        // Chat problemÃ¡tico, saltar silenciosamente
      }
    }

    // Paso 2: Ordenar por timestamp ASCENDENTE (mÃ¡s viejos primero)
    chatsPendientes.sort((a, b) => a.timestamp - b.timestamp);

    console.log(`[RECOVERY] ðŸ“Š ${chatsPendientes.length} chats pendientes encontrados.Enviando desde el mÃ¡s viejo...`);

    // Paso 3: Enviar mensajes en orden (mÃ¡s viejos primero)
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
          `Hola${nombre ? ' ' + nombre.split(' ')[0] : ''} ðŸ‘‹, buenas.\n\n` +
          `Te escribo de parte de * Zona TraumÃ¡tica *.Veo que hace un tiempo nos escribiste y quiero disculparme sinceramente por no haberte atendido â€” estuvimos en un proceso de restructuraciÃ³n y renovamos completamente nuestro equipo y herramientas de atenciÃ³n.\n\n` +
          `Hoy estamos operando con un servicio mucho mÃ¡s Ã¡gil y completo. Â¿Sigues interesado / a en lo que consultaste ? Con gusto te atiendo personalmente ahora. ðŸ™Œ`;

        await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
        await client.sendMessage(chat.id._serialized, mensajeRecuperacion);

        saveContactToVCF(phone, nombre);

        yaEnviados[phone] = new Date().toISOString();
        fs.writeFileSync(controlPath, JSON.stringify(yaEnviados, null, 2), 'utf8');

        enviados++;
        console.log(`[RECOVERY] âœ… (${enviados}/${chatsPendientes.length}) ${nombre || phone} â€” Ãºltimo msg: ${fecha} `);

      } catch (chatError) {
        console.error(`[RECOVERY] âš ï¸ Chat omitido(${item.phone || 'desconocido'}): `, chatError.message);
      }
    }

    console.log(`[RECOVERY] ðŸ RecuperaciÃ³n completa: ${enviados} mensajes enviados, ${omitidos} chats ya atendidos o sin acciÃ³n.`);

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

    // Verificar si ya estÃ¡ en el archivo para no duplicar
    if (fs.existsSync(vcfPath)) {
      const existing = fs.readFileSync(vcfPath, 'utf8');
      if (existing.includes(`+ ${phone} `)) {
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
      `FN:${displayName} \n` +
      `N:${displayName};;;; \n` +
      `TEL; TYPE = CELL: +${phone} \n` +
      `NOTE:Cliente ZT â€” ${new Date().toLocaleDateString('es-CO')} \n` +
      'END:VCARD\n\n';

    // Agregar al archivo (append)
    fs.appendFileSync(vcfPath, vcard, 'utf8');
    console.log(`[VCF] âœ… Contacto guardado: ${displayName} (+${phone})`);

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
      // Saltar contactos sin nÃºmero o de tipo broadcast/grupo
      if (!contact.number || contact.isGroup || contact.id._serialized === 'status@broadcast') continue;

      const name = contact.pushname || contact.name || contact.shortName || contact.number;
      const phone = contact.number;

      vcfContent += 'BEGIN:VCARD\n';
      vcfContent += 'VERSION:3.0\n';
      vcfContent += `FN:${name} \n`;
      if (contact.name) {
        vcfContent += `N:${contact.name};;;; \n`;
      } else {
        vcfContent += `N:${name};;;; \n`;
      }
      vcfContent += `TEL; TYPE = CELL: +${phone} \n`;
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

    console.log(`[VCF] âœ… ${count} contactos exportados a: ${vcfPath} `);
  } catch (error) {
    console.error('[VCF] Error exportando contactos:', error.message);
  }
}

// ============================================
// ARRANCAR EL BOT
// ============================================
console.log('\n[BOT] Iniciando bot empresarial...');
console.log(`[BOT] Negocio: ${CONFIG.businessName} `);
console.log(`[BOT] Modo: ${CONFIG.mode} `);
console.log('[BOT] Conectando a WhatsApp...\n');

// ============================================
// BROADCASTER DE IMÃGENES A GRUPOS
// ============================================
// EnvÃ­a imÃ¡genes rotativas a todos los grupos cada 4 horas
// con texto generado por Claude (diferente cada vez)

let broadcasterImageIndex = 0; // Ã­ndice rotativo de imÃ¡genes

async function getGroupBroadcastText(imageName) {
  const contextos = [
    'Es de maÃ±ana, los grupos estÃ¡n empezando el dÃ­a',
    'Es mediodÃ­a, buen momento para recordar la oferta',
    'Es tarde, Ãºltimo push del dÃ­a para el club',
  ];
  const contextoAleatorio = contextos[Math.floor(Math.random() * contextos.length)];

  try {
    const broadcastModel = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });
    const prompt = `Eres el community manager de Zona TraumÃ¡tica Colombia.
Escribe un mensaje corto y poderoso para acompaÃ±ar esta imagen promocional del Club ZT en un grupo de WhatsApp de portadores de armas traumÃ¡ticas.
  Contexto: ${contextoAleatorio}.
Imagen: ${imageName}.
El mensaje debe:
- Ser mÃ¡ximo 4 lÃ­neas
  - Tener gancho emocional(miedo a perder el arma, orgullo del portador preparado)
    - Terminar con una llamada a la acciÃ³n clara(escribir al privado, preguntar por el plan, etc.)
      - Usar emojis con moderaciÃ³n(mÃ¡ximo 3)
        - Sonar humano, NO robÃ³tico ni corporativo
          - NO repetir exactamente lo que dice la imagen
Solo escribe el mensaje, sin explicaciones.`;
    const result = await broadcastModel.generateContent(prompt);
    return result.response.text().trim();
  } catch (err) {
    console.error('[BROADCASTER] Error generando texto:', err.message);
    return 'ðŸ›¡ï¸ Â¿Ya tienes tu respaldo legal listo? El Club Zona TraumÃ¡tica te protege antes, durante y despuÃ©s. EscrÃ­benos al privado.';
  }
}

async function sendGroupBroadcast() {
  console.log('[BROADCASTER] ðŸ“¢ Iniciando envÃ­o a grupos...');

  // Obtener todas las imÃ¡genes disponibles en /imagenes
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
    console.log('[BROADCASTER] No hay imÃ¡genes en /imagenes â€” cancelando');
    return;
  }

  // Seleccionar imagen rotativa
  const imagenActual = imagenes[broadcasterImageIndex % imagenes.length];
  broadcasterImageIndex++;
  const imagenPath = path.join(imagenesDir, imagenActual);

  console.log(`[BROADCASTER] ðŸ–¼ï¸ Imagen: ${imagenActual} (${broadcasterImageIndex}/${imagenes.length})`);

  // Generar texto con Claude
  const texto = await getGroupBroadcastText(imagenActual);
  console.log(`[BROADCASTER] ðŸ“ Texto: ${texto.substring(0, 80)}...`);

  // Obtener todos los grupos
  let chats;
  try {
    chats = await client.getChats();
  } catch (e) {
    console.error('[BROADCASTER] Error obteniendo chats:', e.message);
    return;
  }

  const grupos = chats.filter(c => c.isGroup);
  console.log(`[BROADCASTER] ðŸ‘¥ Grupos encontrados: ${grupos.length} `);

  if (grupos.length === 0) {
    console.log('[BROADCASTER] No hay grupos â€” cancelando');
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

  // Enviar a cada grupo con delay entre envÃ­os para no saturar
  let enviados = 0;
  for (const grupo of grupos) {
    try {
      await client.sendMessage(grupo.id._serialized, media, { caption: texto });
      enviados++;
      console.log(`[BROADCASTER] âœ… Enviado a: ${grupo.name} `);
      // Esperar entre 3 y 6 segundos entre grupos para parecer natural
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 3000));
    } catch (err) {
      console.error(`[BROADCASTER] âŒ Error en grupo ${grupo.name}: `, err.message);
    }
  }

  console.log(`[BROADCASTER] ðŸ“Š Completado: ${enviados}/${grupos.length} grupos`);
}

function startGroupBroadcaster() {
  // Horas fijas del dÃ­a en que se envÃ­a (hora Colombia UTC-5)
  const HORAS_ENVIO = [8, 12, 16, 20]; // 8am, 12pm, 4pm, 8pm

  function getMsHastaProximoEnvio() {
    const ahora = new Date();
    // Convertir hora actual a hora Colombia (UTC-5)
    const utcMinutes = ahora.getUTCHours() * 60 + ahora.getUTCMinutes();
    const colMinutes = ((utcMinutes - 5 * 60) % (24 * 60) + 24 * 60) % (24 * 60);
    const colHora = Math.floor(colMinutes / 60);
    const colMin = colMinutes % 60;

    // Buscar la prÃ³xima hora de envÃ­o que aÃºn no ha pasado hoy
    let proximaHora = HORAS_ENVIO.find(h => h > colHora || (h === colHora && colMin === 0));
    if (proximaHora === undefined) {
      // Todas las horas de hoy ya pasaron â†’ primera de maÃ±ana
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
    console.log(`[BROADCASTER] â° PrÃ³ximo envÃ­o en ${horasEspera}h ${minsEspera}m`);

    setTimeout(async () => {
      await sendGroupBroadcast();
      programarSiguiente(); // reprogramar para la siguiente hora fija
    }, msEspera);
  }

  console.log(`[BROADCASTER] ðŸš€ Iniciado â€” enviarÃ¡ a grupos a las ${HORAS_ENVIO.join('h, ')}h (hora Colombia)`);
  programarSiguiente(); // NO envÃ­a al arrancar, espera la prÃ³xima hora programada
}

// ============================================
// REACTIVACIÃ“N DE LEADS CALIENTES
// El panel llama a http://localhost:3001/reactivar cuando se presiona el botÃ³n
// El bot procesa la lista uno por uno con delay anti-ban
// ============================================
const http = require('http');

async function procesarClientesCalientes(clientes) {
  console.log(`[REACTIVAR] ðŸ”¥ Iniciando reactivaciÃ³n de ${clientes.length} leads calientes...`);

  for (let i = 0; i < clientes.length; i++) {
    const cliente = clientes[i];
    try {
      const historial = db.getConversationHistory(cliente.phone, 10);
      const resumenHistorial = historial.map(h => `${h.role === 'user' ? 'Cliente' : 'Bot'}: ${h.message}`).join('\n');

      const reactivarModel = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });
      const prompt = `Eres un asesor de ventas de Zona TraumÃ¡tica (tienda de armas traumÃ¡ticas y Club ZT en Colombia).

Tienes este cliente que mostrÃ³ interÃ©s pero no ha cerrado la compra. EnvÃ­ale UN mensaje corto y natural para retomar la conversaciÃ³n y cerrar la venta.

PERFIL DEL CLIENTE:
Nombre: ${cliente.name}
Memoria/perfil: ${cliente.memory}

ÃšLTIMOS MENSAJES:
${resumenHistorial || 'Sin historial previo'}

REGLAS:
1. MÃ¡ximo 3-4 lÃ­neas â€” mensaje de WhatsApp real, no un email
2. Personalizado segÃºn su interÃ©s especÃ­fico (menciona lo que Ã©l preguntÃ³)
3. Urgencia sutil de la promociÃ³n por tiempo limitado â€” como dato, no como presiÃ³n
4. Cierra con una pregunta abierta
5. Tono: cercano, humano, como amigo que avisa â€” NO vendedor desesperado
6. MÃ¡ximo 2 emojis
7. NO menciones que es un mensaje automÃ¡tico

Escribe SOLO el mensaje, sin explicaciones ni comillas.`;

      const result = await reactivarModel.generateContent(prompt);
      const mensaje = result.response.text().trim();

      const phoneForDb = cliente.phone.replace(/@.*/g, '').replace(/\D/g, '');
      await safeSend(phoneForDb, mensaje);
      db.saveMessage(phoneForDb, 'assistant', mensaje);
      console.log(`[REACTIVAR] âœ… (${i + 1}/${clientes.length}) Enviado a ${cliente.name} (${cliente.phone})`);

    } catch (err) {
      console.error(`[REACTIVAR] âŒ Error con ${cliente.phone}:`, err.message);
    }

    // Delay anti-ban entre mensajes: 45-90 segundos aleatorios (excepto despuÃ©s del Ãºltimo)
    if (i < clientes.length - 1) {
      const delay = Math.floor(Math.random() * 45000) + 45000;
      console.log(`[REACTIVAR] â³ Siguiente en ${Math.round(delay / 1000)}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  console.log(`[REACTIVAR] ðŸŽ‰ ReactivaciÃ³n completada â€” ${clientes.length} mensajes enviados`);
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
          // Responder inmediatamente al panel â€” el proceso corre en background
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

          // 1. Actualizar BD primero â€” esto SIEMPRE debe ocurrir
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
              msgDatos = `âœ… Â¡Confirmamos tu pago! Bienvenido al Club ZT ðŸ›¡ï¸\n\nPara generar tu carnet digital necesito estos datos:\n\n` +
                `ðŸ“‹ *Datos para tu Carnet Digital Club ZT:*\n` +
                `1. Nombre completo\n2. NÃºmero de cÃ©dula\n3. TelÃ©fono de contacto\n` +
                `4. Marca del arma\n5. Modelo del arma\n6. NÃºmero de serial del arma\n` +
                `7. ðŸ“¸ Foto de frente (selfie clara, sin gafas de sol, buena iluminaciÃ³n)\n\n` +
                `En cuanto me envÃ­es todo, tu carnet estarÃ¡ listo en menos de 24 horas ðŸ’ª`;
              nuevoStatus = 'carnet_pendiente';
            } else if (tipo === 'bot_asesor') {
              msgDatos = `âœ… Â¡Confirmamos tu pago! Ya tienes acceso al *Bot Asesor Legal ZT* ðŸ¤–âš–ï¸\n\n` +
                `Tu nÃºmero quedarÃ¡ activado en las prÃ³ximas horas. A partir de ese momento podrÃ¡s consultarle directamente al bot sobre:\n\n` +
                `â€¢ Normativa vigente de armas traumÃ¡ticas\n` +
                `â€¢ Derechos y deberes como portador\n` +
                `â€¢ Procedimientos legales en caso de uso\n` +
                `â€¢ Y mucho mÃ¡s ðŸ’ª\n\n` +
                `Te avisamos cuando estÃ© activo. Â¡Gracias por tu confianza! ðŸ™`;
              nuevoStatus = 'bot_asesor_pendiente';
            } else {
              msgDatos = `âœ… Â¡Confirmamos tu pago! Ya estamos procesando tu pedido ðŸ“¦\n\nPara el envÃ­o necesito estos datos:\n\n` +
                `ðŸ“¦ *Datos de envÃ­o:*\n` +
                `1. Nombre completo\n2. NÃºmero de cÃ©dula\n3. TelÃ©fono de contacto\n` +
                `4. DirecciÃ³n completa (calle, nÃºmero, barrio, apartamento si aplica)\n` +
                `5. Ciudad\n6. Departamento\n\n` +
                `El envÃ­o se procesa en 1-2 dÃ­as hÃ¡biles, es discreto y seguro ðŸ”’`;
              nuevoStatus = 'despacho_pendiente';
            }

            // Actualizar estado y memoria â€” operaciones BD, siempre deben ocurrir
            db.upsertClient(phoneClean, { status: nuevoStatus });
            const memoriaActual = db.getClientMemory(phoneClean) || '';
            const tagPago = tipo === 'club'
              ? 'âœ… YA AFILIADO AL CLUB ZT â€” comprobante confirmado. NO ofrecer mÃ¡s productos de club.'
              : tipo === 'bot_asesor'
                ? 'âœ… YA PAGÃ“ BOT ASESOR LEGAL â€” comprobante confirmado. NO ofrecer mÃ¡s suscripciones.'
                : 'âœ… YA COMPRÃ“ PRODUCTO â€” comprobante confirmado. NO ofrecer mÃ¡s ventas, estÃ¡ en proceso de envÃ­o.';
            const nuevaMemoria = memoriaActual ? memoriaActual + '\n' + tagPago : tagPago;
            db.updateClientMemory(phoneClean, nuevaMemoria);
            console.log(`[COMPROBANTE] âœ… BD actualizada ID #${id} para ${phone}`);

          } else {
            msgRechazado = `âš ï¸ Revisamos tu comprobante y el monto no coincide con el valor del plan seleccionado.\n\n` +
              `Por favor verifica el monto y vuelve a enviarnos el comprobante correcto. Si tienes dudas, con gusto te ayudamos ðŸ™`;
          }

          // 4. Intentar notificar al cliente por WhatsApp â€” puede fallar sin romper nada
          try {
            if (msgDatos) {
              await safeSend(phoneClean, msgDatos);
              db.saveMessage(phoneClean, 'assistant', msgDatos);
              console.log(`[COMPROBANTE] ðŸ“± NotificaciÃ³n enviada a ${phone}`);
            } else if (msgRechazado) {
              await safeSend(phoneClean, msgRechazado);
              db.saveMessage(phoneClean, 'assistant', msgRechazado);
              console.log(`[COMPROBANTE] ðŸ“± Rechazo notificado a ${phone}`);
            }
            waSent = true;
          } catch (waErr) {
            waSent = false;
            waError = waErr.message;
            console.error(`[COMPROBANTE] âš ï¸ No se pudo notificar a ${phone}: ${waErr.message}`);
          }

          // BD ya fue actualizada â€” siempre responder ok:true
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, waSent, waWarning: waError }));
        } catch (e) {
          console.error('[COMPROBANTE] Error confirmar:', e.message);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
    } else if (req.url === '/resolver-lids' && req.method === 'POST') {
      // Resolver phones LID: clientes cuyo phone >= 13 dÃ­gitos NO son un nÃºmero real
      // Solo responsabilidad: dejar el nÃºmero real como phone. El chat_id se auto-sana al enviar.
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
        console.log(`[LID] ðŸ” Resolviendo ${lidClients.length} phones LID a nÃºmero real...`);

        for (const c of lidClients) {
          try {
            const chatId = c.chat_id || (c.phone + '@lid');
            const contact = await client.getContactById(chatId);
            const realNumber = (contact.number || '').replace(/\D/g, '');

            if (!realNumber || realNumber === c.phone) {
              console.log(`[LID] â­ï¸  ${c.phone} â€” sin cambio`);
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
              console.log(`[LID] âœ… ${c.phone} â†’ ${realNumber}`);
              resueltos++;
            }
            await new Promise(r => setTimeout(r, 800));
          } catch (err) {
            console.error(`[LID] âŒ ${c.phone}: ${err.message}`);
            fallidos++;
          }
        }

        console.log(`[LID] ðŸŽ‰ Completado â€” ${resueltos} resueltos, ${fallidos} fallidos`);
      })().catch(e => console.error('[LID] Error general:', e.message));

      // POST /enviar-mensaje â€” panel envÃ­a mensaje como Ãlvaro
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

          // Marcar que este phone está siendo escrito desde el panel
          // para que message_create lo detecte como mensaje de Álvaro
          panelSendingTo.add(phone);

          // Enviar por WhatsApp
          const chatId = db.getClientChatId(phone);
          await client.sendMessage(chatId, message);

          // message_create se encargará de: guardar como admin, pausar bot, y enviar transición
          // (porque panelSendingTo tiene el phone marcado)

          console.log(`[PANEL] ðŸ“ Mensaje enviado como Ãlvaro a ${phone}: "${message.substring(0, 60)}"`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          console.error('[PANEL] Error enviar-mensaje:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });

      // POST /devolver-bot â€” panel devuelve un cliente al bot (quita pausa de admin)
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

          console.log(`[PANEL] ðŸ¤– Cliente ${phone} devuelto al bot (estaba pausado: ${wasPaused})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, wasPaused }));
        } catch (e) {
          console.error('[PANEL] Error devolver-bot:', e.message);
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
    console.log('[BOT API] ðŸš€ API interna escuchando en puerto 3001');
  });
}

client.initialize();
