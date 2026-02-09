// ============================================
// search.js - Motor de Búsqueda Inteligente (RAG)
// ============================================
// Busca productos relevantes en el catálogo según lo que
// pregunte el cliente. Solo envía a Claude los que coincidan.
//
// ¿Cómo funciona?
// 1. Recibe el mensaje del cliente
// 2. Extrae palabras clave (quita palabras inútiles como "el", "de", "un")
// 3. Busca cada palabra en título + descripción de cada producto
// 4. Puntúa: coincidencia en título vale más que en descripción
// 5. Devuelve los TOP N productos ordenados por relevancia

const fs = require('fs');
const path = require('path');

// ============================================
// CARGAR CATÁLOGO
// ============================================
let catalogo = [];

function loadCatalog() {
  try {
    const data = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'catalogo_contexto.json'), 'utf8')
    );

    // Aplanar todas las categorías en un solo array
    catalogo = [];
    for (const [categoria, productos] of Object.entries(data.categorias)) {
      productos.forEach(p => {
        catalogo.push({
          ...p,
          categoria,
          // Pre-calcular texto en minúsculas para búsqueda rápida
          _tituloLower: p.titulo.toLowerCase(),
          _descLower: (p.descripcion || '').toLowerCase(),
          _searchText: `${p.titulo} ${p.descripcion} ${categoria}`.toLowerCase(),
        });
      });
    }

    console.log(`[SEARCH] Catálogo cargado: ${catalogo.length} productos en memoria`);
  } catch (error) {
    console.error('[SEARCH] Error cargando catálogo:', error.message);
  }
}

// ============================================
// PALABRAS VACÍAS (stop words en español)
// ============================================
// Estas palabras no aportan a la búsqueda, las ignoramos
const STOP_WORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
  'de', 'del', 'en', 'con', 'por', 'para', 'al', 'a',
  'y', 'o', 'que', 'es', 'se', 'no', 'si', 'su', 'sus',
  'me', 'te', 'le', 'lo', 'mi', 'tu', 'ya', 'hay',
  'como', 'pero', 'más', 'mas', 'este', 'esta', 'ese', 'esa',
  'ser', 'son', 'está', 'esta', 'muy', 'tan', 'aquí', 'ahí',
  'hola', 'buenas', 'buenos', 'dias', 'días', 'tardes', 'noches', 'gracias',
  'tienen', 'tienes', 'tiene', 'quiero', 'necesito', 'busco',
  'ver', 'saber', 'cual', 'cuál', 'cuales', 'cuáles',
  'algo', 'todo', 'todos', 'eso', 'esto', 'bien', 'bueno', 'dale',
  'puedo', 'puede', 'podría', 'favor', 'por favor',
  'info', 'información', 'informacion', 'sobre',
  'cuánto', 'cuanto', 'cuestan', 'cuesta', 'vale', 'valen',
  'hay', 'donde', 'dónde', 'cuando', 'cuándo', 'quien', 'quién',
  'marca', 'modelo', 'tipo', 'qué', 'que',
  'cómo', 'como', 'están', 'estan', 'estás', 'estas', 'oye', 'oiga',
  'por', 'porfavor', 'disculpa', 'disculpe', 'perdón', 'perdon',
]);

// ============================================
// SINÓNIMOS Y EXPANSIONES
// ============================================
// Si el cliente dice "barata" buscamos también "económico", etc.
const SYNONYMS = {
  'barato': ['económico', 'economico', 'precio bajo', 'accesible'],
  'barata': ['económica', 'economica', 'precio bajo', 'accesible'],
  'caro': ['premium', 'alta gama', 'profesional'],
  'cara': ['premium', 'alta gama', 'profesional'],
  'mira': ['telescopica', 'scope', 'óptica', 'optica', 'visor'],
  'municion': ['balines', 'pellets', 'diabolo', 'bbs', 'slug', 'proyectil'],
  'munición': ['balines', 'pellets', 'diabolo', 'bbs', 'slug', 'proyectil'],
  'balines': ['municion', 'munición', 'pellets', 'diabolo', 'bbs'],
  'rifle': ['carabina', 'airgun', 'air gun'],
  'carabina': ['rifle', 'airgun'],
  'pistola': ['handgun', 'marcadora'],
  'pcp': ['pre charged', 'precomprimido', 'aire comprimido'],
  'resorte': ['spring', 'springer', 'nitro piston', 'quiebre'],
  'co2': ['gas', 'cápsula', 'capsula'],
  'bomba': ['pump', 'compresor', 'inflador'],
  'funda': ['estuche', 'maleta', 'case', 'bolso'],
  'limpieza': ['mantenimiento', 'cleaning', 'aceite', 'lubricante'],
  'gamo': ['gamo'],
  'hatsan': ['hatsan'],
  'snowpeak': ['snowpeak', 'artemis'],
  '4.5': ['.177', '4.5mm', 'calibre 4.5'],
  '5.5': ['.22', '5.5mm', 'calibre 5.5', 'calibre 22'],
  '6.35': ['.25', '6.35mm', 'calibre 6.35'],
  '.177': ['4.5', '4.5mm'],
  '.22': ['5.5', '5.5mm'],
  '.25': ['6.35', '6.35mm'],
};

// ============================================
// EXTRAER PALABRAS CLAVE
// ============================================
function extractKeywords(message) {
  // Limpiar: minúsculas, quitar puntuación
  const clean = message
    .toLowerCase()
    .replace(/[¿?¡!.,;:(){}[\]"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Separar en palabras y filtrar stop words
  const words = clean.split(' ').filter(w => w.length > 1 && !STOP_WORDS.has(w));

  // Expandir sinónimos
  const expanded = new Set(words);
  words.forEach(word => {
    if (SYNONYMS[word]) {
      SYNONYMS[word].forEach(syn => expanded.add(syn));
    }
  });

  return Array.from(expanded);
}

// ============================================
// BUSCAR PRODUCTOS
// ============================================
function searchProducts(message, maxResults = 8) {
  if (catalogo.length === 0) {
    console.warn('[SEARCH] Catálogo vacío, recargando...');
    loadCatalog();
  }

  const keywords = extractKeywords(message);

  if (keywords.length === 0) {
    // Sin palabras clave útiles → devolver productos destacados
    return {
      keywords: [],
      products: getHighlightProducts(),
      totalFound: 0,
      strategy: 'highlights',
    };
  }

  // Puntuar cada producto
  const scored = catalogo.map(product => {
    let score = 0;

    keywords.forEach(keyword => {
      // Coincidencia en TÍTULO = +10 puntos (más importante)
      if (product._tituloLower.includes(keyword)) {
        score += 10;
        // Bonus si el título EMPIEZA con la palabra
        if (product._tituloLower.startsWith(keyword)) score += 5;
      }

      // Coincidencia en DESCRIPCIÓN = +3 puntos
      if (product._descLower.includes(keyword)) {
        score += 3;
      }

      // Coincidencia en CATEGORÍA = +5 puntos
      if (product.categoria.toLowerCase().includes(keyword)) {
        score += 5;
      }
    });

    // Bonus si está disponible
    if (product.disponible) score += 1;

    return { ...product, _score: score };
  });

  // Filtrar los que tienen puntaje > 0 y ordenar por relevancia
  const results = scored
    .filter(p => p._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, maxResults);

  console.log(`[SEARCH] "${message}" → ${keywords.length} keywords → ${results.length} productos encontrados`);

  if (results.length > 0) {
    console.log(`[SEARCH] Top resultado: "${results[0].titulo}" (score: ${results[0]._score})`);
  }

  return {
    keywords,
    products: results,
    totalFound: scored.filter(p => p._score > 0).length,
    strategy: 'search',
  };
}

// ============================================
// PRODUCTOS DESTACADOS (cuando no hay búsqueda clara)
// ============================================
function getHighlightProducts() {
  // Devolver 1 producto de cada categoría principal
  const mainCategories = [
    'Rifles de Aire', 'Pistolas de Aire', 'Munición / Balines',
    'Miras y Ópticas', 'Bombas y Compresores PCP'
  ];

  const highlights = [];
  mainCategories.forEach(cat => {
    const inCat = catalogo.filter(p => p.categoria === cat && p.disponible);
    if (inCat.length > 0) highlights.push(inCat[0]);
  });

  return highlights;
}

// ============================================
// FORMATEAR RESULTADOS PARA EL PROMPT DE CLAUDE
// ============================================
function formatForPrompt(searchResult) {
  const { products, totalFound, strategy, keywords } = searchResult;

  if (products.length === 0) {
    return 'No se encontraron productos que coincidan con la búsqueda del cliente.';
  }

  let text = '';

  if (strategy === 'highlights') {
    text += 'PRODUCTOS DESTACADOS DEL CATÁLOGO:\n\n';
  } else {
    text += `PRODUCTOS RELEVANTES (${products.length} de ${totalFound} coincidencias):\n\n`;
  }

  products.forEach((p, i) => {
    text += `${i + 1}. ${p.titulo}\n`;
    text += `   Categoría: ${p.categoria}\n`;
    text += `   Precio: ${p.precio}\n`;
    text += `   Disponible: ${p.disponible ? 'Sí' : 'No'}\n`;

    if (p.descripcion) {
      // Limitar descripción a 400 chars para no inflar
      const desc = p.descripcion.length > 400
        ? p.descripcion.substring(0, 400) + '...'
        : p.descripcion;
      text += `   Descripción: ${desc}\n`;
    }

    if (p.url) {
      text += `   Link: ${p.url}\n`;
    }

    text += '\n';
  });

  // Nota para Claude sobre productos no mostrados
  if (totalFound > products.length) {
    text += `\nNOTA: Hay ${totalFound - products.length} productos más que coinciden. `;
    text += 'Si el cliente necesita ver más opciones, indícale que puede preguntar con más detalle.\n';
  }

  return text;
}

// ============================================
// RESUMEN RÁPIDO DEL CATÁLOGO (para saludos)
// ============================================
function getCatalogSummary() {
  const categorias = {};
  catalogo.forEach(p => {
    if (!categorias[p.categoria]) categorias[p.categoria] = 0;
    categorias[p.categoria]++;
  });

  let summary = 'RESUMEN DEL CATÁLOGO:\n';
  for (const [cat, count] of Object.entries(categorias)) {
    summary += `- ${cat}: ${count} productos\n`;
  }
  summary += `\nTotal: ${catalogo.length} productos disponibles.`;

  return summary;
}

// ============================================
// EXPORTAR
// ============================================
module.exports = {
  loadCatalog,
  searchProducts,
  formatForPrompt,
  getCatalogSummary,
  extractKeywords, // exportamos para testing/debug
};
