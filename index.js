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

const db = require('./db');
const router = require('./router');
const search = require('./search');

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
const RATE_LIMIT_MAX = 6;      // más de 6 mensajes...
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
      '--disable-gpu',
      '--no-zygote'
    ]
  }
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
});

// Error de autenticación
client.on('auth_failure', (msg) => {
  console.error('[BOT] Error de autenticación:', msg);
});

// Desconexión
client.on('disconnected', (reason) => {
  console.log('[BOT] Desconectado:', reason);
});

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

    // 5. ANTI-LOOP: Si un número manda más de 10 msgs en 5 min, es bot
    if (!global._msgTracker) global._msgTracker = {};
    const now = Date.now();
    const tracker = global._msgTracker;
    if (!tracker[senderRaw]) tracker[senderRaw] = [];
    tracker[senderRaw].push(now);
    // Limpiar mensajes viejos (más de 5 min)
    tracker[senderRaw] = tracker[senderRaw].filter(t => now - t < 300000);
    if (tracker[senderRaw].length > 10) {
      console.log(`[BOT] 🚫 ANTI-LOOP: ${senderRaw} (${chat.name || 'sin nombre'}) — ${tracker[senderRaw].length} msgs en 5 min. Ignorando.`);
      return;
    }

    const senderPhone = msg.from.replace('@c.us', '');
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

            // Obtener historial y memoria del cliente
            const history = db.getConversationHistory(senderPhone, 6);
            const clientMemory = db.getClientMemory(senderPhone);
            const systemPrompt = buildSystemPrompt('El cliente no está preguntando por un producto específico. Responde de forma conversacional.', clientMemory);

            // Construir mensaje con imagen para Claude vision
            const visionMessages = [
              ...buildMessages(history, '').slice(0, -1), // historial sin el último user
              {
                role: 'user',
                content: [
                  {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: mediaType,
                      data: media.data
                    }
                  },
                  {
                    type: 'text',
                    text: msg.body || 'El cliente envió esta imagen.'
                  }
                ]
              }
            ];

            const visionResponse = await axios.post(
              'https://api.anthropic.com/v1/messages',
              {
                model: 'claude-sonnet-4-6',
                max_tokens: 1024,
                system: systemPrompt,
                messages: visionMessages
              },
              {
                headers: {
                  'x-api-key': CONFIG.apiKey,
                  'anthropic-version': '2023-06-01',
                  'content-type': 'application/json'
                },
                timeout: 30000
              }
            );

            const reply = visionResponse.data.content[0].text;
            await msg.reply(reply);

            // Guardar en historial CRM
            db.saveMessage(senderPhone, 'user', '[imagen enviada]');
            db.saveMessage(senderPhone, 'assistant', reply);
            db.upsertClient(senderPhone, {});
            console.log(`[IMG] 🖼️ Imagen procesada para ${senderPhone}`);
          }
        } catch (imgErr) {
          console.error(`[IMG] ❌ Error procesando imagen: ${imgErr.message}`);
          await msg.reply('Vi tu imagen pero tuve un problema al procesarla. ¿Me puedes contar qué necesitas?');
        }
        return;
      }

      // Audios/videos/documentos: pedir que escriban
      const mediaResponses = {
        'ptt': '🎙️ Los mensajes de voz no los proceso por ahora. ¿Podrías escribirme tu consulta?',
        'audio': '🎵 No proceso audios aún. ¿Me escribes lo que necesitas?',
        'video': '🎥 No proceso videos. ¿En qué te puedo ayudar?',
        'document': '📄 Recibí tu documento pero no puedo leerlo. ¿Me escribes qué necesitas?',
      };

      const response = mediaResponses[msg.type] || null;
      if (response) await msg.reply(response);
      return;
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
    await handleClientMessage(msg, senderPhone, messageBody, chat, msg);

  } catch (error) {
    console.error('[BOT] Error procesando mensaje:', error);
  }
});

// ============================================
// FLUJO DE CLIENTE
// ============================================
async function handleClientMessage(msg, senderPhone, messageBody, chat, rawMsg) {
  // 1. Obtener nombre del perfil de WhatsApp
  let profileName = '';
  try {
    const contact = await rawMsg.getContact();
    profileName = contact.pushname || contact.name || contact.shortName || '';
    if (CONFIG.debug) {
      console.log(`[DEBUG] Perfil WhatsApp: "${profileName}" (${senderPhone})`);
    }
  } catch (err) {
    console.error('[BOT] Error obteniendo contacto:', err.message);
  }

  // 2. Registrar/actualizar cliente en CRM (con nombre de perfil)
  const existingClient = db.getClient(senderPhone);
  const isNewClient = !existingClient;

  if (isNewClient) {
    // Cliente nuevo → crear con nombre de perfil
    db.upsertClient(senderPhone, { name: profileName });
    console.log(`[BOT] 🆕 Nuevo cliente: "${profileName}" (${senderPhone})`);
    saveContactToVCF(senderPhone, profileName);

  } else if (profileName && !existingClient.name) {
    db.upsertClient(senderPhone, { name: profileName });
    saveContactToVCF(senderPhone, profileName);
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

  if (isPostventa) {
    // --- POST-VENTA: marcar en panel silenciosamente y seguir con IA ---
    await handleHandoff(msg, senderPhone, messageBody, history, 'postventa');
  } else if (wantsHuman && hasEnoughHistory || wantsHumanExplicit) {
    // --- LEAD CALIENTE: marcar en panel silenciosamente y seguir con IA ---
    await handleHandoff(msg, senderPhone, messageBody, history, 'venta');
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
      await msg.reply(response);

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
            await msg.reply(media);
            console.log(`[BOT] 🖼️ Imagen Club ZT enviada a ${senderPhone}`);
          }
        } catch (imgErr) {
          console.error('[BOT] Error enviando imagen Club ZT:', imgErr.message);
        }
      }

      // Detectar confirmación de pago y actualizar estado automáticamente
      const pagoConfirmado = responseLower.includes('comprobante') && (
        responseLower.includes('recib') || responseLower.includes('confirm') || responseLower.includes('verific')
      ) || (
        responseLower.includes('pago') && (responseLower.includes('recib') || responseLower.includes('confirm'))
      );
      if (pagoConfirmado) {
        const clienteActual = db.getClient(senderPhone);
        const memoriaBaja = (clienteActual?.memory || '').toLowerCase();
        const mensajeBajo = messageBody.toLowerCase();
        const respuestaBaja = responseLower;
        // Buscar en mensaje, memoria Y respuesta del bot si hay contexto de club/carnet
        const esClub = mensajeBajo.includes('club') ||
                       mensajeBajo.includes('afiliaci') ||
                       mensajeBajo.includes('carnet') ||
                       memoriaBaja.includes('club') ||
                       memoriaBaja.includes('afiliaci') ||
                       memoriaBaja.includes('carnet') ||
                       respuestaBaja.includes('carnet') ||
                       respuestaBaja.includes('afiliaci') ||
                       respuestaBaja.includes('club zt') ||
                       // Montos típicos del club (100k, 150k, 200k) vs armas (más de 500k)
                       ['150', '170', '100', '200'].some(m => mensajeBajo.includes(m) && !mensajeBajo.includes('500') && !mensajeBajo.includes('600') && !mensajeBajo.includes('700') && !mensajeBajo.includes('800'));
        const nuevoStatus = esClub ? 'carnet_pendiente' : 'despacho_pendiente';
        db.upsertClient(senderPhone, { status: nuevoStatus });
        console.log(`[BOT] 💰 Pago detectado → estado: ${nuevoStatus} para ${senderPhone}`);
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

MEMORIA ACTUAL DEL CLIENTE:
${currentMemory || '(Cliente nuevo, sin memoria previa)'}

ÚLTIMA INTERACCIÓN:
- Cliente dijo: "${userMessage}"
- Bot respondió: "${botResponse.substring(0, 300)}"

INSTRUCCIONES:
Genera una ficha actualizada del cliente en máximo 6 líneas. Incluye SOLO datos útiles para ventas:
- Nombre (si lo mencionó)
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

    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{ role: 'user', content: memoryPrompt }]
      },
      {
        headers: {
          'x-api-key': CONFIG.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      }
    );

    const newMemory = response.data.content[0].text.trim();

    // Solo actualizar si cambió y no está vacío
    if (newMemory && newMemory !== currentMemory) {
      db.updateClientMemory(clientPhone, newMemory);
      if (CONFIG.debug) {
        console.log(`[MEMORY] ✅ Memoria actualizada para ${clientPhone}`);
      }
    }
  } catch (error) {
    // Usar modelo correcto si haiku falla
    if (error.response?.status === 400 || error.response?.status === 404) {
      try {
        const currentMemory = db.getClientMemory(clientPhone);
        // Fallback: generar memoria simple sin API
        const simpleMemory = generateSimpleMemory(currentMemory, userMessage);
        if (simpleMemory !== currentMemory) {
          db.updateClientMemory(clientPhone, simpleMemory);
        }
      } catch (e) { /* silencioso */ }
    }
    if (CONFIG.debug) {
      console.error('[MEMORY] Error:', error.response?.data?.error?.message || error.message);
    }
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

  const postventaKeywords = [
    // Carnet
    'carnet', 'carne', 'certificado', 'qr', 'carnet digital',
    'mi carnet', 'el carnet', 'actualizar carnet', 'estado del carnet',
    'cuando llega el carnet', 'cuando me mandan el carnet',
    // Despacho / envío
    'despacho', 'envio', 'envío', 'pedido', 'paquete', 'domicilio',
    'cuando llega', 'cuando me llega', 'cuando me mandan', 'ya pague',
    'ya pague y', 'hice el pago', 'realize el pago', 'realice el pago',
    'confirmar pago', 'comprobante', 'ya envie el comprobante',
    'cuando me despachan', 'numero de guia', 'número de guía', 'guia',
    // Cambio de arma en carnet
    'cambio de arma', 'cambiar arma', 'actualizar arma', 'nueva arma',
    'cambiar el serial', 'nuevo serial', 'cambiar modelo',
    // Renovación
    'renovar', 'renovacion', 'renovación', 'vencio', 'venció', 'vencimiento',
    'ya se vencio', 'se me vencio', 'vence', 'vencio mi',
    // Soporte general post-pago
    'ya soy afiliado', 'ya me afilie', 'ya me afilié', 'soy miembro',
    'acceso al grupo', 'no me han agregado', 'no recibi', 'no recibí',
    'no me llegó', 'no me llego', 'no he recibido',
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

  // --- SIN MENSAJE AL CLIENTE ---
  // El cliente NO sabe que fue asignado — el bot sigue respondiendo con IA normalmente
  // Álvaro ve el cliente en el panel y decide cuándo intervenir personalmente

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

  // Enviar notificación al empleado
  const employeeChatId = assignment.employee_phone + '@c.us';

  try {
    // Verificar que el número del empleado existe en WhatsApp
    const numberId = await client.getNumberId(assignment.employee_phone);
    console.log(`[HANDOFF] Número verificado: ${JSON.stringify(numberId)}`);

    if (!numberId) {
      console.error(`[HANDOFF] ❌ El número ${assignment.employee_phone} NO está registrado en WhatsApp`);
      return;
    }

    // Usar el _serialized que devuelve getNumberId (formato correcto)
    const verifiedChatId = numberId._serialized;
    console.log(`[HANDOFF] Enviando notificación a ${verifiedChatId}...`);

    await client.sendMessage(verifiedChatId, notification);
    console.log(`[HANDOFF] ✅ Notificación enviada a ${assignment.employee_name} (${assignment.employee_phone})`);
  } catch (error) {
    console.error(`[HANDOFF] ❌ Error enviando a empleado:`, error.message);
    console.error(`[HANDOFF] Stack:`, error.stack);

    // Fallback: intentar con formato directo @c.us
    try {
      console.log(`[HANDOFF] Intentando fallback con ${employeeChatId}...`);
      await client.sendMessage(employeeChatId, notification);
      console.log(`[HANDOFF] ✅ Fallback enviado correctamente`);
    } catch (retryError) {
      console.error(`[HANDOFF] ❌ Fallback también falló:`, retryError.message);
    }
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
// CLAUDE API (Modo Directo) + Búsqueda Inteligente
// ============================================
async function getClaudeResponse(clientPhone, message, history) {
  try {
    // 1. Detectar si el mensaje necesita búsqueda de productos
    let productContext = '';

    if (needsProductSearch(message)) {
      const searchResult = search.searchProducts(message);
      productContext = search.formatForPrompt(searchResult);

      if (CONFIG.debug) {
        console.log(`[DEBUG] 🔍 Búsqueda activada: ${searchResult.keywords.join(', ')} → ${searchResult.products.length} productos`);
      }
    } else {
      // Solo enviar resumen general, sin buscar productos
      productContext = 'El cliente no está preguntando por un producto específico. Responde de forma conversacional.';

      if (CONFIG.debug) {
        console.log(`[DEBUG] 💬 Conversación general, sin búsqueda de productos`);
      }
    }

    // 2. Obtener memoria del cliente para personalizar
    const clientMemory = db.getClientMemory(clientPhone);

    // 3. Construir prompt CON o SIN contexto de productos + memoria
    const systemPrompt = buildSystemPrompt(productContext, clientMemory);
    const messages = buildMessages(history, message);

    // 3. Llamar a Claude con reintentos
    const MAX_RETRIES = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await axios.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            system: systemPrompt,
            messages: messages
          },
          {
            headers: {
              'x-api-key': CONFIG.apiKey,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json'
            },
            timeout: 30000 // 30 segundos de timeout
          }
        );

        return response.data.content[0].text;
      } catch (retryError) {
        lastError = retryError;
        const status = retryError.response?.status;
        const errorMsg = retryError.response?.data?.error?.message || retryError.message;
        console.error(`[CLAUDE] ⚠️ Intento ${attempt}/${MAX_RETRIES} falló (status: ${status || 'N/A'}): ${errorMsg}`);

        // Si es error 4xx (excepto 429 rate limit), no reintentar
        if (status && status >= 400 && status < 500 && status !== 429) break;

        // Esperar antes de reintentar (backoff exponencial)
        if (attempt < MAX_RETRIES) {
          const wait = attempt * 2000; // 2s, 4s
          console.log(`[CLAUDE] ⏳ Reintentando en ${wait / 1000}s...`);
          await new Promise(r => setTimeout(r, wait));
        }
      }
    }

    // Si todos los intentos fallaron
    const finalStatus = lastError?.response?.status;
    const finalMsg = lastError?.response?.data?.error?.message || lastError?.message;
    console.error(`[CLAUDE] ❌ Falló después de ${MAX_RETRIES} intentos. Status: ${finalStatus || 'N/A'}, Error: ${finalMsg}`);
    return 'Disculpa, estoy teniendo un problema momentáneo. Dame unos segundos e inténtalo de nuevo. 🙏';
  } catch (error) {
    console.error('[CLAUDE] Error general:', error.message);
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
✅ Carpeta Jurídica Digital 2026 — 30+ documentos listos para usar el día que te paren
✅ Simulacros de requisa — Qué decir, qué callar, cómo actuar
✅ Descuentos en munición (recuperas tu inversión en la primera caja):
   • Oskurzan Nacional: $120.000 (precio público: $150.000)
   • Oskurzan Importada: $130.000 (precio público: $180.000)
   • Rubber Ball Importada: $180.000 (precio público: $220.000)
✅ Comunidad de 500+ portadores — Red nacional, respaldo inmediato
✅ Certificado digital con QR — Validación profesional por 1 año
✅ Acceso a campo de tiro en Bogotá (Suba - La Conejera) — fines de semana, solo con reserva
   🎯 Primera clase con afiliación: $90.000 (incluye instructor, parte teórica y práctica)
   📌 El afiliado debe llevar: su arma, munición, gafas de seguridad y tapaoídos
→ Te ahorras hasta $50.000 por caja de munición. Y $2 millones en abogados si algo sale mal.

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
🤖 Asesor Legal IA 24/7 por 6 meses directo en tu WhatsApp:
   → Responde en 10 segundos con leyes exactas
   → Decreto 2535 Art. 11, Ley 2197/2022 Art. 28, Código Penal Art. 416
   → Cuando el policía esté frente a ti, citas la ley exacta y el policía retrocede
   → Sistema MCP + RAG — 100% verificado
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

⚠️ FLUJO OBLIGATORIO CUANDO EL CLIENTE CONFIRMA PAGO DE AFILIACIÓN AL CLUB:
Cuando el cliente envíe el comprobante de pago de la afiliación al Club ZT, DEBES hacer lo siguiente en este orden exacto:
1. Agradece el pago calurosamente y confirma que fue recibido.
2. Dile que para generar su carnet digital necesitas los siguientes datos:
   📋 *Datos para tu Carnet Digital Club ZT:*
   1. Nombre completo
   2. Número de cédula
   3. Teléfono de contacto
   4. Marca del arma
   5. Modelo del arma
   6. Número de serial del arma
   7. 📸 Foto de frente (selfie clara, sin gafas de sol, buena iluminación)
3. Dile que en cuanto tengas esos datos, el carnet estará listo en menos de 24 horas.
4. NUNCA marques el proceso como terminado hasta que hayas recibido TODOS los datos y la foto.

⚠️ FLUJO OBLIGATORIO CUANDO EL CLIENTE CONFIRMA PAGO DE UN PRODUCTO (arma/munición):
Cuando el cliente envíe el comprobante de pago de un producto físico (pistola, munición, accesorios), DEBES hacer lo siguiente:
1. Agradece el pago y confirma que fue recibido.
2. Dile que para procesar el envío necesitas los siguientes datos:
   📦 *Datos de envío:*
   1. Nombre completo
   2. Número de cédula
   3. Teléfono de contacto
   4. Dirección completa (calle, número, barrio, apartamento si aplica)
   5. Ciudad
   6. Departamento
3. Dile que el envío se procesa en 1-2 días hábiles y es discreto y seguro.

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

function buildMessages(history, currentMessage) {
  const messages = [];

  // Agregar historial (solo user/assistant, no system)
  for (const h of history) {
    if (h.role === 'user' || h.role === 'assistant') {
      messages.push({ role: h.role, content: h.message });
    }
  }

  // Agregar mensaje actual
  messages.push({ role: 'user', content: currentMessage });

  return messages;
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
  // Claude genera un texto diferente y fresco cada vez
  const contextos = [
    'Es de mañana, los grupos están empezando el día',
    'Es mediodía, buen momento para recordar la oferta',
    'Es tarde, último push del día para el club',
  ];
  const contextoAleatorio = contextos[Math.floor(Math.random() * contextos.length)];

  try {
    const result = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Eres el community manager de Zona Traumática Colombia.
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
Solo escribe el mensaje, sin explicaciones.`
      }]
    }, {
      headers: {
        'x-api-key': CONFIG.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      timeout: 15000
    });
    return result.data.content[0].text.trim();
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
  const INTERVALO_HORAS = 4;
  const INTERVALO_MS = INTERVALO_HORAS * 60 * 60 * 1000;

  console.log(`[BROADCASTER] 🚀 Iniciado — enviará a grupos cada ${INTERVALO_HORAS} horas`);

  // Primer envío al arrancar
  sendGroupBroadcast();

  // Envíos cada 4 horas
  setInterval(() => {
    sendGroupBroadcast();
  }, INTERVALO_MS);
}

client.initialize();
