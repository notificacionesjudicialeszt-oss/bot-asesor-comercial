// ============================================
// agents/scheduler.js — Cronjob Central de Agentes
// ============================================
// Dispara los agentes proactivos a horas programadas.
// Timezone: Colombia (UTC-5)
// Patrón de reloj reutilizado de broadcasters.js

const { runScoring } = require('./lead_scorer');
const dailyBriefing = require('./daily_briefing');
const { runFollowups } = require('./followup_engine');
const { runPaymentReminders } = require('./payment_reminder');
const { runDespachoTracker } = require('./despacho_tracker');
const { runOnboarding } = require('./onboarding');
const { runCampaigns } = require('./campaign_engine');
const salesAnalyst = require('./sales_analyst');
const { runPostventaResolver } = require('./postventa_resolver');

// Inyección de dependencia
let client = null;

function init(whatsappClient) {
  client = whatsappClient;
  dailyBriefing.init(whatsappClient);
  salesAnalyst.init(whatsappClient);
}

// ============================================
// UTILIDADES DE TIMEZONE (Colombia = UTC-5)
// ============================================

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
 * Calcula ms hasta la próxima hora objetivo (Colombia)
 * @param {number[]} targetHours - Array de horas en las que ejecutar
 * @returns {number} Milisegundos hasta la próxima ejecución
 */
function getMsUntilNext(targetHours) {
  const ahora = new Date();
  const utcMinutes = ahora.getUTCHours() * 60 + ahora.getUTCMinutes();
  const colMinutes = ((utcMinutes - 5 * 60) % (24 * 60) + 24 * 60) % (24 * 60);
  const colHora = Math.floor(colMinutes / 60);
  const colMin = colMinutes % 60;

  let proximaHora = targetHours.find(h => h > colHora || (h === colHora && colMin === 0));
  if (proximaHora === undefined) {
    proximaHora = targetHours[0] + 24; // mañana
  }

  const minutosRestantes = proximaHora * 60 - colMinutes;
  return Math.max(minutosRestantes * 60 * 1000, 60000); // mínimo 1 minuto
}

// ============================================
// PROGRAMADORES
// ============================================

/**
 * Programa el briefing diario (7:00 AM hora Colombia)
 */
function scheduleBriefing() {
  const BRIEFING_HOURS = [7];

  function scheduleNext() {
    const msEspera = getMsUntilNext(BRIEFING_HOURS);
    const horasEspera = Math.floor((msEspera / 1000) / 3600);
    const minsEspera = Math.round(((msEspera / 1000) % 3600) / 60);
    console.log(`[SCHEDULER] 📊 Próximo briefing en ${horasEspera}h ${minsEspera}m`);

    setTimeout(async () => {
      try {
        await dailyBriefing.sendDailyBriefing();
      } catch (err) {
        console.error('[SCHEDULER] Error en briefing:', err.message);
      }
      scheduleNext();
    }, msEspera);
  }

  scheduleNext();
}

/**
 * Programa el lead scoring (cada 6 horas: 7AM, 1PM, 7PM, 1AM)
 */
function scheduleLeadScoring() {
  const SCORING_HOURS = [7, 13, 19, 1];

  function scheduleNext() {
    const msEspera = getMsUntilNext(SCORING_HOURS);
    const horasEspera = Math.floor((msEspera / 1000) / 3600);
    const minsEspera = Math.round(((msEspera / 1000) % 3600) / 60);
    console.log(`[SCHEDULER] 🎯 Próximo scoring en ${horasEspera}h ${minsEspera}m`);

    setTimeout(() => {
      try {
        runScoring();
      } catch (err) {
        console.error('[SCHEDULER] Error en scoring:', err.message);
      }
      scheduleNext();
    }, msEspera);
  }

  scheduleNext();
}

/**
 * Programa el follow-up engine (cada 3h: 10AM, 1PM, 4PM, 7PM COL)
 */
function scheduleFollowups() {
  const FOLLOWUP_HOURS = [10, 13, 16, 19];

  function scheduleNext() {
    const msEspera = getMsUntilNext(FOLLOWUP_HOURS);
    const horasEspera = Math.floor((msEspera / 1000) / 3600);
    const minsEspera = Math.round(((msEspera / 1000) % 3600) / 60);
    console.log(`[SCHEDULER] 🔄 Próximo follow-up en ${horasEspera}h ${minsEspera}m`);

    setTimeout(async () => {
      try {
        await runFollowups();
      } catch (err) {
        console.error('[SCHEDULER] Error en follow-ups:', err.message);
      }
      scheduleNext();
    }, msEspera);
  }

  scheduleNext();
}

/**
 * Programa recordatorios de pago (cada 6h: 10AM, 4PM COL)
 */
function schedulePaymentReminders() {
  const PAYMENT_HOURS = [10, 16];

  function scheduleNext() {
    const msEspera = getMsUntilNext(PAYMENT_HOURS);
    const horasEspera = Math.floor((msEspera / 1000) / 3600);
    const minsEspera = Math.round(((msEspera / 1000) % 3600) / 60);
    console.log(`[SCHEDULER] 💰 Próximo payment reminder en ${horasEspera}h ${minsEspera}m`);

    setTimeout(async () => {
      try {
        await runPaymentReminders();
      } catch (err) {
        console.error('[SCHEDULER] Error en payment reminders:', err.message);
      }
      scheduleNext();
    }, msEspera);
  }

  scheduleNext();
}

/**
 * Inicia todos los agentes programados.
 * Llamado desde index.js una vez que el bot esté listo.
 */
function startScheduler() {
  console.log('[SCHEDULER] 🚀 Iniciando agentes proactivos...');

  // Ejecutar scoring inmediatamente al arrancar
  try {
    runScoring();
    console.log('[SCHEDULER] ✅ Scoring inicial completado');
  } catch (err) {
    console.error('[SCHEDULER] Error en scoring inicial:', err.message);
  }

  // Programar ejecuciones futuras
  scheduleBriefing();
  scheduleLeadScoring();
  scheduleFollowups();
  schedulePaymentReminders();
  scheduleDespachoTracker();
  scheduleOnboarding();
  scheduleCampaigns();
  scheduleSalesAnalysis();
  schedulePostventaResolver();

  console.log('[SCHEDULER] ✅ Agentes programados correctamente');
}

/**
 * Programa tracking de despachos (cada 6h: 9AM, 3PM COL)
 */
function scheduleDespachoTracker() {
  const DESPACHO_HOURS = [9, 15];

  function scheduleNext() {
    const msEspera = getMsUntilNext(DESPACHO_HOURS);
    const horasEspera = Math.floor((msEspera / 1000) / 3600);
    const minsEspera = Math.round(((msEspera / 1000) % 3600) / 60);
    console.log(`[SCHEDULER] 📦 Próximo despacho check en ${horasEspera}h ${minsEspera}m`);

    setTimeout(async () => {
      try {
        await runDespachoTracker();
      } catch (err) {
        console.error('[SCHEDULER] Error en despacho tracker:', err.message);
      }
      scheduleNext();
    }, msEspera);
  }

  scheduleNext();
}

/**
 * Programa onboarding Club ZT (cada 12h: 8AM, 8PM COL)
 */
function scheduleOnboarding() {
  const ONBOARDING_HOURS = [8, 18];

  function scheduleNext() {
    const msEspera = getMsUntilNext(ONBOARDING_HOURS);
    const horasEspera = Math.floor((msEspera / 1000) / 3600);
    const minsEspera = Math.round(((msEspera / 1000) % 3600) / 60);
    console.log(`[SCHEDULER] 🎓 Próximo onboarding check en ${horasEspera}h ${minsEspera}m`);

    setTimeout(async () => {
      try {
        await runOnboarding();
      } catch (err) {
        console.error('[SCHEDULER] Error en onboarding:', err.message);
      }
      scheduleNext();
    }, msEspera);
  }

  scheduleNext();
}

/**
 * Programa campañas segmentadas (domingos 10AM COL)
 */
function scheduleCampaigns() {
  function scheduleNext() {
    // Calcular ms hasta el próximo domingo 10AM COL
    const ahora = new Date();
    const utcMinutes = ahora.getUTCHours() * 60 + ahora.getUTCMinutes();
    const colMinutes = ((utcMinutes - 5 * 60) % (24 * 60) + 24 * 60) % (24 * 60);
    const colHour = Math.floor(colMinutes / 60);
    const colDay = ahora.getUTCDay(); // 0=Sunday

    let daysUntilSunday = (7 - colDay) % 7;
    if (daysUntilSunday === 0 && colHour >= 10) daysUntilSunday = 7; // Ya pasó

    const msEspera = daysUntilSunday * 24 * 60 * 60 * 1000 + (10 - colHour) * 60 * 60 * 1000;
    const diasEspera = Math.floor(msEspera / (1000 * 60 * 60 * 24));
    const horasEspera = Math.floor((msEspera % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    console.log(`[SCHEDULER] 📣 Próxima campaña en ${diasEspera}d ${horasEspera}h (domingo 10AM)`);

    setTimeout(async () => {
      try {
        await runCampaigns();
      } catch (err) {
        console.error('[SCHEDULER] Error en campañas:', err.message);
      }
      scheduleNext();
    }, Math.max(msEspera, 60000));
  }

  scheduleNext();
}

/**
 * Programa análisis de ventas (lunes 8AM COL)
 */
function scheduleSalesAnalysis() {
  function scheduleNext() {
    const ahora = new Date();
    const utcMinutes = ahora.getUTCHours() * 60 + ahora.getUTCMinutes();
    const colMinutes = ((utcMinutes - 5 * 60) % (24 * 60) + 24 * 60) % (24 * 60);
    const colHour = Math.floor(colMinutes / 60);
    const colDay = ahora.getUTCDay(); // 0=Sunday, 1=Monday

    let daysUntilMonday = (1 - colDay + 7) % 7;
    if (daysUntilMonday === 0 && colHour >= 8) daysUntilMonday = 7;

    const msEspera = daysUntilMonday * 24 * 60 * 60 * 1000 + (8 - colHour) * 60 * 60 * 1000;
    const diasEspera = Math.floor(msEspera / (1000 * 60 * 60 * 24));
    const horasEspera = Math.floor((msEspera % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    console.log(`[SCHEDULER] 🧠 Próximo coaching de ventas en ${diasEspera}d ${horasEspera}h (lunes 8AM)`);

    setTimeout(async () => {
      try {
        await salesAnalyst.runSalesAnalysis();
      } catch (err) {
        console.error('[SCHEDULER] Error en sales analysis:', err.message);
      }
      scheduleNext();
    }, Math.max(msEspera, 60000));
  }

  scheduleNext();
}

/**
 * Programa el clasificador de postventa (2x día: 11AM, 5PM COL)
 */
function schedulePostventaResolver() {
  const PV_HOURS = [11, 17];

  function scheduleNext() {
    const msEspera = getMsUntilNext(PV_HOURS);
    const horasEspera = Math.floor((msEspera / 1000) / 3600);
    const minsEspera = Math.round(((msEspera / 1000) % 3600) / 60);
    console.log(`[SCHEDULER] 🛠️ Próximo PV-resolver en ${horasEspera}h ${minsEspera}m`);

    setTimeout(async () => {
      try {
        await runPostventaResolver();
      } catch (err) {
        console.error('[SCHEDULER] Error en PV-resolver:', err.message);
      }
      scheduleNext();
    }, msEspera);
  }

  scheduleNext();
}

module.exports = { init, startScheduler };
