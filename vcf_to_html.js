const fs = require('fs');
const path = require('path');

const vcfPath = path.join(__dirname, 'contactos_colombianos_limpios.vcf');
const csvPath = path.join(__dirname, 'contactos_colombianos.csv');
const htmlPath = path.join(__dirname, 'contactos_colombianos.html');

const raw = fs.readFileSync(vcfPath, 'utf8');
const cards = raw.split('BEGIN:VCARD').filter(c => c.trim());

const contactos = [];
for (const card of cards) {
  let nombre = '';
  let tel = '';
  const fnMatch = card.match(/FN:(.*)/);
  if (fnMatch) nombre = fnMatch[1].trim();
  const telMatch = card.match(/TEL[^:]*:(.*)/);
  if (telMatch) tel = telMatch[1].trim();
  if (tel) contactos.push({ nombre, tel });
}

// CSV
const csvRows = ['Nombre,Telefono'];
contactos.forEach(c => {
  csvRows.push(`"${c.nombre.replace(/"/g, '""')}","${c.tel}"`);
});
fs.writeFileSync(csvPath, '\ufeff' + csvRows.join('\n'), 'utf8');
console.log(`✅ CSV: ${csvPath} (${contactos.length} contactos)`);

// HTML interactivo
const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Contactos Zona Traumática 🇨🇴</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #0d1117; color: #e6edf3; padding: 20px; }
  h1 { text-align: center; margin-bottom: 5px; font-size: 24px; }
  .subtitle { text-align: center; color: #8b949e; margin-bottom: 20px; font-size: 14px; }
  .stats { display: flex; justify-content: center; gap: 20px; margin-bottom: 20px; flex-wrap: wrap; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 10px; padding: 15px 25px; text-align: center; }
  .stat .num { font-size: 28px; font-weight: bold; color: #58a6ff; }
  .stat .label { font-size: 12px; color: #8b949e; margin-top: 4px; }
  .search-box { display: flex; justify-content: center; margin-bottom: 20px; }
  .search-box input { width: 400px; padding: 12px 20px; border-radius: 10px; border: 1px solid #30363d; background: #161b22; color: #e6edf3; font-size: 16px; outline: none; }
  .search-box input:focus { border-color: #58a6ff; }
  .search-box input::placeholder { color: #484f58; }
  .count { text-align: center; color: #8b949e; margin-bottom: 15px; font-size: 13px; }
  table { width: 100%; max-width: 800px; margin: 0 auto; border-collapse: collapse; }
  th { background: #161b22; color: #58a6ff; padding: 12px 15px; text-align: left; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; position: sticky; top: 0; }
  td { padding: 10px 15px; border-bottom: 1px solid #21262d; font-size: 14px; }
  tr:hover td { background: #161b22; }
  .idx { color: #484f58; width: 50px; }
  .name { color: #e6edf3; font-weight: 500; }
  .phone { color: #7ee787; font-family: monospace; }
  .wa-link { color: #58a6ff; text-decoration: none; font-size: 12px; }
  .wa-link:hover { text-decoration: underline; }
  .hidden { display: none; }
</style>
</head>
<body>
<h1>📋 Contactos Zona Traumática</h1>
<p class="subtitle">Solo colombianos (+57) — Limpios y únicos</p>
<div class="stats">
  <div class="stat"><div class="num">${contactos.length.toLocaleString()}</div><div class="label">Total contactos</div></div>
  <div class="stat"><div class="num">${contactos.filter(c => c.nombre && c.nombre !== c.tel).length.toLocaleString()}</div><div class="label">Con nombre</div></div>
  <div class="stat"><div class="num">${contactos.filter(c => !c.nombre || c.nombre === c.tel).length.toLocaleString()}</div><div class="label">Sin nombre</div></div>
</div>
<div class="search-box">
  <input type="text" id="search" placeholder="🔍 Buscar por nombre o teléfono..." oninput="filtrar()">
</div>
<p class="count" id="count">Mostrando ${contactos.length.toLocaleString()} contactos</p>
<table>
<thead><tr><th class="idx">#</th><th>Nombre</th><th>Teléfono</th><th>WhatsApp</th></tr></thead>
<tbody id="tabla">
${contactos.map((c, i) => {
  const num = c.tel.replace('+', '');
  return `<tr><td class="idx">${i+1}</td><td class="name">${c.nombre || '<sin nombre>'}</td><td class="phone">${c.tel}</td><td><a class="wa-link" href="https://wa.me/${num}" target="_blank">Abrir chat</a></td></tr>`;
}).join('\n')}
</tbody>
</table>
<script>
function filtrar() {
  const q = document.getElementById('search').value.toLowerCase();
  const rows = document.querySelectorAll('#tabla tr');
  let visible = 0;
  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    if (text.includes(q)) { row.classList.remove('hidden'); visible++; }
    else { row.classList.add('hidden'); }
  });
  document.getElementById('count').textContent = 'Mostrando ' + visible.toLocaleString() + ' contactos';
}
</script>
</body>
</html>`;

fs.writeFileSync(htmlPath, html, 'utf8');
console.log(`✅ HTML: ${htmlPath}`);
console.log(`\n🎯 Abre el HTML en Chrome para verlo bonito con búsqueda y links a WhatsApp`);
