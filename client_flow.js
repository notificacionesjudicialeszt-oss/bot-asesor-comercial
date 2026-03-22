// ============================================
// client_flow.js - Flujo de cliente, respuestas Gemini, handoff, memoria
// ============================================
const fs = require('fs');
const path = require('path');
const db = require('./db');
const search = require('./search');
const router = require('./router');
const { geminiGenerate, SAFETY_SETTINGS, genAI: getGenAI, rotateGeminiKey } = require('./gemini');
const { CONFIG, parseEmployees, knowledgeBase } = require('./config');
const { findBestImage, detectAndSendProductImages: _detectAndSendProductImagesBase } = require('./images');
const { isAdmin, notifyAuditors } = require('./admin_commands');

// Inyeccion de dependencias
let client = null;
let MessageMedia = null;

function init(whatsappClient, msgMedia) {
  client = whatsappClient;
  MessageMedia = msgMedia;
}

// Wrapper para inyectar MessageMedia
async function detectAndSendProductImages(response, rawMsg, senderPhone) {
  return _detectAndSendProductImagesBase(response, rawMsg, senderPhone, MessageMedia);
}

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
        try {
          await rawMsg.reply(response);
        } catch (botErr) {
          if (botErr.message && (botErr.message.includes('Failed to find row') || botErr.message.includes('Evaluation failed'))) {
            console.log(`[BOT] ⚠️ rawMsg.reply falló para ${senderPhone} (chat desincronizado), usando safeSend en su lugar.`);
            await safeSend(senderPhone, response);
          } else {
            throw botErr; // Relanzar si es otro tipo de error
          }
        }

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
    const memoryResult = await geminiGenerate('gemini-3.1-pro-preview', memoryPrompt);
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
    // 0. Obtener memoria y perfil del cliente
    const clientMemory = db.getClientMemory(clientPhone);
    const clientProfile = db.getClient(clientPhone);

    // 1. Detectar si el mensaje necesita búsqueda de productos
    let productContext = '';

    if (needsProductSearch(message)) {
      const searchResult = search.searchProducts(message);
      
      // LOGICA DE OFRECIMIENTO COMPLETO:
      // Si no hubo un match fuerte (ej. Blow TR92 no existe) O si es la primera vez (catalog_sent=0),
      // enviamos TODO el catálogo como "vanguardia" de venta.
      const catalogAlreadySent = clientProfile?.catalog_sent === 1;
      
      if (!searchResult.hasStrongMatch || !catalogAlreadySent) {
        if (CONFIG.debug) console.log(`[DEBUG] 🚀 Ofreciendo catálogo completo para ${clientPhone} (StrongMatch=${searchResult.hasStrongMatch}, Sent=${catalogAlreadySent})`);
        
        const allProducts = search.getAllProducts();
        productContext = search.formatForPrompt({
          products: allProducts,
          totalFound: allProducts.length,
          strategy: 'search', // Usamos 'search' para que el header sea "REFERENCIAS RELEVANTES"
          keywords: searchResult.keywords
        });
        
        // Marcar como enviado en la respuesta (se hará efectivo si Gemini responde OK)
        // Usamos una variable local para actualizar la BD después del éxito de Gemini
        global._pendingCatalogSent = clientPhone;
      } else {
        productContext = search.formatForPrompt(searchResult);
      }
      
      if (CONFIG.debug) console.log(`[DEBUG] 🔍 Búsqueda activada: ${searchResult.keywords.join(', ')} → ${searchResult.products.length} productos`);
    } else {
      // 1.5 Búsqueda secundaria basada en memoria (para evitar ofrecer cosas de memoria que ya no hay)
      const clientMemory = db.getClientMemory(clientPhone) || '';
      if (clientMemory) {
        // Intentamos buscar productos mencionados en la memoria para inyectar su estado actual
        const searchResult = search.searchProducts(clientMemory, 3); 
        if (searchResult.products.length > 0) {
           productContext = `EL CLIENTE NO PREGUNTÓ POR PRODUCTO AHORA, PERO SEGÚN SU MEMORIA PODRÍA INTERESARLE:\n${search.formatForPrompt(searchResult)}\n`;
           productContext += 'Usa esta información de inventario solo si el historial sugiere que siguen hablando de esto. Si no, sé conversacional.';
        } else {
           productContext = 'El cliente no está preguntando por un producto específico. Responde de forma conversacional.';
        }
      } else {
        productContext = 'El cliente no está preguntando por un producto específico. Responde de forma conversacional.';
      }
      if (CONFIG.debug) console.log(`[DEBUG] 💬 Conversación general / basada en memoria`);
    }


    // 3. Construir system prompt con ficha estructurada
    let systemPrompt = buildSystemPrompt(productContext, clientMemory, clientProfile);

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
    const MAX_RETRIES = 3; // geminiGenerate() ya maneja rotación de keys internamente
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const model = getGenAI().getGenerativeModel({
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
        } else if (global._pendingCatalogSent === clientPhone) {
          // Si llegamos aquí, la respuesta fue exitosa y contenía el catálogo completo
          db.updateClientFlag(clientPhone, 'catalog_sent', true);
          delete global._pendingCatalogSent;
          if (CONFIG.debug) console.log(`[DEBUG] ✅ Catalog marked as sent for ${clientPhone}`);
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

⚠️ REGLA DE ORO DE INVENTARIO — NUNCA INVENTES:
- SOLO puedes ofrecer o confirmar la existencia de productos que aparezcan en la sección "REFERENCIAS RELEVANTES" o "REFERENCIAS DESTACADAS" del prompt de arriba.
- Si el cliente pregunta por un modelo (especialmente si viene de su MEMORIA anterior, como la Ekol P29) y ese modelo NO está en la lista de Referencias Relevantes actual, debes asumir que ESTÁ AGOTADO.
- Sé persuasivo: si algo está agotado, dile: "Ese modelo se nos agotó por el momento porque ha gustado mucho, pero tengo disponible el [Modelo similar del catálogo] que es [ventaja del reemplazo]. ¿Te mando fotos?"
- NUNCA digas "revisaré qué hay" o "dame un momento". Tú TIENES el inventario frente a ti en el prompt. Si no está ahí, no hay.

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
⚠️ IMPORTANTE — Plan Plus NO incluye defensa jurídica gratuita ante incautación ni soporte legal para trámites de recuperación. Esto es exclusivo del Plan Pro.
Cuando hables del Plan Plus NO digas "respaldo legal" a secas — di "capacitación legal", "conocimiento jurídico" o "herramientas para saber tus derechos". El respaldo legal post-incautación (respaldo jurídico incluido) es SOLO para Plan Pro con afiliación vigente.
Si el cliente ya tiene una incautación y no es afiliado o es Plan Plus, ofrécele la Consultoría Telefónica de $50.000 (detalles abajo).

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
🔥 RESPALDO JURÍDICO INTEGRAL 100% GRATIS si te incautan ilegalmente:
   🔹 Primera instancia ante Policía — valor comercial: $800.000
   🔹 Tutela para obligar respuesta — valor comercial: $600.000
   🔹 Nulidad del acto administrativo — valor comercial: $1.200.000
   → Total en respaldo jurídico cubierto: $2.6 millones. Tu inversión: $150.000.
   → Con un solo caso que ganes, el club se paga solo por los próximos 13 años.

⭐ PLAN PRO + ASESOR LEGAL IA — *$200.000* (¡EL MEJOR VALOR!)
✅ Todo lo del Plan Pro (carpeta jurídica, simulacros, descuentos, comunidad, certificado QR, respaldo jurídico gratis)
Y además:
🤖 Asesor Legal IA 24/7 por 6 meses directo en tu WhatsApp (ver detalles completos abajo)
(Valor normal del combo: $250.000 — hoy: $200.000)

Contratar respaldo jurídico DESPUÉS de la incautación cuesta $800.000–$1.500.000 solo en primera instancia.
Afiliarte ANTES en promoción cuesta desde $100.000/año + todo listo el día que lo necesites.
Cuando estás preparado, tu arma se queda contigo.

🆘 CASOS DE INCAUTACIÓN — REGLAS PARA EL BOT:
1. SOLO tomamos casos de incautación para afiliados ACTIVOS con PLAN PRO vigente.
2. Si un cliente NO es afiliado o NO tiene Plan Pro y pide ayuda por una incautación:
   - Explícale con amabilidad que el respaldo jurídico es un beneficio exclusivo de los afiliados al Plan Pro.
   - Ofrécele una CONSULTORÍA TELEFÓNICA DE EMERGENCIA: $50.000 por máximo 30 minutos de asesoría telefónica directa para orientarlo sobre su caso.
   - Si acepta, indícale los medios de pago y dile que envíe el comprobante para agendar la llamada de inmediato.

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

🪪 DATOS PARA GENERAR CARNET — LISTA EXACTA (NO pidas NADA más):
Cuando debas pedir datos para el carnet del Club ZT, pide ÚNICAMENTE estos campos:
1. Nombre completo
2. Número de cédula
3. Teléfono de contacto
4. Marca, modelo y número de serial del arma
5. 📸 Foto de frente (selfie clara, sin gafas, buena luz)
NUNCA pidas datos adicionales como tipo de sangre, dirección, fecha de nacimiento, profesión ni ningún otro campo que no esté en esta lista.

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
- Para detalle jurídico completo: Biblioteca Legal https://zonatraumatica.club/portelegal/biblioteca.html — cubre Ley 2197/2022, Art. 223 Constitución, Decreto 2535/93, Sentencia C-014/2023, Tribunal Superior Bogotá, 20+ normas.
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
4. Links permitidos adicionales: Biblioteca https://zonatraumatica.club/portelegal/biblioteca.html | YouTube https://www.youtube.com/@zonatraumatica | TikTok https://www.tiktok.com/@zonatraumaticacolombia
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

module.exports = {
  init,
  safeSend,
  handleClientMessage,
  updateClientMemory,
  generateSimpleMemory,
  detectPostventaIntent,
  detectHandoffIntent,
  handleHandoff,
  summarizeConversation,
  needsProductSearch,
  getClaudeResponse,
  getN8nResponse,
  buildSystemPrompt
};
