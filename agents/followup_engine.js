// ============================================
// agents/followup_engine.js — Secuencias de Follow-up Automático
// ============================================
// Envía mensajes de seguimiento personalizados con Gemini
// a leads que dejaron de responder. Se detiene automáticamente
// si el cliente responde.

const db = require('../db');
const { CONFIG } = require('../config');
const { geminiGenerate } = require('../gemini');
const { safeSend } = require('../client_flow');
const tts = require('../tts');
const search = require('../search');

// Configuración de la secuencia de leads
const LEAD_SEQUENCE = [
  { step: 1, minHoursSince: 24,  maxStep: false, tone: 'sutil' },
  { step: 2, minHoursSince: 120, maxStep: false, tone: 'urgencia' },  // 5 días
  { step: 3, minHoursSince: 360, maxStep: true,  tone: 'ultimo' },    // 15 días
];

// Status que NO deben recibir follow-up (post-venta, ya compró, etc.)
const EXCLUDED_STATUSES = [
  'postventa', 'carnet_pendiente_plus', 'carnet_pendiente_pro',
  'carnet_enviado', 'despacho_pendiente', 'municion_pendiente', 'bot_asesor_pendiente',
  'recuperacion_pendiente', 'completed', 'afiliado'
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
 * Ejecuta el motor de follow-up para leads.
 */
async function runFollowups() {
  const colHour = getColombiaHour();

  // Solo ejecutar entre 8AM y 9PM hora Colombia
  if (colHour < 8 || colHour >= 21) {
    console.log(`[FOLLOWUP] ⏸️ Fuera de horario (${colHour}h COL) — saltando`);
    return;
  }

  console.log('[FOLLOWUP] 🔄 Ejecutando motor de follow-up...');

  // 1. Encontrar leads elegibles (status new/hot, ≥2 interacciones, inactivos 24h+)
  const eligibleLeads = db.db.prepare(`
    SELECT * FROM clients
    WHERE ignored = 0 AND spam_flag = 0
    AND status IN ('new', 'hot')
    AND interaction_count >= 2
    AND updated_at <= datetime('now', '-1 day')
    AND phone NOT IN (
      SELECT client_phone FROM comprobantes WHERE estado IN ('pendiente', 'confirmado')
    )
    ORDER BY lead_score DESC
    LIMIT 20
  `).all();

  // 2. Filtrar los que ya tienen secuencia detenida o excluida
  let processed = 0;
  let sent = 0;

  for (const lead of eligibleLeads) {
    if (EXCLUDED_STATUSES.includes(lead.status)) continue;

    // Verificar si el cliente respondió recientemente (después del último follow-up)
    const seq = db.getSequenceForClient(lead.phone, 'lead');
    
    if (seq) {
      // Verificar si el cliente respondió después del último envío
      const clientReplied = db.db.prepare(`
        SELECT COUNT(*) as c FROM conversations
        WHERE client_phone = ? AND role = 'user'
        AND created_at > ?
      `).get(lead.phone, seq.last_sent_at);

      if (clientReplied && clientReplied.c > 0) {
        // Cliente respondió → detener secuencia
        db.stopSequence(seq.id);
        console.log(`[FOLLOWUP] ✅ ${lead.name || lead.phone} respondió — secuencia detenida`);
        continue;
      }

      // Verificar si ya se alcanzó el paso máximo
      if (seq.step >= 3) {
        db.stopSequence(seq.id);
        console.log(`[FOLLOWUP] 🛑 ${lead.name || lead.phone} — máximo de seguimientos alcanzado`);
        continue;
      }

      // Verificar si pasó suficiente tiempo para el siguiente paso
      const nextStepConfig = LEAD_SEQUENCE.find(s => s.step === seq.step + 1);
      if (!nextStepConfig) continue;

      const lastSent = new Date(seq.last_sent_at);
      const hoursSince = (Date.now() - lastSent.getTime()) / (1000 * 60 * 60);
      if (hoursSince < nextStepConfig.minHoursSince) continue;

      // Enviar siguiente paso
      const success = await sendFollowup(lead, nextStepConfig);
      if (success) {
        db.upsertSequence(lead.phone, 'lead', nextStepConfig.step);
        sent++;
        if (nextStepConfig.maxStep) {
          // No degradar leads de alto score — pueden estar ocupados/vacaciones
          if ((lead.lead_score || 0) >= 50) {
            console.log(`[FOLLOWUP] ⚠️ ${lead.name || lead.phone} (score ${lead.lead_score}) — alto valor, NO se marca frío`);
          } else {
            db.db.prepare("UPDATE clients SET status = 'cold' WHERE phone = ?").run(lead.phone);
            console.log(`[FOLLOWUP] ❄️ ${lead.name || lead.phone} marcado como frío`);
          }
        }
      }
    } else {
      // Nueva secuencia — verificar si ya pasaron 24h desde última actividad
      const lastUpdate = new Date(lead.updated_at);
      const hoursSince = (Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60);
      if (hoursSince < 24) continue;

      const firstStep = LEAD_SEQUENCE[0];
      const success = await sendFollowup(lead, firstStep);
      if (success) {
        db.upsertSequence(lead.phone, 'lead', 1);
        sent++;
      }
    }

    processed++;

    // Anti-ban delay entre mensajes (45-90 segundos)
    if (sent > 0 && processed < eligibleLeads.length) {
      const delay = Math.floor(Math.random() * 45000) + 45000;
      console.log(`[FOLLOWUP] ⏳ Siguiente en ${Math.round(delay / 1000)}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  console.log(`[FOLLOWUP] ✅ Completado — ${sent} mensajes enviados de ${eligibleLeads.length} leads elegibles`);
}

/**
 * Genera y envía un mensaje de follow-up personalizado con Gemini.
 */
async function sendFollowup(lead, stepConfig) {
  try {
    const history = db.getConversationHistory(lead.phone, 8);
    const histText = history.map(h =>
      `${h.role === 'user' ? 'Cliente' : 'Bot'}: ${h.message}`
    ).join('\n').substring(0, 1500);

    const toneInstructions = {
      'sutil': 'Tono casual y sutil. Como un amigo que se acuerda. NO presiones. Pregunta abierta.',
      'urgencia': 'Tono de oportunidad. Menciona que el producto/servicio tiene alta demanda. Crea FOMO sutil sin ser agresivo.',
      'ultimo': 'Tono final y respetuoso. Dile que no quieres molestarlo, pero que si en algún momento decide, aquí estarás. Despedida amable.',
    };

    // Catálogo actual de productos en inventario
    let catalogText = 'Sin catálogo disponible';
    try {
      const allProducts = search.getAllProducts();
      catalogText = allProducts
        .map(p => `- ${p.titulo} (${p.marca || ''}) — Plus: $${p.precio_plus || '?'} / Pro: $${p.precio_pro || '?'}`)
        .join('\n').substring(0, 1200);
    } catch(e) { /* silenciar si search no disponible */ }

    const prompt = `Eres el asesor de Zona Traumática (tienda de armas traumáticas legales en Colombia).

Este cliente mostró interés pero dejó de responder. Envíale UN mensaje de seguimiento.

CLIENTE:
Nombre: ${lead.name || 'Cliente'}
Perfil/memoria: ${lead.memory || 'Sin datos previos'}

HISTORIAL RECIENTE:
${histText || 'Sin historial'}

INSTRUCCIÓN DE TONO: ${toneInstructions[stepConfig.tone]}
PASO ACTUAL: ${stepConfig.step} de 3

CATÁLOGO ACTUAL (PRODUCTOS DISPONIBLES EN STOCK HOY):
${catalogText}

REGLAS ESTRICTAS:
1. Máximo 3-4 líneas — es un WhatsApp, NO un email
2. Personalizado según su interés específico
3. Máximo 2 emojis
4. NO menciones que es automático
5. NO ofrezcas descuentos ni promos inventadas
6. Cierra con pregunta abierta (excepto si es paso 3)
7. ⚠️ SOLO menciona productos que aparecen en el CATÁLOGO ACTUAL. Si el cliente mencionó un producto que NO está en el catálogo de hoy, NO lo menciones — ofrece una alternativa disponible o habla en términos generales. PROHIBIDO inventar o mencionar productos fuera del catálogo actual.

Escribe SOLO el mensaje, sin comillas ni explicaciones.`;

    const result = await geminiGenerate('gemini-3.1-pro-preview', prompt);
    const mensaje = result.response.text().trim();

    if (!mensaje) {
      console.error(`[FOLLOWUP] ⚠️ Gemini no generó respuesta para ${lead.phone}`);
      return false;
    }

    // Paso 1: enviar como nota de voz (más personal y mayor engagement)
    // Pasos 2 y 3: enviar como texto normal
    if (stepConfig.step === 1) {
      const voiceSent = await tts.sendVoiceNote(lead.phone, mensaje);
      if (!voiceSent) {
        // Fallback a texto si TTS falla
        await safeSend(lead.phone, mensaje);
      }
    } else {
      await safeSend(lead.phone, mensaje);
    }
    db.saveMessage(lead.phone, 'assistant', mensaje);
    console.log(`[FOLLOWUP] ${stepConfig.step === 1 ? '🎤' : '✅'} Paso ${stepConfig.step} enviado a ${lead.name || lead.phone}: "${mensaje.substring(0, 60)}..."`);
    return true;
  } catch (err) {
    console.error(`[FOLLOWUP] ❌ Error enviando a ${lead.phone}:`, err.message);
    return false;
  }
}

module.exports = { runFollowups };
