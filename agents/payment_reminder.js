// ============================================
// agents/payment_reminder.js — Recordatorios de Pago Automáticos
// ============================================
// Detecta clientes que expresaron intención de pagar pero
// no han enviado comprobante, y envía recordatorios amables.

const db = require('../db');
const { CONFIG } = require('../config');
const { geminiGenerate } = require('../gemini');
const { safeSend } = require('../client_flow');

// Configuración de la secuencia de pagos
const PAYMENT_SEQUENCE = [
  { step: 1, minHoursSince: 48,  tone: 'amable' },    // 2 días
  { step: 2, minHoursSince: 96,  tone: 'recordatorio' }, // 4 días
];

// Keywords que indican intención de pago en la memoria del cliente
const PAYMENT_INTENT_KEYWORDS = [
  'va a pagar', 'voy a pagar', 'voy a consignar', 'voy a transferir',
  'hago el pago', 'haré el pago', 'pago mañana', 'pago hoy',
  'consigno', 'transfiero', 'lo compro', 'la compro',
  'listo para comprar', 'listo para pagar', 'quiero pagar',
  'quiero pagar',
  'ya me decidí', 'ya me decidi', 'dale listo',
];

// Status que indican que ya pagó (no necesita recordatorio)
const PAID_STATUSES = [
  'carnet_pendiente_plus', 'carnet_pendiente_pro',
  'despacho_pendiente', 'completed', 'afiliado',
  'municion_pendiente', 'bot_asesor_pendiente',
];

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
 * Ejecuta el motor de recordatorios de pago.
 */
async function runPaymentReminders() {
  const colHour = getColombiaHour();

  // Solo entre 9AM y 7PM hora Colombia
  if (colHour < 9 || colHour >= 19) {
    console.log(`[PAYMENT-REMINDER] ⏸️ Fuera de horario (${colHour}h COL) — saltando`);
    return;
  }

  console.log('[PAYMENT-REMINDER] 💰 Buscando clientes con pagos pendientes...');

  // 1. Buscar clientes que expresaron intención de pago
  // Revisar memoria + últimos mensajes del cliente
  const candidates = db.db.prepare(`
    SELECT c.* FROM clients c
    WHERE c.ignored = 0 AND c.spam_flag = 0
    AND c.status NOT IN ('completed', 'afiliado', 'carnet_pendiente_plus', 'carnet_pendiente_pro', 'carnet_enviado', 'despacho_pendiente', 'municion_pendiente', 'bot_asesor_pendiente', 'postventa')
    AND c.interaction_count >= 3
    AND c.updated_at <= datetime('now', '-2 days')
    ORDER BY c.lead_score DESC
    LIMIT 30
  `).all();

  let sent = 0;

  for (const client of candidates) {
    // Verificar intención de pago en memoria
    const memory = (client.memory || '').toLowerCase();
    const hasPaymentIntent = PAYMENT_INTENT_KEYWORDS.some(kw => memory.includes(kw));

    if (!hasPaymentIntent) {
      // También buscar en los últimos mensajes del cliente
      const recentMsgs = db.db.prepare(`
        SELECT message FROM conversations
        WHERE client_phone = ? AND role = 'user'
        ORDER BY created_at DESC LIMIT 5
      `).all(client.phone);

      const msgsText = recentMsgs.map(m => m.message).join(' ').toLowerCase();
      const hasPaymentInMsgs = PAYMENT_INTENT_KEYWORDS.some(kw => msgsText.includes(kw));
      if (!hasPaymentInMsgs) continue;
    }

    // Verificar que no tenga comprobante (ya envió o ya fue confirmado)
    const tieneComprobante = db.db.prepare(
      "SELECT COUNT(*) as c FROM comprobantes WHERE client_phone = ? AND estado IN ('pendiente', 'confirmado')"
    ).get(client.phone);
    if (tieneComprobante && tieneComprobante.c > 0) continue; // Ya pagó o tiene pago pendiente de revisión

    // Verificar secuencia existente
    const seq = db.getSequenceForClient(client.phone, 'payment');

    if (seq) {
      // Verificar si el cliente respondió
      const clientReplied = db.db.prepare(`
        SELECT COUNT(*) as c FROM conversations
        WHERE client_phone = ? AND role = 'user'
        AND created_at > ?
      `).get(client.phone, seq.last_sent_at);

      if (clientReplied && clientReplied.c > 0) {
        db.stopSequence(seq.id);
        console.log(`[PAYMENT-REMINDER] ✅ ${client.name || client.phone} respondió — recordatorio detenido`);
        continue;
      }

      // Ya se alcanzó el máximo
      if (seq.step >= 2) {
        db.stopSequence(seq.id);
        continue;
      }

      // Verificar timing para siguiente paso
      const nextStep = PAYMENT_SEQUENCE.find(s => s.step === seq.step + 1);
      if (!nextStep) continue;

      const lastSent = new Date(seq.last_sent_at);
      const hoursSince = (Date.now() - lastSent.getTime()) / (1000 * 60 * 60);
      if (hoursSince < nextStep.minHoursSince) continue;

      const success = await sendPaymentReminder(client, nextStep);
      if (success) {
        db.upsertSequence(client.phone, 'payment', nextStep.step);
        sent++;
      }
    } else {
      // Nueva secuencia — verificar que hayan pasado al menos 48h
      const lastUpdate = new Date(client.updated_at);
      const hoursSince = (Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60);
      if (hoursSince < 48) continue;

      const firstStep = PAYMENT_SEQUENCE[0];
      const success = await sendPaymentReminder(client, firstStep);
      if (success) {
        db.upsertSequence(client.phone, 'payment', 1);
        sent++;
      }
    }

    // Anti-ban delay
    if (sent > 0) {
      const delay = Math.floor(Math.random() * 45000) + 45000;
      console.log(`[PAYMENT-REMINDER] ⏳ Siguiente en ${Math.round(delay / 1000)}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  console.log(`[PAYMENT-REMINDER] ✅ Completado — ${sent} recordatorios enviados`);
}

/**
 * Genera y envía un recordatorio de pago personalizado.
 */
async function sendPaymentReminder(client, stepConfig) {
  try {
    const history = db.getConversationHistory(client.phone, 6);
    const histText = history.map(h =>
      `${h.role === 'user' ? 'Cliente' : 'Bot'}: ${h.message}`
    ).join('\n').substring(0, 1200);

    const toneInstructions = {
      'amable': 'Pregunta amablemente si pudo hacer la transferencia. Ofrece ayuda con datos de pago. Casual y sin presión.',
      'recordatorio': 'Pregunta si sigue interesado en el producto. Si no ha pagado, ofrece enviar los datos de pago nuevamente. Tono respetuoso sin presionar.',
    };

    const prompt = `Eres el asesor de Zona Traumática (tienda de armas traumáticas legales en Colombia).

Este cliente dijo que iba a pagar pero no ha enviado comprobante. Envíale un recordatorio amable.

CLIENTE:
Nombre: ${client.name || 'Cliente'}
Perfil: ${client.memory || 'Sin datos'}

HISTORIAL:
${histText || 'Sin historial'}

TONO: ${toneInstructions[stepConfig.tone]}

REGLAS:
1. Máximo 3 líneas — WhatsApp breve
2. Menciona el producto/servicio específico que quería si está en el perfil
3. NO seas agresivo ni des urgencia falsa
4. NO ofrezcas descuentos
5. Máximo 2 emojis
6. Incluye por dónde puede enviar el comprobante

Escribe SOLO el mensaje, sin comillas ni explicaciones.`;

    const result = await geminiGenerate('gemini-3.1-pro-preview', prompt);
    const mensaje = result.response.text().trim();

    if (!mensaje) {
      console.error(`[PAYMENT-REMINDER] ⚠️ Sin respuesta de Gemini para ${client.phone}`);
      return false;
    }

    await safeSend(client.phone, mensaje);
    db.saveMessage(client.phone, 'assistant', mensaje);
    console.log(`[PAYMENT-REMINDER] ✅ Paso ${stepConfig.step} enviado a ${client.name || client.phone}: "${mensaje.substring(0, 60)}..."`);
    return true;
  } catch (err) {
    console.error(`[PAYMENT-REMINDER] ❌ Error con ${client.phone}:`, err.message);
    return false;
  }
}

module.exports = { runPaymentReminders };
