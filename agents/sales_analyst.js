// ============================================
// agents/sales_analyst.js — Coaching IA de Ventas
// ============================================
// Analiza conversaciones donde se perdieron leads y genera
// un reporte semanal de objeciones + recomendaciones.
// Se envía a Álvaro los lunes a las 8AM COL.

const db = require('../db');
const { geminiGenerate } = require('../gemini');
const { CONFIG } = require('../config');

// Inyección de dependencia
let client = null;

function init(whatsappClient) {
  client = whatsappClient;
}

/**
 * Analiza leads perdidos y genera reporte de coaching.
 */
async function runSalesAnalysis() {
  console.log('[SALES-ANALYST] 🧠 Iniciando análisis de conversaciones perdidas...');

  if (!client) {
    console.log('[SALES-ANALYST] ⚠️ Cliente WhatsApp no inicializado');
    return;
  }

  // 1. Buscar leads perdidos: clientes con ≥3 interacciones que no compraron
  //    y llevan 7+ días sin responder
  const lostLeads = db.db.prepare(`
    SELECT c.phone, c.name, c.memory, c.interaction_count, c.lead_score, c.updated_at
    FROM clients c
    WHERE c.status IN ('new', 'cold', 'warm')
    AND c.interaction_count >= 3
    AND c.ignored = 0 AND c.spam_flag = 0
    AND c.updated_at <= datetime('now', '-7 days')
    ORDER BY c.lead_score DESC
    LIMIT 20
  `).all();

  if (lostLeads.length === 0) {
    console.log('[SALES-ANALYST] ✅ No hay leads perdidos para analizar');
    const chatId = CONFIG.businessPhone + '@c.us';
    await client.sendMessage(chatId, '📊 *Reporte Semanal de Ventas*\n\n✅ Esta semana no se detectaron patrones de leads perdidos significativos. ¡Buen trabajo!');
    return;
  }

  // 2. Extraer conversaciones de cada lead perdido
  let conversationBatch = '';
  let analyzed = 0;

  for (const lead of lostLeads) {
    if (analyzed >= 15) break; // Limitar para no sobrecargar el prompt

    const msgs = db.db.prepare(`
      SELECT role, message, created_at FROM conversations
      WHERE client_phone = ?
      ORDER BY created_at DESC LIMIT 15
    `).all(lead.phone);

    if (msgs.length < 3) continue;

    const convText = msgs.reverse().map(m => 
      `[${m.role === 'user' ? 'CLIENTE' : 'BOT'}]: ${m.message.substring(0, 200)}`
    ).join('\n');

    conversationBatch += `\n--- LEAD #${analyzed + 1}: ${lead.name || 'Sin nombre'} (Score: ${lead.lead_score || 0}) ---\n`;
    conversationBatch += `Perfil: ${(lead.memory || 'Sin datos').substring(0, 200)}\n`;
    conversationBatch += convText + '\n';
    analyzed++;
  }

  if (analyzed === 0) {
    console.log('[SALES-ANALYST] ✅ No hay conversaciones suficientes para analizar');
    return;
  }

  // 3. Enviar a Gemini para análisis
  const prompt = `Eres un consultor de ventas experto en armas traumáticas (defensa personal legal en Colombia). 
Analiza estas ${analyzed} conversaciones donde el bot de Zona Traumática PERDIÓ al cliente (dejó de responder sin comprar).

${conversationBatch}

Genera un REPORTE DE COACHING con:

1. **PATRONES DE OBJECIONES** — ¿Cuáles son las objeciones más comunes? (precio, desconfianza, no encontraron lo que buscaban, etc.)

2. **PRODUCTOS PROBLEMÁTICOS** — ¿Hay productos específicos que generan muchas preguntas pero pocas ventas? ¿Por qué?

3. **MOMENTOS CRÍTICOS** — ¿En qué punto exacto de la conversación se pierde al cliente? (después de dar precio, al preguntar por envío, etc.)

4. **RECOMENDACIONES CONCRETAS** — 3-5 acciones específicas que Zona Traumática puede tomar para mejorar la conversión.

5. **DATO CURIOSO** — Algo interesante que notaste en las conversaciones.

REGLAS:
- Formato WhatsApp (usar *negrita* y emojis)
- Máximo 800 caracteres total
- Sé directo y útil, no rellenes
- Basa todo en las conversaciones reales, no inventes

Escribe SOLO el reporte.`;

  try {
    const result = await geminiGenerate('gemini-2.5-pro', prompt);
    const reporte = result.response.text().trim();

    if (!reporte) {
      console.log('[SALES-ANALYST] ⚠️ Gemini no generó reporte');
      return;
    }

    // 4. Enviar reporte a Álvaro
    const header = `🧠 *COACHING SEMANAL DE VENTAS*\n📊 ${analyzed} conversaciones analizadas\n${'─'.repeat(20)}\n\n`;
    const fullReport = header + reporte;

    const chatId = CONFIG.businessPhone + '@c.us';
    await client.sendMessage(chatId, fullReport);
    console.log(`[SALES-ANALYST] ✅ Reporte de coaching enviado (${analyzed} leads analizados)`);

    // También guardar en la DB como registro
    db.saveMessage(CONFIG.businessPhone, 'assistant', fullReport);

  } catch (err) {
    console.error('[SALES-ANALYST] ❌ Error generando reporte:', err.message);
  }
}

module.exports = { init, runSalesAnalysis };
