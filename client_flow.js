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
const { buildSystemPrompt } = require('./prompts');
const tts = require('./tts');

// Cola de reintentos para cuando falla Gemini
const retryQueue = [];

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

// Limpiar todas las etiquetas internas del bot antes de enviar al cliente
function cleanBotTags(text) {
  return text
    .replace(/\[?\s*RESPONDER[_\s]*CON[_\s]*AUDIO\s*\]?/gi, '')
    .replace(/\[?\s*NO[_\s]*AUDIO[_\s]*PREFERENCE\s*\]?/gi, '')
    .replace(/\[?\s*ENVIAR[_\s]*IMAGEN[^\]]*\]?/gi, '')
    // Reemplazar placeholders con corchetes por URLs reales
    .replace(/\[ENLACE(?:\s+AL)?\s+(?:CATÁLOGO|CATALOGO|DE LA TIENDA|TIENDA)\]/gi, 'https://www.zonatraumatica.club#productos')
    .replace(/\[(?:VER|IR\s+AL?)\s+(?:CATÁLOGO|CATALOGO|TIENDA)\]/gi, 'https://www.zonatraumatica.club#productos')
    .replace(/\[(?:LINK|ENLACE|URL)\s*(?:DEL?)?\s*(?:CATÁLOGO|CATALOGO|TIENDA|PRODUCTO)?\]/gi, 'https://www.zonatraumatica.club#productos')
    .replace(/\[(?:VER|IR)\s+(?:BIBLIOTECA|LEGAL|SIMULADOR)\]/gi, 'https://www.zonatraumatica.club/portelegal/biblioteca.html')
    .replace(/\[(?:ENLACE|LINK|URL)\]/gi, 'https://www.zonatraumatica.club#productos')
    .trim();
}

async function safeSend(phone, message) {
  let chatId = db.getClientChatId(phone);

  // Guard: nunca enviar a status@broadcast ni a IDs inválidos
  if (!chatId || chatId.includes('status@broadcast') || chatId.includes('broadcast') || (!chatId.includes('@c.us') && !chatId.includes('@lid'))) {
    chatId = `${phone}@c.us`;
    console.warn(`[SEND] ⚠️ chatId inválido para ${phone} — usando fallback ${chatId}`);
  }

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
  // NOTA: El procesamiento de LID, actualizaciÃ³n de CRM e isBotPaused 
  // ya ocurrieron a nivel global en procesarMensaje(). AquÃ­ senderPhone es canÃ³nico.

  // 3. Guardar mensaje del cliente
  db.saveMessage(senderPhone, 'user', messageBody);

  // 4. Obtener historial para contexto
  const history = db.getConversationHistory(senderPhone, 10);

  // 5. Simular escritura (non-critical â€” no debe romper el flujo si el frame estÃ¡ desconectado)
  try { await chat.sendStateTyping(); } catch (e) { console.warn('[FLOW] âš ï¸ sendStateTyping fallÃ³ (frame desconectado):', e.message); }

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
    // --- LEAD CALIENTE: responder CON IA (incluye imÃ¡genes) y escalar silenciosamente ---
    let response;
    if (CONFIG.mode === 'direct') {
      response = await getClaudeResponse(senderPhone, messageBody, history);
    } else {
      response = await getN8nResponse(senderPhone, messageBody, history);
    }

    if (response) {
      if (response === '__ERROR_CONEXION__') {
        const _intermitMsg = 'Estoy experimentando una intermitencia tÃ©cnica momentÃ¡nea. Dame un momeeento que ya te reviso tu consulta y te respondo ðŸ™';
        db.saveMessage(senderPhone, 'assistant', _intermitMsg);
        await rawMsg.reply(_intermitMsg);
        retryQueue.push({
          senderPhone,
          messageBody,
          history,
          rawMsg,
          intent: 'hot_lead' // Para saber que era un lead caliente
        });
        console.log(`[RETRY QUEUE] ðŸ•’ Mensaje de ${senderPhone} encolado para reintento automÃ¡tico (Lead Caliente). Queue size: ${retryQueue.length}`);
      } else {
        response = response.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, '$2');
        response = cleanBotTags(response);
        const { cleanResponse } = await detectAndSendProductImages(response, rawMsg, senderPhone);
        response = cleanResponse;
        db.saveMessage(senderPhone, 'assistant', response);
        await rawMsg.reply(response);
      }
    }

    // Escalar silenciosamente a Ãlvaro (el cliente NO ve el mensaje de handoff)
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
        const _intermitMsg = 'Estoy experimentando una intermitencia tÃ©cnica momentÃ¡nea. Dame un momeeento que ya te reviso tu consulta y te respondo ðŸ™';
        db.saveMessage(senderPhone, 'assistant', _intermitMsg);
        await rawMsg.reply(_intermitMsg);
        retryQueue.push({
          senderPhone,
          messageBody,
          history,
          rawMsg,
          intent: 'normal'
        });
        console.log(`[RETRY QUEUE] ðŸ•’ Mensaje de ${senderPhone} encolado para reintento automÃ¡tico. Queue size: ${retryQueue.length}`);
      } else {
        // Limpiar enlaces Markdown [texto](url) -> url (ej: [Retay G17](https://...) -> https://...)
        // Esto evita que WhatsApp rompa los links si Gemini ignora la instrucciÃ³n
        response = response.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, '$2');

        // Detectar y enviar imÃ¡genes de productos (etiquetas + URLs)
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

        // Detectar si Gemini determinÃ³ que el cliente quiere audio
        // Gemini agrega [RESPONDER_CON_AUDIO] cuando detecta que el cliente pide/necesita audio
        const quiereAudio = /\[?\s*RESPONDER[_\s]*CON[_\s]*AUDIO\s*\]?/i.test(response);
        // Detectar si el cliente NO quiere audio
        const noQuiereAudio = /\[?\s*NO[_\s]*AUDIO[_\s]*PREFERENCE\s*\]?/i.test(response);
        // Limpiar etiquetas internas del bot
        response = cleanBotTags(response);

        if (noQuiereAudio) {
          // Guardar preferencia de NO audio en memoria del cliente
          const mem = db.getClientMemory(senderPhone) || '';
          if (!mem.includes('[PREFIERE_TEXTO]')) {
            db.updateClientMemory(senderPhone, mem + '\n[PREFIERE_TEXTO] Cliente indicÃ³ que no quiere/no puede escuchar audios.');
            console.log(`[AUDIO] ðŸ”‡ Cliente ${senderPhone} prefiere texto â€” guardando preferencia`);
          }
        }

        // Verificar preferencia de texto antes de enviar audio
        const clientMem = db.getClientMemory(senderPhone) || '';
        const prefiereTexto = clientMem.includes('[PREFIERE_TEXTO]');

        if (quiereAudio && !prefiereTexto) {
          // Enviar como nota de voz
          const audioSent = await tts.sendVoiceNote(senderPhone, response);
          if (audioSent) {
            console.log('[TTS] ðŸŽ¤ Respuesta enviada como nota de voz');
          } else {
            // sendVoiceNote fallÃ³ silenciosamente â€” enviar como texto
            console.warn('[TTS] âš ï¸ Audio fallÃ³, enviando como texto');
            try {
              await rawMsg.reply(response);
            } catch (botErr) {
              if (botErr.message && (botErr.message.includes('Failed to find row') || botErr.message.includes('Evaluation failed'))) {
                await safeSend(senderPhone, response);
              } else {
                throw botErr;
              }
            }
          }
        } else {
          // Enviar respuesta normal como texto
          try {
            await rawMsg.reply(response);
          } catch (botErr) {
            if (botErr.message && (botErr.message.includes('Failed to find row') || botErr.message.includes('Evaluation failed'))) {
              console.log(`[BOT] âš ï¸ rawMsg.reply fallÃ³ para ${senderPhone} (chat desincronizado), usando safeSend en su lugar.`);
              await safeSend(senderPhone, response);
            } else {
              throw botErr;
            }
          }
        }

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
              console.log(`[BOT] ðŸ–¼ï¸  Imagen Club ZT enviada a ${senderPhone}`);
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
          // IMPORTANTE: NO auto-asignar status de carnet_pendiente sin comprobante verificado.
          // Solo mover a 'postventa' para revisión del admin desde el panel.
          // El admin confirma el tipo exacto (plus/pro/despacho) desde el panel tras verificar el comprobante.
          const clienteActual = db.getClient(senderPhone);
          const statusActual = clienteActual?.status || '';
          // Solo cambiar si NO está ya en un status de post-venta (evitar pisar datos del admin)
          const statusesPostVenta = ['carnet_pendiente_plus', 'carnet_pendiente_pro', 'despacho_pendiente', 'municion_pendiente', 'bot_asesor_pendiente', 'postventa', 'completed', 'afiliado'];
          if (!statusesPostVenta.includes(statusActual)) {
            db.upsertClient(senderPhone, { status: 'postventa' });
            console.log(`[BOT] 💰 Pago mencionado por cliente → estado: postventa para ${senderPhone} (pendiente verificar comprobante)`);
          }
        }

        // 7. Actualizar memoria del cliente (en background, no bloquea)
        updateClientMemory(senderPhone, messageBody, response, history).catch(err => {
          if (CONFIG.debug) console.error('[MEMORY] Error actualizando memoria:', err.message);
        });

        // 8. NOTA DE VOZ DE BIENVENIDA â€” solo para clientes nuevos (primera interaccion)
        const clienteParaTTS = db.getClient(senderPhone);
        const esNuevo = clienteParaTTS && (clienteParaTTS.interaction_count || 0) <= 1;
        if (esNuevo) {
          (async () => {
            try {
              const nombreCliente = clienteParaTTS.name || '';
              const saludoVoz = nombreCliente
                ? '¡Qué más ' + nombreCliente + '! Bienvenido a Zona Traumática, soy Sofía, tu asesora. Cualquier cosa que necesites, aquí estoy, escríbeme con toda confianza.'
                : '¡Qué más! Bienvenido a Zona Traumática, soy Sofía, tu asesora. Cualquier cosa que necesites, aquí estoy, escríbeme con toda confianza.';
              await tts.sendVoiceNote(senderPhone, saludoVoz);
              console.log('[TTS] \u{1F3A4} Bienvenida de voz enviada a ' + senderPhone);
            } catch (ttsErr) {
              console.error('[TTS] \u26A0\uFE0F Error enviando bienvenida de voz a ' + senderPhone + ':', ttsErr.message);
            }
          })();
        }
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
    const memoryPrompt = `Eres un sistema de CRM para Zona TraumÃ¡tica, tienda de armas traumÃ¡ticas legales en Colombia. Tu tarea es mantener una ficha breve del cliente.

âš ï¸  REGLA CRÃ TICA â€” NOMBRES:
- "Ã lvaro" es el director de Zona TraumÃ¡tica, NO el nombre del cliente.
- NUNCA registres "Ã lvaro" como nombre del cliente aunque aparezca en el mensaje.
- Solo registra el nombre del cliente si Ã©l mismo lo dijo explÃ­citamente ("me llamo X", "soy X", "mi nombre es X").
- Si el cliente saluda a alguien llamado "Ã lvaro" o menciona ese nombre en otro contexto, ignÃ³ralo para el campo nombre.

MEMORIA ACTUAL DEL CLIENTE:
${currentMemory || '(Cliente nuevo, sin memoria previa)'}

ÃšLTIMA INTERACCIÃ“N:
- Cliente dijo: "${userMessage}"
- Bot respondiÃ³: "${botResponse.substring(0, 300)}"

INSTRUCCIONES:
Genera una ficha actualizada del cliente en máximo 8 líneas. Incluye SOLO datos útiles para ventas:
- Nombre del cliente (SOLO si él mismo lo dijo explícitamente: "me llamo X", "soy X". NUNCA si solo saludó a alguien)
- Cédula (CC) si la mencionó
- Ciudad o departamento (si lo mencionó)
- Dirección de envío (si la proporcionó)
- Profesión u ocupación (si la mencionó)
- Referencia o modelo de interés (si mencionó alguno)
- Plan preferido (Plus o Pro, si lo indicó)
- Motivo de compra (defensa personal, colección, regalo, etc.)
- Intención (solo consultando, interesado, listo para comprar)
- Objeciones detectadas (duda del pago virtual, no tiene presupuesto, etc.)
- Si ya compró: qué compró y si tiene carnet pendiente o dispositivo pendiente

Si la conversaciÃ³n fue solo un saludo sin info Ãºtil, devuelve la memoria actual sin cambios.
NO inventes datos. Solo registra lo que el cliente DIJO explÃ­citamente.
Responde SOLO con la ficha, sin explicaciones.`;

    // Usar Gemini Flash para memoria (barato y rÃ¡pido)
    const memoryResult = await geminiGenerate('gemini-2.5-flash', memoryPrompt);
    const newMemory = memoryResult.response.text().trim();

    // Solo actualizar si cambió y no está vacío
    if (newMemory && newMemory !== currentMemory) {
      db.updateClientMemory(clientPhone, newMemory);
      if (CONFIG.debug) console.log(`[MEMORY] ✅ Memoria actualizada para ${clientPhone}`);
    }

    // === EXTRACCIÓN ESTRUCTURADA DE DATOS ===
    // Segundo paso: extraer datos específicos de la MEMORIA ACTUALIZADA + último mensaje
    // y guardarlos en los campos reales del CRM.
    // NOTA: Antes solo analizaba userMessage (último mensaje), lo que perdía datos
    // mencionados en conversaciones anteriores. Ahora usa la memoria completa.
    try {
      const memoryForExtract = newMemory || currentMemory || '';
      const currentProfile = db.getClient(clientPhone);
      // Solo pedir extracción si hay campos vacíos que llenar
      const camposVacios = [];
      if (!currentProfile?.name || currentProfile.name.startsWith('+')) camposVacios.push('nombre');
      if (!currentProfile?.cedula) camposVacios.push('cedula');
      if (!currentProfile?.ciudad) camposVacios.push('ciudad');
      if (!currentProfile?.direccion) camposVacios.push('direccion');
      if (!currentProfile?.profesion) camposVacios.push('profesion');
      if (!currentProfile?.serial_arma) camposVacios.push('serial_arma');
      if (!currentProfile?.modelo_arma) camposVacios.push('modelo_arma');
      if (!currentProfile?.marca_arma) camposVacios.push('marca_arma');

      if (camposVacios.length > 0) {
        const extractResult = await geminiGenerate('gemini-2.5-flash',
          `Extrae datos del cliente usando la memoria del CRM y su último mensaje. Responde SOLO con JSON válido, sin markdown ni explicaciones:
{"nombre": null, "cedula": null, "ciudad": null, "direccion": null, "profesion": null, "serial_arma": null, "modelo_arma": null, "marca_arma": null}

REGLAS:
- Extrae datos que aparezcan en la MEMORIA o en el ÚLTIMO MENSAJE del cliente. Null = no se encontró.
- Solo necesitamos estos campos vacíos: ${camposVacios.join(', ')}. Los demás pon null.
- "nombre": nombre real completo del cliente. NUNCA extraer "Álvaro" (es el director, no el cliente).
- "cedula": número de cédula colombiana (8-10 dígitos). Busca patrones como "CC: 1234567890".
- "ciudad": ciudad colombiana donde vive el cliente.
- "direccion": dirección física del cliente (para envío).
- "profesion": profesión u ocupación del cliente.
- "serial_arma": serial/número de serie de un arma (ej: EFC-200817783).
- "modelo_arma": modelo de arma (ej: Firat Compact, G17, etc.).
- "marca_arma": marca de arma (ej: Ekol, Zoraki, Retay, Blow, etc.).

MEMORIA DEL CLIENTE (datos acumulados de conversaciones anteriores):
${memoryForExtract}

ÚLTIMO MENSAJE DEL CLIENTE: "${userMessage}"`
        );
        const extractText = extractResult.response.text().replace(/\`\`\`json\n?/g, '').replace(/\`\`\`/g, '').trim();
        const extracted = JSON.parse(extractText);
        const updateData = {};
        if (extracted.nombre && camposVacios.includes('nombre')) updateData.name = extracted.nombre;
        if (extracted.cedula && camposVacios.includes('cedula')) updateData.cedula = extracted.cedula;
        if (extracted.ciudad && camposVacios.includes('ciudad')) updateData.ciudad = extracted.ciudad;
        if (extracted.direccion && camposVacios.includes('direccion')) updateData.direccion = extracted.direccion;
        if (extracted.profesion && camposVacios.includes('profesion')) updateData.profesion = extracted.profesion;
        if (extracted.serial_arma && camposVacios.includes('serial_arma')) updateData.serial_arma = extracted.serial_arma;
        if (extracted.modelo_arma && camposVacios.includes('modelo_arma')) updateData.modelo_arma = extracted.modelo_arma;
        if (extracted.marca_arma && camposVacios.includes('marca_arma')) updateData.marca_arma = extracted.marca_arma;
        if (Object.keys(updateData).length > 0) {
          db.upsertClient(clientPhone, updateData);
          console.log(`[MEMORY] 📋 Datos estructurados extraídos para ${clientPhone}:`, Object.keys(updateData).join(', '));
        }
      }
    } catch (extractErr) {
      // No es fatal — la memoria ya se actualizó
      if (CONFIG.debug) console.log(`[MEMORY] Extracción estructurada falló: ${extractErr.message}`);
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
  // Para 'venta': NO enviar mensaje al cliente (la IA ya respondiÃ³ con info del producto + imÃ¡genes)
  // Para 'postventa': enviar confirmaciÃ³n al cliente
  if (tipo === 'postventa') {
    try {
      await msg.reply(`âœ… Tu solicitud fue registrada y ya la estamos gestionando. En breve un asesor te contacta. ðŸ™`);
    } catch (e) {
      console.error(`[HANDOFF] âŒ Error enviando mensaje al cliente:`, e.message);
    }
  }

  // Estado segÃºn tipo
  const nuevoStatus = tipo === 'postventa' ? 'postventa' : 'assigned';
  const logLabel = tipo === 'postventa' ? 'POST-VENTA' : 'LEAD CALIENTE';

  // Guardar en historial (solo interno)
  db.saveMessage(clientPhone, 'system', `[${logLabel} â€” asignado a ${assignment.employee_name} en panel]`);

  // Actualizar estado del cliente
  db.upsertClient(clientPhone, { status: nuevoStatus });

  // Guardar la escalación como pendiente en el panel
  try {
    db.saveEscalacion(clientPhone, clientName, tipo, triggerMessage, db.getClientMemory(clientPhone) || '', summarizeConversation(history));
    console.log(`[HANDOFF] 📋 Escalación guardada en panel (tipo: ${tipo})`);
  } catch (escErr) {
    console.error('[HANDOFF] Error guardando escalación:', escErr.message);
  }

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
    // 0. Obtener memoria y perfil del cliente
    const clientMemory = db.getClientMemory(clientPhone);
    const clientProfile = db.getClient(clientPhone);

    // 1. Detectar si el mensaje necesita bÃºsqueda de productos
    let productContext = '';

    if (needsProductSearch(message)) {
      const searchResult = search.searchProducts(message);
      
      // LOGICA DE OFRECIMIENTO COMPLETO:
      // Si no hubo un match fuerte (ej. Blow TR92 no existe) O si es la primera vez (catalog_sent=0),
      // enviamos TODO el catÃ¡logo como "vanguardia" de venta.
      const catalogAlreadySent = clientProfile?.catalog_sent === 1;
      
      if (!searchResult.hasStrongMatch || !catalogAlreadySent) {
        if (CONFIG.debug) console.log(`[DEBUG] ðŸš€ Ofreciendo catÃ¡logo completo para ${clientPhone} (StrongMatch=${searchResult.hasStrongMatch}, Sent=${catalogAlreadySent})`);
        
        const allProducts = search.getAllProducts();
        productContext = search.formatForPrompt({
          products: allProducts,
          totalFound: allProducts.length,
          strategy: 'search', // Usamos 'search' para que el header sea "REFERENCIAS RELEVANTES"
          keywords: searchResult.keywords
        });
        
        // Marcar como enviado en la respuesta (se harÃ¡ efectivo si Gemini responde OK)
        // Usamos una variable local para actualizar la BD despuÃ©s del Ã©xito de Gemini
        global._pendingCatalogSent = clientPhone;
      } else {
        productContext = search.formatForPrompt(searchResult);
      }
      
      if (CONFIG.debug) console.log(`[DEBUG] ðŸ” BÃºsqueda activada: ${searchResult.keywords.join(', ')} â†’ ${searchResult.products.length} productos`);
    } else {
      // 1.5 BÃºsqueda secundaria basada en memoria (para evitar ofrecer cosas de memoria que ya no hay)
      const clientMemory = db.getClientMemory(clientPhone) || '';
      if (clientMemory) {
        // Intentamos buscar productos mencionados en la memoria para inyectar su estado actual
        const searchResult = search.searchProducts(clientMemory, 3); 
        if (searchResult.products.length > 0) {
           productContext = `EL CLIENTE NO PREGUNTÃ“ POR PRODUCTO AHORA, PERO SEGÃšN SU MEMORIA PODRÃA INTERESARLE:\n${search.formatForPrompt(searchResult)}\n`;
           productContext += 'Usa esta información de inventario solo si el historial sugiere que siguen hablando de esto. Si el mensaje no tiene que ver con armas, defensa o el negocio, responde brevemente y redirige la conversación hacia los productos o servicios de Zona Traumática. NUNCA actúes como chatbot genérico.';
        } else {
           productContext = 'El cliente no está preguntando por un producto específico. Responde brevemente mostrando disposición, pero SIEMPRE como asesor de Zona Traumática. Si el tema no tiene nada que ver con armas traumáticas, defensa personal o el negocio, redirige sutilmente hacia lo que ofreces: armas, Club ZT, Asesor Legal IA. NUNCA actúes como un chatbot genérico ni des asesoría sobre temas que no son del negocio.';
        }
      } else {
        productContext = 'El cliente no está preguntando por un producto específico. Responde brevemente mostrando disposición, pero SIEMPRE como asesor de Zona Traumática. Si el tema no tiene nada que ver con armas traumáticas, defensa personal o el negocio, redirige sutilmente hacia lo que ofreces: armas, Club ZT, Asesor Legal IA. NUNCA actúes como un chatbot genérico ni des asesoría sobre temas que no son del negocio.';
      }
      if (CONFIG.debug) console.log(`[DEBUG] ðŸ’¬ ConversaciÃ³n general / basada en memoria`);
    }


    // 3. Construir system prompt con ficha estructurada (usando prompts.js completo)
    const clientFiles = db.getClientFiles ? db.getClientFiles(clientPhone) : [];
    const documentSummary = clientFiles.length > 0
      ? clientFiles.map(f => `- ${f.tipo}: ${f.descripcion} (${new Date(f.created_at).toLocaleDateString('es-CO')})`).join('\n')
      : '';
    const catalogSent = clientProfile && clientProfile.catalog_sent;
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

    // 5. Llamar a Gemini con reintentos (via geminiGenerate para activar thinking)
    const MAX_RETRIES = 3;
    let lastError = null;

    // Construir contents: historial previo + mensaje actual del cliente
    const contents = [
      ...geminiHistory,
      { role: 'user', parts: [{ text: message }] }
    ];

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const SEPARATOR = '='.repeat(65);
        console.log('\n' + SEPARATOR);
        console.log('[BOT-CONTEXT] LO QUE VE EL BOT — ' + clientPhone + ' (' + (clientProfile && clientProfile.name ? clientProfile.name : 'Sin nombre') + ')');
        console.log(SEPARATOR);
        console.log('MENSAJE CLIENTE: "' + message + '"');
        console.log('STATUS: ' + (clientProfile && clientProfile.status ? clientProfile.status : '?') +
          ' | Score: ' + (clientProfile && clientProfile.lead_score ? clientProfile.lead_score : 0) +
          ' | Interacciones: ' + (clientProfile && clientProfile.interaction_count ? clientProfile.interaction_count : 0));
        console.log('MEMORIA:\n' + (clientMemory ? String(clientMemory).substring(0, 800) : '(sin memoria)'));
        console.log('CONTEXTO PRODUCTO:\n' + (productContext ? String(productContext).substring(0, 500) : '(sin producto)'));
        console.log('HISTORIAL (' + geminiHistory.length + ' turnos, mostrando ultimos 4):');
        geminiHistory.slice(-4).forEach(function(h) {
          var rol = h.role === 'user' ? 'CLIENTE' : 'BOT';
          var txt = (h.parts && h.parts[0] && h.parts[0].text) ? String(h.parts[0].text).substring(0, 150) : '';
          console.log('  [' + rol + ']: ' + txt);
        });
        console.log(SEPARATOR + '\n');

        const result = await geminiGenerate('gemini-3.1-pro-preview', contents, {
          config: { systemInstruction: systemPrompt }
        });

        console.log(`[GEMINI] ✅ Respuesta OK (con thinking) para ${clientPhone}`);
        const responseText = result.response.text();
        if (!responseText || !responseText.trim()) {
          console.error(`[GEMINI] ⚠️ RESPUESTA VACÍA de Gemini para ${clientPhone}. Mensaje: "${message.substring(0, 60)}"`);
        } else if (global._pendingCatalogSent === clientPhone) {
          db.updateClientFlag(clientPhone, 'catalog_sent', true);
          delete global._pendingCatalogSent;
          if (CONFIG.debug) console.log(`[DEBUG] ✅ Catalog marked as sent for ${clientPhone}`);
        }
        return responseText;
      } catch (retryError) {
        lastError = retryError;
        const errorMsg = retryError.message || 'Error desconocido';
        console.error(`[GEMINI] âš ï¸ Intento ${attempt}/${MAX_RETRIES} fallÃ³: ${errorMsg}`);

        const is429 = errorMsg && (errorMsg.includes('429') || errorMsg.includes('quota') || errorMsg.includes('Too Many Requests'));
        if (is429) {
          console.warn(`[GEMINI] âš ï¸ Key agotada (429) en chat principal â€” rotando...`);
          rotateGeminiKey('429 quota exceeded in main chat');
        }

        if (attempt < MAX_RETRIES) {
          const wait = is429 ? 1000 : attempt * 2000;
          console.log(`[GEMINI] â³ Reintentando en ${wait / 1000}s...`);
          await new Promise(r => setTimeout(r, wait));
        }
      }
    }

    console.error(`[GEMINI] âŒ FallÃ³ despuÃ©s de ${MAX_RETRIES} intentos: ${lastError?.message}`);
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
// NOTA: buildSystemPrompt se importa de prompts.js
// La versión anterior inline fue removida para evitar duplicación.
// ============================================


module.exports = {
  init,
  cleanBotTags,
  detectAndSendProductImages,
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
  retryQueue,
};
