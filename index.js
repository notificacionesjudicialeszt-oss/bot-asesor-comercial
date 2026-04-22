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
const jsQR = require('jsqr');
const Jimp = require('jimp');

const db = require('./db');
const router = require('./router');
const search = require('./search');

const { geminiGenerate, SAFETY_SETTINGS, genAI: getGenAI, runDiagnostic } = require('./gemini');
const { CONFIG, parseEmployees, knowledgeBase } = require('./config');
const { findBestImage } = require('./images');
const { buildSystemPrompt } = require('./prompts');
const adminCommands = require('./admin_commands');
const { isAdmin, isAuditor, notifyAuditors, handleAdminCommand } = adminCommands;
const broadcasters = require('./broadcasters');
const { startGroupBroadcaster, startStatusBroadcaster } = broadcasters;
const clientFlow = require('./client_flow');
const { cleanBotTags, safeSend, handleClientMessage, getClaudeResponse, getN8nResponse, updateClientMemory, generateSimpleMemory, detectPostventaIntent, detectHandoffIntent, handleHandoff, summarizeConversation, needsProductSearch, detectAndSendProductImages, retryQueue } = clientFlow;
const apiServer = require('./api_server');
const { startReactivacionServer, procesarClientesCalientes, forceBotReply, forcePostventaReply } = apiServer;
const recovery = require('./recovery');
const { recuperarChatsViejos, saveContactToVCF, exportContactsToVCF } = recovery;
const tts = require('./tts');

// retryQueue ahora viene de client_flow.js





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

// Inyectar client a módulos que lo necesitan
adminCommands.init(client);
broadcasters.init(client, MessageMedia);
clientFlow.init(client, MessageMedia);
apiServer.init(client, MessageMedia, { procesarMensaje, isBotPaused, adminPauseMap, enviarTransicionAdmin });
recovery.init(client);
tts.init(client, MessageMedia);

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
// Unified uncaughtException handler — combines session cleanup + Puppeteer watchdog
process.on('uncaughtException', async (err) => {
  const msg = err.message || '';
  console.error('[BOT] 💥 Error no capturado:', msg);

  const esFatalPuppeteer = (
    msg.includes('Execution context was destroyed') ||
    msg.includes('detached Frame') ||
    msg.includes('Session closed') ||
    msg.includes('Protocol error') ||
    msg.includes('Target closed') ||
    msg.includes('Connection closed')
  );

  if (esFatalPuppeteer) {
    console.error('[WATCHDOG] 💀 Error fatal de Puppeteer detectado — limpiando y reiniciando...');
    const sessionDir = path.join(__dirname, 'session');
    if (fs.existsSync(sessionDir)) {
      try {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        console.log('[BOT] ✅ Sesión corrupta eliminada.');
      } catch (rmErr) {
        console.error(`[BOT] ❌ Error EBUSY: No se pudo borrar la sesión automáticamente.`);
      }
    }
    process.exit(1);
  } else {
    // Error no fatal — loggear y continuar
    console.error('[WATCHDOG] ⚠️ Excepción no capturada (no fatal):', msg);
  }
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

  // Autodiagnóstico de Gemini (10s después para no bloquear el arranque)
  setTimeout(() => {
    runDiagnostic().catch(e => console.error('[DIAGNÓSTICO] Error:', e.message));
  }, 10000);

  // Recovery COMPLETADO — bot en modo venta
  // setTimeout(() => recuperarChatsViejos(), 8000);

  // Iniciar servidor interno y automatizaciones SOLO la primera vez
  if (!serverStarted) {
    serverStarted = true;
    
    // Iniciar broadcaster de imágenes a grupos (esperar 30s)
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
    if (typeof startReactivacionServer === 'function') {
      startReactivacionServer();
    }

    // Iniciar agentes proactivos (scheduler: briefing + lead scoring)
    setTimeout(() => {
      try {
        const scheduler = require('./agents/scheduler');
        scheduler.init(client);
        scheduler.startScheduler();
      } catch (err) {
        console.error('[BOT] Error iniciando scheduler de agentes:', err.message);
      }
    }, 60000);
  }
});

// Error de autenticación — limpiar sesión corrupta y reiniciar
client.on('auth_failure', async (msg) => {
  console.error('[BOT] ❌ Error de autenticación:', msg);
  console.log('[BOT] 🧹 Limpiando sesión corrupta...');
  const sessionDir = path.join(__dirname, 'session');
  if (fs.existsSync(sessionDir)) {
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log('[BOT] ✅ Sesión borrada. Reiniciando para QR nuevo...');
    } catch (rmErr) {
      console.error(`[BOT] ❌ Error EBUSY: No se pudo borrar la sesión de WhatsApp automáticamente por archivos bloqueados. Considera borrar 'session' a mano si el reinicio falla.`);
    }
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

// Watchdog for unhandled promise rejections (Puppeteer fatals)
process.on('unhandledRejection', (reason) => {
  const msg = (reason && reason.message) ? reason.message : String(reason);
  const esFatalPuppeteer = (
    msg.includes('detached Frame') ||
    msg.includes('Session closed') ||
    msg.includes('Target closed') ||
    msg.includes('Protocol error') ||
    msg.includes('Connection closed')
  );
  if (esFatalPuppeteer) {
    console.error('[WATCHDOG] 💀 Promesa rechazada fatal (Puppeteer caído) — reiniciando proceso...');
    console.error('[WATCHDOG]   >', msg);
    process.exit(1);
  } else {
    console.error('[WATCHDOG] ⚠️ Promesa rechazada (no fatal):', msg);
  }
});



async function enviarTransicionAdmin(clientPhone, chatId, alvaroMsg) {
  try {
    const memory = db.getClientMemory(clientPhone) || 'Sin datos previos';
    const history = db.getConversationHistory(clientPhone, 5);
    const histText = history.map(h =>
      `${h.role === 'user' ? 'Cliente' : h.role === 'admin' ? 'Álvaro' : 'Bot'}: ${h.message}`
    ).join('\n');

    const prompt = `Eres Sofía, asesora comercial de Zona Traumática. Álvaro (el director) acaba de responder PERSONALMENTE a este cliente por WhatsApp.

MEMORIA DEL CLIENTE:
${memory}

ÚLTIMOS MENSAJES:
${histText}

MENSAJE DE ÁLVARO:
"${alvaroMsg}"

Tu tarea: Genera un mensaje BREVE de seguimiento natural después de la respuesta de Álvaro. NO repitas lo que Álvaro dijo. Solo complementa si falta algo, o pregunta si el cliente tiene más dudas. Máximo 2-3 líneas, tono natural y cercano. Si Álvaro ya resolvió todo, un simple "¿Algo más en lo que te pueda ayudar?" basta.`;

    const result = await geminiGenerate('gemini-2.5-pro', prompt);
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
// ============================================
// CAPTURA DE MENSAJES SALIENTES DE ÁLVARO
// Cuando Álvaro responde directamente desde el celular (no desde el panel),
// guardamos ese mensaje en la BD para que el bot tenga contexto real del chat.
// También pausamos el bot para ese cliente 30 minutos.
// ============================================
client.on('message_create', async (msg) => {
  try {
    // Solo mensajes SALIENTES (fromMe) y de texto — ignorar los del bot mismo
    if (!msg.fromMe) return;
    if (!msg.body || msg.body.trim() === '') return;
    // Los comandos admin (#) ya se manejan en 'message'
    if (msg.body.startsWith('#')) return;
    // Ignorar mensajes a grupos, estados, newsletters
    if (msg.to === 'status@broadcast') return;
    if ((msg.to || '').includes('@g.us')) return;
    if ((msg.to || '').includes('@newsletter')) return;
    if ((msg.to || '').includes('@broadcast')) return;

    // Extraer el teléfono del destinatario (cliente)
    const clientPhone = (msg.to || '').replace(/@.*/g, '');
    if (!clientPhone || clientPhone.length < 7) return;

    const msgText = msg.body.trim();

    // No capturar si es mensaje que el BOT envió vía safeSend (tienen origen interno)
    // Comparar contra los últimos 5 mensajes assistant para evitar falsos positivos
    const recentMsgs = db.getConversationHistory(clientPhone, 5);
    const isFromBot = recentMsgs.some(m => m.role === 'assistant' && m.message === msgText);
    if (isFromBot) {
      return; // Ya estaba guardado por safeSend — no duplicar
    }

    // Guardar como mensaje de admin (Álvaro respondiendo directo)
    db.saveMessage(clientPhone, 'admin', `[ÁLVARO respondió directamente]: ${msgText}`);
    console.log(`[ÁLVARO→WA] 📤 Mensaje guardado en BD para ${clientPhone}: "${msgText.substring(0, 60)}"`);

    // Pausar el bot para este cliente 30 minutos (Álvaro está atendiendo)
    adminPauseMap.set(clientPhone, Date.now() + 30 * 60 * 1000);
    console.log(`[ÁLVARO→WA] ⏸️ Bot pausado 30min para ${clientPhone}`);
  } catch (e) {
    // Silencioso — no queremos que un error aquí afecte el bot
    if (e.message && !e.message.includes('getContact')) {
      console.error('[ÁLVARO→WA] Error capturando mensaje saliente:', e.message);
    }
  }
});

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

    // Ignorar mensajes propios (los de Álvaro ya se capturan en message_create arriba)
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
          const msgVirtual = { ...msgRef, body: textoConcatenado, type: 'chat', hasMedia: false };
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
      // Si memory tiene un nombre confirmado y difiere del actual → actualizar
      const memMatch = (existingClient.memory || '').match(/Nombre:\s*([^\n]+)/i);
      const memoryName = memMatch ? memMatch[1].replace(/^\*+|\*+$/g, '').trim() : '';
      if (memoryName && memoryName !== existingClient.name) {
        updateData.name = memoryName;
      } else {
        // Sin nombre en memoria → usar pushname solo si el campo está vacío
        const bestName = profileName || chat.name || '';
        if (bestName && !existingClient.name) {
          updateData.name = bestName;
        }
      }
      db.upsertClient(senderPhone, updateData);
    }

    // 2.5 Auto-detener secuencias de follow-up si el cliente escribe
    // Y analizar QUÉ respondió para decidir si bloquearlo de futuros follow-ups
    try {
      // Verificar si TENÍA secuencias activas antes de detenerlas
      const activeSeqs = db.db.prepare(
        "SELECT COUNT(*) as c FROM followup_sequences WHERE client_phone = ? AND stopped = 0"
      ).get(senderPhone);

      const stopped = db.stopAllSequencesForClient(senderPhone);
      if (stopped.changes > 0) {
        console.log(`[FOLLOWUP] 🛑 ${stopped.changes} secuencia(s) detenida(s) — ${senderPhone} respondió`);

        // Analizar la respuesta del cliente en background (no bloquear el flujo)
        setImmediate(async () => {
          try {
            const { analyzeClientResponse } = require('./agents/followup_engine');
            const analysis = await analyzeClientResponse(senderPhone);

            if (analysis.disposition === 'negativa') {
              db.setFollowupOptout(senderPhone, 'desistio');
              const mem = db.getClientMemory(senderPhone) || '';
              if (!mem.includes('DESISTIÓ')) {
                db.updateClientMemory(senderPhone, mem + `\n⛔ DESISTIÓ DE LA COMPRA (${new Date().toLocaleDateString('es-CO')}): ${analysis.reason || 'No quiere comprar'}. NO volver a ofrecer proactivamente.`);
              }
              console.log(`[FOLLOWUP] ⛔ ${senderPhone} DESISTIÓ — bloqueado. Razón: ${analysis.reason}`);
            } else if (analysis.disposition === 'fecha_tentativa') {
              db.setFollowupOptout(senderPhone, 'fecha_tentativa', analysis.resumeDate || null);
              const mem = db.getClientMemory(senderPhone) || '';
              if (!mem.includes('FECHA TENTATIVA')) {
                db.updateClientMemory(senderPhone, mem + `\n📅 FECHA TENTATIVA (${new Date().toLocaleDateString('es-CO')}): ${analysis.reason}${analysis.resumeDate ? '. Recontactar después de ' + analysis.resumeDate : ''}.`);
              }
              console.log(`[FOLLOWUP] 📅 ${senderPhone} FECHA TENTATIVA — recontactar ${analysis.resumeDate || 'cuando indique'}`);
            }
          } catch (e) {
            console.error('[FOLLOWUP] Error analizando respuesta:', e.message);
          }
        });
      }
    } catch (e) { /* silenciar si la tabla aún no existe */ }

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
            const history = db.getConversationHistory(senderPhone, 10);
            const clientMemory = db.getClientMemory(senderPhone);
            const clientProfile = db.getClient(senderPhone);

            // Inyectar catálogo completo para que Gemini pueda identificar precios específicos de la foto
            const allProducts = search.getAllProducts();
            const productContext = search.formatForPrompt({
              products: allProducts,
              totalFound: allProducts.length,
              strategy: 'search',
              keywords: []
            });

            // Obtener document summary para el expediente del cliente
            const clientFiles = db.getClientFiles ? db.getClientFiles(senderPhone) : [];
            const clientComprobantes = db.getClientComprobantes ? db.getClientComprobantes(senderPhone) : [];
            let documentSummary = '';
            if (clientFiles.length > 0) {
              documentSummary += clientFiles.map(f => `- 📎 ${f.tipo.toUpperCase()}: ${f.descripcion} (${new Date(f.created_at).toLocaleDateString('es-CO')})`).join('\n');
            }
            if (clientComprobantes.length > 0) {
              documentSummary += (documentSummary ? '\n' : '') + clientComprobantes.map(c => `- 💰 COMPROBANTE: ${c.info || 'sin detalle'} — Estado: ${c.estado} (${new Date(c.created_at).toLocaleDateString('es-CO')})`).join('\n');
            }
            const catalogSent = clientProfile && clientProfile.catalog_sent;
            const systemPrompt = buildSystemPrompt(productContext, clientMemory, clientProfile, documentSummary, catalogSent, messageBody);

            // Construir historial previo para que Gemini tenga contexto de la conversación
            const geminiHistory = history
              .filter(h => h.role !== 'system' && h.message && h.message.trim().length > 0)
              .map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.message.trim() }] }));
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
              const carnetCheckResult = await geminiGenerate('gemini-2.5-pro', [
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
              const checkResult = await geminiGenerate('gemini-2.5-pro', [
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
              const mensajeLow = (msg.body || '').toLowerCase();

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

              // Deduplicación: verificar si ya existe un comprobante reciente (últimas 48h)
              const recentComp = db.getRecentComprobante(senderPhone);
              if (recentComp) {
                const estadoTxt = recentComp.estado === 'pendiente' ? 'en verificación' : recentComp.estado === 'confirmado' ? 'ya confirmado' : recentComp.estado;
                console.log(`[COMPROBANTE] ⚠️ Dedup: ya existe comprobante #${recentComp.id} (${estadoTxt}) para ${senderPhone}`);
                reply = `Ya tenemos tu comprobante registrado (está ${estadoTxt}) 🙏 Si es un pago diferente, avísanos y lo procesamos.`;
                await msg.reply(reply);
                db.saveMessage(senderPhone, 'user', `[Comprobante duplicado — ya existe #${recentComp.id}]`);
                db.saveMessage(senderPhone, 'assistant', reply);
                return;
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
              const qrPrompt = `El cliente envió una imagen con un código QR que contiene el siguiente texto: "${qrTexto}".\n\nTu tarea es informar al cliente sobre el contenido de este QR de forma amable y profesional, o responder a cualquier pregunta que haya hecho relacionada con el QR.\n\nContexto actual del asesor comercial:\n${systemPrompt}`;
              const qrResult = await geminiGenerate('gemini-2.5-pro', qrPrompt);
              reply = cleanBotTags(qrResult.response.text());
              await msg.reply(reply);
              db.saveMessage(senderPhone, 'user', `[QR escaneado: ${qrTexto.substring(0, 60)}]`);
              db.saveMessage(senderPhone, 'assistant', reply);
              db.upsertClient(senderPhone, {});

            } else {
              // Imagen normal — flujo con system prompt completo e historial
              const textPart = msg.body 
                ? `El cliente envió esta imagen junto con este mensaje: "${msg.body}".\n\n⚠️ INSTRUCCIÓN CRÍTICA: Si la imagen muestra un arma traumática o producto que vendemos, IDENTIFICA la marca y modelo exacto, búscalo en tus REFERENCIAS RELEVANTES abajo, y dale al cliente el PRECIO ESPECÍFICO y detalles de ESE modelo exacto. NUNCA le des el "rango general de precios" si puedes identificar la pistola en la foto.`
                : `El cliente envió solo esta imagen sin texto.\n\n⚠️ INSTRUCCIÓN CRÍTICA: Asume que el cliente quiere saber qué arma es o cuánto cuesta. IDENTIFICA la marca y modelo exacto en la imagen, búscalo en tus REFERENCIAS RELEVANTES abajo, y dale al cliente el PRECIO ESPECÍFICO y los detalles de ESE modelo exacto. NUNCA respondas con el "rango general de precios" si puedes identificar la pistola de la foto.`;
              const visionModel = getGenAI().getGenerativeModel({
                model: 'gemini-2.5-pro',
                systemInstruction: systemPrompt,
                safetySettings: SAFETY_SETTINGS,
              });
              const visionChat = visionModel.startChat({ history: geminiHistory });
              const visionResult = await visionChat.sendMessage([imagePart, textPart]);
              reply = visionResult.response.text();
              // Detectar tag de audio y limpiar etiquetas internas
              const quiereAudioImg = /\[?\s*RESPONDER[_\s]*CON[_\s]*AUDIO\s*\]?/i.test(reply);
              reply = cleanBotTags(reply);
              if (quiereAudioImg) {
                const audioSentImg = await tts.sendVoiceNote(senderPhone, reply);
                if (!audioSentImg) await msg.reply(reply);
              } else {
                await msg.reply(reply);
              }
              db.saveMessage(senderPhone, 'user', '[imagen enviada]');
              db.saveMessage(senderPhone, 'assistant', reply);
              db.upsertClient(senderPhone, {});

              // === CLASIFICACIÓN Y ALMACENAMIENTO DE IMAGEN ===
              // Ejecutar en background para no retrasar la respuesta al cliente
              try {
                const classResult = await geminiGenerate('gemini-2.5-flash', [
                  imagePart,
                  'Clasifica esta imagen en una de estas categorías. Responde SOLO con JSON válido, sin markdown:\n{"tipo": "selfie|cedula|foto_arma|doc_incautacion|peticion_formal|comprobante_envio|documento|otro", "descripcion": "descripcion breve de 5-10 palabras"}\n\n- selfie: foto de la cara/rostro de una persona (tipo carnet o selfie)\n- cedula: documento de identidad colombiano (cédula de ciudadanía)\n- foto_arma: foto de un arma traumática, pistola o similar\n- doc_incautacion: acta de incautación policial, orden de decomiso, boleta de retención, acta de aprehensión de policía\n- peticion_formal: derecho de petición, tutela, recurso de apelación, documento legal formal dirigido a una entidad\n- comprobante_envio: guía de envío, tracking de transportadora, recibo de mensajería\n- documento: otro documento escrito (recibo, factura, certificado, etc.)\n- otro: cualquier otra imagen (memes, paisajes, capturas de redes sociales, etc.)'
                ]);
                const classText = classResult.response.text().replace(/```json\n?/g, '').replace(/```/g, '').trim();
                const classData = JSON.parse(classText);
                if (classData.tipo && classData.tipo !== 'otro') {
                  db.saveClientFile(senderPhone, classData.tipo, classData.descripcion || '', media.data, mediaType, 'cliente');
                  console.log(`[IMG-CLASSIFY] 📁 Imagen guardada como '${classData.tipo}' para ${senderPhone}: ${classData.descripcion}`);
                }
              } catch (classErr) {
                console.log(`[IMG-CLASSIFY] No se pudo clasificar imagen: ${classErr.message}`);
              }
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
          const clientProfile = db.getClient(senderPhone);
          const clientFiles = db.getClientFiles ? db.getClientFiles(senderPhone) : [];
          const clientComprobantes = db.getClientComprobantes ? db.getClientComprobantes(senderPhone) : [];
          let documentSummary = '';
          if (clientFiles.length > 0) {
            documentSummary += clientFiles.map(f => `- 📎 ${f.tipo.toUpperCase()}: ${f.descripcion} (${new Date(f.created_at).toLocaleDateString('es-CO')})`).join('\n');
          }
          if (clientComprobantes.length > 0) {
            documentSummary += (documentSummary ? '\n' : '') + clientComprobantes.map(c => `- 💰 COMPROBANTE: ${c.info || 'sin detalle'} — Estado: ${c.estado} (${new Date(c.created_at).toLocaleDateString('es-CO')})`).join('\n');
          }
          const catalogSent = clientProfile && clientProfile.catalog_sent;
          const systemPrompt = buildSystemPrompt('El cliente envió un mensaje de voz. Continúa la conversación con el contexto previo.', clientMemory, clientProfile, documentSummary, catalogSent, messageBody);

          // Historial previo para mantener contexto
          const geminiHistoryAudio = [];
          for (const h of history) {
            if (h.role === 'system') continue;
            const msgText = (h.message || '').trim();
            if (!msgText) continue; // Saltar mensajes vacíos
            if (h.role === 'admin') {
              geminiHistoryAudio.push({
                role: 'model',
                parts: [{ text: `[ÁLVARO respondió directamente]: ${msgText}` }]
              });
            } else {
              const role = h.role === 'assistant' ? 'model' : 'user';
              geminiHistoryAudio.push({ role, parts: [{ text: msgText }] });
            }
          }
          // Gemini exige que empiece con 'user' y NO tenga roles consecutivos iguales
          while (geminiHistoryAudio.length > 0 && geminiHistoryAudio[0].role !== 'user') geminiHistoryAudio.shift();
          // Merge roles consecutivos iguales (ej: dos 'user' seguidos → uno solo)
          for (let i = geminiHistoryAudio.length - 1; i > 0; i--) {
            if (geminiHistoryAudio[i].role === geminiHistoryAudio[i - 1].role) {
              geminiHistoryAudio[i - 1].parts[0].text += '\n' + geminiHistoryAudio[i].parts[0].text;
              geminiHistoryAudio.splice(i, 1);
            }
          }

          const audioPart = { inlineData: { data: media.data, mimeType: audioMime } };
          const textPart = 'El cliente te ha enviado este mensaje de voz. Escúchalo y respóndele directamente. IMPORTANTE: NO transcribas el audio ni repitas lo que dice. Tu única tarea es dar la respuesta correspondiente como asesor comercial.';

          const audioModel = getGenAI().getGenerativeModel({
            model: 'gemini-2.5-pro',
            systemInstruction: systemPrompt,
            safetySettings: SAFETY_SETTINGS,
          });
          const audioChat = audioModel.startChat({ history: geminiHistoryAudio });
          const audioResult = await audioChat.sendMessage([audioPart, textPart]);
          let reply = audioResult.response.text();
          // Detectar tag de audio y limpiar etiquetas internas
          const quiereAudioPtt = /\[?\s*RESPONDER[_\s]*CON[_\s]*AUDIO\s*\]?/i.test(reply);
          reply = cleanBotTags(reply);
          if (quiereAudioPtt) {
            const audioSentPtt = await tts.sendVoiceNote(senderPhone, reply);
            if (!audioSentPtt) await msg.reply(reply);
          } else {
            await msg.reply(reply);
          }

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
          const clientProfile = db.getClient(senderPhone);
          const clientFiles = db.getClientFiles ? db.getClientFiles(senderPhone) : [];
          const clientComprobantes = db.getClientComprobantes ? db.getClientComprobantes(senderPhone) : [];
          let documentSummary = '';
          if (clientFiles.length > 0) {
            documentSummary += clientFiles.map(f => `- 📎 ${f.tipo.toUpperCase()}: ${f.descripcion} (${new Date(f.created_at).toLocaleDateString('es-CO')})`).join('\n');
          }
          if (clientComprobantes.length > 0) {
            documentSummary += (documentSummary ? '\n' : '') + clientComprobantes.map(c => `- 💰 COMPROBANTE: ${c.info || 'sin detalle'} — Estado: ${c.estado} (${new Date(c.created_at).toLocaleDateString('es-CO')})`).join('\n');
          }
          const catalogSent = clientProfile && clientProfile.catalog_sent;
          const systemPrompt = buildSystemPrompt('El cliente envió un PDF. Continúa la conversación con el contexto previo.', clientMemory, clientProfile, documentSummary, catalogSent, messageBody);

          // Historial previo para mantener contexto
          const geminiHistoryPdf = history
            .filter(h => h.role !== 'system' && h.message && h.message.trim().length > 0)
            .map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.message.trim() }] }));
          while (geminiHistoryPdf.length > 0 && geminiHistoryPdf[0].role !== 'user') geminiHistoryPdf.shift();

          // Gemini recibe el PDF como inlineData (igual que imágenes) — lee texto e imágenes del PDF
          const pdfPart = { inlineData: { data: media.data, mimeType: 'application/pdf' } };
          const textPart = msg.body
            ? `El cliente envió este PDF llamado "${media.filename || 'documento.pdf'}" y escribió: "${msg.body}". Analízalo y responde.`
            : `El cliente envió este PDF llamado "${media.filename || 'documento.pdf'}". Analízalo y responde de forma útil según el contexto de la conversación.`;

          const pdfModel = getGenAI().getGenerativeModel({
            model: 'gemini-2.5-pro',
            systemInstruction: systemPrompt,
            safetySettings: SAFETY_SETTINGS,
          });
          const pdfChat = pdfModel.startChat({ history: geminiHistoryPdf });
          const pdfResult = await pdfChat.sendMessage([pdfPart, textPart]);
          let reply = pdfResult.response.text();
          // Detectar tag de audio y limpiar etiquetas internas
          const quiereAudioPdf = /\[?\s*RESPONDER[_\s]*CON[_\s]*AUDIO\s*\]?/i.test(reply);
          reply = cleanBotTags(reply);
          if (quiereAudioPdf) {
            const audioSentPdf = await tts.sendVoiceNote(senderPhone, reply);
            if (!audioSentPdf) await msg.reply(reply);
          } else {
            await msg.reply(reply);
          }

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



// ARRANCAR EL BOT
// ============================================
console.log('\n[BOT] Iniciando bot empresarial...');
console.log(`[BOT] Negocio: ${CONFIG.businessName}`);
console.log(`[BOT] Modo: ${CONFIG.mode}`);
console.log('[BOT] Conectando a WhatsApp...\n');




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
            // sendPromoImage eliminado — imágenes de promo se manejan en el flujo principal
            console.log(`[RETRY QUEUE] 📢 Bot ofreció el club a ${senderPhone}`);
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
