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
    const messageBody = msg.body.trim();

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
    await handleClientMessage(msg, senderPhone, messageBody, chat);

  } catch (error) {
    console.error('[BOT] Error procesando mensaje:', error);
  }
});

// ============================================
// FLUJO DE CLIENTE
// ============================================
async function handleClientMessage(msg, senderPhone, messageBody, chat) {
  // 1. Registrar/actualizar cliente en CRM
  const clientData = db.upsertClient(senderPhone);

  // 2. Guardar mensaje del cliente
  db.saveMessage(senderPhone, 'user', messageBody);

  // 3. Obtener historial para contexto
  const history = db.getConversationHistory(senderPhone, 10);

  // 4. Simular escritura
  await chat.sendStateTyping();

  // 5. Detectar intención de compra/cotización
  const wantsHuman = detectHandoffIntent(messageBody);

  if (wantsHuman) {
    // --- DERIVAR A EMPLEADO ---
    await handleHandoff(msg, senderPhone, history);
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
// DETECCIÓN DE INTENCIÓN DE COMPRA
// ============================================
function detectHandoffIntent(message) {
  const keywords = [
    'quiero comprar', 'quiero cotizar', 'precio', 'cuánto cuesta',
    'cuanto cuesta', 'disponibilidad', 'tienen en stock',
    'quiero hablar con alguien', 'quiero un asesor', 'hablar con humano',
    'necesito ayuda personalizada', 'quiero hacer un pedido',
    'me interesa comprar', 'cotización', 'cotizacion',
    'quiero ordenar', 'cómo compro', 'como compro',
    'método de pago', 'metodo de pago', 'envío', 'envio',
    'quiero pagar', 'transferencia'
  ];

  const lowerMessage = message.toLowerCase();
  return keywords.some(keyword => lowerMessage.includes(keyword));
}

// ============================================
// DERIVACIÓN A EMPLEADO (HANDOFF)
// ============================================
async function handleHandoff(msg, clientPhone, history) {
  // Asignar empleado (round-robin)
  const assignment = router.assignClient(clientPhone);

  if (!assignment) {
    await msg.reply(
      'Lo siento, en este momento no tenemos asesores disponibles. ' +
      'Por favor intenta más tarde o escríbenos en nuestro horario de atención.'
    );
    return;
  }

  // Mensaje para el cliente
  const handoffMsg = router.getHandoffMessage(assignment, CONFIG.businessName);
  await msg.reply(handoffMsg);

  // Guardar en historial
  db.saveMessage(clientPhone, 'system', `[DERIVADO a ${assignment.employee_name}]`);

  // Actualizar estado del cliente
  db.upsertClient(clientPhone, { status: 'assigned' });

  // Notificar al empleado
  const context = summarizeConversation(history);
  const notification = router.getEmployeeNotification(clientPhone, db.getClient(clientPhone).name, context);

  try {
    // Enviar mensaje al WhatsApp del empleado
    const employeeChatId = assignment.employee_phone + '@c.us';
    await client.sendMessage(employeeChatId, notification);
    console.log(`[BOT] Notificación enviada a ${assignment.employee_name}`);
  } catch (error) {
    console.error(`[BOT] Error notificando a empleado:`, error.message);
  }
}

// Resumir conversación para dar contexto al empleado
function summarizeConversation(history) {
  if (history.length === 0) return 'Sin conversación previa.';

  const lastMessages = history.slice(-5);
  return lastMessages
    .map(h => `${h.role === 'user' ? '👤 Cliente' : '🤖 Bot'}: ${h.message.substring(0, 150)}`)
    .join('\n');
}

// ============================================
// CLAUDE API (Modo Directo) + Búsqueda Inteligente
// ============================================
async function getClaudeResponse(clientPhone, message, history) {
  try {
    // 1. BÚSQUEDA INTELIGENTE: encontrar productos relevantes
    const searchResult = search.searchProducts(message);
    const productContext = search.formatForPrompt(searchResult);

    if (CONFIG.debug) {
      console.log(`[DEBUG] Búsqueda: ${searchResult.keywords.join(', ')} → ${searchResult.products.length} productos`);
    }

    // 2. Construir prompt CON el contexto de productos relevantes
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
- Cuando el cliente quiera comprar, cotizar o necesite atención personalizada, indicarle que lo conectarás con un asesor humano
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
4. Si quieren comprar o cotizar, di: "¡Perfecto! Te conecto con uno de nuestros asesores para que te atienda personalmente."
5. Responde siempre en español
6. Sé amigable pero profesional
7. Incluye el link del producto cuando lo menciones para que el cliente pueda verlo
8. Si no hay productos relevantes, presenta las categorías disponibles y pregunta qué busca`;
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
