// ============================================
// recovery.js - Recuperar chats, exportar/guardar contactos VCF
// ============================================
const fs = require('fs');
const path = require('path');
const { CONFIG } = require('./config');

let client = null;

function init(whatsappClient) {
  client = whatsappClient;
}

/**
 * Busca chats con mensajes sin responder y les envía un mensaje de recuperación.
 * Se ejecuta una sola vez al arrancar el bot. Usa un archivo de control
 * (recovery_enviados.json) para no enviar dos veces al mismo número.
 */
async function recuperarChatsViejos() {
  try {
    console.log('[RECOVERY] 🔍 Buscando chats sin responder...');

    const allChats = await client.getChats();
    let enviados = 0;
    let omitidos = 0;

    // Archivo de control para no enviar dos veces al mismo número
    const controlPath = path.join(__dirname, 'recovery_enviados.json');
    let yaEnviados = {};
    if (fs.existsSync(controlPath)) {
      yaEnviados = JSON.parse(fs.readFileSync(controlPath, 'utf8'));
    }

    // Paso 1: Filtrar chats válidos y recolectar info
    console.log('[RECOVERY] 📋 Filtrando y ordenando chats...');
    const chatsPendientes = [];

    for (const chat of allChats) {
      try {
        if (chat.isGroup) continue;
        if (chat.id._serialized === 'status@broadcast') continue;

        const serialized = chat.id?._serialized || '';
        if (serialized.includes('@newsletter')) continue;
        if (serialized.includes('@broadcast')) continue;
        if (chat.type === 'channel') continue;
        if (!serialized.includes('@c.us')) continue;

        const phone = chat.id.user;
        if (phone === CONFIG.businessPhone.replace('57', '') ||
          phone === '573150177199'.replace('57', '')) continue;
        if (yaEnviados[phone]) { omitidos++; continue; }

        // Bloquear bots empresariales (números cortos)
        const phoneClean = phone.replace('57', '');
        if (phoneClean.length <= 6) continue;

        const messages = await chat.fetchMessages({ limit: 5 });
        if (!messages || messages.length === 0) continue;

        // Buscar el mensaje más antiguo para ordenar por antigüedad
        const firstMsg = messages[0];
        if (!firstMsg) continue;

        // Guardar chat con su timestamp para ordenar (más viejo primero)
        chatsPendientes.push({
          chat,
          phone,
          timestamp: firstMsg.timestamp || 0 // epoch en segundos
        });
      } catch (e) {
        // Chat problemático, saltar silenciosamente
      }
    }

    // Paso 2: Ordenar por timestamp ASCENDENTE (más viejos primero)
    chatsPendientes.sort((a, b) => a.timestamp - b.timestamp);

    console.log(`[RECOVERY] 📊 ${chatsPendientes.length} chats pendientes encontrados. Enviando desde el más viejo...`);

    // Paso 3: Enviar mensajes en orden (más viejos primero)
    for (const item of chatsPendientes) {
      try {
        const { chat, phone } = item;
        const fecha = new Date(item.timestamp * 1000).toLocaleDateString('es-CO');

        let nombre = '';
        try {
          const contact = await chat.getContact();
          nombre = contact.pushname || contact.name || contact.shortName || '';
        } catch (e) { /* silencioso */ }

        const mensajeRecuperacion =
          `Hola${nombre ? ' ' + nombre.split(' ')[0] : ''} 👋, buenas.\n\n` +
          `Te escribo de parte de *Zona Traumática*. Veo que hace un tiempo nos escribiste y quiero disculparme sinceramente por no haberte atendido — estuvimos en un proceso de restructuración y renovamos completamente nuestro equipo y herramientas de atención.\n\n` +
          `Hoy estamos operando con un servicio mucho más ágil y completo. ¿Sigues interesado/a en lo que consultaste? Con gusto te atiendo personalmente ahora. 🙌`;

        await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
        await client.sendMessage(chat.id._serialized, mensajeRecuperacion);

        saveContactToVCF(phone, nombre);

        yaEnviados[phone] = new Date().toISOString();
        fs.writeFileSync(controlPath, JSON.stringify(yaEnviados, null, 2), 'utf8');

        enviados++;
        console.log(`[RECOVERY] ✅ (${enviados}/${chatsPendientes.length}) ${nombre || phone} — último msg: ${fecha}`);

      } catch (chatError) {
        console.error(`[RECOVERY] ⚠️ Chat omitido (${item.phone || 'desconocido'}):`, chatError.message);
      }
    }

    console.log(`[RECOVERY] 🏁 Recuperación completa: ${enviados} mensajes enviados, ${omitidos} chats ya atendidos o sin acción.`);

  } catch (error) {
    console.error('[RECOVERY] Error general:', error.message);
  }
}

// ============================================
// GUARDAR CONTACTO INDIVIDUAL EN VCF MAESTRO
// ============================================
// Cada vez que llega un cliente nuevo, lo agrega al archivo
// contactos_clientes.vcf (acumulativo, no sobreescribe)
/**
 * Guarda un contacto individual en el archivo VCF maestro (acumulativo).
 * @param {string} phone - Número de teléfono
 * @param {string} name - Nombre del contacto
 */
function saveContactToVCF(phone, name) {
  try {
    const displayName = name || phone;
    const vcfPath = path.join(__dirname, 'contactos_clientes.vcf');

    // Verificar si ya está en el archivo para no duplicar
    if (fs.existsSync(vcfPath)) {
      const existing = fs.readFileSync(vcfPath, 'utf8');
      if (existing.includes(`+${phone}`)) {
        if (CONFIG.debug) {
          console.log(`[VCF] Contacto ya existe en VCF: ${displayName} (${phone})`);
        }
        return;
      }
    }

    // Construir entrada vCard
    const vcard =
      'BEGIN:VCARD\n' +
      'VERSION:3.0\n' +
      `FN:${displayName}\n` +
      `N:${displayName};;;;\n` +
      `TEL;TYPE=CELL:+${phone}\n` +
      `NOTE:Cliente ZT — ${new Date().toLocaleDateString('es-CO')}\n` +
      'END:VCARD\n\n';

    // Agregar al archivo (append)
    fs.appendFileSync(vcfPath, vcard, 'utf8');
    console.log(`[VCF] ✅ Contacto guardado: ${displayName} (+${phone})`);

  } catch (error) {
    console.error('[VCF] Error guardando contacto individual:', error.message);
  }
}

// ============================================
// EXPORTAR CONTACTOS A VCF
// ============================================
/**
 * Exporta todos los contactos de WhatsApp a un archivo .vcf con timestamp.
 */
async function exportContactsToVCF() {
  try {
    console.log('[VCF] Exportando contactos de WhatsApp...');
    const contacts = await client.getContacts();

    let vcfContent = '';
    let count = 0;

    for (const contact of contacts) {
      // Saltar contactos sin número o de tipo broadcast/grupo
      if (!contact.number || contact.isGroup || contact.id._serialized === 'status@broadcast') continue;

      const name = contact.pushname || contact.name || contact.shortName || contact.number;
      const phone = contact.number;

      vcfContent += 'BEGIN:VCARD\n';
      vcfContent += 'VERSION:3.0\n';
      vcfContent += `FN:${name}\n`;
      if (contact.name) {
        vcfContent += `N:${contact.name};;;;\n`;
      } else {
        vcfContent += `N:${name};;;;\n`;
      }
      vcfContent += `TEL;TYPE=CELL:+${phone}\n`;
      vcfContent += 'END:VCARD\n\n';
      count++;
    }

    if (count === 0) {
      console.log('[VCF] No se encontraron contactos para exportar.');
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const vcfPath = path.join(__dirname, `contactos_whatsapp_${timestamp}.vcf`);
    fs.writeFileSync(vcfPath, vcfContent, 'utf8');

    console.log(`[VCF] ✅ ${count} contactos exportados a: ${vcfPath}`);
  } catch (error) {
    console.error('[VCF] Error exportando contactos:', error.message);
  }
}

module.exports = {
  init,
  recuperarChatsViejos,
  saveContactToVCF,
  exportContactsToVCF
};
