// ============================================
// ZONA TRAUMÁTICA — Panel de Control Web
// ============================================
// Uso: node panel.js
// Abre http://localhost:3000 en el navegador
// ============================================

const http = require('http');
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'crm.db'));
const PORT = 3000;

function getData() {
  const clients = db.prepare('SELECT * FROM clients ORDER BY updated_at DESC').all();
  const conversations = db.prepare('SELECT * FROM conversations ORDER BY created_at DESC LIMIT 200').all();
  const assignments = db.prepare(`
    SELECT a.*, e.name as employee_name
    FROM assignments a JOIN employees e ON a.employee_id = e.id
    ORDER BY a.assigned_at DESC
  `).all();
  const employees = db.prepare('SELECT * FROM employees').all();

  const totalClients = clients.length;
  const newClients = clients.filter(c => c.status === 'new').length;
  const activeAssignments = assignments.filter(a => a.status === 'active').length;
  const totalMessages = db.prepare('SELECT COUNT(*) as c FROM conversations').get().c;
  const clientsToday = db.prepare("SELECT COUNT(*) as c FROM clients WHERE date(created_at) = date('now')").get().c;
  const messagesToday = db.prepare("SELECT COUNT(*) as c FROM conversations WHERE date(created_at) = date('now')").get().c;

  // Hot leads
  const hotLeads = clients.filter(c =>
    c.memory && (
      c.memory.toLowerCase().includes('comprar') ||
      c.memory.toLowerCase().includes('interesado') ||
      c.memory.toLowerCase().includes('listo') ||
      c.memory.toLowerCase().includes('precio')
    )
  );

  return { clients, conversations, assignments, employees, totalClients, newClients, activeAssignments, totalMessages, clientsToday, messagesToday, hotLeads };
}

function getClientChat(phone) {
  return db.prepare('SELECT * FROM conversations WHERE client_phone = ? ORDER BY created_at ASC').all(phone);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // API endpoints
  if (url.pathname === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getData()));
    return;
  }

  if (url.pathname === '/api/chat') {
    const phone = url.searchParams.get('phone');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getClientChat(phone)));
    return;
  }

  // Panel HTML
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(getHTML());
});

function getHTML() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Panel ZT — Zona Traumática</title>
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600;700&family=Rajdhani:wght@400;500;600;700&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Rajdhani', sans-serif; background: #0a0e13; color: #e6edf3; font-weight: 500; letter-spacing: 0.3px; }
  h1, h2, h3, .stat .num, .panel-header, .tab, .refresh-btn { font-family: 'Chakra Petch', sans-serif; }
  .client-phone, .chat-time, .memory-box, code { font-family: 'Share Tech Mono', monospace; }
  .header { background: linear-gradient(180deg, #131920 0%, #0d1117 100%); border-bottom: 1px solid #f8514944; padding: 15px 25px; display: flex; justify-content: space-between; align-items: center; }
  .header h1 { font-size: 22px; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; }
  .header h1 span { color: #f85149; }
  .refresh-btn { background: #238636; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; }
  .refresh-btn:hover { background: #2ea043; }
  .stats { display: flex; gap: 15px; padding: 20px 25px; flex-wrap: wrap; }
  .stat { background: #111820; border: 1px solid #1c2733; border-radius: 6px; padding: 15px 20px; flex: 1; min-width: 140px; border-left: 3px solid #30363d; }
  .stat .num { font-size: 34px; font-weight: 700; letter-spacing: 1px; }
  .stat .label { font-size: 12px; color: #8b949e; margin-top: 2px; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 600; }
  .stat.green .num { color: #3fb950; }
  .stat.green { border-left-color: #3fb950; }
  .stat.blue .num { color: #58a6ff; }
  .stat.blue { border-left-color: #58a6ff; }
  .stat.orange .num { color: #d29922; }
  .stat.orange { border-left-color: #d29922; }
  .stat.red .num { color: #f85149; }
  .stat.red { border-left-color: #f85149; }
  .stat.purple .num { color: #bc8cff; }
  .stat.purple { border-left-color: #bc8cff; }
  .container { display: flex; gap: 20px; padding: 0 25px 25px; height: calc(100vh - 220px); }
  .panel { background: #111820; border: 1px solid #1c2733; border-radius: 6px; overflow: hidden; display: flex; flex-direction: column; }
  .panel-left { flex: 1; min-width: 400px; }
  .panel-right { flex: 1; min-width: 400px; }
  .panel-header { padding: 12px 15px; border-bottom: 1px solid #1c2733; font-size: 15px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; display: flex; justify-content: space-between; align-items: center; }
  .panel-header input { background: #0a0e13; border: 1px solid #1c2733; color: #e6edf3; padding: 8px 14px; border-radius: 4px; font-size: 14px; width: 220px; font-family: 'Rajdhani', sans-serif; }
  .panel-header input:focus { border-color: #f85149; outline: none; }
  .panel-body { overflow-y: auto; flex: 1; }
  .panel-body::-webkit-scrollbar { width: 6px; }
  .panel-body::-webkit-scrollbar-track { background: #0a0e13; }
  .panel-body::-webkit-scrollbar-thumb { background: #1c2733; border-radius: 3px; }
  .client-row { padding: 10px 15px; border-bottom: 1px solid #151c25; cursor: pointer; display: flex; align-items: center; gap: 12px; transition: all 0.15s; }
  .client-row:hover { background: #151c25; border-left: 3px solid #f8514966; }
  .client-row.active { background: #151c25; border-left: 3px solid #f85149; }
  .client-avatar { width: 38px; height: 38px; border-radius: 4px; background: #1c2733; display: flex; align-items: center; justify-content: center; font-size: 15px; flex-shrink: 0; font-family: 'Chakra Petch', sans-serif; font-weight: 700; color: #f85149; }
  .client-info { flex: 1; min-width: 0; }
  .client-name { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .client-phone { font-size: 12px; color: #586776; }
  .client-meta { text-align: right; flex-shrink: 0; }
  .client-status { font-size: 10px; padding: 2px 8px; border-radius: 3px; display: inline-block; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; font-family: 'Chakra Petch', sans-serif; }
  .status-new { background: #1f6feb22; color: #58a6ff; border: 1px solid #1f6feb44; }
  .status-assigned { background: #d2992222; color: #d29922; border: 1px solid #d2992244; }
  .status-completed { background: #23863622; color: #3fb950; border: 1px solid #23863644; }
  .client-count { font-size: 11px; color: #3d4f5f; font-family: 'Share Tech Mono', monospace; }
  .client-memory { font-size: 12px; color: #586776; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 280px; }
  .chat-container { padding: 15px; display: flex; flex-direction: column; gap: 8px; }
  .chat-empty { display: flex; align-items: center; justify-content: center; height: 100%; color: #3d4f5f; font-size: 15px; text-transform: uppercase; letter-spacing: 2px; font-family: 'Chakra Petch', sans-serif; }
  .chat-bubble { max-width: 80%; padding: 10px 14px; border-radius: 6px; font-size: 14px; line-height: 1.5; word-wrap: break-word; }
  .chat-user { background: #1a3a5c; align-self: flex-start; border-left: 3px solid #58a6ff; }
  .chat-assistant { background: #1c2733; align-self: flex-end; border-right: 3px solid #f85149; }
  .chat-time { font-size: 10px; color: #3d4f5f; margin-top: 2px; }
  .client-detail { padding: 15px; border-bottom: 1px solid #1c2733; background: #0d1219; }
  .client-detail h3 { font-size: 18px; margin-bottom: 10px; font-family: 'Chakra Petch', sans-serif; font-weight: 700; letter-spacing: 1px; }
  .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .detail-item { font-size: 13px; }
  .detail-item .dl { color: #586776; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; }
  .detail-item .dv { color: #e6edf3; font-weight: 600; display: block; margin-top: 2px; }
  .memory-box { background: #0a0e13; border: 1px solid #1c2733; border-left: 3px solid #bc8cff; border-radius: 4px; padding: 12px; margin-top: 12px; font-size: 12px; color: #8b949e; white-space: pre-wrap; max-height: 120px; overflow-y: auto; }
  .hot-badge { background: #f8514933; color: #f85149; font-size: 10px; padding: 2px 8px; border-radius: 3px; margin-left: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; font-family: 'Chakra Petch', sans-serif; }
  .tabs { display: flex; border-bottom: 1px solid #1c2733; }
  .tab { padding: 10px 18px; font-size: 13px; cursor: pointer; border-bottom: 2px solid transparent; color: #586776; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; transition: all 0.15s; }
  .tab.active { color: #e6edf3; border-bottom-color: #f85149; }
  .tab:hover { color: #e6edf3; }
</style>
</head>
<body>
<div class="header">
  <h1>🔫 Panel <span>Zona Traumática</span></h1>
  <div>
    <span id="lastUpdate" style="color:#484f58;font-size:12px;margin-right:15px;"></span>
    <button class="refresh-btn" onclick="loadData()">🔄 Actualizar</button>
  </div>
</div>
<div class="stats" id="stats"></div>
<div class="container">
  <div class="panel panel-left">
    <div class="panel-header">
      <span>👥 Clientes (<span id="clientCount">0</span>)</span>
      <input type="text" id="searchInput" placeholder="🔍 Buscar..." oninput="filterClients()">
    </div>
    <div class="tabs">
      <div class="tab active" data-filter="all" onclick="setFilter('all',this)">Todos</div>
      <div class="tab" data-filter="new" onclick="setFilter('new',this)">Nuevos</div>
      <div class="tab" data-filter="hot" onclick="setFilter('hot',this)">🔥 Calientes</div>
      <div class="tab" data-filter="assigned" onclick="setFilter('assigned',this)">Asignados</div>
    </div>
    <div class="panel-body" id="clientList"></div>
  </div>
  <div class="panel panel-right">
    <div class="panel-header"><span id="chatTitle">💬 Selecciona un cliente</span></div>
    <div id="clientDetail" style="display:none;"></div>
    <div class="panel-body" id="chatArea"><div class="chat-empty">Selecciona un cliente para ver su conversación</div></div>
  </div>
</div>

<script>
let allData = null;
let currentFilter = 'all';
let selectedPhone = null;

async function loadData() {
  const res = await fetch('/api/data');
  allData = await res.json();
  renderStats();
  renderClients();
  document.getElementById('lastUpdate').textContent = 'Actualizado: ' + new Date().toLocaleTimeString();
}

function renderStats() {
  const d = allData;
  document.getElementById('stats').innerHTML = \`
    <div class="stat blue"><div class="num">\${d.totalClients}</div><div class="label">Total clientes</div></div>
    <div class="stat green"><div class="num">\${d.clientsToday}</div><div class="label">Nuevos hoy</div></div>
    <div class="stat orange"><div class="num">\${d.activeAssignments}</div><div class="label">Asignados activos</div></div>
    <div class="stat red"><div class="num">\${d.hotLeads.length}</div><div class="label">🔥 Leads calientes</div></div>
    <div class="stat purple"><div class="num">\${d.totalMessages}</div><div class="label">Mensajes totales</div></div>
    <div class="stat green"><div class="num">\${d.messagesToday}</div><div class="label">Mensajes hoy</div></div>
  \`;
}

function renderClients() {
  let clients = allData.clients;
  const search = document.getElementById('searchInput').value.toLowerCase();

  if (currentFilter === 'new') clients = clients.filter(c => c.status === 'new');
  else if (currentFilter === 'assigned') clients = clients.filter(c => c.status === 'assigned');
  else if (currentFilter === 'hot') clients = allData.hotLeads;

  if (search) {
    clients = clients.filter(c =>
      (c.name||'').toLowerCase().includes(search) ||
      c.phone.includes(search) ||
      (c.memory||'').toLowerCase().includes(search)
    );
  }

  document.getElementById('clientCount').textContent = clients.length;

  const html = clients.map(c => {
    const isHot = c.memory && (c.memory.toLowerCase().includes('comprar') || c.memory.toLowerCase().includes('interesado'));
    const initial = (c.name || c.phone).charAt(0).toUpperCase();
    return \`<div class="client-row \${selectedPhone === c.phone ? 'active' : ''}" onclick="selectClient('\${c.phone}')">
      <div class="client-avatar">\${initial}</div>
      <div class="client-info">
        <div class="client-name">\${c.name || 'Sin nombre'}\${isHot ? '<span class="hot-badge">🔥 HOT</span>' : ''}</div>
        <div class="client-phone">\${c.phone}</div>
        \${c.memory ? '<div class="client-memory">💭 ' + c.memory.substring(0, 80) + '</div>' : ''}
      </div>
      <div class="client-meta">
        <div class="client-status status-\${c.status}">\${c.status}</div>
        <div class="client-count">\${c.interaction_count || 0} msgs</div>
      </div>
    </div>\`;
  }).join('');

  document.getElementById('clientList').innerHTML = html || '<div class="chat-empty">No hay clientes</div>';
}

async function selectClient(phone) {
  selectedPhone = phone;
  renderClients();

  const client = allData.clients.find(c => c.phone === phone);
  const assignment = allData.assignments.find(a => a.client_phone === phone && a.status === 'active');

  document.getElementById('chatTitle').textContent = '💬 ' + (client.name || phone);

  // Detail
  document.getElementById('clientDetail').style.display = 'block';
  document.getElementById('clientDetail').innerHTML = \`
    <div class="client-detail">
      <h3>\${client.name || 'Sin nombre'} <span class="client-status status-\${client.status}">\${client.status}</span></h3>
      <div class="detail-grid">
        <div class="detail-item"><span class="dl">📱 Teléfono:</span> <span class="dv">\${client.phone}</span></div>
        <div class="detail-item"><span class="dl">💬 Mensajes:</span> <span class="dv">\${client.interaction_count || 0}</span></div>
        <div class="detail-item"><span class="dl">📅 Registro:</span> <span class="dv">\${new Date(client.created_at).toLocaleDateString()}</span></div>
        <div class="detail-item"><span class="dl">👔 Asignado:</span> <span class="dv">\${assignment ? assignment.employee_name : 'No'}</span></div>
      </div>
      \${client.memory ? '<div class="memory-box">🧠 <strong>Memoria CRM:</strong>\\n' + client.memory + '</div>' : ''}
      <div style="margin-top:10px;">
        <a href="https://wa.me/\${client.phone}" target="_blank" style="color:#3fb950;font-size:12px;text-decoration:none;">📲 Abrir WhatsApp</a>
      </div>
    </div>
  \`;

  // Chat
  const res = await fetch('/api/chat?phone=' + phone);
  const messages = await res.json();

  const chatHtml = messages.map(m => \`
    <div style="display:flex;flex-direction:column;align-items:\${m.role === 'user' ? 'flex-start' : 'flex-end'};">
      <div class="chat-bubble chat-\${m.role}">\${m.message}</div>
      <div class="chat-time">\${new Date(m.created_at).toLocaleString()}</div>
    </div>
  \`).join('');

  document.getElementById('chatArea').innerHTML = '<div class="chat-container">' + (chatHtml || '<div class="chat-empty">Sin mensajes</div>') + '</div>';
  document.getElementById('chatArea').scrollTop = document.getElementById('chatArea').scrollHeight;
}

function setFilter(filter, el) {
  currentFilter = filter;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  renderClients();
}

function filterClients() { renderClients(); }

// Auto-refresh cada 15 segundos
loadData();
setInterval(loadData, 15000);
</script>
</body>
</html>`;
}

server.listen(PORT, () => {
  console.log('\\n🔫 ==========================================');
  console.log('   PANEL ZONA TRAUMÁTICA');
  console.log('   Abre en Chrome: http://localhost:3000');
  console.log('==========================================\\n');
});
