// ============================================
// agents/onboarding.js — Onboarding Club ZT
// ============================================
// Secuencia de 5 mensajes en 7 días para nuevos afiliados.
// Se activa cuando el status cambia a carnet_pendiente_plus/pro.

const db = require('../db');
const { safeSend } = require('../client_flow');

// Secuencia de onboarding (5 pasos en 7 días)
const ONBOARDING_STEPS = [
  {
    step: 1,
    minHoursAfterPrev: 0, // Inmediato (o al primer ciclo del scheduler)
    getMessage: (client, plan) => {
      const nombre = client.name || 'Crack';
      // Verificar si los datos para el carnet ya están completos
      const tieneNombre = client.name && client.name.trim() !== '';
      const tieneCedula = client.cedula && client.cedula.trim() !== '';
      const tieneArma = client.modelo_arma && client.modelo_arma.trim() !== '';
      const datosCompletos = tieneNombre && tieneCedula && tieneArma;

      if (datosCompletos) {
        // Verificar si ya tiene carnet generado en la tabla carnets
        try {
          const carnetExiste = db.db.prepare(
            "SELECT id FROM carnets WHERE phone = ? AND estado IN ('enviado', 'aprobado', 'entregado') LIMIT 1"
          ).get(client.phone);
          if (carnetExiste) {
            return `¡Bienvenido al Club ZT, ${nombre}! 🏆🎉\n\nYa eres parte de la familia. Tu carnet digital ${plan} ya fue generado y enviado. Si no lo encuentras en el chat, escríbenos y te lo reenviamos 🙌`;
          }
        } catch(e) { /* tabla puede no existir */ }
        return `¡Bienvenido al Club ZT, ${nombre}! 🏆🎉\n\nYa eres parte de la familia. Tenemos tus datos listos y estamos finalizando tu carnet digital de afiliado ${plan}. ¡En breve te lo enviamos por WhatsApp! 🙌`;
      }
      return `¡Bienvenido al Club ZT, ${nombre}! 🏆🎉\n\nYa eres parte de la familia. Estamos preparando tu carnet digital de afiliado ${plan}.\n\nSi aún no nos has enviado tu foto de perfil y datos para el carnet, envíalos por aquí y te lo generamos lo más pronto posible 📸`;
    }
  },
  {
    step: 2,
    minHoursAfterPrev: 24, // Día 1
    getMessage: (client, plan) => {
      return `📚 Tip #1 para afiliados Club ZT:\n\n¿Ya conoces tu Carpeta Jurídica? Es el respaldo legal que te protege como portador de arma traumática. Incluye todo lo que necesitas saber sobre la Ley 2197 de 2022.\n\n¡Pregúntame lo que quieras sobre temas legales! 🛡️`;
    }
  },
  {
    step: 3,
    minHoursAfterPrev: 48, // Día 3
    getMessage: (client, plan) => {
      const beneficios = plan === 'PRO' 
        ? '• Descuento especial en munición\n• Acceso al campo de tiro\n• Bot Asesor Legal 24/7\n• Seguro de defensa legal'
        : '• Descuento especial en munición\n• Acceso al campo de tiro\n• Carpeta jurídica digital completa';
      return `💪 ¿Sabías todos los beneficios que tienes como afiliado ${plan}?\n\n${beneficios}\n\n¿Ya aprovechaste alguno? Cuéntame 😎`;
    }
  },
  {
    step: 4,
    minHoursAfterPrev: 48, // Día 5
    getMessage: (client, plan) => {
      return `⚖️ Tip legal del Club ZT:\n\nSi alguna vez te detiene la policía portando tu arma traumática, recuerda:\n\n1️⃣ Muestra tu carnet digital del Club ZT\n2️⃣ Cita la Ley 2197 de 2022 — las armas traumáticas NO requieren permiso\n3️⃣ Mantén la calma, eres 100% legal\n\n¡Para eso estamos! 🛡️`;
    }
  },
  {
    step: 5,
    minHoursAfterPrev: 48, // Día 7
    getMessage: (client, plan) => {
      const nombre = client.name || 'crack';
      return `Hola ${nombre}! 🤖\n\n¿Sabías que como afiliado tienes acceso al Bot Asesor Legal 24/7? Puedes preguntarme cualquier duda sobre:\n\n• Porte y tenencia de armas traumáticas\n• Procedimientos policiales\n• Tu carpeta jurídica digital\n• Renovación de tu afiliación\n\n¿Tienes alguna duda? ¡Estoy aquí para ayudarte! 💬`;
    }
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
 * Determina el plan del afiliado (PLUS o PRO) basado en su status.
 */
function getPlan(client) {
  if (client.status === 'carnet_pendiente_pro' || client.is_club_pro) return 'PRO';
  return 'PLUS';
}

/**
 * Ejecuta el motor de onboarding.
 */
async function runOnboarding() {
  const colHour = getColombiaHour();

  // Solo entre 8AM y 8PM hora Colombia
  if (colHour < 8 || colHour >= 20) {
    console.log(`[ONBOARDING] ⏸️ Fuera de horario (${colHour}h COL) — saltando`);
    return;
  }

  console.log('[ONBOARDING] 🎓 Verificando secuencias de onboarding...');

  // 1. Buscar nuevos afiliados sin secuencia de onboarding
  const nuevosAfiliados = db.db.prepare(`
    SELECT * FROM clients
    WHERE (status = 'carnet_pendiente_plus' OR status = 'carnet_pendiente_pro')
    AND status NOT IN ('carnet_enviado', 'afiliado', 'completed')
    AND ignored = 0 AND spam_flag = 0
    AND phone IN (
      SELECT client_phone FROM comprobantes WHERE estado = 'confirmado'
    )
    AND phone NOT IN (
      SELECT phone FROM carnets WHERE estado IN ('enviado', 'aprobado', 'entregado')
    )
    ORDER BY updated_at DESC
  `).all();

  // Auto-stop onboarding sequences for clients who already received their carnet
  try {
    const yaEntregados = db.db.prepare(`
      SELECT phone FROM clients
      WHERE status IN ('carnet_enviado', 'afiliado', 'completed')
    `).all();
    for (const c of yaEntregados) {
      const seq = db.getSequenceForClient(c.phone, 'onboarding');
      if (seq && seq.status !== 'completed') {
        db.stopSequence(seq.id);
        console.log(`[ONBOARDING] 🛑 Secuencia detenida para ${c.phone} (ya tiene carnet)`);
      }
    }
  } catch (e) {
    // Non-critical
    console.warn('[ONBOARDING] ⚠️ Error limpiando secuencias:', e.message);
  }

  let sent = 0;

  for (const client of nuevosAfiliados) {
    const plan = getPlan(client);
    const seq = db.getSequenceForClient(client.phone, 'onboarding');

    if (seq) {
      // Verificar si ya completó la secuencia
      if (seq.step >= 5) {
        db.stopSequence(seq.id);
        console.log(`[ONBOARDING] 🎉 ${client.name || client.phone} — onboarding completo`);
        continue;
      }

      // Verificar timing para siguiente paso
      const nextStepConfig = ONBOARDING_STEPS.find(s => s.step === seq.step + 1);
      if (!nextStepConfig) continue;

      const lastSent = new Date(seq.last_sent_at);
      const hoursSince = (Date.now() - lastSent.getTime()) / (1000 * 60 * 60);
      if (hoursSince < nextStepConfig.minHoursAfterPrev) continue;

      // Enviar siguiente paso
      const message = nextStepConfig.getMessage(client, plan);
      try {
        await safeSend(client.phone, message);
        db.saveMessage(client.phone, 'assistant', message);
        db.upsertSequence(client.phone, 'onboarding', nextStepConfig.step);
        sent++;
        console.log(`[ONBOARDING] ✅ Paso ${nextStepConfig.step}/5 enviado a ${client.name || client.phone} (${plan})`);
      } catch (err) {
        console.error(`[ONBOARDING] ❌ Error enviando a ${client.phone}:`, err.message);
      }
    } else {
      // Nuevo afiliado — iniciar secuencia
      // Verificar que el status fue cambiado hace al menos 30 minutos (evitar spam si recién llegó)
      const statusAge = (Date.now() - new Date(client.updated_at).getTime()) / (1000 * 60);
      if (statusAge < 30) continue;

      const firstStep = ONBOARDING_STEPS[0];
      const message = firstStep.getMessage(client, plan);
      try {
        await safeSend(client.phone, message);
        db.saveMessage(client.phone, 'assistant', message);
        db.upsertSequence(client.phone, 'onboarding', 1);
        sent++;
        console.log(`[ONBOARDING] 🆕 Secuencia iniciada para ${client.name || client.phone} (${plan})`);
      } catch (err) {
        console.error(`[ONBOARDING] ❌ Error iniciando onboarding para ${client.phone}:`, err.message);
      }
    }

    // Anti-ban delay
    if (sent > 0) {
      const delay = Math.floor(Math.random() * 30000) + 30000;
      await new Promise(r => setTimeout(r, delay));
    }
  }

  console.log(`[ONBOARDING] ✅ Completado — ${sent} mensajes, ${nuevosAfiliados.length} afiliados monitoreados`);
}

module.exports = { runOnboarding };
