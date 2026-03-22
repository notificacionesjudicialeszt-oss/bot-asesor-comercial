// ============================================
// config.js — Configuración global del bot
// ============================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const CONFIG = {
  mode: process.env.MODE || 'direct',
  apiKey: process.env.ANTHROPIC_API_KEY,
  businessName: process.env.BUSINESS_NAME || 'Mi Tienda',
  businessPhone: process.env.BUSINESS_PHONE || '',
  auditors: (process.env.AUDITORS || '').split(',').map(a => a.trim()).filter(Boolean),
  ignoreGroups: process.env.IGNORE_GROUPS === 'true',
  debug: process.env.DEBUG === 'true',
  n8nWebhook: process.env.N8N_WEBHOOK_URL || '',
};

// Parsear empleados del .env
// Formato: "Juan:573001111111,Maria:573002222222"
/**
 * Parsea los empleados configurados en el .env.
 * Formato esperado: "Juan:573001111111,Maria:573002222222"
 * @returns {Array<{name: string, phone: string}>} Lista de empleados
 */
function parseEmployees() {
  const envEmployees = process.env.EMPLOYEES || '';
  if (!envEmployees) return [];

  return envEmployees.split(',').map(emp => {
    const [name, phone] = emp.trim().split(':');
    return { name: name.trim(), phone: phone.trim() };
  });
}

// Cargar base de conocimiento
let knowledgeBase = {};
try {
  const kbPath = path.join(__dirname, 'knowledge_base.json');
  if (fs.existsSync(kbPath)) {
    knowledgeBase = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
    console.log('[BOT] Base de conocimiento cargada');
  } else {
    console.log('[BOT] No se encontró knowledge_base.json, se usará memoria vacía o catálogo.');
  }
} catch (error) {
  console.error('[BOT] Error cargando knowledge_base.json:', error.message);
}

module.exports = { CONFIG, parseEmployees, knowledgeBase };
