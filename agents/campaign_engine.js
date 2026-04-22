// ============================================
// agents/campaign_engine.js — Campañas Segmentadas 1-a-1
// ============================================
// Envía mensajes personalizados a segmentos específicos del CRM.
// Ejecuta 1x por semana (domingos 10AM). Máximo 15 mensajes por campaña.

const db = require('../db');
const { safeSend } = require('../client_flow');
const tts = require('../tts');
const { geminiGenerate } = require('../gemini');

// ============================================
// SEGMENTOS PREDEFINIDOS
// ============================================
const SEGMENTS = [
  {
    id: 'gun_no_club',
    name: '🔫 Compraron arma, NO se afiliaron',
    query: `
      SELECT * FROM clients
      WHERE has_bought_gun = 1 AND is_club_plus = 0 AND is_club_pro = 0
      AND ignored = 0 AND spam_flag = 0
      AND status NOT IN ('completed', 'postventa', 'afiliado', 'carnet_pendiente_plus', 'carnet_pendiente_pro', 'carnet_enviado', 'despacho_pendiente', 'municion_pendiente', 'bot_asesor_pendiente', 'recuperacion_pendiente')
      AND phone NOT IN (
        SELECT client_phone FROM comprobantes WHERE estado IN ('pendiente', 'confirmado')
      )
      ORDER BY updated_at DESC LIMIT 15
    `,
    promptTemplate: (client) => `Eres el asesor de Zona Traumática. Este cliente compró un arma traumática pero NO se afilió al Club ZT.

CLIENTE: ${client.name || 'Cliente'}
PERFIL: ${client.memory || 'Sin datos'}

Envíale un mensaje corto invitándolo al Club ZT. Menciona los beneficios:
- Descuento especial en munición
- Carpeta jurídica digital
- Campo de tiro
- Carnet digital de portador legal

REGLAS:
1. Máximo 3-4 líneas, tono amable
2. NO seas agresivo ni vendedor
3. Personaliza según lo que compró (si está en el perfil)
4. Máximo 2 emojis
5. NO menciones que es automático

Escribe SOLO el mensaje.`
  },
  {
    id: 'hot_leads_dormant',
    name: '⭐ Leads calientes dormidos',
    query: `
      SELECT * FROM clients
      WHERE lead_score >= 50 AND status = 'new'
      AND ignored = 0 AND spam_flag = 0
      AND updated_at <= datetime('now', '-3 days')
      AND phone NOT IN (
        SELECT client_phone FROM comprobantes WHERE estado IN ('pendiente', 'confirmado')
      )
      ORDER BY lead_score DESC LIMIT 15
    `,
    promptTemplate: (client) => `Eres el asesor de Zona Traumática. Este lead tiene alto interés pero no ha comprado.

CLIENTE: ${client.name || 'Cliente'}  (Score: ${client.lead_score || 0})
PERFIL: ${client.memory || 'Sin datos'}

Envíale un mensaje casual retomando la conversación. Menciona lo que le interesaba.

REGLAS:
1. Máximo 3 líneas, tono cercano
2. Pregunta abierta al final
3. NO ofrezcas descuentos inventados
4. Máximo 2 emojis

Escribe SOLO el mensaje.`
  },
  {
    id: 'cold_reactivation',
    name: '❄️ Leads fríos reactivables',
    query: `
      SELECT * FROM clients
      WHERE (status = 'cold' OR (status = 'new' AND lead_score < 20))
      AND ignored = 0 AND spam_flag = 0
      AND interaction_count >= 3
      AND updated_at >= datetime('now', '-60 days')
      AND updated_at <= datetime('now', '-15 days')
      ORDER BY lead_score DESC LIMIT 15
    `,
    promptTemplate: (client) => `Eres el asesor de Zona Traumática. Este cliente mostró interés hace tiempo pero se enfrió.

CLIENTE: ${client.name || 'Cliente'}
PERFIL: ${client.memory || 'Sin datos'}

Envíale un mensaje breve y casual como "oye, me acordé de ti". NO vendas directamente.

REGLAS:
1. Máximo 2-3 líneas, súper casual
2. Menciona algo específico de su perfil si hay datos
3. Pregunta sencilla al final ("¿Sigues interesado?")
4. 1 emoji máximo
5. Si no hay datos en perfil, pregunta si aún busca arma traumática

Escribe SOLO el mensaje.`
  }
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
 * Ejecuta campañas segmentadas.
 */
async function runCampaigns() {
  const colHour = getColombiaHour();

  if (colHour < 9 || colHour >= 19) {
    console.log(`[CAMPAIGN] ⏸️ Fuera de horario (${colHour}h COL) — saltando`);
    return;
  }

  console.log('[CAMPAIGN] 📣 Ejecutando campañas segmentadas...');

  let totalSent = 0;

  for (const segment of SEGMENTS) {
    try {
      const audience = db.db.prepare(segment.query).all();
      
      // Filtrar los que ya recibieron esta campaña (en los últimos 30 días)
      // Y también los que tienen optout activo (desistieron o fecha tentativa)
      const eligible = audience.filter(client => {
        const existing = db.db.prepare(
          "SELECT id FROM followup_sequences WHERE client_phone = ? AND type = ? AND created_at >= datetime('now', '-30 days')"
        ).get(client.phone, 'campaign_' + segment.id);
        if (existing) return false;

        // Verificar optout de follow-ups
        const optout = db.getFollowupOptout(client.phone);
        if (optout) {
          if (optout.reason === 'desistio' || optout.reason === 'no_molestar') {
            console.log(`[CAMPAIGN] 🚫 ${client.name || client.phone} — optout (${optout.reason}), excluido de campaña`);
            return false;
          }
          if (optout.reason === 'fecha_tentativa' && optout.resumeDate) {
            const resumeDate = new Date(optout.resumeDate);
            if (resumeDate > new Date()) {
              console.log(`[CAMPAIGN] 📅 ${client.name || client.phone} — fecha tentativa activa, excluido de campaña`);
              return false;
            }
            // Fecha ya pasó — limpiar y permitir
            db.clearFollowupOptout(client.phone);
          }
        }

        return true;
      });

      if (eligible.length === 0) {
        console.log(`[CAMPAIGN] ${segment.name}: 0 elegibles (ya contactados o sin audiencia)`);
        continue;
      }

      console.log(`[CAMPAIGN] ${segment.name}: ${eligible.length} cliente(s) elegible(s)`);

      let segmentSent = 0;
      for (const client of eligible) {
        if (segmentSent >= 5) break; // Máx 5 por segmento por ejecución

        try {
          const prompt = segment.promptTemplate(client);
          const result = await geminiGenerate('gemini-2.5-pro', prompt);
          const mensaje = result.response.text().trim();

          if (!mensaje) continue;

          // Enviar como nota de voz (las campañas como audio se sienten más personales)
          const voiceSent = await tts.sendVoiceNote(client.phone, mensaje);
          if (!voiceSent) {
            // Fallback a texto si TTS falla
            await safeSend(client.phone, mensaje);
          }
          db.saveMessage(client.phone, 'assistant', mensaje);
          db.upsertSequence(client.phone, 'campaign_' + segment.id, 1);
          segmentSent++;
          totalSent++;
          console.log(`[CAMPAIGN] ✅ ${segment.name} → ${client.name || client.phone}: "${mensaje.substring(0, 50)}..."`);
        } catch (err) {
          console.error(`[CAMPAIGN] ❌ Error con ${client.phone}:`, err.message);
        }

        // Anti-ban delay
        const delay = Math.floor(Math.random() * 45000) + 45000;
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (err) {
      console.error(`[CAMPAIGN] ❌ Error en segmento ${segment.id}:`, err.message);
    }
  }

  console.log(`[CAMPAIGN] ✅ Campañas completadas — ${totalSent} mensajes enviados`);
}

module.exports = { runCampaigns };
