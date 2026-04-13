// ============================================
// agents/daily_briefing.js — Resumen Diario Ejecutivo
// ============================================
// Genera un reporte matutino del estado del negocio
// y lo envía a Álvaro por WhatsApp.
// Ejecutado automáticamente por scheduler.js a las 7:00 AM COL.

const db = require('../db');
const { CONFIG } = require('../config');

// Inyección de dependencia
let client = null;

function init(whatsappClient) {
  client = whatsappClient;
}

/**
 * Genera y envía el resumen ejecutivo diario.
 */
async function sendDailyBriefing() {
  console.log('[BRIEFING] 📊 Generando resumen ejecutivo diario...');

  try {
    const data = gatherBriefingData();
    const message = formatBriefingMessage(data);

    // Enviar a Álvaro
    const chatId = CONFIG.businessPhone + '@c.us';
    await client.sendMessage(chatId, message);
    console.log('[BRIEFING] ✅ Resumen diario enviado a Álvaro');
  } catch (err) {
    console.error('[BRIEFING] ❌ Error enviando resumen:', err.message);
  }
}

/**
 * Recopila todos los datos necesarios para el briefing.
 */
function gatherBriefingData() {
  // ── Clientes ──
  const totalClients = db.db.prepare('SELECT COUNT(*) as c FROM clients').get().c;

  const clientsYesterday = db.db.prepare(`
    SELECT COUNT(*) as c FROM clients
    WHERE date(created_at) = date('now', '-1 day')
  `).get().c;

  const clientsToday = db.db.prepare(`
    SELECT COUNT(*) as c FROM clients
    WHERE date(created_at) = date('now')
  `).get().c;

  const clientsThisWeek = db.db.prepare(`
    SELECT COUNT(*) as c FROM clients
    WHERE created_at >= datetime('now', '-7 days')
  `).get().c;

  // ── Mensajes ──
  const messagesYesterday = db.db.prepare(`
    SELECT COUNT(*) as c FROM conversations
    WHERE date(created_at) = date('now', '-1 day')
  `).get().c;

  // ── Comprobantes pendientes ──
  const comprobantesPendientes = db.db.prepare(`
    SELECT COUNT(*) as c FROM comprobantes WHERE estado = 'pendiente'
  `).get().c;

  // ── Carnets pendientes ──
  const carnetsPendientes = db.db.prepare(`
    SELECT COUNT(*) as c FROM carnets WHERE estado = 'pendiente'
  `).get().c;

  // ── Pipeline por estado ──
  const pipeline = db.db.prepare(`
    SELECT status, COUNT(*) as count FROM clients
    WHERE ignored = 0 AND spam_flag = 0
    GROUP BY status ORDER BY count DESC
  `).all();

  // ── Leads calientes sin atender en 24h+ ──
  const leadsAbandoned = db.db.prepare(`
    SELECT COUNT(*) as c FROM clients
    WHERE status IN ('hot', 'assigned')
    AND ignored = 0 AND spam_flag = 0
    AND updated_at <= datetime('now', '-1 day')
  `).get().c;

  // ── Clientes post-venta pendientes ──
  const postventaPendientes = db.db.prepare(`
    SELECT status, COUNT(*) as count FROM clients
    WHERE status IN ('carnet_pendiente_plus', 'carnet_pendiente_pro', 'despacho_pendiente', 'bot_asesor_pendiente', 'municion_pendiente')
    AND ignored = 0
    GROUP BY status
  `).all();

  // ── Top 5 leads por score ──
  const topLeads = db.db.prepare(`
    SELECT phone, name, lead_score, status, memory FROM clients
    WHERE ignored = 0 AND spam_flag = 0 AND lead_score > 0
    ORDER BY lead_score DESC LIMIT 5
  `).all();

  // ── Ventas confirmadas ayer ──
  const ventasAyer = db.db.prepare(`
    SELECT COUNT(*) as c FROM comprobantes
    WHERE estado = 'confirmado'
    AND date(verified_at) = date('now', '-1 day')
  `).get().c;

  return {
    totalClients,
    clientsYesterday,
    clientsToday,
    clientsThisWeek,
    messagesYesterday,
    comprobantesPendientes,
    carnetsPendientes,
    pipeline,
    leadsAbandoned,
    postventaPendientes,
    topLeads,
    ventasAyer,
  };
}

/**
 * Formatea el mensaje de briefing.
 */
function formatBriefingMessage(data) {
  const hoy = new Date().toLocaleDateString('es-CO', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Bogota'
  });

  let msg = `📊 *RESUMEN EJECUTIVO — ZONA TRAUMÁTICA*\n`;
  msg += `━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `📅 ${hoy}\n\n`;

  // ── Sección 1: Actividad ──
  msg += `👥 *ACTIVIDAD*\n`;
  msg += `• Clientes nuevos ayer: *${data.clientsYesterday}*\n`;
  msg += `• Clientes esta semana: *${data.clientsThisWeek}*\n`;
  msg += `• Mensajes procesados ayer: *${data.messagesYesterday}*\n`;
  msg += `• Total clientes en CRM: *${data.totalClients}*\n\n`;

  // ── Sección 2: Alertas urgentes ──
  const alertas = [];
  if (data.comprobantesPendientes > 0) {
    alertas.push(`💰 *${data.comprobantesPendientes}* comprobante(s) SIN verificar`);
  }
  if (data.carnetsPendientes > 0) {
    alertas.push(`🪪 *${data.carnetsPendientes}* carnet(s) SIN verificar`);
  }
  if (data.leadsAbandoned > 0) {
    alertas.push(`🔥 *${data.leadsAbandoned}* lead(s) caliente(s) sin atender en 24h+`);
  }

  if (alertas.length > 0) {
    msg += `⚠️ *REQUIERE TU ATENCIÓN*\n`;
    msg += alertas.join('\n') + '\n\n';
  }

  // ── Sección 3: Ventas ──
  if (data.ventasAyer > 0) {
    msg += `✅ *VENTAS AYER:* ${data.ventasAyer} pago(s) confirmado(s)\n\n`;
  }

  // ── Sección 4: Post-venta pendiente ──
  if (data.postventaPendientes.length > 0) {
    msg += `📦 *POST-VENTA PENDIENTE*\n`;
    const statusLabels = {
      'carnet_pendiente_plus': '🪪 Carnets Plus',
      'carnet_pendiente_pro': '🪪 Carnets Pro',
      'despacho_pendiente': '📦 Despachos',
      'bot_asesor_pendiente': '🤖 Bot Asesor',
      'municion_pendiente': '💥 Munición',
    };
    for (const pv of data.postventaPendientes) {
      const label = statusLabels[pv.status] || pv.status;
      msg += `• ${label}: *${pv.count}*\n`;
    }
    msg += '\n';
  }

  // ── Sección 5: Top leads ──
  if (data.topLeads.length > 0) {
    msg += `🎯 *TOP LEADS (por score)*\n`;
    for (let i = 0; i < data.topLeads.length; i++) {
      const lead = data.topLeads[i];
      const emoji = lead.lead_score >= 60 ? '🔥' : lead.lead_score >= 30 ? '⭐' : '•';
      const name = lead.name || lead.phone;
      msg += `${emoji} ${name} — *${lead.lead_score}pts*\n`;
    }
    msg += '\n';
  }

  // ── Sección 6: Pipeline ──
  msg += `📋 *PIPELINE*\n`;
  const statusEmojis = {
    'new': '🆕', 'hot': '🔥', 'assigned': '👤',
    'carnet_pendiente_plus': '🪪', 'carnet_pendiente_pro': '🪪',
    'despacho_pendiente': '📦', 'postventa': '🛠️',
    'completed': '✅', 'afiliado': '🛡️',
    'bot_asesor_pendiente': '🤖', 'municion_pendiente': '💥',
  };
  for (const p of data.pipeline) {
    const emoji = statusEmojis[p.status] || '•';
    msg += `${emoji} ${p.status}: *${p.count}*\n`;
  }

  msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
  msg += `_Panel: http://localhost:3000_`;

  return msg;
}

module.exports = { init, sendDailyBriefing, gatherBriefingData, formatBriefingMessage };
