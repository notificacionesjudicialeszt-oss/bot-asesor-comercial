// ============================================
// ZONA TRAUMÁTICA — Broadcast Masivo
// ============================================
// Envía un mensaje a TODOS los contactos del WhatsApp
// Uso: node broadcast.js
// ============================================

const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './session' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--disable-gpu',
      '--no-zygote'
    ]
  }
});

// ============================================
// EL MENSAJE DE BROADCAST
// ============================================
const MENSAJE_BROADCAST = `¡Hola! 👋 Te saluda el equipo de *Zona Traumática*.

Queremos contarte algo importante.

En Colombia, el derecho a la legítima defensa es REAL — y nosotros llevamos meses trabajando para que más personas lo conozcan, lo ejerzan y estén protegidas legal y físicamente.

🔹 *¿Sabías que las armas traumáticas son 100% legales?*
La Ley 2197 de 2022 las clasifica como dispositivos menos letales. No requieren permiso de porte. Pero portarlas con respaldo jurídico marca la diferencia entre estar protegido o tener un problema.

🔹 *¿Para qué existe el Club Zona Traumática?*
Para que no estés solo. Cuando te afilias al Club recibes:
✅ Carnet digital de portador legal
✅ Respaldo jurídico ante incautaciones
✅ Acceso a capacitaciones en vivo
✅ Asesoría legal permanente
✅ Comunidad de portadores responsables

📢 *ESTE SÁBADO a las 8:00 PM tenemos capacitación en vivo.*
Vamos a hablar de normativa, casos reales, cómo actuar ante una incautación y cómo ejercer tu derecho. Es GRATIS para afiliados al Club.

💪 Zona Traumática no es solo una tienda — somos un movimiento por el derecho a la seguridad personal, el activismo político y jurídico en pro del porte legal de armas menos letales en Colombia.

¿Ya tienes tu dispositivo? ¿Ya estás afiliado al Club?
Escríbenos y te asesoramos. Estamos para ayudarte. 🙌

_*Zona Traumática — Tu seguridad, nuestro compromiso.*_`;

// ============================================
// NÚMEROS A EXCLUIR
// ============================================
const EXCLUIR = [
  '573013981979',  // Bot
  '573150177199',  // Álvaro
];

// ============================================
// CONTROL DE ENVÍO
// ============================================
const CONTROL_PATH = path.join(__dirname, 'broadcast_enviados.json');

function cargarEnviados() {
  if (fs.existsSync(CONTROL_PATH)) {
    return JSON.parse(fs.readFileSync(CONTROL_PATH, 'utf8'));
  }
  return {};
}

function guardarEnviado(phone, enviados) {
  enviados[phone] = new Date().toISOString();
  fs.writeFileSync(CONTROL_PATH, JSON.stringify(enviados, null, 2), 'utf8');
}

// ============================================
// ARRANQUE
// ============================================
console.log('\n🚀 BROADCAST ZONA TRAUMÁTICA');
console.log('============================\n');
console.log('📝 Mensaje a enviar:\n');
console.log(MENSAJE_BROADCAST);
console.log('\n============================\n');

client.on('qr', (qr) => {
  console.log('⚠️ El broadcast usa la misma sesión del bot. Si ves QR, cierra el bot primero.');
});

client.on('ready', async () => {
  console.log('[BROADCAST] ✅ Conectado a WhatsApp\n');

  try {
    const chats = await client.getChats();
    const enviados = cargarEnviados();
    let count = 0;
    let skipped = 0;
    let errors = 0;

    // Filtrar solo chats individuales válidos
    const chatsValidos = [];
    for (const chat of chats) {
      try {
        if (chat.isGroup) continue;
        const serialized = chat.id?._serialized || '';
        if (serialized.includes('@newsletter')) continue;
        if (serialized.includes('@broadcast')) continue;
        if (!serialized.includes('@c.us')) continue;

        const phone = chat.id.user;

        // Excluir números propios
        if (EXCLUIR.includes(phone)) continue;

        // Excluir números cortos (bots empresariales)
        const phoneClean = phone.replace('57', '');
        if (phoneClean.length <= 6) continue;

        // Excluir si ya se le envió en este broadcast
        if (enviados[phone]) {
          skipped++;
          continue;
        }

        chatsValidos.push({ chat, phone });
      } catch (e) { /* skip */ }
    }

    console.log(`[BROADCAST] 📊 ${chatsValidos.length} contactos pendientes | ${skipped} ya enviados\n`);
    console.log(`[BROADCAST] ⏳ Tiempo estimado: ~${Math.ceil(chatsValidos.length * 4 / 60)} minutos\n`);

    for (const item of chatsValidos) {
      try {
        // Delay entre mensajes (3-5 seg para no ser marcado como spam)
        await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));

        await client.sendMessage(item.chat.id._serialized, MENSAJE_BROADCAST);

        guardarEnviado(item.phone, enviados);
        count++;

        // Obtener nombre para el log
        let nombre = '';
        try {
          const contact = await item.chat.getContact();
          nombre = contact.pushname || contact.name || '';
        } catch (e) { /* sin nombre */ }

        console.log(`[BROADCAST] ✅ (${count}/${chatsValidos.length}) ${nombre || item.phone}`);

        // Pausa larga cada 50 mensajes (para evitar ban)
        if (count % 50 === 0) {
          console.log(`[BROADCAST] ⏸️ Pausa de 30 seg (protección anti-spam)...`);
          await new Promise(r => setTimeout(r, 30000));
        }

      } catch (err) {
        errors++;
        console.error(`[BROADCAST] ❌ Error con ${item.phone}: ${err.message}`);
      }
    }

    console.log(`\n============================`);
    console.log(`[BROADCAST] 🏁 COMPLETADO`);
    console.log(`  ✅ Enviados: ${count}`);
    console.log(`  ⏭️ Ya tenían: ${skipped}`);
    console.log(`  ❌ Errores: ${errors}`);
    console.log(`============================\n`);

    // Cerrar después de terminar
    process.exit(0);

  } catch (error) {
    console.error('[BROADCAST] Error general:', error.message);
    process.exit(1);
  }
});

client.initialize();
