// ============================================
// search.js - Motor de Búsqueda Inteligente (RAG)
// ============================================
// Busca productos relevantes en el catálogo según lo que
// pregunte el cliente. Solo envía a Claude los que coincidan.

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

    catalogo = [];
    for (const [categoria, productos] of Object.entries(data.categorias)) {
      productos.forEach(p => {
        catalogo.push({
          ...p,
          categoria,
          _tituloLower: p.titulo.toLowerCase(),
          _descLower: (p.descripcion || '').toLowerCase(),
          _searchText: `${p.titulo} ${p.descripcion} ${p.marca || ''} ${p.modelo || ''} ${categoria} ${(p.keywords || []).join(' ')}`.toLowerCase(),
        });
      });
    }

    console.log(`[SEARCH] Catálogo cargado: ${catalogo.length} productos en memoria`);
  } catch (error) {
    console.error('[SEARCH] Error cargando catálogo:', error.message);
  }
}

// ============================================
// PALABRAS VACÍAS
// ============================================
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
const SYNONYMS = {
  'traumatica': ['traumática', 'trauma', 'pistola', 'arma'],
  'traumática': ['traumatica', 'trauma', 'pistola', 'arma'],
  'pistola': ['arma', 'traumática', 'traumatica', 'revolver'],
  'arma': ['pistola', 'traumática', 'traumatica', 'revolver'],
  'revolver': ['revólver', 'ekol', 'tambor'],
  'revólver': ['revolver', 'ekol', 'tambor'],
  'ekol': ['ekol'],
  'retay': ['retay'],
  'blow': ['blow'],
  'negro': ['negra', 'black'],
  'negra': ['negro', 'black'],
  'fume': ['fumé', 'gris', 'plomo'],
  'cromado': ['cromo', 'plateado', 'silver'],
  'compacto': ['compacta', 'pequeña', 'pequeño', 'mini'],
  'mini': ['compacto', 'compacta', 'pequeño', 'pequeña'],
  'magnum': ['grande', 'largo', 'potente'],
  'barato': ['económico', 'economico', 'precio bajo', 'accesible'],
  'caro': ['premium', 'alta gama', 'top'],
  'club': ['membresía', 'membresia', 'plan', 'plus', 'pro'],
  'membresia': ['club', 'membresía', 'plan', 'plus', 'pro'],
  'membresía': ['club', 'membresia', 'plan', 'plus', 'pro'],
  'legal': ['ley', 'juridico', 'jurídico', 'legalidad'],
  'juridico': ['legal', 'jurídico', 'ley', 'defensa'],
  'jurídico': ['legal', 'juridico', 'ley', 'defensa'],
  'defensa': ['juridico', 'jurídico', 'legal', 'proteccion'],
  'carnet': ['carnét', 'certificado', 'documento', 'qr'],
  'municion': ['munición', 'cartuchos', 'balas', 'oskurzan', 'rubber'],
  'munición': ['municion', 'cartuchos', 'balas', 'oskurzan', 'rubber'],
  'plan': ['plus', 'pro', 'membresía', 'membresia', 'club'],
  'plus': ['plan plus', 'plan', 'club'],
  'pro': ['plan pro', 'plan', 'club'],
  'asesor': ['asesor legal', 'ia legal', 'bot legal', 'legal ia'],
  'policia': ['policía', 'retencion', 'retención', 'incautacion', 'ley'],
  'retencion': ['retención', 'policia', 'policía', 'incautacion', 'ley'],
  'decreto': ['decreto 2535', 'ley 2197', 'legal', 'juridico'],
  'afiliacion': ['afiliación', 'club', 'membresia', 'carnet'],
  'afiliación': ['afiliacion', 'club', 'membresia', 'carnet'],
};

// ============================================
// EXTRAER PALABRAS CLAVE
// ============================================
function extractKeywords(message) {
  const clean = message
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!.,;:(){}[\]"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = clean.split(' ').filter(w => w.length > 1 && !STOP_WORDS.has(w));

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
function searchProducts(message, maxResults = 6) {
  if (catalogo.length === 0) {
    console.warn('[SEARCH] Catálogo vacío, recargando...');
    loadCatalog();
  }

  const keywords = extractKeywords(message);

  if (keywords.length === 0) {
    return {
      keywords: [],
      products: getHighlightProducts(),
      totalFound: 0,
      strategy: 'highlights',
    };
  }

  const scored = catalogo.map(product => {
    let score = 0;

    keywords.forEach(keyword => {
      if (product._tituloLower.includes(keyword)) {
        score += 10;
        if (product._tituloLower.startsWith(keyword)) score += 5;
      }
      if (product._descLower.includes(keyword)) score += 3;
      if (product.categoria.toLowerCase().includes(keyword)) score += 5;
      if ((product.marca || '').toLowerCase().includes(keyword)) score += 8;
      if ((product.modelo || '').toLowerCase().includes(keyword)) score += 8;
      if (product._searchText.includes(keyword)) score += 2; // keywords del catálogo
    });

    if (product.disponible) score += 1;

    return { ...product, _score: score };
  });

  const results = scored
    .filter(p => p._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, maxResults);

  console.log(`[SEARCH] "${message}" → ${keywords.length} keywords → ${results.length} productos encontrados`);

  return {
    keywords,
    products: results,
    totalFound: scored.filter(p => p._score > 0).length,
    strategy: 'search',
  };
}

// ============================================
// PRODUCTOS DESTACADOS
// ============================================
function getHighlightProducts() {
  // Uno por marca
  const marcas = ['RETAY', 'EKOL', 'BLOW'];
  const highlights = [];
  marcas.forEach(marca => {
    const inMarca = catalogo.filter(p => p.categoria === marca && p.disponible);
    if (inMarca.length > 0) highlights.push(inMarca[0]);
  });
  return highlights;
}

// ============================================
// FORMATEAR PARA EL PROMPT DE CLAUDE
// ============================================
function formatForPrompt(searchResult) {
  const { products, totalFound, strategy, keywords } = searchResult;

  if (products.length === 0) {
    return 'No se encontraron productos que coincidan con la búsqueda del cliente.';
  }

  let text = '';

  if (strategy === 'highlights') {
    text += 'REFERENCIAS DESTACADAS DEL CATÁLOGO:\n\n';
  } else {
    text += `REFERENCIAS RELEVANTES (${products.length} de ${totalFound} coincidencias):\n\n`;
  }

  products.forEach((p, i) => {
    text += `${i + 1}. ${p.titulo}\n`;
    text += `   Marca: ${p.marca || p.categoria} | Modelo: ${p.modelo || '-'}\n`;
    text += `   Color(es): ${p.color || '-'}\n`;
    text += `   Precio Plan Plus: ${p.precio_plus || 'Consultar'}\n`;
    text += `   Precio Plan Pro: ${p.precio_pro || 'No disponible en Plan Pro'}\n`;
    text += `   Disponible: ${p.disponible ? 'Sí' : 'No'}\n`;
    if (p.url) {
      text += `   🔗 Link del producto: ${p.url}\n`;
    }
    if (p.descripcion) {
      const desc = p.descripcion.length > 300
        ? p.descripcion.substring(0, 300) + '...'
        : p.descripcion;
      text += `   Descripción: ${desc}\n`;
    }
    text += '\n';
  });

  if (totalFound > products.length) {
    text += `\nNOTA: Hay ${totalFound - products.length} referencias más disponibles. `;
    text += 'Si el cliente quiere ver más opciones, indícale que puede preguntar por marca o características.\n';
  }

  return text;
}

// ============================================
// RESUMEN DEL CATÁLOGO
// ============================================
function getCatalogSummary() {
  const marcas = {};
  catalogo.forEach(p => {
    if (!marcas[p.categoria]) marcas[p.categoria] = 0;
    marcas[p.categoria]++;
  });

  let summary = 'RESUMEN DEL INVENTARIO ZONA TRAUMÁTICA:\n';
  summary += `- Total de referencias: ${catalogo.length} pistolas traumáticas\n`;
  for (const [marca, count] of Object.entries(marcas)) {
    summary += `- ${marca}: ${count} referencias\n`;
  }
  summary += `- Rango de precios: $1.150.000 - $1.500.000\n`;
  summary += `- Todos los precios incluyen Plan de Respaldo (Plus o Pro)\n`;

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
  extractKeywords,
};
