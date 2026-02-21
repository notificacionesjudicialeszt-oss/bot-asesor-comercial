const fs = require('fs');
const path = require('path');

const vcfPath = path.join(__dirname, 'contactos_whatsapp_2026-02-19T21-57-40.vcf');
const outputPath = path.join(__dirname, 'contactos_colombianos_limpios.vcf');

const raw = fs.readFileSync(vcfPath, 'utf8');
const cards = raw.split('BEGIN:VCARD').filter(c => c.trim());

let colombianos = 0;
let descartados = 0;
let duplicados = 0;
const telefonosVistos = new Set();
let output = '';

for (const card of cards) {
  const telMatch = card.match(/TEL[^:]*:(.*)/);
  if (!telMatch) { descartados++; continue; }

  const tel = telMatch[1].trim();

  // Solo colombianos (+57)
  if (!tel.startsWith('+57')) { descartados++; continue; }

  // Extraer solo los dígitos del número
  const digitos = tel.replace(/\D/g, '');

  // Números colombianos válidos: 57 + 10 dígitos = 12 dígitos total
  if (digitos.length < 12 || digitos.length > 13) { descartados++; continue; }

  // Verificar duplicados por número
  if (telefonosVistos.has(digitos)) { duplicados++; continue; }
  telefonosVistos.add(digitos);

  output += 'BEGIN:VCARD' + card;
  colombianos++;
}

fs.writeFileSync(outputPath, output, 'utf8');

console.log('✅ VCF limpio creado:');
console.log(`   📁 ${outputPath}`);
console.log(`\n📊 Resultados:`);
console.log(`   🇨🇴 Colombianos válidos: ${colombianos}`);
console.log(`   🔁 Duplicados eliminados: ${duplicados}`);
console.log(`   ❌ Descartados (internacionales/inválidos): ${descartados}`);
console.log(`   📋 Total procesados: ${cards.length}`);
