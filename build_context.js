// ============================================
// build_context.js - Generar contexto RAG para Zona Traumática
// ============================================
// Uso: node build_context.js
//
// Lee knowledge_base.json y catalogo_contexto.json y genera:
//   1. catalogo_contexto.txt → Texto legible para revisar el catálogo

const fs = require('fs');
const path = require('path');

const KB = path.join(__dirname, 'knowledge_base.json');
const CATALOGO = path.join(__dirname, 'catalogo_contexto.json');
const OUTPUT_TXT = path.join(__dirname, 'catalogo_contexto.txt');

function formatPrice(num) {
  if (!num) return 'No disponible';
  return '$' + Number(num).toLocaleString('es-CO');
}

function buildContext() {
  const kb = JSON.parse(fs.readFileSync(KB, 'utf8'));
  const catalogo = JSON.parse(fs.readFileSync(CATALOGO, 'utf8'));

  let txt = '';
  txt += '===================================================\n';
  txt += ' CATÁLOGO DE REFERENCIAS — ZONA TRAUMÁTICA\n';
  txt += ` Generado: ${new Date().toLocaleString('es-CO')}\n`;
  txt += ` Total: ${catalogo.metadata.total_productos} referencias\n`;
  txt += '===================================================\n\n';
  txt += `NOTA: ${catalogo.metadata.nota_precios}\n\n`;

  for (const [marca, productos] of Object.entries(catalogo.categorias)) {
    txt += `\n== ${marca} (${productos.length} referencias) ==\n`;
    txt += '-'.repeat(50) + '\n\n';

    productos.forEach(p => {
      txt += `• ${p.titulo}\n`;
      txt += `  Color(es): ${p.color}\n`;
      txt += `  Plan Plus: ${p.precio_plus || 'N/A'} | Plan Pro: ${p.precio_pro || 'No disponible'}\n`;
      txt += `  Disponible: ${p.disponible ? 'Sí' : 'No'}\n`;
      if (p.descripcion) {
        txt += `  ${p.descripcion.substring(0, 200)}\n`;
      }
      txt += '\n';
    });
  }

  txt += '\n===================================================\n';
  txt += ' PAQUETE INCLUIDO EN CADA COMPRA\n';
  txt += '===================================================\n';
  (kb.paquete_compra?.items || []).forEach(item => {
    txt += `  ✓ ${item}\n`;
  });

  txt += '\n===================================================\n';
  txt += ' CLUB ZONA TRAUMÁTICA\n';
  txt += '===================================================\n';
  txt += `Plan Plus (${kb.club?.plan_plus?.precio}):\n`;
  (kb.club?.plan_plus?.incluye || []).forEach(i => txt += `  • ${i}\n`);
  txt += `\nPlan Pro (${kb.club?.plan_pro?.precio}):\n`;
  (kb.club?.plan_pro?.incluye || []).forEach(i => txt += `  • ${i}\n`);

  fs.writeFileSync(OUTPUT_TXT, txt, 'utf8');
  console.log(`\n✅ Archivo generado: ${OUTPUT_TXT}`);
  console.log(`Tamaño: ${(fs.statSync(OUTPUT_TXT).size / 1024).toFixed(1)} KB`);
}

buildContext();
