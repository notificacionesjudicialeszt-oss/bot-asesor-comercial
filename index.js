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
const { Client, LocalAuth } = require('whatsapp-web.js');
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
client.on('ready', () => {
  console.log('\n============================================');
  console.log(`[BOT] ¡${CONFIG.businessName} está en línea!`);
  console.log(`[BOT] Modo: ${CONFIG.mode}`);
  console.log(`[BOT] Línea principal: ${CONFIG.businessPhone}`);
  console.log(`[BOT] Empleados activos: ${employees.length}`);
  console.log(`[BOT] Auditores: ${CONFIG.auditors.length > 0 ? CONFIG.auditors.join(', ') : 'ninguno'}`);
  console.log('============================================\n');
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
    // Ignorar mensajes de grupos si está configurado
    const chat = await msg.getChat();
    if (CONFIG.ignoreGroups && chat.isGroup) return;

    // Ignorar mensajes del propio bot
    if (msg.fromMe) return;

    // Ignorar mensajes de status/broadcast
    if (msg.from === 'status@broadcast') return;

    const senderPhone = msg.from.replace('@c.us', '');
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

      const mediaResponses = {
        'ptt': '🎙️ ¡Gracias por tu mensaje de voz! Por el momento solo puedo leer mensajes de *texto*. ¿Podrías escribirme tu consulta? Así te puedo ayudar mejor. 😊',
        'audio': '🎵 ¡Gracias por el audio! Por ahora solo proceso mensajes de *texto*. ¿Podrías escribirme lo que necesitas?',
        'image': '📷 ¡Gracias por la imagen! Por el momento solo puedo leer *texto*. Si tienes alguna consulta, escríbemela y con gusto te ayudo.',
        'video': '🎥 ¡Gracias por el video! Actualmente solo proceso mensajes de *texto*. ¿En qué puedo ayudarte?',
        'sticker': '', // No responder a stickers
        'document': '📄 ¡Gracias por el documento! Por ahora solo puedo leer mensajes de *texto*. ¿Podrías escribirme tu consulta?',
      };

      const response = mediaResponses[msg.type] || '📎 ¡Gracias! Por el momento solo puedo leer mensajes de *texto*. ¿Podrías escribirme tu consulta?';

      if (response) {
        await msg.reply(response);
      }
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

    // Guardar como contacto de WhatsApp
    try {
      const contactId = await client.getContactById(senderPhone + '@c.us');
      // whatsapp-web.js no tiene API directa para "agregar contacto",
      // pero el chat se crea automáticamente al enviar/recibir mensajes.
      // Lo registramos en la DB que es nuestro CRM real.
      if (CONFIG.debug) {
        console.log(`[DEBUG] Contacto registrado en CRM: ${profileName} (${senderPhone})`);
      }
    } catch (err) {
      // No es crítico, el CRM ya lo tiene
      if (CONFIG.debug) {
        console.log(`[DEBUG] Contacto creado solo en CRM (no se pudo verificar en WhatsApp)`);
      }
    }
  } else if (profileName && !existingClient.name) {
    // Ya existía pero sin nombre → actualizar con nombre de perfil
    db.upsertClient(senderPhone, { name: profileName });
  }

  // 3. Guardar mensaje del cliente
  db.saveMessage(senderPhone, 'user', messageBody);

  // 4. Obtener historial para contexto
  const history = db.getConversationHistory(senderPhone, 10);

  // 5. Simular escritura
  await chat.sendStateTyping();

  // 6. Detectar intención de compra/cotización
  const wantsHuman = detectHandoffIntent(messageBody);

  if (wantsHuman) {
    // --- DERIVAR A EMPLEADO ---
    await handleHandoff(msg, senderPhone, messageBody, history);
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
    }
  }
}

// ============================================
// DETECCIÓN DE INTENCIÓN DE DERIVACIÓN
// ============================================
function detectHandoffIntent(message) {
  const lowerMessage = message.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar acentos para comparar
    .replace(/[¿?¡!.,;:()]/g, '');

  // Frases de COMPRA / COTIZACIÓN
  const buyKeywords = [
    'quiero comprar', 'quiero cotizar', 'cuanto cuesta', 'cuanto vale',
    'disponibilidad', 'tienen en stock', 'quiero hacer un pedido',
    'me interesa comprar', 'cotizacion', 'hacer pedido',
    'quiero ordenar', 'como compro', 'como lo compro',
    'metodo de pago', 'forma de pago', 'medios de pago',
    'quiero pagar', 'nequi', 'daviplata', 'bancolombia',
    'envio', 'envios', 'hacen envios', 'hacen envio',
    'lo quiero', 'me lo llevo', 'lo llevo',
    'comprar', // palabra sola
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

  const detected = buyKeywords.some(kw => lowerMessage.includes(kw)) ||
         humanKeywords.some(kw => lowerMessage.includes(kw));

  if (detected && CONFIG.debug) {
    console.log(`[DEBUG] 🚨 Intención de derivación detectada en: "${message}"`);
  }

  return detected;
}

// ============================================
// DERIVACIÓN A EMPLEADO (HANDOFF)
// ============================================
async function handleHandoff(msg, clientPhone, triggerMessage, history) {
  console.log(`[HANDOFF] Iniciando derivación para ${clientPhone}...`);

  // Asignar empleado (round-robin)
  const assignment = router.assignClient(clientPhone);

  if (!assignment) {
    console.log(`[HANDOFF] ❌ No hay empleados disponibles`);
    await msg.reply(
      'Lo siento, en este momento no tenemos asesores disponibles. ' +
      'Por favor intenta más tarde o escríbenos en nuestro horario de atención.'
    );
    return;
  }

  console.log(`[HANDOFF] Empleado asignado: ${assignment.employee_name} (${assignment.employee_phone})`);

  // Obtener datos del cliente
  const clientInfo = db.getClient(clientPhone);
  const clientName = clientInfo?.name || 'Cliente';
  const clientLink = `https://wa.me/${clientPhone}`;

  // --- MENSAJE PARA EL CLIENTE ---
  const handoffMsgToClient =
    `¡Gracias por tu interés! 🎯\n\n` +
    `Te voy a comunicar con *${assignment.employee_name}*, quien te atenderá personalmente.\n\n` +
    `${assignment.employee_name} se comunicará contigo pronto. ` +
    `También puedes escribirle directamente:\n` +
    `📱 https://wa.me/${assignment.employee_phone}\n\n` +
    `_${CONFIG.businessName} - Atención personalizada_`;

  await msg.reply(handoffMsgToClient);

  // Guardar en historial
  db.saveMessage(clientPhone, 'system', `[DERIVADO a ${assignment.employee_name}]`);

  // Actualizar estado del cliente
  db.upsertClient(clientPhone, { status: 'assigned' });

  // --- MENSAJE PARA EL EMPLEADO ---
  const context = summarizeConversation(history);

  const notification =
    `🔔 *Nueva asignación de cliente*\n\n` +
    `👤 *Cliente:* ${clientName}\n` +
    `📱 *Contactar:* ${clientLink}\n\n` +
    `💬 *Requerimiento del cliente:*\n` +
    `"${triggerMessage}"\n\n` +
    `📋 *Historial de la conversación:*\n${context}\n\n` +
    `👆 _Haz clic en el link para contactar al cliente._`;

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

  // Palabras que indican que SÍ busca un producto
  const productKeywords = [
    'rifle', 'rifles', 'pistola', 'pistolas', 'carabina',
    'pcp', 'co2', 'resorte', 'springer', 'nitro',
    'mira', 'miras', 'telescop', 'scope', 'punto rojo', 'red dot',
    'balin', 'balines', 'municion', 'munición', 'pellet', 'diabolo', 'slug',
    'funda', 'estuche', 'maleta',
    'bomba', 'compresor', 'tanque',
    'bipode', 'bipod', 'soporte',
    'limpieza', 'mantenimiento', 'aceite',
    'blanco', 'diana', 'target',
    'cuchillo', 'navaja',
    'linterna', 'gorra', 'gafas',
    'calibre', '4.5', '5.5', '6.35', '.177', '.22', '.25',
    'gamo', 'hatsan', 'snowpeak', 'artemis', 'apolo', 'jsb',
    'arma', 'armas', 'aire', 'comprimido',
    'producto', 'productos', 'catalogo', 'catálogo',
    'qué tienen', 'que tienen', 'qué venden', 'que venden',
    'qué manejan', 'que manejan', 'mostrar', 'opciones',
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

    // 2. Construir prompt CON o SIN contexto de productos
    const systemPrompt = buildSystemPrompt(productContext);
    const messages = buildMessages(history, message);

    // 3. Llamar a Claude
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages
      },
      {
        headers: {
          'x-api-key': CONFIG.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      }
    );

    return response.data.content[0].text;
  } catch (error) {
    console.error('[CLAUDE] Error:', error.response?.data || error.message);
    return 'Disculpa, tuve un problema técnico. ¿Podrías repetir tu consulta?';
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
function buildSystemPrompt(productContext) {
  // Resumen general del catálogo (siempre va, es corto)
  const catalogSummary = search.getCatalogSummary();

  return `Eres el asistente virtual de "${CONFIG.businessName}", una tienda especializada en rifles de aire comprimido, accesorios, munición y más.

TU ROL:
- Atender clientes por WhatsApp de forma amable y profesional
- Responder preguntas sobre productos usando ÚNICAMENTE la información proporcionada abajo
- Ayudar al cliente a encontrar lo que busca y resolver sus dudas
- Mantener respuestas cortas y claras (máximo 2-3 párrafos para WhatsApp)

${catalogSummary}

${productContext}

INFORMACIÓN GENERAL DEL NEGOCIO:
${JSON.stringify(knowledgeBase.negocio || {}, null, 2)}

PREGUNTAS FRECUENTES:
${JSON.stringify(knowledgeBase.preguntas_frecuentes || {}, null, 2)}

REGLAS IMPORTANTES:
1. SOLO menciona productos que aparecen en "PRODUCTOS RELEVANTES" arriba. NUNCA inventes productos.
2. Puedes mencionar los precios que aparecen en la lista. Son precios reales del catálogo.
3. Si el cliente pide algo que NO está en los productos mostrados, di: "Déjame verificar, ¿podrías darme más detalles de lo que buscas?"
4. Si el cliente quiere comprar, cotizar, o hablar con un humano, dile: "¡Con gusto! Escríbeme 'quiero comprar' o 'hablar con asesor' y te conecto con un experto de inmediato."
5. Responde siempre en español
6. Sé amigable pero profesional
7. Incluye el link del producto cuando lo menciones para que el cliente pueda verlo
8. Si no hay productos relevantes, presenta las categorías disponibles y pregunta qué busca

⚠️ REGLA CRÍTICA - DERIVACIONES:
- NUNCA simules una derivación o transferencia tú mismo. NO escribas cosas como "[TRANSFERIR A AGENTE HUMANO]", "Te estoy redirigiendo...", ni resúmenes para el asesor.
- Tú NO tienes la capacidad de transferir clientes. Eso lo hace el sistema automáticamente cuando el cliente escribe ciertas frases.
- Si el cliente quiere comprar o hablar con alguien, simplemente dile que escriba "quiero comprar" o "hablar con asesor" para que el sistema lo conecte automáticamente.
- NUNCA generes bloques de texto con formato de transferencia, resúmenes para asesores, o simulaciones de derivación. Eso confunde al cliente.`;
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

  } else if (cmd === '!clients' || cmd === '!clientes') {
    const clients = db.getAllClients();
    if (clients.length === 0) {
      await msg.reply('No hay clientes registrados aún.');
      return;
    }

    let list = `📋 *Últimos clientes:*\n\n`;
    const recent = clients.slice(0, 10);
    recent.forEach((c, i) => {
      list += `${i + 1}. ${c.name || 'Sin nombre'} - ${c.phone} [${c.status}]\n`;
    });
    list += `\n_Total: ${clients.length} clientes_`;

    await msg.reply(list);

  } else if (cmd === '!help' || cmd === '!ayuda') {
    const help = `🤖 *Comandos de Admin:*\n\n` +
      `!stats - Ver estadísticas\n` +
      `!clients - Ver últimos clientes\n` +
      `!help - Ver esta ayuda\n`;
    await msg.reply(help);

  } else {
    await msg.reply('Comando no reconocido. Escribe !help para ver los comandos disponibles.');
  }
}

// ============================================
// ARRANCAR EL BOT
// ============================================
console.log('\n[BOT] Iniciando bot empresarial...');
console.log(`[BOT] Negocio: ${CONFIG.businessName}`);
console.log(`[BOT] Modo: ${CONFIG.mode}`);
console.log('[BOT] Conectando a WhatsApp...\n');

client.initialize();
