const fs = require('fs');
const path = require('path');

const vcfPath = path.join(__dirname, 'contactos_whatsapp_2026-02-19T21-57-40.vcf');
const csvPath = path.join(__dirname, 'contactos_analisis.csv');

const raw = fs.readFileSync(vcfPath, 'utf8');
const cards = raw.split('BEGIN:VCARD').filter(c => c.trim());

const rows = [];
rows.push('Nombre,Telefono,Codigo_Pais,Es_Colombiano');

for (const card of cards) {
  let nombre = '';
  let tel = '';

  const fnMatch = card.match(/FN:(.*)/);
  if (fnMatch) nombre = fnMatch[1].trim().replace(/,/g, ' ');

  const telMatch = card.match(/TEL[^:]*:(.*)/);
  if (telMatch) tel = telMatch[1].trim();

  // Determinar código de país
  let codigoPais = '';
  let esColombia = 'NO';
  if (tel.startsWith('+57')) {
    codigoPais = '+57';
    esColombia = 'SI';
  } else if (tel.startsWith('+1')) {
    codigoPais = '+1 (US/CA)';
  } else if (tel.startsWith('+52')) {
    codigoPais = '+52 (MX)';
  } else if (tel.startsWith('+34')) {
    codigoPais = '+34 (ES)';
  } else {
    const match = tel.match(/^\+(\d{1,3})/);
    codigoPais = match ? '+' + match[1] : 'Desconocido';
  }

  rows.push(`"${nombre}","${tel}","${codigoPais}","${esColombia}"`);
}

fs.writeFileSync(csvPath, '\ufeff' + rows.join('\n'), 'utf8'); // BOM para Excel
console.log(`✅ CSV creado: ${csvPath}`);
console.log(`📊 Total: ${cards.length} contactos`);

// Estadísticas por país
const stats = {};
for (const card of cards) {
  const telMatch = card.match(/TEL[^:]*:(.*)/);
  if (!telMatch) continue;
  const tel = telMatch[1].trim();
  
  if (tel.startsWith('+57')) stats['Colombia +57'] = (stats['Colombia +57'] || 0) + 1;
  else if (tel.startsWith('+1')) stats['US/Canada +1'] = (stats['US/Canada +1'] || 0) + 1;
  else if (tel.startsWith('+52')) stats['Mexico +52'] = (stats['Mexico +52'] || 0) + 1;
  else if (tel.startsWith('+34')) stats['España +34'] = (stats['España +34'] || 0) + 1;
  else if (tel.startsWith('+58')) stats['Venezuela +58'] = (stats['Venezuela +58'] || 0) + 1;
  else if (tel.startsWith('+593')) stats['Ecuador +593'] = (stats['Ecuador +593'] || 0) + 1;
  else if (tel.startsWith('+51')) stats['Peru +51'] = (stats['Peru +51'] || 0) + 1;
  else stats['Otros'] = (stats['Otros'] || 0) + 1;
}

console.log('\n📊 Distribución por país:');
Object.entries(stats).sort((a, b) => b[1] - a[1]).forEach(([pais, count]) => {
  console.log(`  ${pais}: ${count}`);
});
