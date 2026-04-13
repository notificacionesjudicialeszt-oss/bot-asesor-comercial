// ============================================
// api_server.js - Servidor HTTP, reactivación de leads, panel CRM
// ============================================
const http = require('http');
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { CONFIG } = require('./config');
const { geminiGenerate } = require('./gemini');
const { isAdmin } = require('./admin_commands');
const { safeSend, updateClientMemory } = require('./client_flow');

// Inyeccion de dependencias (funciones que viven en index.js)
let client = null;
let MessageMedia = null;
let procesarMensaje = null;
let isBotPaused = null;
let adminPauseMap = null;
let enviarTransicionAdmin = null;

function init(whatsappClient, msgMedia, deps) {
  client = whatsappClient;
  MessageMedia = msgMedia;
  procesarMensaje = deps.procesarMensaje;
  isBotPaused = deps.isBotPaused;
  adminPauseMap = deps.adminPauseMap;
  enviarTransicionAdmin = deps.enviarTransicionAdmin;
}

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

async function forceBotReply(phone, preloadedChat = null) {
  try {
    const chatId = db.getClientChatId(phone) || `${phone}@c.us`;
    console.log(`\n[PANEL-REACTIVACION] Buscando mensajes pendientes para: ${phone} (${chatId})`);

    // ESTRATEGIA: fetchMessages() está roto en versiones recientes de WA Web
    // (depende de waitForChatLoading que ya no existe). En su lugar, leemos
    // el último mensaje del cliente desde nuestra BD local.
    const historial = db.getConversationHistory(phone, 20);

    // Buscar el último mensaje que sea del usuario (role = 'user')
    let ultimoMsgUsuario = null;
    for (let i = historial.length - 1; i >= 0; i--) {
      if (historial[i].role === 'user') {
        ultimoMsgUsuario = historial[i];
        break;
      }
    }

    if (!ultimoMsgUsuario || !ultimoMsgUsuario.message) {
      return { ok: false, message: 'No se encontró mensaje reciente del usuario en el historial.' };
    }

    const userMessageText = ultimoMsgUsuario.message.trim();

    // Si es un mensaje de media guardado como texto plano, no procesarlo
    if (!userMessageText || userMessageText === '') {
      return { ok: false, message: 'El último mensaje del usuario está vacío.' };
    }

    console.log(`[PANEL-REACTIVACION] Último mensaje del usuario encontrado en BD: "${userMessageText.substring(0, 80)}"`);

    // Construir un objeto de mensaje sintético para procesarMensaje
    // Obtenemos el chat para poder enviar la respuesta
    let chat;
    try {
      chat = preloadedChat || await client.getChatById(chatId);
    } catch (chatErr) {
      console.warn(`[PANEL-REACTIVACION] No se pudo obtener chat (${chatErr.message}) — usando chatId directo`);
      chat = { id: { _serialized: chatId }, isGroup: false };
    }

    // Crear mensaje sintético compatible con procesarMensaje
    const msgSintetico = {
      from: chatId,
      to: 'me',
      body: userMessageText,
      type: 'chat',
      hasMedia: false,
      fromMe: false,
      id: { remote: chatId },
      getChat: async () => chat,
      getContact: async () => ({ pushname: '', name: '', number: phone }),
      reply: async (text) => {
        await safeSend(phone, text);
      }
    };

    await procesarMensaje(msgSintetico, chat, phone, msgSintetico);

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

    const result = await geminiGenerate('gemini-3.1-pro-preview', prompt);
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
    } else if (req.url === '/reatender-no-leidos' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      (async () => {
        try {
          console.log('[PANEL] 📬 Iniciando reatención de mensajes no leídos...');
          const chats = await client.getChats();
          console.log(`[DEBUG-PANEL] Total chats obtenidos de WhatsApp: ${chats.length}`);
          
          // Debugging top 10 recent chats to see their unread status
          chats.slice(0, 10).forEach(c => {
            console.log(`[DEBUG-PANEL] Chat: ${c.name} | Phone: ${c.id._serialized} | UnreadCount: ${c.unreadCount} | IsGroup: ${c.isGroup}`);
          });

          // Filtrar solo chats con mensajes no leídos y que no sean de grupos
          const pendientes = chats.filter(c =>
            c.unreadCount > 0 &&
            !c.isGroup &&
            !c.id._serialized.includes('@g.us')
          );

          if (pendientes.length === 0) {
            console.log('[DEBUG-PANEL] No se encontraron pendientes tras el filtro.');
            res.end(JSON.stringify({ ok: false, msg: 'No hay chats con mensajes sin leer' }));
            return;
          }

          console.log(`[PANEL] 📬 ${pendientes.length} chats con mensajes no leídos encontrados`);
          res.end(JSON.stringify({ ok: true, total: pendientes.length, msg: `Procesando ${pendientes.length} chats en background...` }));

          // Procesar en background con delay anti-ban
          (async () => {
            let procesados = 0;
            let errores = 0;
            for (const chat of pendientes) {
              try {
                const chatId = chat.id._serialized;
                // Extraer número de teléfono del chatId (ej: "573101234567@c.us" → "573101234567")
                const phone = chatId.replace('@c.us', '').replace(/\D/g, '');

                // Verificar si el bot está pausado para este cliente (Álvaro está atendiendo manualmente)
                if (isBotPaused(phone)) {
                  console.log(`[NO-LEIDOS] ⏸️ Bot pausado para ${phone} — omitiendo`);
                  continue;
                }

                // Verificar si está ignorado
                if (db.isIgnored(phone)) {
                  console.log(`[NO-LEIDOS] 🔇 Ignorado: ${phone} — omitiendo`);
                  continue;
                }

                console.log(`[NO-LEIDOS] 📨 Reatendiendo: ${phone} (${chat.unreadCount} mensajes sin leer)`);
                const result = await forceBotReply(phone, chat);
                if (result.ok) {
                  procesados++;
                  console.log(`[NO-LEIDOS] ✅ Respondido: ${phone}`);
                } else {
                  console.log(`[NO-LEIDOS] ⚠️ Sin respuesta para ${phone}: ${result.message}`);
                }
              } catch (err) {
                errores++;
                console.error(`[NO-LEIDOS] ❌ Error con chat:`, err.message);
              }
              // Delay anti-ban entre mensajes: 5-15 segundos
              if (pendientes.indexOf(chat) < pendientes.length - 1) {
                const delay = Math.floor(Math.random() * 10000) + 5000;
                await new Promise(resolve => setTimeout(resolve, delay));
              }
            }
            console.log(`[NO-LEIDOS] 🎉 Completado: ${procesados} respondidos, ${errores} errores`);
          })().catch(e => console.error('[NO-LEIDOS] Error general:', e.message));

        } catch (e) {
          console.error('[NO-LEIDOS] Error /reatender-no-leidos:', e.message);
          if (!res.writableEnded) {
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        }
      })();
    } else if (req.url === '/agregar-cliente' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { phone, name, contexto } = JSON.parse(body);
          if (!phone) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, msg: 'Falta el número de teléfono' }));
            return;
          }

          const cleanPhone = phone.replace(/\D/g, '');
          const chatId = `${cleanPhone}@c.us`;

          // Registrar cliente en la DB si no existe
          const existingClient = db.getClient(cleanPhone);
          if (!existingClient) {
            db.upsertClient(cleanPhone, { name: name || '', chat_id: chatId });
          } else if (name && !existingClient.name) {
            db.upsertClient(cleanPhone, { name });
          }

          // Si hay contexto, guardarlo en la memoria
          if (contexto && contexto.trim()) {
            const memoriaActual = db.getClientMemory(cleanPhone) || '';
            const nuevaMemoria = memoriaActual
              ? memoriaActual + `\n[Nota inicial del asesor]: ${contexto.trim()}`
              : `[Nota inicial del asesor]: ${contexto.trim()}`;
            db.updateClientMemory(cleanPhone, nuevaMemoria);
          }

          // Generar primer mensaje con IA basado en el contexto
          const nombreCliente = name || 'amigo';
          const promptIA = `Eres el asesor comercial de Zona Traumática en Colombia (armas traumáticas legales + Club ZT con membresía y respaldo jurídico).

Genera el primer mensaje de WhatsApp para este nuevo cliente potencial:
- Nombre: ${nombreCliente}
- Contexto/interés: ${contexto || 'interesado en productos o servicios'}

REGLAS:
1. Máximo 3-4 líneas — mensaje de WhatsApp real, natural
2. Salúdalo por su nombre, preséntate brevemente
3. Menciona el contexto de su interés de forma natural
4. Cierra con una pregunta que invite a responder
5. Tono: humano, cálido, directo. NO vendedor agresivo  
6. Máximo 2 emojis
7. NO menciones que es un mensaje automático

Escribe SOLO el mensaje, sin explicaciones ni comillas.`;

          let mensajeIA = '';
          try {
            const iaResult = await geminiGenerate('gemini-3.1-pro-preview', promptIA);
            mensajeIA = iaResult.response.text().trim();
          } catch (iaErr) {
            console.error('[AGREGAR] Error generando mensaje con IA:', iaErr.message);
            mensajeIA = `¡Hola ${nombreCliente}! Soy de Zona Traumática. Vi que puedes estar interesado en nuestros productos/servicios. ¿En qué te puedo ayudar? 🛡️`;
          }

          // Enviar el mensaje por WhatsApp
          try {
            // Verificar que el número existe en WhatsApp antes de enviar
            const waId = await client.getNumberId(cleanPhone);
            if (!waId) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: false, message: `⚠️ El número ${cleanPhone} no está registrado en WhatsApp. Cliente guardado en CRM sin mensaje.` }));
              return;
            }
            // Actualizar chat_id con el ID canónico resuelto
            const canonicalId = waId._serialized;
            db.upsertClient(cleanPhone, { chat_id: canonicalId });

            await client.sendMessage(canonicalId, mensajeIA);
            db.saveMessage(cleanPhone, 'assistant', mensajeIA);
            console.log(`[AGREGAR] ✅ Cliente ${nombreCliente} (${cleanPhone}) agregado y mensaje enviado`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, message: `✅ Cliente agregado y mensaje enviado a ${nombreCliente}`, msg: mensajeIA }));
          } catch (waErr) {
            // Si falla el envío de WA, igual guardamos el cliente pero avisamos
            console.error(`[AGREGAR] ⚠️ Error enviando WA a ${cleanPhone}:`, waErr.message);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, message: `⚠️ Cliente registrado pero no se pudo enviar el mensaje WhatsApp: ${waErr.message}` }));
          }
        } catch (e) {
          console.error('[AGREGAR] Error /agregar-cliente:', e.message);
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
          const { id, accion, phone, tipo, productoName } = JSON.parse(body);

          // Omitir: marcar en BD y salir sin notificar
          if (accion === 'omitir') {
            db.updateComprobanteEstado(id, 'omitido');
            console.log(`[COMPROBANTE] ⏭️ Comprobante #${id} omitido silenciosamente`);
            res.end(JSON.stringify({ ok: true, waSent: false, accion: 'omitir' }));
            return;
          }

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

            const clienteInfo = db.getClient(phoneClean) || {};

            if (tieneClub) {
              let clubMsgs = [];
              if (!clienteInfo.name || clienteInfo.name.trim().length < 3) clubMsgs.push('Nombre completo');
              if (!clienteInfo.cedula) clubMsgs.push('Número de cédula');
              clubMsgs.push('Teléfono de contacto'); // Always ask/confirm phone just in case for club
              if (!clienteInfo.modelo_arma) clubMsgs.push('Marca y Modelo del arma');
              if (!clienteInfo.serial_arma) clubMsgs.push('Número de serial del arma');
              clubMsgs.push('📸 Foto de frente (selfie clara, sin gafas, buena luz)');

              let clubBody = `🛡️ *Afiliación Club ZT (${planNombre}):* ¡Bienvenido!\n\n`;
              if (clubMsgs.length > 1) {
                clubBody += `Para generar tu *Carnet Digital* necesito:\n` + clubMsgs.map((req, i) => `${i + 1}. ${req}`).join('\n');
                clubBody += `\n\n📝 *Por favor envíame los datos en este mismo formato, indicando a qué corresponde cada uno.* Ejemplo:\n`;
                clubBody += `1. Nombre: Juan Pérez\n2. Cédula: 12345678\n3. Teléfono: 3001234567\n4. Arma: Ekol Firat Compact\n5. Serial: AB12345\n6. (Adjunta tu foto de frente)`;
              } else {
                clubBody += `Solo necesito 1 cosa para tu carnet:\n1. 📸 Foto de frente (selfie clara, sin gafas, buena luz)`;
              }

              partes.push(clubBody);
              nuevoStatus = tieneClubPro ? 'carnet_pendiente_pro' : 'carnet_pendiente_plus';
              const fechaHoy = new Date().toLocaleDateString('es-CO');
              memoriaTags.push(`✅ COMPRA CONFIRMADA:\n- ¿Qué compró?: Afiliación Club ZT (${planNombre})\n- ¿Cuándo lo compró?: ${fechaHoy}\n- ¿Ya le llegó?: N/A (Es un servicio digital activo)`);
            }

            if (tieneBot) {
              partes.push(
                `🤖 *Bot Asesor Legal ZT:* ¡Activado!\n\n` +
                `Tu número quedará habilitado en las próximas horas. Podrás consultar sobre normativa, derechos del portador y procedimientos legales.`
              );
              if (!nuevoStatus) nuevoStatus = 'bot_asesor_pendiente';
              const fechaHoy = new Date().toLocaleDateString('es-CO');
              memoriaTags.push(`✅ COMPRA CONFIRMADA:\n- ¿Qué compró?: Bot Asesor Legal ZT\n- ¿Cuándo lo compró?: ${fechaHoy}\n- ¿Ya le llegó?: N/A (Es un servicio digital activo)`);
            }

            if (tieneProducto) {
              let prodMsgs = [];
              if (!clienteInfo.name || clienteInfo.name.trim().length < 3) prodMsgs.push('Nombre completo');
              if (!clienteInfo.cedula) prodMsgs.push('Número de cédula');
              prodMsgs.push('Teléfono de contacto');
              if (!clienteInfo.direccion) prodMsgs.push('Dirección completa (calle, número, barrio, apto si aplica)');
              if (!clienteInfo.ciudad) prodMsgs.push('Ciudad y Departamento');

              const prodNameStr = productoName ? ` (${productoName})` : '';
              let prodBody = `📦 *Producto / Arma${prodNameStr}:* ¡En proceso!\n\n`;
              if (prodMsgs.length > 1) {
                prodBody += `Para el envío necesito:\n` + prodMsgs.map((req, i) => `${i + 1}. ${req}`).join('\n');
              } else {
                prodBody += `¡Ya contamos con tus datos de envío registrados! 🚚`;
              }
              prodBody += `\n\nEl envío se procesa en 1-2 días hábiles, discreto y seguro 🔒`;

              partes.push(prodBody);
              if (!nuevoStatus) nuevoStatus = 'despacho_pendiente';
              
              const fechaHoy = new Date().toLocaleDateString('es-CO');
              if (productoName) {
                memoriaTags.push(`✅ COMPRA CONFIRMADA:\n- ¿Qué compró?: ${productoName}\n- ¿Cuándo lo compró?: ${fechaHoy}\n- ¿Ya le llegó?: NO (En proceso de envío)`);
              } else {
                memoriaTags.push(`✅ COMPRA CONFIRMADA:\n- ¿Qué compró?: Producto por definir\n- ¿Cuándo lo compró?: ${fechaHoy}\n- ¿Ya le llegó?: NO (En proceso de envío)`);
              }
            }

            if (partes.length === 0) {
              msgDatos = `✅ ¡Confirmamos tu pago! Gracias por tu confianza 🙏\n\n` +
                `¿Me confirmas qué adquiriste? Así te pido los datos correctos 🚀`;
              nuevoStatus = 'hot';
              const fechaHoy = new Date().toLocaleDateString('es-CO');
              memoriaTags.push(`✅ COMPRA CONFIRMADA:\n- ¿Qué compró?: Pendiente por definir con el cliente\n- ¿Cuándo lo compró?: ${fechaHoy}\n- ¿Ya le llegó?: NO (En proceso)`);
            } else {
              const header = `✅ ¡Confirmamos tu pago! Gracias por tu confianza 🙏\n\n`;
              
              // Si no se pide nada de datos (por ejemplo, producto completado y sin club o club ya completito excepto foto que siempre se pide un item)
              let pideAlgo = (tieneClub) || (tieneProducto && (!clienteInfo.direccion || !clienteInfo.ciudad || !clienteInfo.name));
              let footer = "";
              if (pideAlgo) {
                footer = `\n\nEn cuanto me envíes los datos solicitados, arrancamos de una 💪`;
              } else {
                footer = `\n\n¡Arrancamos de una con tu proceso! 💪`;
              }
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
    } else if (req.url === '/extraer-datos-carnet' && req.method === 'POST') {
      // Extraer datos de un carnet con Gemini Vision (OCR inteligente)
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { imagenBase64, imagenMime } = JSON.parse(body);
          if (!imagenBase64) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Falta la imagen' }));
            return;
          }

          console.log('[EXTRAER-CARNET] 🔍 Analizando imagen de carnet con Gemini Vision...');

          const prompt = `Analiza esta imagen de un carnet/credencial de portador de arma traumática. Extrae TODOS los datos visibles y devuelve SOLO un JSON válido sin markdown ni explicaciones, con esta estructura exacta:

{
  "nombre": "nombre completo del titular",
  "cedula": "número de cédula",
  "marca_arma": "marca del arma (ej: Ekol, Retay, Blow)",
  "modelo_arma": "modelo del arma (ej: Special 99, Firat Compact)",
  "serial": "número de serial del arma",
  "vigente_hasta": "fecha de vigencia en formato DD/MM/YYYY",
  "plan_tipo": "Plus o Pro (si se puede determinar)"
}

Si algún campo no es legible o no está presente, pon null.
Responde SOLO con el JSON, sin backticks ni explicaciones.`;

          const content = [
            { text: prompt },
            {
              inlineData: {
                mimeType: imagenMime || 'image/jpeg',
                data: imagenBase64
              }
            }
          ];

          const result = await geminiGenerate('gemini-2.5-flash', content);
          const responseText = result.response.text().trim();

          // Limpiar respuesta de posibles backticks
          const cleanJson = responseText.replace(/```json\n?/g, '').replace(/```/g, '').trim();
          const datos = JSON.parse(cleanJson);

          console.log('[EXTRAER-CARNET] ✅ Datos extraídos:', JSON.stringify(datos));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, datos }));
        } catch (e) {
          console.error('[EXTRAER-CARNET] ❌ Error:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
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

      // Helper: detectar si un error es por frame/contexto detached
      function isFrameDetached(err) {
        const msg = (err.message || '').toLowerCase();
        return msg.includes('detached frame') ||
               msg.includes('execution context was destroyed') ||
               msg.includes('frame was detached') ||
               msg.includes('session closed') ||
               msg.includes('target closed') ||
               msg.includes('protocol error');
      }

      // Helper: refrescar la página del navegador y esperar reconexión
      async function refreshWhatsAppPage() {
        console.log('[LID] 🔄 Refrescando página de WhatsApp Web para recuperar frames...');
        try {
          if (client.pupPage) {
            await client.pupPage.reload({ waitUntil: 'networkidle0', timeout: 30000 });
            // Esperar a que WhatsApp Web se re-inicialice completamente
            await new Promise(r => setTimeout(r, 8000));
            console.log('[LID] ✅ Página refrescada — frames restaurados');
            return true;
          }
        } catch (refreshErr) {
          console.error('[LID] ⚠️ Error al refrescar página:', refreshErr.message);
        }
        return false;
      }

      // Helper: getContactById con reintento + refresh de página
      async function safeGetContact(chatId) {
        try {
          return await client.getContactById(chatId);
        } catch (err) {
          if (isFrameDetached(err)) {
            // Intentar refrescar la página y reintentar UNA vez
            const refreshed = await refreshWhatsAppPage();
            if (refreshed) {
              try {
                return await client.getContactById(chatId);
              } catch (retryErr) {
                throw retryErr;
              }
            }
          }
          throw err;
        }
      }

      (async () => {
        let resueltos = 0;
        let fallidos = 0;
        let pageRefreshed = false;
        console.log(`[LID] 🔍 Resolviendo ${lidClients.length} phones LID a número real...`);

        // Pre-check: verificar si la página está viva antes de empezar
        try {
          await client.getContactById(lidClients[0].chat_id || (lidClients[0].phone + '@lid'));
        } catch (preErr) {
          if (isFrameDetached(preErr)) {
            console.log('[LID] ⚠️ Frame detached detectado en pre-check — refrescando antes de empezar...');
            pageRefreshed = await refreshWhatsAppPage();
            if (!pageRefreshed) {
              console.error('[LID] ❌ No se pudo recuperar la conexión. Intente reiniciar el bot.');
              return;
            }
          }
        }

        for (const c of lidClients) {
          try {
            const chatId = c.chat_id || (c.phone + '@lid');
            const contact = await safeGetContact(chatId);
            if (!contact) {
              console.log(`[LID] ⏭️  ${c.phone} — contacto no encontrado`);
              fallidos++;
              continue;
            }
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
            await new Promise(r => setTimeout(r, 1500));
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
              const inventarioImg = path.join(imagenesDir, 'oferta actual', 'inventario y precios', 'inventario y precios pistolas.png');
              if (fs.existsSync(inventarioImg)) {
                const media = MessageMedia.fromFilePath(inventarioImg);
                await client.sendMessage(chatId, media, { caption: '📊 *Tabla oficial de precios — Zona Traumática*' });
                await new Promise(r => setTimeout(r, 2000));
              }

              // 4. Mensaje final con servicios
              const cierre = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
                `🛡️ *Club Zona Traumática* — Respaldo jurídico total\n` +
                `  🟡 Plan Plus: $100.000/año\n` +
                `  🔴 Plan Pro: $150.000/año\n\n` +
                `🤖 *Asesor Legal IA* — Tu consultor legal 24/7\n` +
                `  $50.000 por 6 meses\n\n` +
                `¿Cuál te interesa? Estoy para ayudarte 🙌`;

              await client.sendMessage(chatId, cierre);
              db.saveMessage(phone, 'assistant', `[📋 Catálogo completo enviado: ${totalEnviados} productos con fotos]`);
              console.log(`[CATÁLOGO] ✅ Catálogo enviado a ${phone}: ${totalEnviados} productos`);

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

          // === SMART RESUME: siempre corre al presionar "Devolver al Bot" ===
          // NO depende de wasPaused — el adminPauseMap se pierde en cada reinicio
          {
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
                // Sin mensajes de Álvaro — usar los últimos mensajes del cliente como contexto
                const recientes = history.slice(-5);
                msgsDurantePausa.push(...recientes);
                console.log(`[RESUME] ℹ️ Sin msgs de pausa para ${phone} — usando últimos ${recientes.length} msgs`);
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


              const resumeResult = await geminiGenerate('gemini-3.1-pro-preview', resumePrompt);
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
    } else if (req.url === '/enviar-carnet-whatsapp' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { phone, imagenBase64, imagenMime, caption, carnetData } = JSON.parse(body);
          if (!phone || !imagenBase64) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'phone y imagenBase64 son requeridos' }));
            return;
          }

          const chatId = db.getClientChatId(phone);
          const planStr = (carnetData && carnetData.plan_tipo) ? carnetData.plan_tipo : 'Club ZT';
          let msgText = caption || `🪪 *¡Aquí tienes tu Carnet Digital del ${planStr}!* \n\nGuarda esta imagen en tu celular. Es tu identificación oficial que te acredita como miembro activo y te brinda todo nuestro respaldo jurídico. 🛡️`;

          try {
            // 1. Enviar carnet FRENTE
            const media = new MessageMedia(imagenMime || 'image/png', imagenBase64, 'carnet_digital.png');
            await client.sendMessage(chatId, media, { caption: msgText });
            db.saveMessage(phone, 'assistant', msgText);
            console.log(`[PANEL] 🪪 Carnet (frente) enviado a ${phone}`);

            // 2. Enviar REVERSO genérico (si existe)
            const reversoPath = path.join(__dirname, 'imagenes', 'carnets', 'reverso.png');
            if (fs.existsSync(reversoPath)) {
              await new Promise(r => setTimeout(r, 1500)); // delay anti-spam
              const reversoMedia = MessageMedia.fromFilePath(reversoPath);
              const reversoCaption = `🪪 *Reverso de tu Carnet Digital*\n\nAquí están los términos y condiciones de tu membresía. Guárdalo junto con el frente del carnet. 🛡️`;
              await client.sendMessage(chatId, reversoMedia, { caption: reversoCaption });
              db.saveMessage(phone, 'assistant', reversoCaption);
              console.log(`[PANEL] 📋 Reverso enviado a ${phone}`);
            }

            // 3. Enviar mensaje de bienvenida con links de recursos
            await new Promise(r => setTimeout(r, 2000)); // delay anti-spam
            const bienvenidaMsg = `🌟 *¡Bienvenido a la familia ZT!* 🌟\n\n` +
              `Como afiliado activo, tienes acceso a estos recursos exclusivos:\n\n` +
              `📢 *Grupo Exclusivo de Afiliados (WhatsApp):*\nhttps://chat.whatsapp.com/KpuqBkuEFqjJDKtproEgKf\n👉 Solicita acceso al grupo para estar conectado con la comunidad.\n\n` +
              `📁 *Carpeta de Pruebas (Google Drive):*\nhttps://drive.google.com/drive/u/1/folders/1KSi1v5Y_07f8X6ei2IVVyh45cXEbegJr\n👉 Solicita acceso para consultar el material disponible.\n\n` +
              `¡Estamos para servirte! 💪`;
            await client.sendMessage(chatId, bienvenidaMsg);
            db.saveMessage(phone, 'assistant', bienvenidaMsg);
            console.log(`[PANEL] 🔗 Mensaje de bienvenida con links enviado a ${phone}`);
            
            // Actualizar la memoria indicando que ya se entregó el carnet
            const memoriaActual = db.getClientMemory(phone) || '';
            let nuevaMemoria = '';
            // Buscar si hay una entrada de "N/A (Es un servicio digital activo)" para reemplazar
            if (memoriaActual.includes('N/A (Es un servicio digital activo)')) {
              nuevaMemoria = memoriaActual.replace('N/A (Es un servicio digital activo)', 'SÍ (Carnet Digital Enviado)');
            } else {
              nuevaMemoria = memoriaActual ? memoriaActual + `\n🪪 ESTADO DE ENTREGA: Carnet Digital Enviado` : `🪪 ESTADO DE ENTREGA: Carnet Digital Enviado`;
            }
            db.updateClientMemory(phone, nuevaMemoria);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, msg: 'Carnet enviado correctamente', waSent: true }));
          } catch (waErr) {
            console.error(`[PANEL] ⚠️ Error enviando carnet a ${phone}:`, waErr.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, waSent: false, waWarning: waErr.message }));
          }
        } catch (e) {
          console.error('[PANEL] Error enviar-carnet-whatsapp:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });

    } else if (req.url === '/enviar-factura-whatsapp' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { phone, valor, caption, imagenBase64, imagenMime } = JSON.parse(body);
          if (!phone || !imagenBase64) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'phone y imagenBase64 son requeridos' }));
            return;
          }

          const chatId = db.getClientChatId(phone);
          let msgText = caption || `🧾 *¡Aquí tienes tu factura de compra!* \n\nAdjuntamos el comprobante por el valor de *${valor || 'su compra'}*. Muchas gracias por confiar en ZT. 🤝`;

          try {
            const media = new MessageMedia(imagenMime || 'image/jpeg', imagenBase64, 'factura_zt.jpg');
            await client.sendMessage(chatId, media, { caption: msgText });
            db.saveMessage(phone, 'assistant', msgText);
            console.log(`[PANEL] 🧾 Factura enviada a ${phone}`);
            
            // Guardar imagen en perfil
            db.saveClientFile(phone, 'factura', `Factura - ${valor || 'S/V'}`, imagenBase64, imagenMime || 'image/jpeg', 'panel', Date.now(), 'pagos');
            
            // Actualizar la memoria indicando que ya se entregó la factura
            const memoriaActual = db.getClientMemory(phone) || '';
            let nuevaMemoria = '';
            
            // Si estaba en "NO (En proceso de envío)", actualizarlo. 
            // Esto es útil si el bot marcó que la factura estaba pendiente de envío.
            const fechaHoy = new Date().toLocaleDateString('es-CO');
            const entradaFactura = `\n✅ FACTURA ENVIADA: ${fechaHoy}${valor ? ' - Valor: ' + valor : ''}`;

            if (memoriaActual.includes('NO (Pendiente de Factura)')) {
               nuevaMemoria = memoriaActual.replace('NO (Pendiente de Factura)', 'SÍ (Factura Enviada el ' + fechaHoy + ')');
            } else {
               nuevaMemoria = memoriaActual ? memoriaActual + entradaFactura : entradaFactura;
            }
            db.updateClientMemory(phone, nuevaMemoria);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, msg: 'Factura enviada correctamente' }));
          } catch (waErr) {
            console.error(`[PANEL] ⚠️ Error enviando factura a ${phone}:`, waErr.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: waErr.message }));
          }
        } catch (e) {
          console.error('[PANEL] Error enviar-factura-whatsapp:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });

    } else if (req.url === '/enviar-guia-whatsapp' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { phone, transportadora, numeroGuia, producto, caption, imagenBase64, imagenMime } = JSON.parse(body);
          if (!phone || !numeroGuia || !transportadora) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'phone, transportadora y numeroGuia son requeridos' }));
            return;
          }

          const chatId = db.getClientChatId(phone);
          
          let msgText = caption || `📦 *¡Tu envío está en camino!*\n\nHemos despachado tu pedido a través de *${transportadora}*.\nTu número de guía es: *${numeroGuia}*\n${producto ? `Producto: ${producto}\n\n` : '\n'}Puedes rastrear tu paquete en la página oficial de la transportadora. ¡Gracias por tu confianza!`;

          try {
            if (imagenBase64) {
              const media = new MessageMedia(imagenMime || 'image/jpeg', imagenBase64, 'guia.jpg');
              await client.sendMessage(chatId, media, { caption: msgText });
            } else {
              await client.sendMessage(chatId, msgText);
            }
            db.saveMessage(phone, 'assistant', msgText);
            console.log(`[PANEL] 📦 Guía de envío enviada a ${phone}`);
            
            // Guardar imagen en perfil si existe
            if (imagenBase64) {
              db.saveClientFile(phone, 'guia', `Guía ${transportadora} - ${numeroGuia}`, imagenBase64, imagenMime || 'image/jpeg', 'panel', Date.now(), 'guias');
            }
            
            // Actualizar la memoria indicando que ya se envió
            const memoriaActual = db.getClientMemory(phone) || '';
            let nuevaMemoria = '';
            if (memoriaActual.includes('NO (En proceso de envío)')) {
              nuevaMemoria = memoriaActual.replace('NO (En proceso de envío)', `SÍ (Enviado por ${transportadora} - Guía: ${numeroGuia})`);
            } else {
              nuevaMemoria = memoriaActual ? memoriaActual + `\n📦 ESTADO DE ENTREGA: Despachado por ${transportadora} (Guía: ${numeroGuia})` : `📦 ESTADO DE ENTREGA: Despachado por ${transportadora} (Guía: ${numeroGuia})`;
            }
            db.updateClientMemory(phone, nuevaMemoria);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, msg: 'Guía enviada correctamente' }));
          } catch (waErr) {
            console.error(`[PANEL] ⚠️ Error enviando guía a ${phone}:`, waErr.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Error enviando mensaje por WhatsApp: ' + waErr.message }));
          }
        } catch (e) {
          console.error('[PANEL] Error enviar-guia-whatsapp:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
    } else if (req.url === '/execute-directive' && req.method === 'POST') {
      // ── Ejecutar directiva del admin — FLUJO DEDICADO ──
      // NO usa forceBotReply (que re-procesa el último msg del usuario y pierde la directiva).
      // En su lugar, llama directamente a Gemini con la directiva prominente en el prompt.
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { phone, directive } = JSON.parse(body || '{}');
          if (!phone || !directive) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, msg: 'Faltan phone o directive' }));
            return;
          }
          console.log(`[DIRECTIVE] 🎯 Ejecutando directiva para ${phone}: "${directive.substring(0, 80)}"`);

          // 1. Obtener contexto completo del cliente
          const clientProfile = db.getClient(phone);
          const clientMemory = db.getClientMemory(phone) || '';
          const history = db.getConversationHistory(phone, 15);
          const clientFiles = db.getClientFiles ? db.getClientFiles(phone) : [];
          const documentSummary = clientFiles.length > 0
            ? clientFiles.map(f => `- ${f.tipo}: ${f.descripcion} (${new Date(f.created_at).toLocaleDateString('es-CO')})`).join('\n')
            : '';
          const catalogSent = clientProfile && clientProfile.catalog_sent;

          // 2. Construir system prompt (ya incluye la directiva via buildSystemPrompt → bot_directive)
          const search = require('./search');
          const allProducts = search.getAllProducts();
          const productContext = search.formatForPrompt({
            products: allProducts,
            totalFound: allProducts.length,
            strategy: 'search',
            keywords: []
          });
          const { buildSystemPrompt } = require('./prompts');
          const systemPrompt = buildSystemPrompt(productContext, clientMemory, clientProfile, documentSummary, catalogSent);

          // 3. Construir historial de Gemini
          const geminiHistory = [];
          for (const m of history) {
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
          while (geminiHistory.length > 0 && geminiHistory[0].role !== 'user') geminiHistory.shift();
          // Merge roles consecutivos
          for (let i = geminiHistory.length - 1; i > 0; i--) {
            if (geminiHistory[i].role === geminiHistory[i - 1].role) {
              geminiHistory[i - 1].parts[0].text += '\n' + geminiHistory[i].parts[0].text;
              geminiHistory.splice(i, 1);
            }
          }

          // 4. Enviar a Gemini con un trigger EXPLÍCITO para ejecutar la directiva
          const triggerMessage = `[SISTEMA INTERNO — NO VISIBLE PARA EL CLIENTE]\nEl administrador Álvaro te ha dado esta ORDEN DIRECTA que debes ejecutar AHORA MISMO:\n"${directive}"\n\nGenera el mensaje correspondiente para enviarle al cliente. Ejecuta la orden tal cual. NO menciones que recibiste una orden, simplemente actúa naturalmente.`;

          const contents = [
            ...geminiHistory,
            { role: 'user', parts: [{ text: triggerMessage }] }
          ];

          console.log(`[DIRECTIVE] 📋 Enviando a Gemini con directiva explícita para ${phone}`);

          const result = await geminiGenerate('gemini-3.1-pro-preview', contents, {
            config: { systemInstruction: systemPrompt }
          });

          let response = result.response.text();
          if (!response || !response.trim()) {
            console.error(`[DIRECTIVE] ⚠️ Gemini devolvió respuesta vacía para ${phone}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, message: 'Gemini devolvió respuesta vacía' }));
            return;
          }

          // 5. Limpiar tags internos
          const { cleanBotTags, detectAndSendProductImages } = require('./client_flow');
          response = response.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, '$2');
          response = cleanBotTags(response);

          // 6. Enviar al cliente
          await safeSend(phone, response);
          db.saveMessage(phone, 'assistant', response);

          // 7. Detectar y enviar imágenes de productos si las hay
          try {
            // Crear rawMsg mínimo para detectAndSendProductImages
            const chatId = db.getClientChatId(phone);
            const fakeMsg = {
              reply: async (content) => await client.sendMessage(chatId, content),
              from: chatId
            };
            await detectAndSendProductImages(response, fakeMsg, phone);
          } catch (imgErr) {
            console.warn(`[DIRECTIVE] ⚠️ Error enviando imágenes: ${imgErr.message}`);
          }

          console.log(`[DIRECTIVE] ✅ Directiva ejecutada para ${phone}: "${response.substring(0, 80)}"`);

          // 8. Limpiar la directiva
          db.db.prepare('UPDATE clients SET bot_directive = NULL, updated_at = CURRENT_TIMESTAMP WHERE phone = ?').run(phone);
          console.log(`[DIRECTIVE] 🧹 Directiva limpiada para ${phone}`);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: 'Directiva ejecutada correctamente' }));
        } catch (e) {
          console.error('[DIRECTIVE] Error execute-directive:', e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: e.message }));
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

module.exports = {
  init,
  startReactivacionServer,
  procesarClientesCalientes,
  forceBotReply,
  forcePostventaReply
};
