// ============================================
// scrape_calonge.js - Descargar catálogo completo de Calonge Sport
// ============================================
// Uso: node scrape_calonge.js
//
// Itera sobre la API pública de Shopify (products.json)
// página por página hasta que no haya más productos.
// Guarda todo en inventario_calonge.json

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://calongesport.com/products.json';
const LIMIT = 250; // máximo permitido por Shopify
const OUTPUT_FILE = path.join(__dirname, 'inventario_calonge.json');

async function scrapeAllProducts() {
  const allProducts = [];
  let page = 1;
  let hasMore = true;

  console.log('=== Descargando catálogo de Calonge Sport ===\n');

  while (hasMore) {
    const url = `${BASE_URL}?limit=${LIMIT}&page=${page}`;
    console.log(`[Página ${page}] Descargando: ${url}`);

    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; CatalogBot/1.0)',
        },
        timeout: 30000,
      });

      const products = response.data.products;

      if (!products || products.length === 0) {
        console.log(`[Página ${page}] Sin productos. Fin del catálogo.\n`);
        hasMore = false;
      } else {
        console.log(`[Página ${page}] ${products.length} productos encontrados`);
        allProducts.push(...products);

        // Si devolvió menos del límite, es la última página
        if (products.length < LIMIT) {
          hasMore = false;
        } else {
          page++;
        }
      }

      // Pausa de 1 segundo entre requests para no saturar el servidor
      if (hasMore) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

    } catch (error) {
      if (error.response?.status === 404 || error.response?.status === 422) {
        console.log(`[Página ${page}] No hay más páginas (${error.response.status}). Fin.\n`);
        hasMore = false;
      } else {
        console.error(`[Página ${page}] Error: ${error.message}`);
        console.log('Reintentando en 3 segundos...');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }

  // --- Procesar y guardar ---
  console.log(`=== Total: ${allProducts.length} productos descargados ===\n`);

  // Crear inventario optimizado para el bot
  const inventario = {
    metadata: {
      fuente: 'https://calongesport.com',
      fecha_descarga: new Date().toISOString(),
      total_productos: allProducts.length,
      total_variantes: allProducts.reduce((sum, p) => sum + (p.variants?.length || 0), 0),
    },
    productos: allProducts.map(product => ({
      id: product.id,
      titulo: product.title,
      descripcion: product.body_html ? product.body_html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '',
      tipo: product.product_type || '',
      marca: product.vendor || '',
      tags: product.tags || [],
      estado: product.status || 'active',
      creado: product.created_at,
      actualizado: product.updated_at,
      url: product.handle ? `https://calongesport.com/products/${product.handle}` : '',
      imagenes: (product.images || []).map(img => img.src),
      imagen_principal: product.images?.[0]?.src || '',
      variantes: (product.variants || []).map(v => ({
        id: v.id,
        titulo: v.title,
        precio: v.price,
        precio_comparacion: v.compare_at_price,
        sku: v.sku || '',
        disponible: v.available,
        inventario: v.inventory_quantity,
        requiere_envio: v.requires_shipping,
        peso: v.weight,
        unidad_peso: v.weight_unit,
      })),
      opciones: (product.options || []).map(opt => ({
        nombre: opt.name,
        valores: opt.values,
      })),
    })),
  };

  // Guardar archivo
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(inventario, null, 2), 'utf8');
  console.log(`Archivo guardado: ${OUTPUT_FILE}`);
  console.log(`Tamaño: ${(fs.statSync(OUTPUT_FILE).size / 1024).toFixed(1)} KB\n`);

  // Resumen por tipo de producto
  const tipos = {};
  inventario.productos.forEach(p => {
    const tipo = p.tipo || 'Sin categoría';
    tipos[tipo] = (tipos[tipo] || 0) + 1;
  });

  console.log('--- Productos por categoría ---');
  Object.entries(tipos)
    .sort((a, b) => b[1] - a[1])
    .forEach(([tipo, count]) => {
      console.log(`  ${tipo}: ${count}`);
    });

  console.log('\n¡Listo! El inventario está en inventario_calonge.json');
}

scrapeAllProducts();
