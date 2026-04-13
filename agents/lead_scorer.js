// ============================================
// agents/lead_scorer.js — Puntuación automática de leads
// ============================================
// Calcula un puntaje 0-100 para cada cliente activo
// basado en señales de intención de compra.
// Se ejecuta periódicamente vía scheduler.js

const db = require('../db');

/**
 * Calcula el lead score para UN cliente.
 * @param {Object} client - Registro de la tabla clients
 * @returns {number} Score de 0 a 100
 */
function calculateScore(client) {
  let score = 0;

  // ── 1. Interacciones (más mensajes = más interés) ──
  // +2 por interacción, máximo 20 puntos
  const interactionPoints = Math.min((client.interaction_count || 0) * 2, 20);
  score += interactionPoints;

  // ── 2. Análisis de memoria (intención de compra) ──
  const memory = (client.memory || '').toLowerCase();

  // Palabras de alta intención (+15)
  const highIntentWords = ['comprar', 'listo', 'pagar', 'quiero', 'lo llevo', 'me interesa', 'separame'];
  if (highIntentWords.some(w => memory.includes(w))) {
    score += 15;
  }

  // Palabras de interés medio (+10)
  const medIntentWords = ['precio', 'presupuesto', 'interesado', 'cotizar', 'cuesta', 'vale'];
  if (medIntentWords.some(w => memory.includes(w))) {
    score += 10;
  }

  // Preguntó por envío/despacho (+10) — señal fuerte de compra inminente
  const shippingWords = ['envío', 'envio', 'despacho', 'dirección', 'direccion', 'ciudad'];
  if (shippingWords.some(w => memory.includes(w))) {
    score += 10;
  }

  // Preguntó por Club ZT (+5)
  const clubWords = ['club', 'afiliación', 'afiliacion', 'plan plus', 'plan pro', 'membresía', 'membresia'];
  if (clubWords.some(w => memory.includes(w))) {
    score += 5;
  }

  // ── 3. Comprobantes pendientes (+30) / confirmados (+50) ──
  try {
    const compPendiente = db.db.prepare(
      "SELECT COUNT(*) as c FROM comprobantes WHERE client_phone = ? AND estado = 'pendiente'"
    ).get(client.phone);
    if (compPendiente && compPendiente.c > 0) {
      score += 30;
    }
    const compConfirmado = db.db.prepare(
      "SELECT COUNT(*) as c FROM comprobantes WHERE client_phone = ? AND estado = 'confirmado'"
    ).get(client.phone);
    if (compConfirmado && compConfirmado.c > 0) {
      score += 50; // Ya pagó confirmado — prioridad máxima
    }
  } catch (e) { /* silencioso */ }

  // ── 4. Status del cliente ──
  if (client.status === 'hot' || client.status === 'assigned') {
    score += 15;
  } else if (client.status === 'new' && (client.interaction_count || 0) >= 3) {
    score += 10; // nuevo pero con varias interacciones = interesado
  }

  // ── 5. Recencia — penalizar inactividad ──
  // -3 por día sin actividad, máximo -30
  if (client.updated_at) {
    const lastUpdate = new Date(client.updated_at);
    const now = new Date();
    const daysSince = Math.floor((now - lastUpdate) / (1000 * 60 * 60 * 24));
    const recencyPenalty = Math.min(daysSince * 3, 30);
    score -= recencyPenalty;
  }

  // ── 6. Ya compró → reducir prioridad (ya no es "lead") ──
  if (client.is_club_plus || client.is_club_pro || client.has_bought_gun) {
    score -= 20;
  }

  // Clamp entre 0 y 100
  return Math.max(0, Math.min(100, score));
}

/**
 * Ejecuta el scoring para TODOS los clientes activos.
 * @returns {{ updated: number, topLeads: Array }} Resultado del scoring
 */
function runScoring() {
  console.log('[LEAD-SCORER] 🎯 Iniciando cálculo de lead scores...');

  // Solo puntuar clientes no ignorados y no spam
  const clients = db.db.prepare(`
    SELECT * FROM clients
    WHERE ignored = 0 AND spam_flag = 0
    ORDER BY updated_at DESC
  `).all();

  let updated = 0;
  const scores = [];

  for (const client of clients) {
    const newScore = calculateScore(client);
    const currentScore = client.lead_score || 0;

    // Solo actualizar si cambió (evitar escrituras innecesarias)
    if (newScore !== currentScore) {
      db.db.prepare(
        'UPDATE clients SET lead_score = ? WHERE phone = ?'
      ).run(newScore, client.phone);
      updated++;
    }

    scores.push({ phone: client.phone, name: client.name, score: newScore });
  }

  // Ordenar por score descendente para obtener top leads
  scores.sort((a, b) => b.score - a.score);
  const topLeads = scores.filter(s => s.score >= 30).slice(0, 10);

  console.log(`[LEAD-SCORER] ✅ ${clients.length} clientes analizados, ${updated} scores actualizados`);
  if (topLeads.length > 0) {
    console.log(`[LEAD-SCORER] 🔥 Top leads: ${topLeads.map(l => `${l.name || l.phone}(${l.score})`).join(', ')}`);
  }

  return { updated, topLeads, total: clients.length };
}

module.exports = { runScoring, calculateScore };
