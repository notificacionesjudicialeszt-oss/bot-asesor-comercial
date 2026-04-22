// ============================================
// agents/client_recovery.js — Recuperación de Clientes con Pagos Pendientes
// ============================================
// Contacta proactivamente a clientes que pagaron pero tienen solicitudes
// sin resolver. Usa la excusa de "inconveniente con la línea" para
// re-enganche, recolección de datos y resolución de pendientes.
// Soporta TTS (notas de voz) con fallback a texto.
// Se ejecuta manualmente desde el panel (POST /api/run-client-recovery).

const db = require('../db');
const { safeSend } = require('../client_flow');
const { geminiGenerate } = require('../gemini');
const tts = require('../tts');

// ============================================
// SEGMENTOS DE RECUPERACIÓN
// ============================================
const RECOVERY_SEGMENTS = [
  {
    id: 'pistola_sin_docs',
    label: '🔫 Compró pistola — sin documentos/carnet',
    query: `
      SELECT c.* FROM clients c
      WHERE c.has_bought_gun = 1
        AND c.ignored = 0 AND c.spam_flag = 0
        AND c.phone NOT IN (
          SELECT client_phone FROM carnets WHERE estado IN ('enviado', 'aprobado', 'entregado')
        )
        AND c.phone IN (
          SELECT client_phone FROM comprobantes WHERE estado = 'confirmado'
        )
      ORDER BY c.updated_at DESC
      LIMIT 30
    `,
    directiva: `DIRECTIVA PRIORITARIA — RECUPERACIÓN DE CLIENTE:
Este cliente COMPRÓ una pistola traumática y su pago fue CONFIRMADO, pero NO se le han generado los documentos ni el carnet de portador.
Lo contactamos porque tuvimos un inconveniente con nuestra línea y perdimos parte de la información.

TU TAREA (en orden):
1. Si el cliente dice que SÍ fue atendido/resuelto → agradecer, ofrecer cualquier servicio adicional, preguntar si le interesa afiliarse al Club ZT
2. Si el cliente dice que NO fue resuelto o que le falta el carnet/documentos:
   - Recolectar datos faltantes: nombre completo, cédula, ciudad, dirección de envío
   - Preguntar modelo y serial del arma (si no lo tenemos)
   - Confirmar que la pistola ya le llegó
   - Informar que le generaremos su carnet de portador legal en las próximas horas
3. Actualizar TODA la información nueva en tu resumen del cliente
4. NO ofrezcas descuentos ni inventes nada. Solo recolecta datos y resuelve.`
  },
  {
    id: 'club_sin_carnet',
    label: '🏆 Pagó afiliación Club — sin carnet enviado',
    query: `
      SELECT c.* FROM clients c
      WHERE (c.is_club_plus = 1 OR c.is_club_pro = 1)
        AND c.ignored = 0 AND c.spam_flag = 0
        AND c.phone NOT IN (
          SELECT client_phone FROM carnets WHERE estado IN ('enviado', 'aprobado', 'entregado')
        )
        AND c.phone IN (
          SELECT client_phone FROM comprobantes WHERE estado = 'confirmado'
        )
      ORDER BY c.updated_at DESC
      LIMIT 30
    `,
    directiva: `DIRECTIVA PRIORITARIA — RECUPERACIÓN DE CLIENTE:
Este cliente PAGÓ su afiliación al Club Zona Traumática y su pago fue CONFIRMADO, pero NO se le ha enviado el carnet digital.
Lo contactamos porque tuvimos un inconveniente con nuestra línea y perdimos parte de la información.

TU TAREA (en orden):
1. Si dice que SÍ fue atendido → agradecer, verificar que tiene su carnet, ofrecer servicio adicional
2. Si dice que NO:
   - Disculparse genuinamente
   - Recolectar datos faltantes: nombre completo, cédula, ciudad
   - Si tiene arma: marca, modelo, serial
   - Pedir foto de perfil para el carnet (si no la tenemos)
   - Informar que el carnet se generará en las próximas horas
3. Actualizar TODA la información nueva
4. NO inventes datos ni descuentos.`
  },
  {
    id: 'bot_ia_pendiente',
    label: '🤖 Pagó Bot Asesor IA — sin activar',
    query: `
      SELECT c.* FROM clients c
      WHERE c.has_ai_bot = 1
        AND c.ignored = 0 AND c.spam_flag = 0
        AND c.phone IN (
          SELECT client_phone FROM comprobantes WHERE estado = 'confirmado'
            AND tipo = 'bot_asesor'
        )
        AND c.status NOT IN ('completed', 'afiliado', 'carnet_enviado')
      ORDER BY c.updated_at DESC
      LIMIT 30
    `,
    directiva: `DIRECTIVA PRIORITARIA — RECUPERACIÓN DE CLIENTE:
Este cliente PAGÓ el Bot Asesor Legal con IA y su pago fue CONFIRMADO, pero NO se ha verificado su activación.
Lo contactamos porque tuvimos un inconveniente con nuestra línea.

TU TAREA:
1. Si dice que SÍ fue atendido → verificar que el bot funciona bien, ofrecer ayuda
2. Si dice que NO:
   - Disculparse
   - Confirmar su nombre y datos
   - Informar que se activará su acceso en las próximas horas
   - Explicar brevemente cómo funciona el bot asesor
3. Actualizar la información del cliente
4. NO inventes ni prometas cosas que no existen.`
  },
  {
    id: 'despacho_pendiente',
    label: '📦 Despacho pendiente — pagó pero no le ha llegado',
    query: `
      SELECT c.* FROM clients c
      WHERE c.status = 'despacho_pendiente'
        AND c.ignored = 0 AND c.spam_flag = 0
        AND c.phone IN (
          SELECT client_phone FROM comprobantes WHERE estado = 'confirmado'
        )
      ORDER BY c.updated_at DESC
      LIMIT 30
    `,
    directiva: `DIRECTIVA PRIORITARIA — RECUPERACIÓN DE CLIENTE:
Este cliente PAGÓ por un producto (pistola/dispositivo) y su pago fue CONFIRMADO, pero el despacho está PENDIENTE (puede que no le haya llegado aún).
Lo contactamos porque tuvimos un inconveniente con nuestra línea.

TU TAREA:
1. Si dice que SÍ le llegó → confirmar satisfacción, ofrecer afiliación al Club ZT si no la tiene
2. Si dice que NO le ha llegado:
   - Disculparse
   - Confirmar datos de envío: nombre completo, ciudad, dirección exacta
   - Verificar qué producto esperaba
   - Informar que se priorizará su despacho
3. Actualizar toda la información
4. NO inventes guías de envío ni tiempos de entrega falsos.`
  },
  {
    id: 'esperando_datos_arma',
    label: '📋 Esperando datos del arma — proceso incompleto',
    query: `
      SELECT c.* FROM clients c
      WHERE c.status = 'esperando_datos_arma'
        AND c.ignored = 0 AND c.spam_flag = 0
      ORDER BY c.updated_at DESC
      LIMIT 30
    `,
    directiva: `DIRECTIVA PRIORITARIA — RECUPERACIÓN DE CLIENTE:
Este cliente tiene un proceso incompleto — estábamos esperando los datos de su arma para completar la documentación.
Lo contactamos porque tuvimos un inconveniente con nuestra línea y perdimos parte de la información.

TU TAREA:
1. Si dice que ya lo resolvió → confirmar y cerrar
2. Si dice que NO:
   - Pedir datos del arma: marca, modelo, serial
   - Confirmar nombre completo y cédula
   - Si necesita carnet, pedir foto de perfil
3. Actualizar la memoria del cliente
4. NO inventes datos.`
  },
  {
    id: 'ayuda_juridica',
    label: '⚖️ Pagó ayuda jurídica — sin resolver',
    query: `
      SELECT c.* FROM clients c
      WHERE c.ignored = 0 AND c.spam_flag = 0
        AND c.phone IN (
          SELECT client_phone FROM comprobantes WHERE estado = 'confirmado'
            AND (tipo LIKE '%juridic%' OR tipo LIKE '%legal%' OR info LIKE '%juridic%' OR info LIKE '%tutela%' OR info LIKE '%derecho%')
        )
        AND c.status NOT IN ('completed', 'afiliado', 'carnet_enviado')
      ORDER BY c.updated_at DESC
      LIMIT 30
    `,
    directiva: `DIRECTIVA PRIORITARIA — RECUPERACIÓN DE CLIENTE:
Este cliente PAGÓ por un servicio de ayuda jurídica (tutela, derecho de petición, asesoría legal) y su pago fue CONFIRMADO.
Lo contactamos porque tuvimos un inconveniente con nuestra línea.

TU TAREA:
1. Si dice que SÍ fue atendido → verificar satisfacción, ofrecer servicios adicionales
2. Si dice que NO:
   - Disculparse
   - Preguntar específicamente qué servicio jurídico necesita
   - Recolectar: nombre completo, cédula, ciudad, descripción del caso
   - Informar que se le asignará atención prioritaria
3. Actualizar toda la información
4. NO des asesoría legal directa en este primer contacto, solo recolecta info.`
  }
];

// ============================================
// OBTENER CANDIDATOS (Dry Run)
// ============================================

/**
 * Consulta la DB y retorna los clientes candidatos por segmento
 * sin enviar ningún mensaje. Útil para revisar antes de ejecutar.
 * @returns {{ segment: string, label: string, clients: object[] }[]}
 */
function getRecoveryCandidates() {
  const results = [];

  for (const segment of RECOVERY_SEGMENTS) {
    try {
      const rawClients = db.db.prepare(segment.query).all();

      // Filtrar los que ya fueron contactados por este agente
      const clients = rawClients.filter(client => {
        const existing = db.db.prepare(
          "SELECT id FROM followup_sequences WHERE client_phone = ? AND type = 'recovery_outreach'"
        ).get(client.phone);
        return !existing;
      });

      results.push({
        segment: segment.id,
        label: segment.label,
        clients: clients.map(c => ({
          phone: c.phone,
          name: c.name || 'Sin nombre',
          status: c.status,
          memory: (c.memory || '').substring(0, 200),
          has_bought_gun: c.has_bought_gun,
          is_club_plus: c.is_club_plus,
          is_club_pro: c.is_club_pro,
          has_ai_bot: c.has_ai_bot,
          updated_at: c.updated_at
        }))
      });
    } catch (err) {
      console.error(`[RECOVERY] Error en segmento ${segment.id}:`, err.message);
      results.push({ segment: segment.id, label: segment.label, clients: [], error: err.message });
    }
  }

  return results;
}

// ============================================
// GENERAR MENSAJE PERSONALIZADO
// ============================================

async function generateRecoveryMessage(client, segment) {
  const nombre = client.name || 'Cliente';
  const memoria = client.memory || 'Sin datos previos';

  const prompt = `Eres un asesor profesional de Zona Traumática (tienda de armas traumáticas legales en Colombia).

CONTEXTO: Tuvimos un inconveniente técnico con nuestra línea telefónica y perdimos parte de la información de algunos clientes.
Necesitas escribirle a este cliente para:
1. Disculparte brevemente por el inconveniente
2. Preguntar si su solicitud ya fue resuelta
3. Ofrecerte a ayudarle si hay algo pendiente

DATOS DEL CLIENTE:
- Nombre: ${nombre}
- Segmento: ${segment.label}
- Memoria/Perfil: ${memoria}

REGLAS ESTRICTAS:
1. Máximo 5-6 líneas
2. Tono: profesional pero cálido, genuino, NO robótico
3. Usa el nombre del cliente si lo tienes
4. NO digas que eres un bot ni que es un mensaje automático
5. NO ofrezcas descuentos ni inventes nada
6. Empieza con un saludo natural y la disculpa
7. Máximo 3 emojis
8. Hazlo sonar como si fueras un humano que se acuerda de él/ella
9. Sé específico sobre qué servicio contrató (según el segmento)
10. Termina con pregunta abierta para que responda
11. IMPORTANTE: Este texto será leído como nota de voz, así que escríbelo de forma conversacional y natural, como si estuvieras hablando (sin usar formato de texto como asteriscos, negritas ni bullets)

Escribe SOLO el mensaje, sin explicaciones.`;

  try {
    const result = await geminiGenerate('gemini-2.5-pro', prompt);
    return result.response.text().trim();
  } catch (err) {
    console.error(`[RECOVERY] Error generando mensaje para ${client.phone}:`, err.message);
    // Fallback genérico
    const primerNombre = nombre !== 'Cliente' ? ' ' + nombre.split(' ')[0] : '';
    return `Hola${primerNombre}, te saluda el equipo de Zona Traumática. Te escribo porque tuvimos un inconveniente con nuestra línea y perdimos parte de la información de algunos clientes. Quería verificar si tu solicitud ya fue atendida o si hay algo pendiente que podamos resolver. ¿Me podrías confirmar? Estamos para servirte.`;
  }
}

// ============================================
// EJECUCIÓN PRINCIPAL
// ============================================

/**
 * Ejecuta la recuperación de clientes.
 * @param {object} opts
 * @param {number} opts.maxPerRun - Máximo de mensajes por ejecución (default: 10)
 * @param {string[]} opts.segments - Filtrar por IDs de segmento (default: todos)
 * @returns {{ sent: number, skipped: number, errors: number, details: object[] }}
 */
async function runClientRecovery(opts = {}) {
  const maxPerRun = opts.maxPerRun || 10;
  const segmentFilter = opts.segments || null;

  console.log('[RECOVERY] 🔍 Iniciando recuperación de clientes con pagos pendientes...');

  const colHour = getColombiaHour();
  if (colHour < 8 || colHour >= 20) {
    console.log(`[RECOVERY] ⏸️ Fuera de horario (${colHour}h COL) — saltando`);
    return { sent: 0, skipped: 0, errors: 0, details: [], message: 'Fuera de horario (8AM-8PM COL)' };
  }

  let totalSent = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  const details = [];

  const segmentsToRun = segmentFilter
    ? RECOVERY_SEGMENTS.filter(s => segmentFilter.includes(s.id))
    : RECOVERY_SEGMENTS;

  for (const segment of segmentsToRun) {
    if (totalSent >= maxPerRun) break;

    try {
      const rawClients = db.db.prepare(segment.query).all();

      // Filtrar ya contactados
      const clients = rawClients.filter(client => {
        const existing = db.db.prepare(
          "SELECT id FROM followup_sequences WHERE client_phone = ? AND type = 'recovery_outreach'"
        ).get(client.phone);
        return !existing;
      });

      if (clients.length === 0) {
        console.log(`[RECOVERY] ${segment.label}: 0 pendientes`);
        continue;
      }

      console.log(`[RECOVERY] ${segment.label}: ${clients.length} cliente(s) pendiente(s)`);

      for (const client of clients) {
        if (totalSent >= maxPerRun) break;

        try {
          // 1. Generar mensaje personalizado
          const mensaje = await generateRecoveryMessage(client, segment);
          if (!mensaje) {
            totalErrors++;
            continue;
          }

          // 2. Intentar enviar como nota de voz (TTS) con fallback a texto
          const voiceSent = await tts.sendVoiceNote(client.phone, mensaje);
          if (!voiceSent) {
            // Fallback a texto
            await safeSend(client.phone, mensaje);
          }
          db.saveMessage(client.phone, 'assistant', mensaje);

          // 3. Inyectar bot_directive para el seguimiento
          db.upsertClient(client.phone, {
            bot_directive: segment.directiva
          });

          // 4. Registrar en followup_sequences para no duplicar
          db.upsertSequence(client.phone, 'recovery_outreach', 1);

          totalSent++;
          details.push({
            phone: client.phone,
            name: client.name || 'Sin nombre',
            segment: segment.id,
            sentAs: voiceSent ? 'voz' : 'texto',
            message: mensaje.substring(0, 100) + '...',
            status: 'sent'
          });

          console.log(`[RECOVERY] ✅ (${totalSent}/${maxPerRun}) ${segment.label} → ${client.name || client.phone} [${voiceSent ? '🎤 voz' : '💬 texto'}]`);

          // 5. Anti-ban delay (45-90s)
          if (totalSent < maxPerRun) {
            const delay = Math.floor(Math.random() * 45000) + 45000;
            console.log(`[RECOVERY] 🛡️ Anti-ban: ${Math.round(delay / 1000)}s...`);
            await new Promise(r => setTimeout(r, delay));
          }

        } catch (err) {
          totalErrors++;
          details.push({
            phone: client.phone,
            name: client.name || 'Sin nombre',
            segment: segment.id,
            status: 'error',
            error: err.message
          });
          console.error(`[RECOVERY] ❌ Error con ${client.phone}:`, err.message);
          await new Promise(r => setTimeout(r, 3000));
        }
      }

    } catch (err) {
      console.error(`[RECOVERY] ❌ Error en segmento ${segment.id}:`, err.message);
      totalErrors++;
    }
  }

  const summary = `[RECOVERY] 📊 Resultado: ${totalSent} enviados, ${totalSkipped} omitidos, ${totalErrors} errores`;
  console.log(summary);

  return { sent: totalSent, skipped: totalSkipped, errors: totalErrors, details };
}

// ============================================
// UTILIDADES
// ============================================

function getColombiaHour() {
  const ahora = new Date();
  const utcMinutes = ahora.getUTCHours() * 60 + ahora.getUTCMinutes();
  const colMinutes = ((utcMinutes - 5 * 60) % (24 * 60) + 24 * 60) % (24 * 60);
  return Math.floor(colMinutes / 60);
}

module.exports = { runClientRecovery, getRecoveryCandidates };
