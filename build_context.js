// ============================================
// build_context.js - Generar contexto RAG para el bot
// ============================================
// Uso: node build_context.js
//
// Lee inventario_calonge.json y extrae:
//   - Título del producto
//   - Descripción (texto plano, sin HTML)
//   - Precio del primer variant
//   - URL de imagen principal
//
// Genera DOS archivos:
//   1. catalogo_contexto.txt  → Texto legible para el system prompt (RAG)
//   2. catalogo_contexto.json → Versión estructurada para búsqueda programática

const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, 'inventario_calonge.json');
const OUTPUT_TXT = path.join(__dirname, 'catalogo_contexto.txt');
const OUTPUT_JSON = path.join(__dirname, 'catalogo_contexto.json');

// ============================================
// UTILIDADES
// ============================================

// Limpiar HTML a texto plano (por si quedaron restos)
function cleanHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')          // <br> → salto de línea
    .replace(/<\/p>/gi, '\n')                // cierre de párrafo → salto
    .replace(/<\/li>/gi, '\n')               // cierre de lista → salto
    .replace(/<li[^>]*>/gi, '• ')            // apertura de lista → viñeta
    .replace(/<[^>]*>/g, '')                 // eliminar todas las demás etiquetas
    .replace(/&nbsp;/g, ' ')                 // espacios HTML
    .replace(/&amp;/g, '&')                  // &
    .replace(/&lt;/g, '<')                   // <
    .replace(/&gt;/g, '>')                   // >
    .replace(/&quot;/g, '"')                 // "
    .replace(/&#39;/g, "'")                  // '
    .replace(/\n{3,}/g, '\n\n')             // máximo 2 saltos seguidos
    .replace(/[ \t]+/g, ' ')                // múltiples espacios → uno
    .trim();
}

// Formatear precio en COP legible
function formatPrice(price) {
  if (!price || price === '0.00') return 'Consultar precio';
  const num = parseFloat(price);
  return '$' + num.toLocaleString('es-CO', { maximumFractionDigits: 0 });
}

// Categorizar producto automáticamente por palabras clave en el título
function categorize(titulo, descripcion) {
  const text = (titulo + ' ' + descripcion).toLowerCase();

  if (/rifle|pcp|carabina|airgun|air gun|springer|nitro piston/.test(text)) return 'Rifles de Aire';
  if (/pistola/.test(text)) return 'Pistolas de Aire';
  if (/mira|telescop|scope|holograf|red dot|punto rojo/.test(text)) return 'Miras y Ópticas';
  if (/bal[ií]n|pellet|munici|bbs|diabolo|slug/.test(text)) return 'Munición / Balines';
  if (/bomba|tanque|compresor|pcp.*pump|inflador/.test(text)) return 'Bombas y Compresores PCP';
  if (/funda|estuche|malet|case|bolso/.test(text)) return 'Fundas y Estuches';
  if (/limpieza|cleaning|mantenimiento|aceite|lubricant/.test(text)) return 'Limpieza y Mantenimiento';
  if (/bípode|bipod|soporte|monopod|trípode/.test(text)) return 'Soportes y Bípodes';
  if (/cuchillo|navaja|machete|hacha/.test(text)) return 'Cuchillería';
  if (/linterna|flashlight|lámpara|lamp/.test(text)) return 'Linternas';
  if (/caña|sedal|anzuelo|pesca|carrete|señuelo|curricán/.test(text)) return 'Pesca';
  if (/gorra|gafas|guante|ropa|camisa|pantalón|bota|chaleco/.test(text)) return 'Ropa y Accesorios';
  if (/blanco|diana|target/.test(text)) return 'Blancos y Dianas';
  if (/co2|cápsula|capsul/.test(text)) return 'CO2 y Cápsulas';
  if (/juguete|infantil|niño|niña/.test(text)) return 'Juguetes';

  return 'Otros';
}

// ============================================
// PROCESAR
// ============================================
function buildContext() {
  // Leer inventario
  const raw = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  const productos = raw.productos;

  console.log(`Leyendo ${productos.length} productos de inventario_calonge.json...\n`);

  // Extraer campos necesarios y categorizar
  const processed = productos.map(p => {
    const titulo = p.titulo || 'Sin título';
    const descripcion = cleanHtml(p.descripcion);
    const precio = formatPrice(p.variantes?.[0]?.precio);
    const precioRaw = p.variantes?.[0]?.precio || '0';
    const disponible = p.variantes?.[0]?.disponible ?? false;
    const imagen = p.imagen_principal || '';
    const url = p.url || '';
    const categoria = categorize(titulo, descripcion);

    return { titulo, descripcion, precio, precioRaw, disponible, imagen, url, categoria };
  });

  // Agrupar por categoría
  const porCategoria = {};
  processed.forEach(p => {
    if (!porCategoria[p.categoria]) porCategoria[p.categoria] = [];
    porCategoria[p.categoria].push(p);
  });

  // ============================================
  // GENERAR TEXTO RAG (catalogo_contexto.txt)
  // ============================================
  let txt = '';
  txt += '===================================================\n';
  txt += ' CATÁLOGO DE PRODUCTOS - CALONGE SPORT\n';
  txt += ` Generado: ${new Date().toLocaleString('es-CO')}\n`;
  txt += ` Total: ${productos.length} productos\n`;
  txt += '===================================================\n\n';

  // Orden de categorías (las más relevantes primero)
  const ordenCategorias = [
    'Rifles de Aire', 'Pistolas de Aire', 'Munición / Balines',
    'Miras y Ópticas', 'Bombas y Compresores PCP', 'CO2 y Cápsulas',
    'Soportes y Bípodes', 'Fundas y Estuches', 'Limpieza y Mantenimiento',
    'Blancos y Dianas', 'Cuchillería', 'Linternas',
    'Pesca', 'Ropa y Accesorios', 'Juguetes', 'Otros'
  ];

  for (const cat of ordenCategorias) {
    const items = porCategoria[cat];
    if (!items || items.length === 0) continue;

    txt += `\n== ${cat.toUpperCase()} (${items.length} productos) ==\n`;
    txt += '-'.repeat(50) + '\n\n';

    items.forEach(p => {
      txt += `• ${p.titulo}\n`;
      txt += `  Precio: ${p.precio}`;
      txt += p.disponible ? ' | Disponible: Sí' : ' | Disponible: No';
      txt += '\n';

      if (p.descripcion) {
        // Limitar descripción a 300 caracteres para no inflar el contexto
        const desc = p.descripcion.length > 300
          ? p.descripcion.substring(0, 300) + '...'
          : p.descripcion;
        txt += `  ${desc}\n`;
      }

      if (p.url) {
        txt += `  Link: ${p.url}\n`;
      }

      txt += '\n';
    });
  }

  // Resumen al final
  txt += '\n===================================================\n';
  txt += ' RESUMEN POR CATEGORÍA\n';
  txt += '===================================================\n';
  for (const cat of ordenCategorias) {
    const items = porCategoria[cat];
    if (!items || items.length === 0) continue;
    const disponibles = items.filter(i => i.disponible).length;
    txt += `  ${cat}: ${items.length} productos (${disponibles} disponibles)\n`;
  }

  fs.writeFileSync(OUTPUT_TXT, txt, 'utf8');
  console.log(`Archivo TXT generado: ${OUTPUT_TXT}`);
  console.log(`Tamaño: ${(fs.statSync(OUTPUT_TXT).size / 1024).toFixed(1)} KB\n`);

  // ============================================
  // GENERAR JSON ESTRUCTURADO (catalogo_contexto.json)
  // ============================================
  const jsonOutput = {
    metadata: {
      fuente: 'https://calongesport.com',
      fecha_generacion: new Date().toISOString(),
      total_productos: productos.length,
      categorias: Object.keys(porCategoria).length,
    },
    categorias: {},
  };

  for (const cat of ordenCategorias) {
    const items = porCategoria[cat];
    if (!items || items.length === 0) continue;

    jsonOutput.categorias[cat] = items.map(p => ({
      titulo: p.titulo,
      descripcion: p.descripcion,
      precio: p.precio,
      disponible: p.disponible,
      imagen: p.imagen,
      url: p.url,
    }));
  }

  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(jsonOutput, null, 2), 'utf8');
  console.log(`Archivo JSON generado: ${OUTPUT_JSON}`);
  console.log(`Tamaño: ${(fs.statSync(OUTPUT_JSON).size / 1024).toFixed(1)} KB\n`);

  // ============================================
  // REPORTE
  // ============================================
  console.log('--- Productos por categoría ---');
  for (const cat of ordenCategorias) {
    const items = porCategoria[cat];
    if (!items || items.length === 0) continue;
    const disponibles = items.filter(i => i.disponible).length;
    console.log(`  ${cat}: ${items.length} (${disponibles} disponibles)`);
  }

  console.log('\n¡Contexto RAG generado correctamente!');
  console.log('Usa catalogo_contexto.txt como system prompt del bot.');
  console.log('Usa catalogo_contexto.json para búsquedas programáticas.');
}

buildContext();
