// ============================================
// agents/despacho_tracker.js — Tracking de Despachos Automático
// ============================================
// Monitorea clientes en status 'despacho_pendiente' y envía
// seguimiento automático: confirmación de envío, check de
// entrega a los 4 días, y auto-cierre a los 7 días.

const db = require('../db');
const { safeSend } = require('../client_flow');
const { geminiGenerate } = require('../gemini');

/**
 * Obtiene la hora actual en Colombia (0-23)
 */
function getColombiaHour() {
  const ahora = new Date();
  const utcMinutes = ahora.getUTCHours() * 60 + ahora.getUTCMinutes();
  const colMinutes = ((utcMinutes - 5 * 60) % (24 * 60) + 24 * 60) % (24 * 60);
  return Math.floor(colMinutes / 60);
}

/**
 * Ejecuta el tracker de despachos.
 */
async function runDespachoTracker() {
  const colHour = getColombiaHour();

  // Solo entre 9AM y 7PM hora Colombia
  if (colHour < 9 || colHour >= 19) {
    console.log(`[DESPACHO] ⏸️ Fuera de horario (${colHour}h COL) — saltando`);
    return;
  }

  console.log('[DESPACHO] 📦 Verificando despachos pendientes...');

  // Buscar clientes en despacho_pendiente
  const pendientes = db.db.prepare(`
    SELECT * FROM clients
    WHERE status = 'despacho_pendiente'
    AND ignored = 0 AND spam_flag = 0
    ORDER BY updated_at ASC
  `).all();

  if (pendientes.length === 0) {
    console.log('[DESPACHO] ✅ No hay despachos pendientes');
    return;
  }

  let sent = 0;

  for (const client of pendientes) {
    const memory = client.memory || '';

    // Verificar si ya tiene guía en memoria
    const guiaMatch = memory.match(/Gu[ií]a:\s*([A-Za-z0-9\-]+)/i);
    const hasGuia = !!guiaMatch;
    const guiaNumber = guiaMatch ? guiaMatch[1] : null;

    // Buscar transportadora
    const transpMatch = memory.match(/Despachado por\s+([^\(]+)/i);
    const transportadora = transpMatch ? transpMatch[1].trim() : null;

    // --- DETECCIÓN TEMPRANA: el cliente confirmó recepción por su cuenta ---
    // Solo revisar el ÚLTIMO mensaje del cliente (no los últimos 5, causa falsos positivos)
    const lastClientMsg = db.db.prepare(`
      SELECT message FROM conversations
      WHERE client_phone = ? AND role = 'user'
      ORDER BY created_at DESC LIMIT 1
    `).get(client.phone);

    const lastText = (lastClientMsg?.message || '').toLowerCase();
    // Usar frases completas para evitar falsos positivos
    // ('lleg' solo matchea "llegaron los precios?", 'gracias' matchea "gracias por la info")
    const confirmedDelivery =
      lastText.includes('ya me llegó') || lastText.includes('ya me llego') ||
      lastText.includes('ya lo recibí') || lastText.includes('ya lo recibi') ||
      lastText.includes('ya lo tengo') || lastText.includes('ya llegó el') ||
      lastText.includes('ya llego el') || lastText.includes('ya llego mi') ||
      lastText.includes('todo llegó bien') || lastText.includes('todo llego bien') ||
      lastText.includes('si ya me llegó') || lastText.includes('si ya me llego') ||
      lastText.includes('si ya llegó') || lastText.includes('si ya llego') ||
      lastText.includes('ya lo tengo en mis manos');

    if (confirmedDelivery) {
      // El cliente confirmó que le llegó → cerrar todo
      const seq = db.getSequenceForClient(client.phone, 'despacho');
      if (seq) db.stopSequence(seq.id);
      db.db.prepare("UPDATE clients SET status = 'completed' WHERE phone = ?").run(client.phone);

      // Enviar mensaje de cierre solo si no le hemos respondido ya
      const lastBotMsg = db.db.prepare(`
        SELECT message FROM conversations
        WHERE client_phone = ? AND role = 'assistant'
        ORDER BY created_at DESC LIMIT 1
      `).get(client.phone);

      const alreadyResponded = lastBotMsg && (
        lastBotMsg.message.includes('Nos alegra') || lastBotMsg.message.includes('disfrutes')
      );

      if (!alreadyResponded) {
        const closeMsg = '¡Excelente! 🙌 Nos alegra que ya lo tengas. Si necesitas algo más, aquí estamos. ¡Que lo disfrutes! 💪';
        await safeSend(client.phone, closeMsg);
        db.saveMessage(client.phone, 'assistant', closeMsg);
        sent++;
      }
      console.log(`[DESPACHO] 🎉 ${client.name || client.phone} confirmó recepción temprana → completado`);
      continue;
    }

    // Verificar secuencia existente
    const seq = db.getSequenceForClient(client.phone, 'despacho');

    if (seq) {
      // Verificar si el cliente respondió
      const clientReplied = db.db.prepare(`
        SELECT message FROM conversations
        WHERE client_phone = ? AND role = 'user'
        AND created_at > ?
        ORDER BY created_at DESC LIMIT 1
      `).get(client.phone, seq.last_sent_at);

      if (clientReplied) {
        const replyLower = clientReplied.message.toLowerCase();
        // Si el cliente confirmó que recibió → completar
        // Usar frases completas para evitar falsos positivos
        const confirmoRecepcion =
          replyLower.includes('ya me llegó') || replyLower.includes('ya me llego') ||
          replyLower.includes('ya lo recibí') || replyLower.includes('ya lo recibi') ||
          replyLower.includes('ya lo tengo') || replyLower.includes('ya llegó') ||
          replyLower.includes('ya llego') || replyLower.includes('sí, ya') ||
          replyLower.includes('si, ya') || replyLower.includes('todo llegó bien') ||
          replyLower.includes('todo llego bien');
        if (confirmoRecepcion) {
          db.stopSequence(seq.id);
          db.db.prepare("UPDATE clients SET status = 'completed' WHERE phone = ?").run(client.phone);
          
          await safeSend(client.phone, '¡Excelente! 🙌 Nos alegra que ya lo tengas. Si necesitas algo más, aquí estamos para lo que necesites. ¡Que lo disfrutes! 💪');
          db.saveMessage(client.phone, 'assistant', '¡Excelente! 🙌 Nos alegra que ya lo tengas. Si necesitas algo más, aquí estamos para lo que necesites. ¡Que lo disfrutes! 💪');
          console.log(`[DESPACHO] 🎉 ${client.name || client.phone} confirmó recepción → completado`);
          continue;
        }
        // Respondió pero no confirmó → detener secuencia (necesita atención humana)
        db.stopSequence(seq.id);
        console.log(`[DESPACHO] 💬 ${client.name || client.phone} respondió algo distinto — requiere atención manual`);
        continue;
      }

      // No respondió — verificar timing para siguiente paso
      const lastSent = new Date(seq.last_sent_at);
      const daysSince = (Date.now() - lastSent.getTime()) / (1000 * 60 * 60 * 24);

      if (seq.step === 1 && daysSince >= 4) {
        const checkMsg = `Hola ${client.name || ''}! 📦 ¿Ya te llegó tu pedido${guiaNumber ? ' (guía ' + guiaNumber + ')' : ''}? Cuéntanos para estar pendientes 🙌`;
        await safeSend(client.phone, checkMsg);
        db.saveMessage(client.phone, 'assistant', checkMsg);
        db.upsertSequence(client.phone, 'despacho', 2);
        sent++;
        console.log(`[DESPACHO] ✅ Check de entrega enviado a ${client.name || client.phone}`);
      } else if (seq.step === 2 && daysSince >= 3) {
        db.stopSequence(seq.id);
        // NO auto-completar — escalar a postventa para que Álvaro confirme entrega manualmente
        db.db.prepare("UPDATE clients SET status = 'postventa' WHERE phone = ?").run(client.phone);
        try {
          db.saveEscalacion(
            client.phone, client.name || '', 'despacho',
            `⚠️ 7 días sin confirmar recepción${guiaNumber ? ' (guía ' + guiaNumber + ')' : ''}. Verificar si el cliente recibió el paquete.`,
            client.memory || '', ''
          );
        } catch(e) { /* non-critical */ }
        console.log(`[DESPACHO] ⚠️ ${client.name || client.phone} — 7d sin respuesta, escalado a postventa para revisión manual`);
      }
    } else if (hasGuia) {
      // Nuevo seguimiento — la guía ya fue enviada por el panel pero no hay secuencia
      // Verificar que la guía fue enviada hace al menos 1 hora (evitar duplicar el mensaje del panel)
      const guiaMessage = db.db.prepare(`
        SELECT created_at FROM conversations
        WHERE client_phone = ? AND role = 'assistant'
        AND (message LIKE '%guía%' OR message LIKE '%en camino%')
        ORDER BY created_at DESC LIMIT 1
      `).get(client.phone);

      if (guiaMessage) {
        const msgTime = new Date(guiaMessage.created_at);
        const hoursSince = (Date.now() - msgTime.getTime()) / (1000 * 60 * 60);
        if (hoursSince >= 1) {
          // Iniciar secuencia desde paso 1 (el panel ya envió la notificación)
          db.upsertSequence(client.phone, 'despacho', 1);
          console.log(`[DESPACHO] 📋 Secuencia iniciada para ${client.name || client.phone} (guía: ${guiaNumber})`);
        }
      }
    }
    // Si no tiene guía → no hacer nada (esperando que Álvaro la registre)

    // Anti-ban delay
    if (sent > 0) {
      const delay = Math.floor(Math.random() * 30000) + 30000;
      await new Promise(r => setTimeout(r, delay));
    }
  }

  console.log(`[DESPACHO] ✅ Completado — ${sent} mensajes, ${pendientes.length} despachos monitoreados`);
}

module.exports = { runDespachoTracker };
