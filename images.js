// ============================================
// images.js — Buscar y enviar imágenes de productos
// ============================================
const fs = require('fs');
const path = require('path');

/**
 * Busca la mejor imagen de producto que coincida con la query.
 * Escanea el directorio imagenes/pistolas/ por marca y modelo.
 * @param {string} query - Término de búsqueda (ej: "retay g17", "blow f92")
 * @returns {string|null} Ruta absoluta a la imagen, o null si no hay match
 */
function findBestImage(query) {
  const baseDir = path.join(__dirname, 'imagenes', 'pistolas');
  if (!fs.existsSync(baseDir)) return null;

  const tokens = query.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);

  if (tokens.length === 0) return null;

  let bestMatch = null;
  let bestScore = 0;

  try {
    const brands = fs.readdirSync(baseDir);
    for (const brand of brands) {
      const brandDir = path.join(baseDir, brand);
      if (!fs.statSync(brandDir).isDirectory()) continue;

      const files = fs.readdirSync(brandDir);
      for (const file of files) {
        if (!file.endsWith('.png') && !file.endsWith('.jpg') && !file.endsWith('.jpeg') && !file.endsWith('.webp')) continue;

        const fileNameClean = file.replace(/\.[^/.]+$/, "").toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]/g, ' ');
          
        const targetString = `${brand.toLowerCase()} ${fileNameClean}`;
        
        let score = 0;
        for (const token of tokens) {
          if (targetString.includes(token)) {
            score += (token === brand.toLowerCase() ? 1 : 2);
          }
        }

        if (score > bestScore || (score === bestScore && score > 0 && bestMatch && file.length < path.basename(bestMatch).length)) {
          bestScore = score;
          bestMatch = path.join(brandDir, file);
        }
      }
    }
  } catch (e) {
    console.error('[BOT] Error buscando imagen:', e.message);
  }

  return bestScore >= 2 ? bestMatch : null;
}

/**
 * Detecta nombres de productos en la respuesta del bot y envía las imágenes.
 * Detecta por: 1) Etiqueta [ENVIAR_IMAGEN: X]  2) URL de producto en la respuesta.
 * @param {string} response - Texto de respuesta del bot
 * @param {object} rawMsg - Mensaje original de WhatsApp (para reply)
 * @param {string} senderPhone - Teléfono del cliente
 * @param {object} MessageMedia - Clase MessageMedia de whatsapp-web.js
 * @returns {{cleanResponse: string, imagesSent: number}}
 */
async function detectAndSendProductImages(response, rawMsg, senderPhone, MessageMedia) {
  const imagesToSend = [];

  // 1. Detección por etiqueta explícita [ENVIAR_IMAGEN: Marca Modelo]
  const imageRegex = /\[ENVIAR_IMAGEN:\s*([^\]]+)\]/ig;
  let match;
  while ((match = imageRegex.exec(response)) !== null) {
    const productQuery = match[1].trim();
    console.log(`[IMG] 🔍 Etiqueta ENVIAR_IMAGEN: "${productQuery}"`);
    const foundPath = findBestImage(productQuery);
    console.log(`[IMG] ${foundPath ? '✅' : '❌'} findBestImage("${productQuery}") → ${foundPath || 'NO ENCONTRADA'}`);
    if (foundPath && !imagesToSend.includes(foundPath)) {
      imagesToSend.push(foundPath);
    }
  }

  // Limpiar todas las etiquetas del mensaje final
  response = response.replace(imageRegex, '').trim();

  // 2. Detección automática por URL de producto
  const urlRegex = /producto\/([a-zA-Z0-9\-]+)/ig;
  let urlMatch;
  while ((urlMatch = urlRegex.exec(response)) !== null) {
    const productSlug = urlMatch[1].replace(/-/g, ' ').trim();
    console.log(`[IMG] 🔍 URL producto detectada: slug="${urlMatch[1]}", query="${productSlug}"`);
    const foundPath = findBestImage(productSlug);
    console.log(`[IMG] ${foundPath ? '✅' : '❌'} findBestImage("${productSlug}") → ${foundPath ? path.basename(foundPath) : 'NO ENCONTRADA'}`);
    if (foundPath && !imagesToSend.includes(foundPath)) {
      imagesToSend.push(foundPath);
    }
  }

  // 3. Enviar las imágenes encontradas
  let sent = 0;
  for (const imgPath of imagesToSend) {
    try {
      const media = MessageMedia.fromFilePath(imgPath);
      await rawMsg.reply(media);
      console.log(`[IMG] 🖼️ Imagen enviada a ${senderPhone}: ${path.basename(imgPath)}`);
      sent++;
    } catch (imgErr) {
      console.error(`[IMG] ❌ Error enviando imagen ${imgPath}:`, imgErr.message);
    }
  }

  if (imagesToSend.length === 0) {
    console.log(`[IMG] ℹ️ Sin imágenes detectadas en respuesta para ${senderPhone}`);
  }

  return { cleanResponse: response, imagesSent: sent };
}

module.exports = { findBestImage, detectAndSendProductImages };
