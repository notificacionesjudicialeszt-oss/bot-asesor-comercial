// ============================================
// agents/postventa_resolver.js — Clasificador de Postventa con IA
// ============================================
// Escanea TODOS los clientes en cualquier status de postventa,
// lee su historial completo + memoria, usa Gemini para entender
// qué hay pendiente de resolver, y:
//   1. Reclasifica el status a la categoría correcta si estaba mal
//   2. Crea una escalación pendiente con un resumen claro de qué falta
// NO habla con clientes — solo analiza y organiza para que Álvaro
// pueda dar buen servicio post-venta.

const db = require('../db');
const { geminiGenerate } = require('../gemini');

// TODOS los status que pertenecen a postventa en el panel
const PV_STATUSES = [
  'postventa',
  'carnet_pendiente_plus',
  'carnet_pendiente_pro',
  'despacho_pendiente',
  'municion_pendiente',
  'recuperacion_pendiente',
  'bot_asesor_pendiente',
];

const CATEGORY_LABELS = {
  carnet_pendiente_plus: '🟢 Carnet Club Plus pendiente',
  carnet_pendiente_pro: '🔴 Carnet Club Pro pendiente',
  despacho_pendiente: '📦 Despacho de dispositivo pendiente',
  municion_pendiente: '🔫 Envío de munición pendiente',
  recuperacion_pendiente: '🔄 Recuperación/garantía pendiente',
  bot_asesor_pendiente: '🤖 Activación bot asesor IA pendiente',
  devolucion_pendiente: '💸 Devolución/reembolso pendiente',
  postventa: '🛠️ Postventa (requiere revisión manual)',
};

/**
 * Ejecuta el scan completo de postventa.
 * Busca TODOS los clientes en cualquier status de postventa y analiza cada uno.
 */
async function runPostventaResolver() {
  console.log('[PV-RESOLVER] 🔍 Iniciando escaneo completo de postventa...');

  // Obtener TODOS los clientes en cualquier status de postventa
  const placeholders = PV_STATUSES.map(() => '?').join(', ');
  const clients = db.db.prepare(`
    SELECT phone, name, memory, status, updated_at
    FROM clients
    WHERE status IN (${placeholders})
    ORDER BY updated_at DESC
    LIMIT 60
  `).all(...PV_STATUSES);

  if (clients.length === 0) {
    console.log('[PV-RESOLVER] ✅ No hay clientes en postventa');
    return { processed: 0 };
  }

  console.log(`[PV-RESOLVER] 📋 ${clients.length} clientes en postventa por analizar`);

  // Verificar si ya hay escalaciones pendientes O resueltas recientemente (evitar duplicados)
  // Un cliente se salta si tiene: escalación pendiente, o si fue gestionada/descartada en las últimas 48h
  const existingEscalaciones = new Set();
  try {
    const existing = db.db.prepare(`
      SELECT client_phone FROM escalaciones
      WHERE estado = 'pendiente'
         OR (estado IN ('gestionada', 'descartada') AND resolved_at >= datetime('now', '-48 hours'))
    `).all();
    existing.forEach(e => existingEscalaciones.add(e.client_phone));
  } catch (e) { /* tabla puede no existir aún */ }

  let analyzed = 0;
  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const client of clients) {
    try {
      // Si ya tiene escalación pendiente, no duplicar
      if (existingEscalaciones.has(client.phone)) {
        skipped++;
        continue;
      }

      // Obtener historial AMPLIO (últimos 50 mensajes para tener contexto completo)
      const history = db.getConversationHistory(client.phone, 50);
      const histText = history.map(h =>
        `${h.role === 'user' ? 'CLIENTE' : h.role === 'assistant' ? 'BOT' : 'SISTEMA'}: ${h.message}`
      ).join('\n');

      if (!histText && !client.memory) {
        console.log(`[PV-RESOLVER] ⏭️ ${client.phone} sin historial ni memoria — saltando`);
        skipped++;
        continue;
      }

      // Usar Gemini para analizar y crear resumen accionable
      const prompt = `Eres un analista de postventa de Zona Traumática (tienda de armas traumáticas legales en Colombia).

CONTEXTO DEL NEGOCIO:
- Vendemos dispositivos (armas traumáticas), munición, y membresías Club ZT (Plus y Pro)
- Club Plus ($100.000/año) y Club Pro ($150.000/año): incluyen carnet, respaldo legal, acceso a línea de tiro
- También vendemos acceso a un Bot Asesor Legal con IA ($79.900)
- Los despachos se hacen por Servientrega/Coordinadora a todo Colombia

CLIENTE: ${client.name || 'Sin nombre'} (${client.phone})
STATUS ACTUAL EN CRM: ${client.status}

MEMORIA CRM:
${client.memory || 'Sin datos'}

CONVERSACIÓN COMPLETA (${history.length} mensajes):
${histText || 'Sin historial'}

TAREA: Analiza TODO el contexto y responde con un JSON que me ayude a entender:
1. ¿Qué está PENDIENTE de resolver con este cliente? (ser específico)
2. ¿Cuál es la categoría correcta?
3. ¿Qué tan urgente es?

Categorías válidas:
- carnet_pendiente_plus → Falta generar/entregar carnet Club Plus
- carnet_pendiente_pro → Falta generar/entregar carnet Club Pro
- despacho_pendiente → Falta enviar dispositivo/arma comprado
- municion_pendiente → Falta enviar munición
- recuperacion_pendiente → Problema con dispositivo (garantía, daño, revisión técnica)
- bot_asesor_pendiente → Falta activar acceso al bot asesor legal IA
- devolucion_pendiente → El cliente pidió devolución o reembolso
- postventa → No encaja o falta info para clasificar

Responde SOLO con JSON:
{"categoria": "...", "resumen": "Descripción clara y específica de qué falta resolver (max 150 chars)", "urgencia": "alta|media|baja", "accion_sugerida": "Qué debería hacer Álvaro como siguiente paso (max 100 chars)"}`;

      const result = await geminiGenerate('gemini-2.5-pro', prompt);
      const responseText = result.response.text().trim().replace(/```json|```/g, '').trim();

      let parsed;
      try {
        parsed = JSON.parse(responseText);
      } catch (parseErr) {
        console.error(`[PV-RESOLVER] ❌ JSON inválido para ${client.phone}: ${responseText.substring(0, 100)}`);
        errors++;
        continue;
      }

      const { categoria, resumen, urgencia, accion_sugerida } = parsed;

      // Validar categoría
      if (!CATEGORY_LABELS[categoria]) {
        console.warn(`[PV-RESOLVER] ⚠️ Categoría desconocida: ${categoria} — usando status actual`);
        continue;
      }

      // NO reclasificar automáticamente — solo sugerir en la escalación
      // Los cambios de status los hace Álvaro desde el panel (previene errores de la IA)
      if (categoria !== client.status) {
        console.log(`[PV-RESOLVER] 💡 ${client.phone} — IA sugiere reclasificar: ${client.status} → ${categoria} (NO aplicado, solo escalado)`);
      }

      // Crear escalación con el resumen completo
      const urgenciaEmoji = urgencia === 'alta' ? '🔴' : urgencia === 'media' ? '🟡' : '🟢';
      const triggerMsg = `${urgenciaEmoji} ${CATEGORY_LABELS[categoria]}\n📝 ${resumen}${accion_sugerida ? '\n👉 ' + accion_sugerida : ''}`;

      db.saveEscalacion(
        client.phone,
        client.name || '',
        'postventa',
        triggerMsg,
        client.memory || '',
        histText.substring(0, 500)
      );

      analyzed++;
      created++;
      console.log(`[PV-RESOLVER] ✅ ${client.phone} (${client.name || 'N/A'}) → ${categoria} (${urgencia}): ${resumen}`);

      // Pausa entre llamadas a Gemini (1.5s)
      await new Promise(r => setTimeout(r, 1500));

    } catch (err) {
      errors++;
      console.error(`[PV-RESOLVER] ❌ Error procesando ${client.phone}:`, err.message);
      // Pausa extra en caso de error (rate limit, etc.)
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  const summary = `[PV-RESOLVER] 📊 Resultado: ${analyzed} analizados, ${created} escalaciones creadas, ${skipped} ya tenían escalación, ${errors} errores`;
  console.log(summary);

  return { processed: clients.length, analyzed, created, skipped, errors };
}

module.exports = { runPostventaResolver };
