// ============================================
// ZONA TRAUMÁTICA — Panel de Control Web
// ============================================
// Uso: node panel.js
// Abre http://localhost:3000 en el navegador
// ============================================

const http = require('http');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const db = new Database(path.join(__dirname, 'crm.db'));
const PORT = 3000;

// Nota: Las migraciones se ejecutan en db.js al arrancar el bot.
// El panel solo lee datos — no necesita crear tablas ni columnas.

function getData() {
  const clients = db.prepare('SELECT * FROM clients ORDER BY COALESCE(updated_at, created_at) DESC').all();
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

  // Posibles bots / spam
  const spamFlagged = clients.filter(c => c.spam_flag == 1);

  return { clients, conversations, assignments, employees, totalClients, newClients, activeAssignments, totalMessages, clientsToday, messagesToday, hotLeads, spamFlagged };
}

function getClientChat(phone, limit = 100) {
  // Traer los últimos N mensajes en orden cronológico (más reciente al final)
  return db.prepare(`
    SELECT * FROM (
      SELECT * FROM conversations WHERE client_phone = ? ORDER BY created_at DESC LIMIT ?
    ) ORDER BY created_at ASC
  `).all(phone, limit);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Log de requests (excepto polling que genera ruido)
  const silentRoutes = ['/api/data', '/api/comprobantes-count', '/api/chat', '/'];
  if (!silentRoutes.includes(url.pathname)) {
    console.log(`[PANEL] ${req.method} ${url.pathname}`);
  }

  // API endpoints
  if (url.pathname === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getData()));
    return;
  }

  if (url.pathname === '/api/chat') {
    const phone = url.searchParams.get('phone');
    const limit = parseInt(url.searchParams.get('limit') || '100');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getClientChat(phone, limit)));
    return;
  }

  // Actualizar memoria/estado de cliente desde el panel
  if (url.pathname === '/api/update-client' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { phone, note, append, status } = JSON.parse(body);
        console.log(`[PANEL] 📝 Actualizando cliente ${phone}${status ? ' → status: ' + status : ''}${note ? ' → nota: "' + note.substring(0, 40) + '"' : ''}`);
        const client = db.prepare('SELECT * FROM clients WHERE phone = ?').get(phone);
        if (!client) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cliente no encontrado' }));
          return;
        }
        // Actualizar status si se envió
        if (status) {
          db.prepare('UPDATE clients SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ?').run(status, phone);
        }
        // Actualizar memoria si se envió nota
        let newMemory = client.memory || '';
        if (note) {
          if (append && client.memory) {
            newMemory = client.memory + '\n[PANEL] ' + note;
          } else if (append) {
            newMemory = '[PANEL] ' + note;
          } else {
            newMemory = note;
          }
          db.prepare('UPDATE clients SET memory = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ?').run(newMemory, phone);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, memory: newMemory, status: status || client.status }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Ignorar / des-ignorar contacto
  if (url.pathname === '/api/set-ignored' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { phone, ignored } = JSON.parse(body);
        const val = ignored ? 1 : 0;
        const result = db.prepare('UPDATE clients SET ignored = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ?').run(val, phone);
        console.log(`[PANEL] 🔇 set-ignored: ${phone} → ${val} (rows: ${result.changes})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ignored: val, changes: result.changes }));
      } catch (e) {
        console.error('[PANEL] set-ignored error:', e.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Marcar / desmarcar spam flag
  if (url.pathname === '/api/set-spam-flag' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { phone, flagged } = JSON.parse(body);
        const val = flagged ? 1 : 0;
        db.prepare('UPDATE clients SET spam_flag = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ?').run(val, phone);
        console.log(`[PANEL] 🚨 set-spam-flag: ${phone} → ${val}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Enviar mensaje como Álvaro — relay al bot en puerto 3001
  if (url.pathname === '/api/enviar-mensaje' && req.method === 'POST') {
    let bodyData = '';
    req.on('data', chunk => bodyData += chunk);
    req.on('end', () => {
      const parsed = JSON.parse(bodyData);
      console.log(`[PANEL] 👤 Enviando como Álvaro a ${parsed.phone}: "${(parsed.message || '').substring(0, 60)}"`);
      const payload = bodyData;
      const botReq = http.request({
        hostname: 'localhost',
        port: 3001,
        path: '/enviar-mensaje',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      }, botRes => {
        let data = '';
        botRes.on('data', chunk => data += chunk);
        botRes.on('end', () => {
          res.writeHead(botRes.statusCode, { 'Content-Type': 'application/json' });
          res.end(data);
        });
      });
      botReq.on('error', () => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'No se pudo conectar con el bot. ¿Está corriendo?' }));
      });
      botReq.write(payload);
      botReq.end();
    });
    return;
  }

  // Reactivar clientes calientes — llama directo al bot por HTTP (puerto 3001)
  if (url.pathname === '/api/reactivar-calientes' && req.method === 'POST') {
    try {
      const calientes = db.prepare(`
        SELECT * FROM clients
        WHERE status IN ('hot', 'assigned', 'new')
        AND ignored = 0
        AND spam_flag = 0
        AND memory IS NOT NULL AND memory != ''
        AND phone IS NOT NULL
        ORDER BY updated_at DESC
      `).all();

      if (calientes.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: 'No hay clientes calientes con contexto para reactivar' }));
        return;
      }

      const clientes = calientes.map(c => ({
        phone: c.phone,
        name: c.name || 'Cliente',
        memory: c.memory || '',
        status: c.status
      }));

      // Llamar directamente al bot por HTTP — sin archivos, sin polling
      const payload = JSON.stringify({ clientes });
      const botReq = http.request({
        hostname: 'localhost',
        port: 3001,
        path: '/reactivar',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      }, botRes => {
        let data = '';
        botRes.on('data', chunk => data += chunk);
        botRes.on('end', () => {
          console.log(`[PANEL] 🔥 Reactivación iniciada en bot: ${clientes.length} clientes`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, total: clientes.length, msg: `${clientes.length} clientes enviados al bot` }));
        });
      });

      botReq.on('error', () => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: '❌ No se pudo conectar con el bot. ¿Está corriendo?' }));
      });

      botReq.write(payload);
      botReq.end();

    } catch (e) {
      console.error('[PANEL] Error reactivar-calientes:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Confirmar o rechazar comprobante — relay al bot en puerto 3001
  if (url.pathname === '/api/confirmar-comprobante' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = body; // reenviar tal cual al bot
        const botReq = http.request({
          hostname: 'localhost',
          port: 3001,
          path: '/confirmar-comprobante',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, botRes => {
          let data = '';
          botRes.on('data', chunk => data += chunk);
          botRes.on('end', () => {
            console.log(`[PANEL] 💰 Comprobante procesado:`, data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(data);
          });
        });
        botReq.on('error', () => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '❌ No se pudo conectar con el bot. ¿Está corriendo?' }));
        });
        botReq.write(payload);
        botReq.end();
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Resolver LIDs a números reales — relay al bot
  if (url.pathname === '/api/resolver-lids' && req.method === 'POST') {
    const lidCount = db.prepare("SELECT COUNT(*) as c FROM clients WHERE length(phone) >= 13 OR chat_id LIKE '%@c.us'").get().c;
    if (lidCount === 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, total: 0, msg: 'Sin clientes LID pendientes' }));
      return;
    }
    const botReq = http.request({
      hostname: 'localhost', port: 3001, path: '/resolver-lids', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 2 }
    }, botRes => {
      let data = '';
      botRes.on('data', chunk => data += chunk);
      botRes.on('end', () => {
        console.log(`[PANEL] 🔍 Resolución LIDs iniciada: ${lidCount} clientes`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    });
    botReq.on('error', () => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, msg: '❌ No se pudo conectar con el bot. ¿Está corriendo?' }));
    });
    botReq.write('{}');
    botReq.end();
    return;
  }

  // Migración única: assigned → hot
  if (url.pathname === '/api/migrar-assigned' && req.method === 'POST') {
    try {
      const result = db.prepare(`UPDATE clients SET status = 'hot', updated_at = datetime('now') WHERE status = 'assigned'`).run();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, migrados: result.changes }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Cambiar status de un cliente (para mover a post-venta manualmente)
  if (url.pathname === '/api/cambiar-status' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { phone, status } = JSON.parse(body);
        const validStatuses = ['new', 'hot', 'warm', 'completed', 'postventa', 'carnet_pendiente', 'despacho_pendiente', 'municion_pendiente', 'recuperacion_pendiente', 'bot_asesor_pendiente'];
        if (!phone || !validStatuses.includes(status)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'phone o status inválido' }));
          return;
        }
        db.prepare(`UPDATE clients SET status = ?, updated_at = datetime('now') WHERE phone = ?`).run(status, phone);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Devolver cliente al bot — relay al bot en puerto 3001
  if (url.pathname === '/api/devolver-bot' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = body;
        const botReq = http.request({
          hostname: 'localhost',
          port: 3001,
          path: '/devolver-bot',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, botRes => {
          let data = '';
          botRes.on('data', chunk => data += chunk);
          botRes.on('end', () => {
            console.log(`[PANEL] 🤖 Devolver al bot:`, data);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(data);
          });
        });
        botReq.on('error', () => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'No se pudo conectar con el bot. ¿Está corriendo?' }));
        });
        botReq.write(payload);
        botReq.end();
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Comprobantes pendientes
  if (url.pathname === '/api/comprobantes') {
    try {
      const comprobantes = db.prepare(`SELECT id, client_phone, client_name, info, imagen_base64, imagen_mime, tipo, estado, created_at FROM comprobantes WHERE estado = 'pendiente' ORDER BY created_at DESC`).all();
      console.log(`[PANEL] 💰 Comprobantes cargados: ${comprobantes.length} pendientes`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(comprobantes));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Count liviano de comprobantes (para el badge, sin cargar imágenes)
  if (url.pathname === '/api/comprobantes-count') {
    try {
      const count = db.prepare(`SELECT COUNT(*) as c FROM comprobantes WHERE estado = 'pendiente'`).get().c;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
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
  .reactivar-btn { background: linear-gradient(135deg, #f85149, #c0392b); color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; font-family: 'Chakra Petch', sans-serif; margin-right: 8px; }
  .reactivar-btn:hover { background: linear-gradient(135deg, #ff6b6b, #e74c3c); }
  .reactivar-btn:disabled { background: #333; color: #666; cursor: not-allowed; }
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
  /* Alertas de spam/bot */
  #spamAlerts { padding: 0 25px; }
  .spam-alert-box { background: #2d1b1b; border: 1px solid #f85149; border-left: 4px solid #f85149; border-radius: 6px; padding: 12px 18px; margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .spam-alert-box .spam-info { flex: 1; }
  .spam-alert-box .spam-title { color: #f85149; font-weight: 700; font-size: 14px; }
  .spam-alert-box .spam-sub { color: #8b949e; font-size: 12px; margin-top: 2px; }
  .spam-alert-box .spam-actions { display: flex; gap: 8px; flex-shrink: 0; }
  .btn-spam-bot { background: #f85149; color: #fff; border: none; border-radius: 4px; padding: 6px 12px; font-size: 12px; cursor: pointer; font-weight: 600; }
  .btn-spam-bot:hover { background: #da3633; }
  .btn-spam-ok { background: #238636; color: #fff; border: none; border-radius: 4px; padding: 6px 12px; font-size: 12px; cursor: pointer; font-weight: 600; }
  .btn-spam-ok:hover { background: #2ea043; }
  .btn-spam-ver { background: #1c2733; color: #58a6ff; border: 1px solid #1c6fb5; border-radius: 4px; padding: 6px 12px; font-size: 12px; cursor: pointer; }
  .btn-spam-ver:hover { background: #0d1117; }
  .container { display: flex; gap: 20px; padding: 0 25px 25px; height: calc(100vh - 265px); }
  .panel { background: #111820; border: 1px solid #1c2733; border-radius: 6px; overflow: hidden; display: flex; flex-direction: column; }
  .panel-left { flex: 1; min-width: 400px; }
  .panel-right { flex: 1.4; min-width: 400px; display: flex; flex-direction: column; }
  .panel-right-detail { flex: 0 0 auto; max-height: 45%; overflow-y: auto; border-bottom: 2px solid #f8514933; }
  .panel-right-detail::-webkit-scrollbar { width: 4px; }
  .panel-right-detail::-webkit-scrollbar-track { background: #0a0e13; }
  .panel-right-detail::-webkit-scrollbar-thumb { background: #1c2733; border-radius: 3px; }
  .panel-right-chat { flex: 1; overflow-y: auto; min-height: 0; }
  .panel-right-chat::-webkit-scrollbar { width: 6px; }
  .panel-right-chat::-webkit-scrollbar-track { background: #0a0e13; }
  .panel-right-chat::-webkit-scrollbar-thumb { background: #1c2733; border-radius: 3px; }
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
  .status-postventa { background: #3fb95022; color: #3fb950; border: 1px solid #3fb95044; }
  .status-carnet_pendiente, .status-carnet-pendiente { background: #bc8cff22; color: #bc8cff; border: 1px solid #bc8cff44; }
  .status-despacho_pendiente, .status-despacho-pendiente { background: #f0883e22; color: #f0883e; border: 1px solid #f0883e44; }
  .status-municion_pendiente, .status-municion-pendiente { background: #f8514922; color: #f85149; border: 1px solid #f8514944; }
  .status-recuperacion_pendiente, .status-recuperacion-pendiente { background: #d2992222; color: #d29922; border: 1px solid #d2992244; }
  .status-bot_asesor_pendiente, .status-bot-asesor-pendiente { background: #58a6ff22; color: #58a6ff; border: 1px solid #58a6ff44; }
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
  .crm-actions { margin-top: 12px; border-top: 1px solid #1c2733; padding-top: 12px; }
  .crm-actions-title { font-size: 11px; color: #586776; text-transform: uppercase; letter-spacing: 1.5px; margin-bottom: 8px; font-family: 'Chakra Petch', sans-serif; }
  .crm-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .crm-chip { background: #1c2733; border: 1px solid #30363d; color: #8b949e; font-size: 11px; padding: 4px 10px; border-radius: 3px; cursor: pointer; font-family: 'Chakra Petch', sans-serif; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; transition: all 0.15s; }
  .crm-chip:hover { background: #238636; border-color: #3fb950; color: #fff; }
  .crm-chip.danger:hover { background: #b91c1c; border-color: #f85149; color: #fff; }
  .crm-note-row { display: flex; gap: 6px; }
  .crm-note-input { flex: 1; background: #0a0e13; border: 1px solid #1c2733; color: #e6edf3; padding: 7px 10px; border-radius: 4px; font-size: 13px; font-family: 'Rajdhani', sans-serif; }
  .crm-note-input:focus { border-color: #f85149; outline: none; }
  .crm-note-btn { background: #1f6feb; border: none; color: #fff; padding: 7px 14px; border-radius: 4px; cursor: pointer; font-size: 12px; font-family: 'Chakra Petch', sans-serif; font-weight: 600; text-transform: uppercase; letter-spacing: 0.8px; white-space: nowrap; }
  .crm-note-btn:hover { background: #388bfd; }
  .crm-feedback { font-size: 11px; color: #3fb950; margin-top: 5px; height: 14px; font-family: 'Share Tech Mono', monospace; }
  .tabs { display: flex; border-bottom: 1px solid #1c2733; }
  .tab { padding: 10px 18px; font-size: 13px; cursor: pointer; border-bottom: 2px solid transparent; color: #586776; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; transition: all 0.15s; }
  .tab.active { color: #e6edf3; border-bottom-color: #f85149; }
  .tab:hover { color: #e6edf3; }
  /* Tabs de vista principal */
  .main-tabs { display: flex; border-bottom: 2px solid #1c2733; padding: 0 25px; background: #0d1117; gap: 0; }
  .main-tab { padding: 12px 22px; font-size: 14px; cursor: pointer; border-bottom: 3px solid transparent; margin-bottom: -2px; color: #586776; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px; transition: all 0.15s; font-family: 'Chakra Petch', sans-serif; }
  .main-tab.active { color: #e6edf3; border-bottom-color: #f85149; }
  .main-tab:hover { color: #e6edf3; }
  .main-tab .badge { background: #f85149; color: #fff; border-radius: 10px; font-size: 10px; padding: 1px 6px; margin-left: 6px; font-weight: 700; }
  /* Vista comprobantes */
  #viewClientes, #viewComprobantes, #viewPostventa { display: none; }
  #viewClientes.active, #viewPostventa.active { display: flex; }
  #viewComprobantes.active { display: flex; flex-direction: column; padding: 20px 25px; gap: 15px; overflow-y: auto; height: calc(100vh - 265px); }
  .comprobante-card { background: #111820; border: 1px solid #1c2733; border-left: 4px solid #d29922; border-radius: 6px; padding: 18px; display: flex; gap: 18px; align-items: flex-start; }
  .comprobante-img { width: 120px; height: 120px; object-fit: cover; border-radius: 4px; border: 1px solid #30363d; cursor: pointer; flex-shrink: 0; background: #0a0e13; }
  .comprobante-img-placeholder { width: 120px; height: 120px; border-radius: 4px; border: 1px solid #30363d; background: #0a0e13; display: flex; align-items: center; justify-content: center; color: #3d4f5f; font-size: 12px; flex-shrink: 0; text-align: center; }
  .comprobante-info { flex: 1; min-width: 0; }
  .comprobante-name { font-size: 17px; font-weight: 700; font-family: 'Chakra Petch', sans-serif; letter-spacing: 0.5px; }
  .comprobante-phone { font-size: 12px; color: #586776; font-family: 'Share Tech Mono', monospace; margin-top: 2px; }
  .comprobante-detail { font-size: 13px; color: #8b949e; margin-top: 8px; line-height: 1.6; }
  .comprobante-detail strong { color: #d29922; }
  .comprobante-tipo { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 3px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; font-family: 'Chakra Petch', sans-serif; margin-top: 6px; }
  .tipo-club { background: #1f6feb22; color: #58a6ff; border: 1px solid #1f6feb44; }
  .tipo-producto { background: #23863622; color: #3fb950; border: 1px solid #23863644; }
  .tipo-bot { background: #bc8cff22; color: #bc8cff; border: 1px solid #bc8cff44; }
  .tipo-desconocido { background: #d2992222; color: #d29922; border: 1px solid #d2992244; }
  .comprobante-time { font-size: 11px; color: #3d4f5f; font-family: 'Share Tech Mono', monospace; margin-top: 4px; }
  .comprobante-actions { display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; align-self: center; }
  .btn-confirmar { background: linear-gradient(135deg, #238636, #2ea043); color: #fff; border: none; border-radius: 4px; padding: 10px 18px; font-size: 13px; font-weight: 700; cursor: pointer; font-family: 'Chakra Petch', sans-serif; text-transform: uppercase; letter-spacing: 1px; white-space: nowrap; }
  .btn-confirmar:hover { background: linear-gradient(135deg, #2ea043, #3fb950); }
  .btn-confirmar:disabled { background: #1a4a1a; color: #3fb950; cursor: not-allowed; }
  .btn-rechazar { background: linear-gradient(135deg, #6e1313, #9b1c1c); color: #fff; border: none; border-radius: 4px; padding: 10px 18px; font-size: 13px; font-weight: 700; cursor: pointer; font-family: 'Chakra Petch', sans-serif; text-transform: uppercase; letter-spacing: 1px; white-space: nowrap; }
  .btn-rechazar:hover { background: linear-gradient(135deg, #9b1c1c, #b91c1c); }
  .btn-rechazar:disabled { background: #3a1010; color: #f85149; cursor: not-allowed; }
  .comprobante-empty { display: flex; align-items: center; justify-content: center; height: 200px; color: #3d4f5f; font-size: 15px; text-transform: uppercase; letter-spacing: 2px; font-family: 'Chakra Petch', sans-serif; }
  /* Lightbox para ver imagen completa */
  #imgLightbox { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:#000000cc; z-index:9999; align-items:center; justify-content:center; cursor:zoom-out; }
  #imgLightbox.open { display:flex; }
  #imgLightbox img { max-width: 90%; max-height: 90%; border-radius: 6px; border: 2px solid #30363d; }
</style>
</head>
<body>
<div class="header">
  <h1>🔫 Panel <span>Zona Traumática</span></h1>
  <div>
    <span id="lastUpdate" style="color:#484f58;font-size:12px;margin-right:15px;"></span>
    <button class="reactivar-btn" id="btnReactivar" onclick="reactivarCalientes()">🔥 Reactivar Calientes</button>
    <button id="btnMigrar" onclick="migrarAssigned()" style="background:#1c2733;border:1px solid #30363d;color:#8b949e;padding:8px 14px;border-radius:4px;cursor:pointer;font-size:12px;font-family:'Chakra Petch',sans-serif;margin-right:8px;" title="Migración única: mueve todos los clientes 'asignados' a Calientes">🔄 Migrar Asignados → Calientes</button>
    <button id="btnResolverLid" onclick="resolverLids()" style="background:#1c2733;border:1px solid #388bfd;color:#388bfd;padding:8px 14px;border-radius:4px;cursor:pointer;font-size:12px;font-family:'Chakra Petch',sans-serif;margin-right:8px;" title="Resuelve LIDs de WhatsApp a números de teléfono reales">🔍 Resolver LIDs</button>
    <button class="refresh-btn" onclick="refreshAll()">🔄 Actualizar</button>
  </div>
</div>
<div class="stats" id="stats"></div>
<div id="spamAlerts"></div>

<!-- Tabs de vista principal -->
<div class="main-tabs">
  <div class="main-tab active" id="mainTabComercial" onclick="switchMainTab('comercial')">💼 Comercial</div>
  <div class="main-tab" id="mainTabComprobantes" onclick="switchMainTab('comprobantes')">💰 Por Verificar <span class="badge" id="comprobanteBadge" style="display:none">0</span></div>
  <div class="main-tab" id="mainTabPostventa" onclick="switchMainTab('postventa')">🛠️ Post-venta <span class="badge" id="postventaBadge" style="display:none">0</span></div>
</div>

<!-- Vista: Comercial -->
<div id="viewClientes" class="container active">
  <div class="panel panel-left">
    <div class="panel-header">
      <span>💼 Comercial (<span id="clientCount">0</span>)</span>
      <input type="text" id="searchInput" placeholder="🔍 Buscar..." oninput="filterClients()">
    </div>
    <div class="tabs">
      <div class="tab active" data-filter="all" onclick="setFilter('all',this)">Todos</div>
      <div class="tab" data-filter="new" onclick="setFilter('new',this)">Nuevos</div>
      <div class="tab" data-filter="hot" onclick="setFilter('hot',this)">🔥 Calientes</div>
    </div>
    <div class="panel-body" id="clientList"></div>
  </div>
  <div class="panel panel-right">
    <div class="panel-header"><span id="chatTitle">💬 Selecciona un cliente</span></div>
    <div class="panel-right-detail" id="clientDetail" style="display:none;"></div>
    <div class="panel-right-chat" id="chatArea"><div class="chat-empty">Selecciona un cliente para ver su conversación</div></div>
  </div>
</div>

<!-- Vista: Comprobantes por verificar -->
<div id="viewComprobantes">
  <div id="comprobantesList"></div>
</div>

<!-- Vista: Post-venta -->
<div id="viewPostventa" class="container">
  <div class="panel panel-left">
    <div class="panel-header">
      <span>🛠️ Post-venta (<span id="postventaCount">0</span>)</span>
      <input type="text" id="searchPostventa" placeholder="🔍 Buscar..." oninput="filterPostventa()">
    </div>
    <div class="tabs" style="flex-wrap:wrap;">
      <div class="tab active" data-pvfilter="all" onclick="setPvFilter('all',this)">Todos</div>
      <div class="tab" data-pvfilter="carnet_pendiente" onclick="setPvFilter('carnet_pendiente',this)">🪪 Carnet Club</div>
      <div class="tab" data-pvfilter="despacho_pendiente" onclick="setPvFilter('despacho_pendiente',this)">📦 Dispositivo</div>
      <div class="tab" data-pvfilter="municion_pendiente" onclick="setPvFilter('municion_pendiente',this)">🔫 Munición</div>
      <div class="tab" data-pvfilter="recuperacion_pendiente" onclick="setPvFilter('recuperacion_pendiente',this)">🔧 Recuperación</div>
      <div class="tab" data-pvfilter="bot_asesor_pendiente" onclick="setPvFilter('bot_asesor_pendiente',this)">🤖 Bot Asesor</div>
    </div>
    <div class="panel-body" id="postventaList"></div>
  </div>
  <div class="panel panel-right">
    <div class="panel-header"><span id="chatTitlePv">💬 Selecciona un cliente</span></div>
    <div class="panel-right-detail" id="clientDetailPv" style="display:none;"></div>
    <div class="panel-right-chat" id="chatAreaPv"><div class="chat-empty">Selecciona un cliente para ver su conversación</div></div>
  </div>
</div>

<!-- Lightbox imagen -->
<div id="imgLightbox" onclick="closeLightbox()"><img id="imgLightboxImg" src="" alt="comprobante"></div>

<script>
let allData = null;
let currentFilter = 'all';
let selectedPhone = null;

async function reactivarCalientes() {
  const btn = document.getElementById('btnReactivar');
  btn.disabled = true;
  btn.textContent = '⏳ Procesando...';
  try {
    const res = await fetch('/api/reactivar-calientes', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      btn.textContent = '✅ ' + data.msg;
      btn.style.background = '#238636';
      setTimeout(() => {
        btn.textContent = '🔥 Reactivar Calientes';
        btn.style.background = '';
        btn.disabled = false;
      }, 5000);
    } else {
      alert('⚠️ ' + (data.msg || data.error || 'Error desconocido'));
      btn.textContent = '🔥 Reactivar Calientes';
      btn.disabled = false;
    }
  } catch (e) {
    alert('❌ Error conectando con el servidor');
    btn.textContent = '🔥 Reactivar Calientes';
    btn.disabled = false;
  }
}

async function resolverLids() {
  const btn = document.getElementById('btnResolverLid');
  btn.disabled = true;
  btn.textContent = '⏳ Resolviendo...';
  try {
    const res = await fetch('/api/resolver-lids', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      if (data.total === 0) {
        btn.textContent = '✅ Sin LIDs pendientes';
      } else {
        btn.textContent = '⏳ Procesando ' + data.total + ' en background...';
        // Esperar un momento y recargar datos para mostrar los resueltos
        setTimeout(() => {
          loadData();
          btn.textContent = '🔍 Resolver LIDs';
          btn.style.color = '#388bfd';
          btn.disabled = false;
        }, Math.min(data.total * 1200, 30000));
        return;
      }
    } else {
      alert('⚠️ ' + (data.msg || data.error || 'Error'));
    }
  } catch (e) {
    alert('❌ Error conectando con el servidor');
  }
  btn.textContent = '🔍 Resolver LIDs';
  btn.disabled = false;
}

async function loadData() {
  const res = await fetch('/api/data');
  allData = await res.json();
  renderStats();
  renderSpamAlerts();
  renderClients();
  document.getElementById('lastUpdate').textContent = 'Actualizado: ' + new Date().toLocaleTimeString();
}

function renderSpamAlerts() {
  const container = document.getElementById('spamAlerts');
  const flagged = allData.spamFlagged || [];
  if (flagged.length === 0) { container.innerHTML = ''; return; }
  container.innerHTML = flagged.map(c => \`
    <div class="spam-alert-box" id="spam_\${c.phone}">
      <div class="spam-info">
        <div class="spam-title">🚨 Posible BOT / Spam detectado</div>
        <div class="spam-sub">📱 \${c.phone} &nbsp;|&nbsp; \${c.name || 'Sin nombre'} &nbsp;|&nbsp; Demasiados mensajes por minuto — pendiente tu revisión</div>
      </div>
      <div class="spam-actions">
        <button class="btn-spam-ver" onclick="selectClient('\${c.phone}')">👁️ Ver chat</button>
        <button class="btn-spam-ok" onclick="resolveSpam('\${c.phone}', false)">✅ Es cliente real — reactivar</button>
        <button class="btn-spam-bot" onclick="resolveSpam('\${c.phone}', true)">🤖 Es bot — silenciar</button>
      </div>
    </div>
  \`).join('');
}

async function resolveSpam(phone, isBot) {
  // Quitar el spam_flag siempre
  await fetch('/api/set-spam-flag', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, flagged: false })
  });
  // Si es bot, además ignorarlo
  if (isBot) {
    await fetch('/api/set-ignored', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, ignored: true })
    });
  }
  await loadData();
  if (!isBot) selectClient(phone); // si es cliente real, abrirlo para atenderlo
}

function renderStats() {
  const d = allData;
  const PV_ST = ['postventa', 'carnet_pendiente', 'despacho_pendiente', 'municion_pendiente', 'recuperacion_pendiente', 'bot_asesor_pendiente'];
  const pvCount = d.clients.filter(c => PV_ST.includes(c.status)).length;
  document.getElementById('stats').innerHTML = \`
    <div class="stat blue"><div class="num">\${d.totalClients}</div><div class="label">Total clientes</div></div>
    <div class="stat green"><div class="num">\${d.clientsToday}</div><div class="label">Nuevos hoy</div></div>
    <div class="stat red"><div class="num">\${d.hotLeads.length}</div><div class="label">🔥 Leads calientes</div></div>
    <div class="stat orange"><div class="num">\${pvCount}</div><div class="label">🛠️ En post-venta</div></div>
    <div class="stat purple"><div class="num">\${d.totalMessages}</div><div class="label">Mensajes totales</div></div>
    <div class="stat green"><div class="num">\${d.messagesToday}</div><div class="label">Mensajes hoy</div></div>
  \`;
}

function renderClients() {
  // Comercial solo muestra clientes que NO están en post-venta
  const PV_ST = ['postventa', 'carnet_pendiente', 'despacho_pendiente', 'municion_pendiente', 'recuperacion_pendiente', 'bot_asesor_pendiente'];
  let clients = allData.clients.filter(c => !PV_ST.includes(c.status));
  const rawSearch = document.getElementById('searchInput').value.toLowerCase().trim();
  // Para búsqueda de teléfono: quitar +, espacios y guiones
  const searchDigits = rawSearch.replace(/[^0-9]/g, '');
  const search = rawSearch;

  if (currentFilter === 'new') clients = clients.filter(c => c.status === 'new');
  else if (currentFilter === 'hot') clients = clients.filter(c =>
    c.memory && (c.memory.toLowerCase().includes('comprar') || c.memory.toLowerCase().includes('interesado') ||
    c.memory.toLowerCase().includes('listo') || c.memory.toLowerCase().includes('precio'))
  );

  if (search) {
    clients = clients.filter(c =>
      (c.name||'').toLowerCase().includes(search) ||
      (searchDigits && c.phone.includes(searchDigits)) ||
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
        <div class="client-phone">\${isLid(c.phone) ? '🔒 ID privado' : c.phone}</div>
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
        <div class="detail-item"><span class="dl">\${isLid(client.phone) ? '🔒 ID WA:' : '📱 Teléfono:'}</span> <span class="dv">\${isLid(client.phone) ? '<span style=\\"color:#8b949e;font-size:11px;\\">' + client.phone + ' (privado)</span>' : client.phone}</span></div>
        <div class="detail-item"><span class="dl">💬 Mensajes:</span> <span class="dv">\${client.interaction_count || 0}</span></div>
        <div class="detail-item"><span class="dl">📅 Registro:</span> <span class="dv">\${new Date(client.created_at).toLocaleDateString()}</span></div>
        <div class="detail-item"><span class="dl">👔 Asignado:</span> <span class="dv">\${assignment ? assignment.employee_name : 'No'}</span></div>
      </div>
      \${client.memory ? '<div class="memory-box">🧠 <strong>Memoria CRM:</strong>\\n' + client.memory + '</div>' : ''}

      <div class="crm-actions">
        <div class="crm-actions-title">⚡ Acciones rápidas — el bot sabrá esto al responder</div>
        <div class="crm-chips">
          <div class="crm-chip" onclick="addNote('\${client.phone}', '✅ Carnet enviado')">🪪 Carnet enviado</div>
          <div class="crm-chip" onclick="addNote('\${client.phone}', '📦 Dispositivo despachado')">📦 Dispositivo despachado</div>
          <div class="crm-chip" onclick="addNote('\${client.phone}', '💰 Pago recibido y confirmado')">💰 Pago recibido</div>
          <div class="crm-chip" onclick="addNote('\${client.phone}', '🏆 Afiliación al club activa')">🏆 Afiliación activa</div>
          <div class="crm-chip" onclick="addNote('\${client.phone}', '📋 Pendiente: enviar carnet')">🕐 Pendiente carnet</div>
          <div class="crm-chip" onclick="addNote('\${client.phone}', '📋 Pendiente: despachar dispositivo')">🕐 Pendiente despacho</div>
          <div class="crm-chip danger" onclick="addNote('\${client.phone}', '🚫 Cliente marcado como NO interesado')">❌ No interesado</div>
          <div class="crm-chip" style="background:\${client.ignored == 1 ? '#7c1d1d' : '#1c2733'};border-color:\${client.ignored == 1 ? '#f85149' : '#30363d'};color:\${client.ignored == 1 ? '#f85149' : '#8b949e'};" onclick="toggleIgnored('\${client.phone}', \${client.ignored == 1 ? 0 : 1})">\${client.ignored == 1 ? '🔇 IGNORADO — click para reactivar' : '🔇 Silenciar — no es cliente'}</div>
          <div class="crm-chip" style="background:#1c2733;border-color:#30363d;color:#8b949e;" onclick="changeStatus('\${client.phone}', 'new')">↩️ Resetear a Nuevo</div>
          <div class="crm-chip" style="background:#1c2733;border-color:#30363d;color:#d29922;" onclick="changeStatus('\${client.phone}', 'completed')">✅ Marcar Completado</div>
          <div class="crm-chip" style="background:#0d3b66;border-color:#1f6feb;color:#58a6ff;" onclick="devolverAlBot('\${client.phone}')">🤖 Devolver al Bot</div>
        </div>
        <div style="margin-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-size:12px;color:#8b949e;font-family:'Chakra Petch',sans-serif;">📦 Mover a Post-venta:</span>
          <select id="pvSelect_\${client.phone}" style="background:#111820;border:1px solid #30363d;color:#e6edf3;padding:5px 10px;border-radius:4px;font-size:12px;cursor:pointer;">
            <option value="">— seleccionar —</option>
            <option value="carnet_pendiente">🪪 Pendiente Carnet Club</option>
            <option value="despacho_pendiente">📦 Pendiente Envío Dispositivo</option>
            <option value="municion_pendiente">🔫 Pendiente Envío Munición</option>
            <option value="recuperacion_pendiente">🔧 Pendiente Recuperación</option>
            <option value="bot_asesor_pendiente">🤖 Pendiente Bot Asesor</option>
            <option value="postventa">📋 Post-venta general</option>
          </select>
          <button onclick="moverPostventa('\${client.phone}')" style="background:#238636;border:none;color:white;padding:5px 12px;border-radius:4px;font-size:12px;cursor:pointer;font-family:'Chakra Petch',sans-serif;">✅ Mover</button>
        </div>
        <div class="crm-note-row">
          <input class="crm-note-input" id="noteInput_\${client.phone}" type="text" placeholder="Nota interna... (ej: ya le expliqué los precios, espera depósito)" onkeydown="if(event.key==='Enter') saveNote('\${client.phone}')">
          <button class="crm-note-btn" onclick="saveNote('\${client.phone}')">📝 Guardar</button>
        </div>
        <div class="crm-feedback" id="noteFeedback_\${client.phone}"></div>
      </div>

      <div style="margin-top:10px;">
        \${waLink(client.phone)}
      </div>
    </div>
  \`;

  // Chat
  const res = await fetch('/api/chat?phone=' + phone);
  const messages = await res.json();

  const chatHtml = messages.map(m => \`
    <div style="display:flex;flex-direction:column;align-items:\${m.role === 'user' ? 'flex-start' : 'flex-end'};">
      <div class="chat-bubble chat-\${m.role}" \${m.role === 'admin' ? 'style="background:#1a5276;border:1px solid #2980b9;"' : ''}>\${m.role === 'admin' ? '👤 ' : ''}\${m.message}</div>
      <div class="chat-time">\${m.role === 'admin' ? 'Álvaro • ' : ''}\${new Date(m.created_at).toLocaleString()}</div>
    </div>
  \`).join('');

  const chatArea = document.getElementById('chatArea');
  chatArea.innerHTML = '<div class="chat-container">' + (chatHtml || '<div class="chat-empty">Sin mensajes</div>') + '</div>' +
    '<div style="display:flex;gap:8px;margin-top:10px;padding:10px;background:#161b22;border-radius:8px;border:1px solid #30363d;">' +
      '<textarea id="adminReplyInput" placeholder="Escribir como Álvaro..." style="flex:1;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:8px;resize:none;height:40px;font-family:inherit;font-size:13px;"></textarea>' +
      '<button onclick="enviarMensajeAdmin()" style="background:#1a5276;color:white;border:none;border-radius:6px;padding:8px 16px;cursor:pointer;font-weight:bold;white-space:nowrap;">Enviar 👤</button>' +
    '</div>';
  // Esperar a que el DOM renderice antes de hacer scroll
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      chatArea.scrollTop = chatArea.scrollHeight;
    });
  });
}

function setFilter(filter, el) {
  currentFilter = filter;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  renderClients();
}

async function enviarMensajeAdmin() {
  const input = document.getElementById('adminReplyInput');
  const message = (input.value || '').trim();
  if (!message || !selectedPhone) return;
  input.disabled = true;
  try {
    const res = await fetch('/api/enviar-mensaje', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: selectedPhone, message })
    });
    const data = await res.json();
    if (data.ok) {
      input.value = '';
      selectClient(selectedPhone); // refrescar chat
    } else {
      alert('❌ ' + (data.error || 'Error enviando'));
    }
  } catch (e) {
    alert('❌ Error conectando con el bot');
  }
  input.disabled = false;
}

function filterClients() { renderClients(); }

// Detectar si un phone es LID (ID interno de WA, no número real)
function isLid(phone) { return phone && phone.length >= 13; }
// Mostrar phone legible
function displayPhone(phone) {
  if (isLid(phone)) return '<span style="color:#8b949e;font-size:11px;">🔒 ID WhatsApp (privado)</span>';
  return phone;
}
// Enlace wa.me solo si es teléfono real
function waLink(phone) {
  if (isLid(phone)) return '<span style="color:#8b949e;font-size:12px;">📵 Sin número real (usuario LID)</span>';
  return '<a href="https://wa.me/' + phone + '" target="_blank" style="color:#3fb950;font-size:12px;text-decoration:none;">📲 Abrir WhatsApp</a>';
}

async function addNote(phone, note) {
  try {
    const res = await fetch('/api/update-client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, note, append: true })
    });
    const data = await res.json();
    if (data.ok) {
      await loadData(); // recargar todo para que hotLeads y listas estén al día
      selectedPhone = phone;
      selectClient(phone);
      const fb = document.getElementById('noteFeedback_' + phone);
      if (fb) { fb.textContent = '✅ Guardado: ' + note; setTimeout(() => { if(fb) fb.textContent = ''; }, 3000); }
    } else {
      const fb = document.getElementById('noteFeedback_' + phone);
      if (fb) fb.textContent = '❌ Error: ' + (data.error || 'desconocido');
    }
  } catch(e) { console.error(e); }
}

async function saveNote(phone) {
  const input = document.getElementById('noteInput_' + phone);
  if (!input || !input.value.trim()) return;
  const note = input.value.trim();
  await addNote(phone, note);
  input.value = '';
}

async function toggleIgnored(phone, ignored) {
  try {
    const res = await fetch('/api/set-ignored', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, ignored })
    });
    const data = await res.json();
    if (data.ok) {
      await loadData(); // recargar todo
      selectedPhone = phone;
      selectClient(phone);
      const fb = document.getElementById('noteFeedback_' + phone);
      if (fb) {
        fb.textContent = ignored ? '🔇 Silenciado — el bot no responderá' : '✅ Reactivado — el bot responderá de nuevo';
        setTimeout(() => { if(fb) fb.textContent = ''; }, 3000);
      }
    }
  } catch(e) { console.error(e); }
}

async function changeStatus(phone, status) {
  try {
    const res = await fetch('/api/update-client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, note: '', append: true, status })
    });
    const data = await res.json();
    if (data.ok) {
      await loadData(); // recargar todo para que los tabs reflejen el nuevo estado
      selectedPhone = phone;
      selectClient(phone);
      const fb = document.getElementById('noteFeedback_' + phone);
      if (fb) {
        fb.textContent = '✅ Estado actualizado a: ' + status;
        setTimeout(() => { if(fb) fb.textContent = ''; }, 3000);
      }
    }
  } catch(e) { console.error(e); }
}

async function devolverAlBot(phone) {
  if (!confirm('¿Devolver este cliente al bot? El bot volverá a responder automáticamente.')) return;
  try {
    const res = await fetch('/api/devolver-bot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (data.ok) {
      const fb = document.getElementById('noteFeedback_' + phone);
      if (fb) {
        fb.textContent = '🤖 Cliente devuelto al bot — responderá automáticamente';
        setTimeout(() => { if(fb) fb.textContent = ''; }, 4000);
      }
    } else {
      alert('❌ ' + (data.error || 'Error devolviendo al bot'));
    }
  } catch(e) {
    alert('❌ Error conectando con el bot. ¿Está corriendo?');
  }
}

async function moverPostventa(phone) {
  const select = document.getElementById('pvSelect_' + phone);
  const status = select ? select.value : '';
  if (!status) { alert('Selecciona una sub-categoría de post-venta'); return; }
  try {
    const res = await fetch('/api/cambiar-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, status })
    });
    const data = await res.json();
    if (data.ok) {
      await loadData();
      switchMainTab('postventa');
    } else { alert('Error: ' + (data.error || 'desconocido')); }
  } catch(e) { console.error(e); }
}

async function migrarAssigned() {
  const btn = document.getElementById('btnMigrar');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Migrando...'; }
  try {
    const res = await fetch('/api/migrar-assigned', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      alert(\`✅ Migración lista: \${data.migrados} clientes pasados de "asignados" → 🔥 Calientes\`);
      await loadData();
    } else { alert('Error: ' + (data.error || 'desconocido')); }
  } catch(e) { alert('Error de conexión'); }
  if (btn) { btn.disabled = false; btn.textContent = '🔄 Migrar Asignados → Calientes'; }
}

async function loadComprobanteBadge() {
  try {
    const res = await fetch('/api/comprobantes-count');
    const { count } = await res.json();
    const badge = document.getElementById('comprobanteBadge');
    if (badge) {
      if (count > 0) { badge.textContent = count; badge.style.display = 'inline'; }
      else badge.style.display = 'none';
    }
  } catch(e) {}
}

async function refreshAll() {
  await loadData();
  await loadComprobanteBadge();
  // Badge post-venta (todos los status del grupo PV)
  if (allData) {
    const pvStatuses = ['postventa', 'carnet_pendiente', 'despacho_pendiente', 'municion_pendiente', 'recuperacion_pendiente', 'bot_asesor_pendiente'];
    const pvCount = allData.clients.filter(c => pvStatuses.includes(c.status)).length;
    const badge = document.getElementById('postventaBadge');
    if (badge) { badge.textContent = pvCount; badge.style.display = pvCount > 0 ? 'inline' : 'none'; }
  }
  // Si estamos en post-venta, refrescar la lista
  if (currentMainTab === 'postventa') renderPostventa();
}

// Auto-refresh cada 15 segundos
refreshAll();
setInterval(refreshAll, 15000);

// ====== VISTA PRINCIPAL TABS ======
let currentMainTab = 'comercial';

function switchMainTab(tab) {
  currentMainTab = tab;
  document.getElementById('mainTabComercial').classList.toggle('active', tab === 'comercial');
  document.getElementById('mainTabComprobantes').classList.toggle('active', tab === 'comprobantes');
  document.getElementById('mainTabPostventa').classList.toggle('active', tab === 'postventa');
  document.getElementById('viewClientes').classList.toggle('active', tab === 'comercial');
  document.getElementById('viewComprobantes').classList.toggle('active', tab === 'comprobantes');
  document.getElementById('viewPostventa').classList.toggle('active', tab === 'postventa');
  if (tab === 'comprobantes') loadComprobantes();
  if (tab === 'postventa') renderPostventa();
}

// ====== POST-VENTA ======
let selectedPhonePv = null;
let currentPvFilter = 'all';

// Todos los status que pertenecen a post-venta
const PV_STATUSES = ['postventa', 'carnet_pendiente', 'despacho_pendiente', 'municion_pendiente', 'recuperacion_pendiente', 'bot_asesor_pendiente'];

const PV_LABELS = {
  'postventa': 'Post-venta',
  'carnet_pendiente': '🪪 Carnet',
  'despacho_pendiente': '📦 Dispositivo',
  'municion_pendiente': '🔫 Munición',
  'recuperacion_pendiente': '🔧 Recuperación',
  'bot_asesor_pendiente': '🤖 Bot Asesor'
};

function setPvFilter(filter, el) {
  currentPvFilter = filter;
  document.querySelectorAll('[data-pvfilter]').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  renderPostventa();
}

function renderPostventa() {
  if (!allData) return;
  // Todos los clientes de post-venta = cualquier status del grupo PV
  let allPv = allData.clients.filter(c => PV_STATUSES.includes(c.status));

  // Aplicar sub-filtro
  let clients = currentPvFilter === 'all'
    ? allPv
    : allPv.filter(c => c.status === currentPvFilter);

  // Búsqueda
  const rawSearchPv = (document.getElementById('searchPostventa')?.value || '').toLowerCase().trim();
  const searchPvDigits = rawSearchPv.replace(/[^0-9]/g, '');
  if (rawSearchPv) clients = clients.filter(c =>
    (c.name||'').toLowerCase().includes(rawSearchPv) ||
    (searchPvDigits && c.phone.includes(searchPvDigits))
  );

  document.getElementById('postventaCount').textContent = allPv.length;

  // Badge en tab principal (total de todos los PV)
  const badge = document.getElementById('postventaBadge');
  if (badge) { badge.textContent = allPv.length; badge.style.display = allPv.length > 0 ? 'inline' : 'none'; }

  const html = clients.map(c => {
    const initial = (c.name || c.phone).charAt(0).toUpperCase();
    const statusLabel = PV_LABELS[c.status] || c.status;
    const statusClass = 'status-' + c.status.replace(/_/g, '-');
    return \`<div class="client-row \${selectedPhonePv === c.phone ? 'active' : ''}" onclick="selectClientPv('\${c.phone}')">
      <div class="client-avatar" style="color:#3fb950;">\${initial}</div>
      <div class="client-info">
        <div class="client-name">\${c.name || 'Sin nombre'}</div>
        <div class="client-phone">\${isLid(c.phone) ? '🔒 ID privado' : c.phone}</div>
        \${c.memory ? '<div class="client-memory">💭 ' + c.memory.substring(0, 80) + '</div>' : ''}
      </div>
      <div class="client-meta">
        <div class="client-status \${statusClass}" style="font-size:9px;">\${statusLabel}</div>
        <div class="client-count">\${c.interaction_count || 0} msgs</div>
      </div>
    </div>\`;
  }).join('');
  document.getElementById('postventaList').innerHTML = html || '<div class="chat-empty">Sin clientes en esta categoría</div>';
}

function filterPostventa() { renderPostventa(); }

async function selectClientPv(phone) {
  selectedPhonePv = phone;
  renderPostventa();
  const client = allData.clients.find(c => c.phone === phone);
  document.getElementById('chatTitlePv').textContent = '💬 ' + (client.name || phone);
  document.getElementById('clientDetailPv').style.display = 'block';
  document.getElementById('clientDetailPv').innerHTML = \`
    <div class="client-detail">
      <h3>\${client.name || 'Sin nombre'} <span class="client-status status-postventa">postventa</span></h3>
      <div class="detail-grid">
        <div class="detail-item"><span class="dl">\${isLid(client.phone) ? '🔒 ID WA:' : '📱 Teléfono:'}</span> <span class="dv">\${isLid(client.phone) ? '<span style=\\"color:#8b949e;font-size:11px;\\">' + client.phone + ' (privado)</span>' : client.phone}</span></div>
        <div class="detail-item"><span class="dl">💬 Mensajes:</span> <span class="dv">\${client.interaction_count || 0}</span></div>
      </div>
      \${client.memory ? '<div class="memory-box">🧠 <strong>Memoria CRM:</strong>\\n' + client.memory + '</div>' : ''}
      <div class="crm-actions">
        <div class="crm-actions-title">📂 Categorizar</div>
        <div class="crm-chips">
          <div class="crm-chip" onclick="changeStatus('\${client.phone}', 'carnet_pendiente')">🪪 Pend. Carnet Club</div>
          <div class="crm-chip" onclick="changeStatus('\${client.phone}', 'despacho_pendiente')">📦 Pend. Dispositivo</div>
          <div class="crm-chip" onclick="changeStatus('\${client.phone}', 'municion_pendiente')">🔫 Pend. Munición</div>
          <div class="crm-chip" onclick="changeStatus('\${client.phone}', 'recuperacion_pendiente')">🔧 Pend. Recuperación</div>
          <div class="crm-chip" onclick="changeStatus('\${client.phone}', 'bot_asesor_pendiente')">🤖 Pend. Bot Asesor</div>
        </div>
        <div class="crm-actions-title" style="margin-top:10px;">⚡ Acciones</div>
        <div class="crm-chips">
          <div class="crm-chip" onclick="addNote('\${client.phone}', '✅ Caso resuelto')">✅ Caso resuelto</div>
          <div class="crm-chip" onclick="changeStatus('\${client.phone}', 'completed')">🏁 Marcar completado</div>
          <div class="crm-chip" onclick="changeStatus('\${client.phone}', 'new')">↩️ Devolver a Comercial</div>
        </div>
      </div>
      <div style="margin-top:10px;">\${waLink(client.phone)}</div>
    </div>
  \`;
  const res = await fetch('/api/chat?phone=' + phone);
  const messages = await res.json();
  const chatHtml = messages.map(m => \`
    <div style="display:flex;flex-direction:column;align-items:\${m.role === 'user' ? 'flex-start' : 'flex-end'};">
      <div class="chat-bubble chat-\${m.role}">\${m.message}</div>
      <div class="chat-time">\${new Date(m.created_at).toLocaleString()}</div>
    </div>
  \`).join('');
  const chatArea = document.getElementById('chatAreaPv');
  chatArea.innerHTML = '<div class="chat-container">' + (chatHtml || '<div class="chat-empty">Sin mensajes</div>') + '</div>';
  requestAnimationFrame(() => requestAnimationFrame(() => { chatArea.scrollTop = chatArea.scrollHeight; }));
}

// ====== COMPROBANTES ======
async function loadComprobantes() {
  try {
    const res = await fetch('/api/comprobantes');
    const comprobantes = await res.json();

    // Actualizar badge
    const badge = document.getElementById('comprobanteBadge');
    if (comprobantes.length > 0) {
      badge.textContent = comprobantes.length;
      badge.style.display = 'inline';
    } else {
      badge.style.display = 'none';
    }

    const container = document.getElementById('comprobantesList');
    if (!comprobantes.length) {
      container.innerHTML = '<div class="comprobante-empty">✅ No hay comprobantes pendientes de verificar</div>';
      return;
    }

    container.innerHTML = comprobantes.map(c => {
      const tipoClass = c.tipo === 'club' ? 'tipo-club' : c.tipo === 'producto' ? 'tipo-producto' : c.tipo === 'bot_asesor' ? 'tipo-bot' : 'tipo-desconocido';
      const tipoLabel = c.tipo === 'club' ? '🏆 Club ZT' : c.tipo === 'producto' ? '📦 Producto' : c.tipo === 'bot_asesor' ? '🤖 Bot Asesor' : '❓ Desconocido';
      const fecha = new Date(c.created_at).toLocaleString('es-CO');
      const imgHtml = c.imagen_base64
        ? \`<img class="comprobante-img" src="data:\${c.imagen_mime};base64,\${c.imagen_base64}" alt="comprobante" onclick="openLightbox(this.src)" title="Click para ver completo">\`
        : \`<div class="comprobante-img-placeholder">📄 Sin imagen</div>\`;

      return \`
        <div class="comprobante-card" id="comp_\${c.id}">
          \${imgHtml}
          <div class="comprobante-info">
            <div class="comprobante-name">\${c.client_name || 'Sin nombre'}</div>
            <div class="comprobante-phone">📱 \${c.client_phone}</div>
            <div class="comprobante-detail">
              \${c.info ? c.info.split(',').map(p => '<strong>' + p.trim() + '</strong>').join(' &nbsp;·&nbsp; ') : '<em style="color:#3d4f5f">Sin info detectada</em>'}
            </div>
            <div><span class="comprobante-tipo \${tipoClass}">\${tipoLabel}</span></div>
            <div class="comprobante-time">📅 \${fecha}</div>
            <div style="margin-top:8px;"><a href="https://wa.me/\${c.client_phone}" target="_blank" style="color:#3fb950;font-size:12px;text-decoration:none;">📲 Abrir en WhatsApp</a></div>
          </div>
          <div class="comprobante-actions">
            <button class="btn-confirmar" id="btn_confirm_\${c.id}" onclick="accionComprobante(\${c.id}, 'confirmar', '\${c.client_phone}', '\${c.tipo}')">✅ Confirmar pago</button>
            <button class="btn-rechazar" id="btn_reject_\${c.id}" onclick="accionComprobante(\${c.id}, 'rechazar', '\${c.client_phone}', '\${c.tipo}')">❌ Rechazar</button>
          </div>
        </div>
      \`;
    }).join('');
  } catch(e) {
    console.error('Error cargando comprobantes:', e);
  }
}

async function accionComprobante(id, accion, phone, tipo) {
  const btnConfirm = document.getElementById('btn_confirm_' + id);
  const btnReject = document.getElementById('btn_reject_' + id);
  if (btnConfirm) btnConfirm.disabled = true;
  if (btnReject) btnReject.disabled = true;
  const label = accion === 'confirmar' ? (btnConfirm || {}) : (btnReject || {});
  if (accion === 'confirmar' && btnConfirm) btnConfirm.textContent = '⏳ Confirmando...';
  if (accion === 'rechazar' && btnReject) btnReject.textContent = '⏳ Rechazando...';

  try {
    const res = await fetch('/api/confirmar-comprobante', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, accion, phone, tipo })
    });
    const data = await res.json();
    if (data.ok) {
      const card = document.getElementById('comp_' + id);
      if (card) {
        card.style.opacity = '0.4';
        card.style.pointerEvents = 'none';
        let status;
        if (!data.waSent) {
          // BD actualizada pero el mensaje de WA falló
          const accionLabel = accion === 'confirmar' ? '✅ BD actualizada' : '❌ BD actualizada';
          status = '<div style="color:#d29922;font-size:13px;font-weight:700;margin-top:8px;">' + accionLabel + ' — ⚠️ No se pudo notificar al cliente por WhatsApp (' + (data.waWarning || 'error LID') + '). Notifícalo manualmente.</div>';
        } else {
          status = accion === 'confirmar'
            ? '<div style="color:#3fb950;font-size:13px;font-weight:700;margin-top:8px;">✅ Pago confirmado — bot solicitando datos al cliente</div>'
            : '<div style="color:#f85149;font-size:13px;font-weight:700;margin-top:8px;">❌ Rechazado — bot notificó al cliente</div>';
        }
        card.querySelector('.comprobante-actions').innerHTML = status;
      }
      // Recargar solo si seguimos en el tab de comprobantes
      if (currentMainTab === 'comprobantes') setTimeout(loadComprobantes, 2000);
    } else {
      alert('❌ Error: ' + (data.error || 'No se pudo conectar con el bot'));
      if (btnConfirm) { btnConfirm.disabled = false; btnConfirm.textContent = '✅ Confirmar pago'; }
      if (btnReject) { btnReject.disabled = false; btnReject.textContent = '❌ Rechazar'; }
    }
  } catch(e) {
    alert('❌ Error de red. ¿Está corriendo el panel?');
    if (btnConfirm) { btnConfirm.disabled = false; btnConfirm.textContent = '✅ Confirmar pago'; }
    if (btnReject) { btnReject.disabled = false; btnReject.textContent = '❌ Rechazar'; }
  }
}

// Lightbox para ver comprobante completo
function openLightbox(src) {
  document.getElementById('imgLightboxImg').src = src;
  document.getElementById('imgLightbox').classList.add('open');
}
function closeLightbox() {
  document.getElementById('imgLightbox').classList.remove('open');
}

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
