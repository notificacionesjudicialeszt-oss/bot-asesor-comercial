// ============================================
// broadcasters.js — Cola de imágenes + Broadcasting a Grupos y Estados
// ============================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { geminiGenerate } = require('./gemini');

// Inyección de dependencia
let client = null;
let MessageMedia = null;

function init(whatsappClient, msgMedia) {
  client = whatsappClient;
  MessageMedia = msgMedia;
}

// ============================================
// SISTEMA DE COLA SECUENCIAL PARA BROADCASTING
// ============================================
const BROADCAST_QUEUE_PATH = path.join(__dirname, 'broadcast_queue.json');

// ── Utilidades de la cola ──

function obtenerImagenesRecursivo(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      if (fs.statSync(filePath).isDirectory()) {
        obtenerImagenesRecursivo(filePath, fileList);
      } else if (file.match(/\.(png|jpg|jpeg|webp)$/i)) {
        fileList.push(filePath);
      }
    }
  } catch (e) { /* silencioso */ }
  return fileList;
}

function shuffleArray(arr) {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Construye la cola de imágenes filtrando por catálogo disponible.
 * Devuelve un array de objetos { fullPath, relativePath, productoInfo }
 */
function buildImageQueue() {
  const imagenesDir = path.join(__dirname, 'imagenes');
  const catalogoPath = path.join(__dirname, 'catalogo_contexto.json');

  // 1. Cargar catálogo
  let catalogo = { categorias: {} };
  try {
    catalogo = JSON.parse(fs.readFileSync(catalogoPath, 'utf8'));
  } catch (e) {
    console.error('[QUEUE] ⚠️ No se pudo leer catalogo_contexto.json:', e.message);
  }

  // 2. Construir mapeo de productos disponibles: modelo → info
  const productosDisponibles = {};
  for (const [marca, productos] of Object.entries(catalogo.categorias || {})) {
    if (marca === 'SERVICIOS') continue;
    for (const p of productos) {
      if (p.disponible) {
        const modeloKey = (p.modelo || p.titulo || '').toLowerCase().replace(/\s+/g, ' ').trim();
        productosDisponibles[modeloKey] = {
          titulo: p.titulo,
          marca: p.marca || marca,
          color: p.color,
          precio_plus: p.precio_plus,
          precio_pro: p.precio_pro,
          url: p.url
        };
      }
    }
  }
  console.log(`[QUEUE] 📦 Productos disponibles en catálogo: ${Object.keys(productosDisponibles).length}`);

  // 3. Escanear imágenes por categoría
  // 4 fuentes: club (ofertas), pistolas (inventario disponible), didáctico y marketing
  const pistolasDir = path.join(imagenesDir, 'pistolas');
  const clubDir = path.join(imagenesDir, 'oferta actual', 'club');
  const didacticoDir = path.join(imagenesDir, 'didactico');
  const marketingDir = path.join(imagenesDir, 'oferta actual', 'marketing');

  const imagenesPistolas = obtenerImagenesRecursivo(pistolasDir);
  const imagenesClub = obtenerImagenesRecursivo(clubDir);
  const imagenesDidactico = obtenerImagenesRecursivo(didacticoDir);
  const imagenesMarketing = obtenerImagenesRecursivo(marketingDir);

  // 4. Filtrar pistolas: solo las que corresponden a productos del catálogo
  const pistolasFiltradas = [];
  const pistolasExcluidas = [];

  for (const fullPath of imagenesPistolas) {
    const relativePath = path.relative(imagenesDir, fullPath);
    const fileName = path.basename(fullPath, path.extname(fullPath)).toLowerCase();
    const parentFolder = path.basename(path.dirname(fullPath)).toLowerCase();

    let productoMatch = null;
    for (const [modeloKey, info] of Object.entries(productosDisponibles)) {
      const marcaLower = (info.marca || '').toLowerCase();
      const modeloLower = modeloKey;

      const modeloParts = modeloLower.split(' ');
      const fileMatchesModel = modeloParts.every(part => fileName.includes(part)) ||
        fileName.includes(modeloLower.replace(/\s+/g, ''));

      if (parentFolder === marcaLower && fileMatchesModel) {
        productoMatch = info;
        break;
      }

      if (relativePath.toLowerCase().includes(marcaLower) && fileMatchesModel) {
        productoMatch = info;
        break;
      }
    }

    if (productoMatch) {
      pistolasFiltradas.push({ fullPath, relativePath, productoInfo: productoMatch });
    } else {
      pistolasExcluidas.push(relativePath);
    }
  }

  if (pistolasExcluidas.length > 0) {
    console.log(`[QUEUE] 🚫 Excluidas (no en catálogo): ${pistolasExcluidas.join(', ')}`);
  }

  // 5. Construir cola intercalada: pistola → club → didáctico → marketing → ...
  const shuffledPistolas = shuffleArray(pistolasFiltradas);
  const toItem = fullPath => ({
    fullPath,
    relativePath: path.relative(imagenesDir, fullPath),
    productoInfo: null
  });
  const shuffledClub = shuffleArray(imagenesClub).map(toItem);
  const shuffledDidactico = shuffleArray(imagenesDidactico).map(toItem);
  const shuffledMarketing = shuffleArray(imagenesMarketing).map(toItem);

  const colaOrdenada = [];
  const maxLen = Math.max(shuffledPistolas.length, shuffledClub.length, shuffledDidactico.length, shuffledMarketing.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < shuffledPistolas.length) colaOrdenada.push(shuffledPistolas[i]);
    if (i < shuffledClub.length) colaOrdenada.push(shuffledClub[i]);
    if (i < shuffledDidactico.length) colaOrdenada.push(shuffledDidactico[i]);
    if (i < shuffledMarketing.length) colaOrdenada.push(shuffledMarketing[i]);
  }

  console.log(`[QUEUE] 📋 Cola construida: ${pistolasFiltradas.length} pistolas + ${shuffledClub.length} club + ${shuffledDidactico.length} didáctico + ${shuffledMarketing.length} marketing = ${colaOrdenada.length} total`);

  return colaOrdenada;
}

// ── Persistencia de la cola ──

function loadBroadcastQueues() {
  try {
    if (fs.existsSync(BROADCAST_QUEUE_PATH)) {
      return JSON.parse(fs.readFileSync(BROADCAST_QUEUE_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('[QUEUE] Error leyendo broadcast_queue.json:', e.message);
  }
  return { groups: { queue: [], index: 0 }, status: { queue: [], index: 0 } };
}

function saveBroadcastQueues(data) {
  try {
    fs.writeFileSync(BROADCAST_QUEUE_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[QUEUE] Error guardando broadcast_queue.json:', e.message);
  }
}

function getNextImage(type) {
  const queues = loadBroadcastQueues();
  let queueData = queues[type] || { queue: [], index: 0 };

  if (!queueData.queue || queueData.queue.length === 0 || queueData.index >= queueData.queue.length) {
    console.log(`[QUEUE] 🔄 Reconstruyendo cola para ${type}...`);
    const nuevaCola = buildImageQueue();
    if (nuevaCola.length === 0) return null;

    queueData = { queue: nuevaCola, index: 0 };
    queues[type] = queueData;
    saveBroadcastQueues(queues);
    console.log(`[QUEUE] ✅ Cola ${type} lista: ${nuevaCola.length} imágenes`);
  }

  const item = queueData.queue[queueData.index];
  queueData.index++;
  queues[type] = queueData;
  saveBroadcastQueues(queues);

  console.log(`[QUEUE] 📸 ${type} → [${queueData.index}/${queueData.queue.length}] ${item.relativePath}`);
  return item;
}

// ============================================
// BROADCASTER DE IMÁGENES A GRUPOS
// ============================================

// Semáforo para evitar ejecuciones concurrentes (scheduler + manual)
let isBroadcasting = false;

async function getGroupBroadcastText(imageRelativePath, productoInfo) {
  // Hora real Colombia (UTC-5)
  const ahoraUTC = new Date();
  const horaCol = ((ahoraUTC.getUTCHours() - 5) + 24) % 24;
  let contextoHora;
  if (horaCol >= 5 && horaCol < 12) {
    contextoHora = `Es de mañana (${horaCol}h Colombia), saluda con buenos días y da un arranque motivador`;
  } else if (horaCol >= 12 && horaCol < 18) {
    contextoHora = `Es mediodía/tarde (${horaCol}h Colombia), buen momento para recordar la oferta con energía`;
  } else {
    contextoHora = `Es noche (${horaCol}h Colombia), cierre del día, apela a la tranquilidad y seguridad de la familia`;
  }

  let productoCtx = '';
  if (productoInfo) {
    productoCtx = `\nINFO DEL PRODUCTO:\n- Nombre: ${productoInfo.titulo}\n- Marca: ${productoInfo.marca}\n- Color(es): ${productoInfo.color}\n- Precio Plan Plus: ${productoInfo.precio_plus}\n- Precio Plan Pro: ${productoInfo.precio_pro}\nUsa estos datos reales en tu mensaje cuando sea natural hacerlo.`;
  }

  try {
    const prompt = `Eres el community manager de Zona Traumática Colombia.
Escribe un mensaje corto y poderoso para acompañar esta imagen promocional en un grupo de WhatsApp de portadores de armas traumáticas.
Contexto de tiempo: ${contextoHora}.
Dato de la imagen: ${imageRelativePath.replace(/\\/g, '/')}${productoCtx}
El mensaje debe:
- Ser máximo 4 líneas
- Tener gancho emocional (miedo a perder el arma, orgullo del portador preparado)
- Terminar con una llamada a la acción clara (escribir al privado, preguntar por el plan, etc.)
- Usar emojis con moderación (máximo 3)
- Sonar humano, NO robótico ni corporativo
- NO repetir exactamente lo que dice la imagen
- REGLA LEGAL ESTRICTA: Las armas traumáticas NO son armas de fuego. Según la Ley 2197 de 2022, son dispositivos MENOS LETALES. JAMÁS digas que son armas de fuego.
Solo escribe el mensaje, sin explicaciones.`;
    const result = await geminiGenerate('gemini-3.1-pro-preview', prompt);
    return result.response.text().trim();
  } catch (err) {
    console.error('[BROADCASTER] Error generando texto:', err.message);
    return '🛡️ ¿Ya tienes tu respaldo legal listo? El Club Zona Traumática te protege antes, durante y después. Escríbenos al privado.';
  }
}

async function sendGroupBroadcast() {
  if (isBroadcasting) {
    console.log('[BROADCASTER] ⚠️ Ya hay un broadcast de grupos en curso — ignorando solicitud duplicada');
    return;
  }
  isBroadcasting = true;
  console.log('[BROADCASTER] 📢 Iniciando envío a grupos...');

  try {
    const imageItem = getNextImage('groups');
    if (!imageItem) {
      console.log('[BROADCASTER] No hay imágenes disponibles en la cola — cancelando');
      return;
    }

    if (!fs.existsSync(imageItem.fullPath)) {
      console.log(`[BROADCASTER] ⚠️ Imagen ya no existe: ${imageItem.relativePath} — saltando`);
      return;
    }

    let chats;
    try {
      chats = await client.getChats();
    } catch (e) {
      console.error('[BROADCASTER] Error obteniendo chats:', e.message);
      return;
    }

    const grupos = chats.filter(c => c.isGroup);
    console.log(`[BROADCASTER] 👥 Grupos encontrados: ${grupos.length}`);

    if (grupos.length === 0) {
      console.log('[BROADCASTER] No hay grupos — cancelando');
      return;
    }

    let media;
    try {
      media = MessageMedia.fromFilePath(imageItem.fullPath);
    } catch (mediaErr) {
      console.error(`[BROADCASTER] ❌ No se pudo cargar imagen: ${mediaErr.message}`);
      return;
    }

    let enviados = 0;
    let frameDetached = false;

    for (const grupo of grupos) {
      if (frameDetached) {
        console.warn(`[BROADCASTER] ⚠️ Frame caído — abortando resto de grupos`);
        break;
      }

      try {
        console.log(`[BROADCASTER] ➡️ Preparando envío a ${grupo.name} (Img: ${imageItem.relativePath})...`);
        
        const textoUnico = await getGroupBroadcastText(imageItem.relativePath, imageItem.productoInfo);

        await client.sendMessage(grupo.id._serialized, media, { caption: textoUnico });
        enviados++;
        console.log(`[BROADCASTER] ✅ Enviado a: ${grupo.name}`);
        
        if (enviados < grupos.length) {
          const banDelay = Math.floor(Math.random() * 120000) + 60000; 
          console.log(`[BROADCASTER] 🛡️ Anti-Ban: Esperando ${Math.round(banDelay/1000)}s antes del próximo grupo...`);
          await new Promise(r => setTimeout(r, banDelay));
        }
      } catch (err) {
        const esDetachedFrame = err.message && (
          err.message.includes('detached Frame') ||
          err.message.includes('Execution context was destroyed') ||
          err.message.includes('Target closed') ||
          err.message.includes('Session closed')
        );

        if (esDetachedFrame) {
          console.error(`[BROADCASTER] 💀 Frame de Puppeteer caído en grupo ${grupo.name} — deteniendo broadcast`);
          frameDetached = true;
        } else {
          console.error(`[BROADCASTER] ❌ Error en grupo ${grupo.name}:`, err.message);
          // Pequeña pausa antes de continuar con el siguiente grupo
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }

    console.log(`[BROADCASTER] 📊 Completado: ${enviados}/${grupos.length} grupos`);
    if (frameDetached) {
      console.log(`[BROADCASTER] ℹ️ El frame se cayó en medio del envío — el watchdog reiniciará el bot si es necesario`);
    }
  } finally {
    isBroadcasting = false;
  }
}

function startGroupBroadcaster() {
  if (process.env.ENABLE_GROUP_BROADCAST !== 'true') {
    console.log('[BROADCASTER] ⏸️ Broadcasting a grupos DESACTIVADO (ENABLE_GROUP_BROADCAST=false)');
    return;
  }
  const ENVIOS_POR_DIA = 16;
  const HORA_INICIO = 7;   // 7am Colombia
  const HORA_FIN = 23;     // 11pm Colombia
  const VENTANA_HORAS = HORA_FIN - HORA_INICIO; // 16h activas
  const INTERVALO_MS = Math.floor((VENTANA_HORAS * 60 * 60 * 1000) / ENVIOS_POR_DIA); // ~60 min

  function getColombiaHour() {
    const ahora = new Date();
    const utcMinutes = ahora.getUTCHours() * 60 + ahora.getUTCMinutes();
    const colMinutes = ((utcMinutes - 5 * 60) % (24 * 60) + 24 * 60) % (24 * 60);
    return Math.floor(colMinutes / 60);
  }

  // Log de la cola al arrancar para confirmar que no se repiten
  const colaActual = buildImageQueue();
  console.log(`[BROADCASTER] 📦 Imágenes disponibles en cola: ${colaActual.length} (se reciclan sin repetir hasta agotar todas)`);

  async function ciclo() {
    const hora = getColombiaHour();
    if (hora >= HORA_INICIO && hora < HORA_FIN) {
      await sendGroupBroadcast();
    } else {
      console.log(`[BROADCASTER] 🌙 Fuera de horario (${hora}h Colombia) — saltando hasta las ${HORA_INICIO}h`);
    }
    setTimeout(ciclo, INTERVALO_MS);
  }

  const intervaloMin = Math.round(INTERVALO_MS / 60000);
  console.log(`[BROADCASTER] 🚀 Iniciado — ${ENVIOS_POR_DIA}x/día, cada ~${intervaloMin}min (${HORA_INICIO}h-${HORA_FIN}h Colombia)`);
  // Primer envío en 2 minutos para no bloquear el arranque
  setTimeout(ciclo, 2 * 60 * 1000);
}

// ============================================
// AUTOMATIZACIÓN DE ESTADOS (STATUS) DE WHATSAPP
// ============================================

async function getStatusBroadcastText(imageRelativePath, productoInfo) {
  // Hora real Colombia (UTC-5)
  const ahoraUTC = new Date();
  const horaCol = ((ahoraUTC.getUTCHours() - 5) + 24) % 24;
  let contextoHora;
  if (horaCol >= 5 && horaCol < 12) {
    contextoHora = `Mañana (${horaCol}h): invita a empezar el día protegido con buenos días`;
  } else if (horaCol >= 12 && horaCol < 18) {
    contextoHora = `Mediodía/tarde (${horaCol}h): mensaje rápido y contundente para el break del almuerzo`;
  } else {
    contextoHora = `Noche (${horaCol}h): cierre del día, apela a la tranquilidad y seguridad de la familia`;
  }

  let productoCtx = '';
  if (productoInfo) {
    productoCtx = `\nINFO DEL PRODUCTO: ${productoInfo.titulo} (${productoInfo.marca}) — ${productoInfo.color} — Plus: ${productoInfo.precio_plus} / Pro: ${productoInfo.precio_pro}`;
  }

  try {
    const prompt = `Eres el community manager de Zona Traumática Colombia.
Escribe un texto persuasivo para acompañar esta imagen en una HISTORIA/ESTADO de WhatsApp.
Dado que la imagen proviene de la ruta: "${imageRelativePath.replace(/\\/g, '/')}", adapta tu mensaje a la categoría:
- Si es de /oferta: Enfatiza la promoción, el descuento de 50k o el bot IA gratis.
- Si es de /didactico: Da un tip legal rápido de 1 frase (Ejemplo correcto: "Ley 2197/2022: Las traumáticas son dispositivos menos letales, NO armas de fuego").
- Si es de /pistolas: Habla de equipo táctico, seguridad y respaldo.
${productoCtx}

Contexto de la hora: ${contextoHora}

El mensaje debe:
- Ser MUY CORTO (máximo 3 líneas) para lectura rápida en un estado.
- Tener un gancho visual con 1 o 2 emojis.
- Invitar a responder la historia (ej: "Escríbeme", "Responde a esta historia para info", "👇").
- Sonar orgánico y persuasivo, no un copy-paste aburrido.
- REGLA LEGAL ESTRICTA: Las armas traumáticas NO son armas de fuego. Si las mencionas, son dispositivos o armas MENOS LETALES.
Solo escribe el texto de la historia, sin comillas ni explicaciones extra.`;

    const result = await geminiGenerate('gemini-3.1-pro-preview', prompt);
    return result.response.text().trim();
  } catch (err) {
    console.error('[STATUS] Error generando texto:', err.message);
    return '🛡️ ¿Preparado para cualquier situación? Responde a esta historia y te asesoro hoy mismo. 👊';
  }
}

async function sendStatusBroadcast() {
  console.log('[STATUS] 📲 Iniciando publicación en Estado de WhatsApp...');

  const imageItem = getNextImage('status');
  if (!imageItem) {
    console.log('[STATUS] No hay imágenes disponibles en la cola — cancelando');
    return;
  }

  if (!fs.existsSync(imageItem.fullPath)) {
    console.log(`[STATUS] ⚠️ Imagen ya no existe: ${imageItem.relativePath} — saltando`);
    return;
  }

  try {
    const texto = await getStatusBroadcastText(imageItem.relativePath, imageItem.productoInfo);
    const media = MessageMedia.fromFilePath(imageItem.fullPath);

    console.log(`[STATUS] ➡️ Subiendo historia (Img: ${imageItem.relativePath})...`);
    await client.sendMessage('status@broadcast', media, { caption: texto });
    console.log(`[STATUS] ✅ Historia publicada exitosamente.`);

  } catch (err) {
    const msg = err.message || '';
    if (msg.includes('detached Frame') || msg.includes('Session closed') || msg.includes('Target closed')) {
      console.error('[STATUS] 💀 Error fatal de Puppeteer — el bot necesita reiniciarse.');
      process.exit(1);
    }
    console.error(`[STATUS] ❌ Error subiendo estado:`, msg);
  }
}

function startStatusBroadcaster() {
  if (process.env.ENABLE_STATUS_BROADCAST !== 'true') {
    console.log('[STATUS] ⏸️ Broadcasting de estados DESACTIVADO (ENABLE_STATUS_BROADCAST=false)');
    return;
  }
  const INTERVALO_MS = 30 * 60 * 1000; // 30 minutos
  const HORA_INICIO = 7;  // no publicar antes de 7am Colombia
  const HORA_FIN = 23;    // no publicar después de 11pm Colombia

  function getColombiaHour() {
    const ahora = new Date();
    const utcMinutes = ahora.getUTCHours() * 60 + ahora.getUTCMinutes();
    const colMinutes = ((utcMinutes - 5 * 60) % (24 * 60) + 24 * 60) % (24 * 60);
    return Math.floor(colMinutes / 60);
  }

  async function ciclo() {
    const hora = getColombiaHour();
    if (hora >= HORA_INICIO && hora < HORA_FIN) {
      await sendStatusBroadcast();
    } else {
      console.log(`[STATUS] 🌙 Fuera de horario (${hora}h Colombia) — saltando hasta las ${HORA_INICIO}h`);
    }
    setTimeout(ciclo, INTERVALO_MS);
  }

  console.log(`[STATUS] 🚀 Automatización de Historias iniciada — cada 30 min (${HORA_INICIO}h-${HORA_FIN}h Colombia)`);
  // Primer envío en 1 minuto para no bloquear el arranque
  setTimeout(ciclo, 60 * 1000);
}

module.exports = { init, startGroupBroadcaster, startStatusBroadcaster, sendGroupBroadcast, sendStatusBroadcast, buildImageQueue };
