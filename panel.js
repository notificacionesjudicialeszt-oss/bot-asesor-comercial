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
const { exec } = require('child_process');
require('dotenv').config();

const db = new Database(path.join(__dirname, 'crm.db'));
const PORT = 3000;
const BOT_API_KEY = process.env.INTERNAL_API_KEY || '';

// Helper: headers para proxy requests al bot (puerto 3001) con auth
function botHeaders(payloadLength) {
  const h = { 'Content-Type': 'application/json', 'Content-Length': payloadLength };
  if (BOT_API_KEY) h['Authorization'] = 'Bearer ' + BOT_API_KEY;
  return h;
}

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

  // Hot leads — basado en lead_score calculado por lead_scorer.js
  const hotLeads = clients.filter(c => (c.lead_score || 0) >= 60);

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
  const silentRoutes = ['/api/data', '/api/events', '/api/chat', '/'];
  if (!silentRoutes.includes(url.pathname)) {
    console.log(`[PANEL] ${req.method} ${url.pathname}`);
  }

  // API endpoints
  // ── Broadcast proxy → bot puerto 3001 ──
  if (url.pathname.startsWith('/api/broadcast/')) {
    const botPath = url.pathname.replace('/api/broadcast', '/broadcast');
    const botPort = 3001;
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const http2 = require('http');
        const proxyReq = http2.request({ hostname: 'localhost', port: botPort, path: botPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, proxyRes => {
          let data = ''; proxyRes.on('data', ch => data += ch); proxyRes.on('end', () => { res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' }); res.end(data); });
        });
        proxyReq.on('error', e => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, msg: 'Bot no disponible: ' + e.message })); });
        proxyReq.write(body); proxyReq.end();
      });
      return;
    } else {
      const http2 = require('http');
      const proxyReq = http2.request({ hostname: 'localhost', port: botPort, path: botPath, method: 'GET' }, proxyRes => {
        let data = ''; proxyRes.on('data', ch => data += ch); proxyRes.on('end', () => { res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' }); res.end(data); });
      });
      proxyReq.on('error', e => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, msg: 'Bot no disponible: ' + e.message })); });
      proxyReq.end();
      return;
    }
  }

  if (url.pathname === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getData()));
    return;
  }

  if (url.pathname === '/api/dashboard') {
    try {
      const funnel = db.prepare("SELECT status, COUNT(*) as count FROM clients WHERE ignored = 0 AND spam_flag = 0 GROUP BY status ORDER BY count DESC").all();
      const total = db.prepare("SELECT COUNT(*) as c FROM clients WHERE ignored = 0 AND spam_flag = 0").get().c;
      const completed = db.prepare("SELECT COUNT(*) as c FROM clients WHERE status = 'completed'").get().c;
      const conversionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
      const thisWeek = db.prepare("SELECT COUNT(*) as c FROM clients WHERE created_at >= datetime('now', '-7 days')").get().c;
      const lastWeek = db.prepare("SELECT COUNT(*) as c FROM clients WHERE created_at >= datetime('now', '-14 days') AND created_at < datetime('now', '-7 days')").get().c;
      const weekTrend = thisWeek - lastWeek;
      const msgsToday = db.prepare("SELECT COUNT(*) as c FROM conversations WHERE date(created_at) = date('now')").get().c;
      let confirmedThisMonth = 0;
      try { confirmedThisMonth = db.prepare("SELECT COUNT(*) as c FROM comprobantes WHERE estado = 'confirmado' AND created_at >= datetime('now', 'start of month')").get().c; } catch(e) {}
      const productPatterns = ['firat','zoraki','blow','ekol','retay','bruni','kuzey','major','magnum','compact','aral','carrera','voltran','club plus','club pro','munición','municion','traumática','traumatica','carnet'];
      const allMemories = db.prepare("SELECT memory FROM clients WHERE memory IS NOT NULL AND memory != ''").all();
      const pkw = {};
      for (const row of allMemories) { const mem = (row.memory||'').toLowerCase(); for (const kw of productPatterns) { if (mem.includes(kw)) pkw[kw] = (pkw[kw]||0) + 1; } }
      const topProducts = Object.entries(pkw).sort((a,b)=>b[1]-a[1]).slice(0,7).map(([product,count])=>({product,count}));
      let activeSequences = [];
      try { activeSequences = db.prepare("SELECT type, COUNT(*) as count FROM followup_sequences WHERE stopped = 0 GROUP BY type").all(); } catch(e) {}
      let scoreDistribution = { hot: 0, warm: 0, cold: 0 };
      try {
        scoreDistribution.hot = db.prepare("SELECT COUNT(*) as c FROM clients WHERE lead_score >= 60 AND ignored = 0").get().c;
        scoreDistribution.warm = db.prepare("SELECT COUNT(*) as c FROM clients WHERE lead_score >= 30 AND lead_score < 60 AND ignored = 0").get().c;
        scoreDistribution.cold = db.prepare("SELECT COUNT(*) as c FROM clients WHERE lead_score > 0 AND lead_score < 30 AND ignored = 0").get().c;
      } catch(e) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ funnel, total, completed, conversionRate, thisWeek, lastWeek, weekTrend, msgsToday, confirmedThisMonth, topProducts, activeSequences, scoreDistribution }));
    } catch(e) {
      console.error('[PANEL] Error dashboard:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url.pathname === '/api/chat') {
    const phone = url.searchParams.get('phone');
    const limit = parseInt(url.searchParams.get('limit') || '100');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getClientChat(phone, limit)));
    return;
  }

  // ============================================
  // DOSSIER COMPLETO DEL CLIENTE — consulta TODAS las tablas
  // ============================================
  if (url.pathname === '/api/client-dossier') {
    const phone = url.searchParams.get('phone');
    if (!phone) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Parámetro phone requerido' }));
      return;
    }
    try {
      const clean = phone.replace(/@.*/, '').replace(/\D/g, '');
      const profile = db.prepare('SELECT * FROM clients WHERE phone = ?').get(clean);
      if (!profile) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Cliente no encontrado' }));
        return;
      }

      // Comprobantes (TODOS, no solo pendientes)
      const comprobantes = db.prepare(`
        SELECT id, tipo, estado, info, imagen_mime, created_at, verified_at
        FROM comprobantes WHERE client_phone = ? ORDER BY created_at DESC
      `).all(clean);

      // Carnets (TODOS)
      const carnets = db.prepare(`
        SELECT id, estado, nombre, cedula, vigente_hasta, marca_arma, modelo_arma, serial, imagen_mime, created_at, verified_at
        FROM carnets WHERE client_phone = ? ORDER BY created_at DESC
      `).all(clean);

      // Archivos del cliente (sin imagen_base64 para no sobrecargar)
      const files = db.prepare(`
        SELECT id, tipo, descripcion, imagen_mime, subido_por, created_at
        FROM client_files WHERE client_phone = ? ORDER BY created_at DESC
      `).all(clean);

      // Estadísticas
      const totalMessages = db.prepare('SELECT COUNT(*) as c FROM conversations WHERE client_phone = ?').get(clean).c;
      const firstContact = db.prepare('SELECT MIN(created_at) as d FROM conversations WHERE client_phone = ?').get(clean).d;

      // Asignación activa
      const assignment = db.prepare(`
        SELECT a.*, e.name as employee_name FROM assignments a
        JOIN employees e ON a.employee_id = e.id
        WHERE a.client_phone = ? AND a.status = 'active'
        ORDER BY a.assigned_at DESC LIMIT 1
      `).get(clean);

      console.log(`[PANEL] 📋 Dossier cargado para ${clean}: ${comprobantes.length} comprobantes, ${carnets.length} carnets, ${files.length} archivos`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        profile,
        comprobantes,
        carnets,
        files,
        assignment: assignment || null,
        stats: { totalMessages, firstContact, lastContact: profile.updated_at }
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Archivos de un cliente específico (con imagen_base64 para ver)
  if (url.pathname === '/api/client-files') {
    const phone = url.searchParams.get('phone');
    const id = url.searchParams.get('id');
    try {
      if (id) {
        // Un archivo específico con su imagen
        const file = db.prepare('SELECT * FROM client_files WHERE id = ?').get(parseInt(id));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(file || null));
      } else if (phone) {
        const clean = phone.replace(/@.*/, '').replace(/\D/g, '');
        const files = db.prepare(`
          SELECT id, tipo, descripcion, imagen_mime, subido_por, created_at
          FROM client_files WHERE client_phone = ? ORDER BY created_at DESC
        `).all(clean);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(files));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Parámetro phone o id requerido' }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Actualizar memoria completa de un cliente directamente
  if (url.pathname === '/api/update-client-memory' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { phone, memory } = JSON.parse(body);
        if (!phone) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'phone requerido' }));
          return;
        }
        const clean = phone.replace(/@.*/, '').replace(/\D/g, '');
        db.prepare('UPDATE clients SET memory = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ?').run(memory || '', clean);
        console.log(`[PANEL] 🧠 Memoria editada para ${clean} (${(memory || '').length} chars)`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Actualizar memoria/estado de cliente desde el panel
  if (url.pathname === '/api/update-client' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { phone, note, append, status, profileData } = JSON.parse(body);
        console.log(`[PANEL] 📝 Actualizando cliente ${phone}${status ? ' → status: ' + status : ''}${profileData ? ' → (ficha CRM)' : ''}${note ? ' → nota: "' + note.substring(0, 40) + '"' : ''}`);
        const client = db.prepare('SELECT * FROM clients WHERE phone = ?').get(phone);
        if (!client) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cliente no encontrado' }));
          return;
        }

        // 1. Actualizar datos estructurados de perfil (Ficha CRM)
        if (profileData) {
          const fields = [];
          const values = [];
          const validKeys = [
            'name', 'cedula', 'ciudad', 'direccion',
            'profesion', 'club_plan', 'club_vigente_hasta',
            'modelo_arma', 'marca_arma', 'serial_arma'
          ];

          for (const key of validKeys) {
            if (profileData[key] !== undefined) {
              fields.push(`${key} = ?`);
              values.push(profileData[key] || '');
            }
          }

          if (fields.length > 0) {
            fields.push('updated_at = CURRENT_TIMESTAMP');
            values.push(phone);
            db.prepare(`UPDATE clients SET ${fields.join(', ')} WHERE phone = ?`).run(...values);
          }
        }

        // 2. Actualizar status si se envió
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

  // Toggles de la Bóveda de Servicios (Botones DB boolean)
  if (url.pathname === '/api/toggle-client-flag' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { phone, flag, value } = JSON.parse(body);
        const val = value ? 1 : 0;
        const validFlags = ['has_bought_gun', 'is_club_plus', 'is_club_pro', 'has_ai_bot'];

        if (!validFlags.includes(flag)) {
          throw new Error('Flag de servicio inválido');
        }
        db.prepare(`UPDATE clients SET ${flag} = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ?`).run(val, phone);
        console.log(`[PANEL] 🔒 Bóveda de Servicios: ${phone} → ${flag} = ${val}`);
        
        // Actualizar la memoria si se está activando el Bot Asesor para registrar la 'entrega'
        if (flag === 'has_ai_bot' && val === 1) {
          const client = db.prepare('SELECT memory FROM clients WHERE phone = ?').get(phone);
          const memoriaActual = client ? (client.memory || '') : '';
          let nuevaMemoria = '';
          if (memoriaActual.includes('N/A (Es un servicio digital activo)')) {
            nuevaMemoria = memoriaActual.replace('N/A (Es un servicio digital activo)', 'SÍ (Bot Activado)');
          } else {
             nuevaMemoria = memoriaActual ? memoriaActual + `\n🤖 ESTADO DE ENTREGA: Bot Activado` : `🤖 ESTADO DE ENTREGA: Bot Activado`;
          }
          db.prepare('UPDATE clients SET memory = ? WHERE phone = ?').run(nuevaMemoria, phone);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, flag, val }));
      } catch (e) {
        console.error('[PANEL] toggle-client-flag error:', e.message);
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
        headers: botHeaders(Buffer.byteLength(payload))
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

  // Enviar catálogo completo con fotos — relay al bot en puerto 3001
  if (url.pathname === '/api/enviar-catalogo' && req.method === 'POST') {
    let bodyData = '';
    req.on('data', chunk => bodyData += chunk);
    req.on('end', () => {
      const parsed = JSON.parse(bodyData);
      console.log(`[PANEL] 📋 Enviando catálogo a ${parsed.phone}`);
      const payload = bodyData;
      const botReq = http.request({
        hostname: 'localhost',
        port: 3001,
        path: '/enviar-catalogo',
        method: 'POST',
        headers: botHeaders(Buffer.byteLength(payload))
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
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payloadFromClient = body ? JSON.parse(body) : {};
        const mode = payloadFromClient.mode || 'normal';

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
        const payload = JSON.stringify({ clientes, mode });
        const botReq = http.request({
          hostname: 'localhost',
          port: 3001,
          path: '/reactivar',
          method: 'POST',
          headers: botHeaders(Buffer.byteLength(payload))
        }, botRes => {
          let data = '';
          botRes.on('data', chunk => data += chunk);
          botRes.on('end', () => {
            console.log(`[PANEL] 🔥 Reactivación iniciada en bot: ${clientes.length} clientes (Modo: ${mode})`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, total: clientes.length, msg: `${clientes.length} clientes enviados al bot (${mode.toUpperCase()})` }));
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
    });
    return;
  }

  // Reatender mensajes no leídos — llama directo al bot por HTTP (puerto 3001)
  if (url.pathname === '/api/reatender-no-leidos' && req.method === 'POST') {
    const botReq = http.request({
      hostname: 'localhost',
      port: 3001,
      path: '/reatender-no-leidos',
      method: 'POST',
      headers: botHeaders(0)
    }, botRes => {
      let data = '';
      botRes.on('data', chunk => data += chunk);
      botRes.on('end', () => {
        console.log(`[PANEL] 📬 Reatender no leídos: ${data}`);
        res.writeHead(botRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(data);
      });
    });
    botReq.on('error', () => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, msg: '❌ No se pudo conectar con el bot. ¿Está corriendo?' }));
    });
    botReq.end();
    return;
  }

  // Reactivar cliente INDIVIDUAL — llama directo al bot por HTTP (puerto 3001)
  if (url.pathname === '/api/reactivar-individual' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { phone, mode = 'normal' } = JSON.parse(body);
        if (!phone) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: 'Teléfono requerido' }));
          return;
        }

        const clienteDb = db.prepare('SELECT * FROM clients WHERE phone = ?').get(phone);
        if (!clienteDb) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: 'Cliente no encontrado en CRM' }));
          return;
        }

        const clientes = [{
          phone: clienteDb.phone,
          name: clienteDb.name || 'Cliente',
          memory: clienteDb.memory || '',
          status: clienteDb.status
        }];

        // Llamar directamente al bot por HTTP
        const payload = JSON.stringify({ clientes, mode });
        const botReq = http.request({
          hostname: 'localhost',
          port: 3001,
          path: '/reactivar',
          method: 'POST',
          headers: botHeaders(Buffer.byteLength(payload))
        }, botRes => {
          let data = '';
          botRes.on('data', chunk => data += chunk);
          botRes.on('end', () => {
            console.log(`[PANEL] 🔥 Reactivación individual iniciada para: ${clienteDb.phone} (Modo: ${mode})`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, msg: `Mensaje de reactivación (${mode}) enviado al bot` }));
          });
        });

        botReq.on('error', () => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: '❌ No se pudo conectar con el bot. ¿Está corriendo?' }));
        });

        botReq.write(payload);
        botReq.end();
      } catch (e) {
        console.error('[PANEL] Error reactivar-individual:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/api/reatender' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = body;
        const botReq = http.request({
          hostname: 'localhost',
          port: 3001,
          path: '/reatender',
          method: 'POST',
          headers: botHeaders(Buffer.byteLength(payload))
        }, botRes => {
          let data = '';
          botRes.on('data', chunk => data += chunk);
          botRes.on('end', () => {
            console.log(`[PANEL] 🔄 Reatender solicitado para:`, JSON.parse(body).phone);
            res.writeHead(botRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(data);
          });
        });

        botReq.on('error', () => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: '❌ No se pudo conectar con el bot. ¿Está corriendo?' }));
        });

        botReq.write(payload);
        botReq.end();
      } catch (e) {
        console.error('[PANEL] Error reatender:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Reatender post-venta — seguimiento IA (NO comercial)
  if (url.pathname === '/api/reatender-postventa' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = body;
        const botReq = http.request({
          hostname: 'localhost',
          port: 3001,
          path: '/reatender-postventa',
          method: 'POST',
          headers: botHeaders(Buffer.byteLength(payload))
        }, botRes => {
          let data = '';
          botRes.on('data', chunk => data += chunk);
          botRes.on('end', () => {
            console.log(`[PANEL] 📬 Seguimiento post-venta solicitado para:`, JSON.parse(body).phone);
            res.writeHead(botRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(data);
          });
        });

        botReq.on('error', () => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: '❌ No se pudo conectar con el bot. ¿Está corriendo?' }));
        });

        botReq.write(payload);
        botReq.end();
      } catch (e) {
        console.error('[PANEL] Error reatender-postventa:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Agregar cliente nuevo y enviar primer mensaje
  if (url.pathname === '/api/agregar-cliente' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = body;
        const botReq = http.request({
          hostname: 'localhost',
          port: 3001,
          path: '/agregar-cliente',
          method: 'POST',
          headers: botHeaders(Buffer.byteLength(payload))
        }, botRes => {
          let data = '';
          botRes.on('data', chunk => data += chunk);
          botRes.on('end', () => {
            console.log(`[PANEL] \u2795 Agregar cliente:`, JSON.parse(body).phone);
            res.writeHead(botRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(data);
          });
        });

        botReq.on('error', () => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: '\u274c No se pudo conectar con el bot. \u00bfEst\u00e1 corriendo?' }));
        });

        botReq.write(payload);
        botReq.end();
      } catch (e) {
        console.error('[PANEL] Error agregar-cliente:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Resolver escalación (marcar como gestionada/descartada)
  if (url.pathname === '/api/resolver-escalacion' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { id, estado, notas } = JSON.parse(body);
        if (!id || !estado) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Faltan id o estado' }));
          return;
        }

        // 1. Marcar escalacion como resuelta
        db.prepare('UPDATE escalaciones SET estado = ?, notas = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?').run(estado, notas || '', id);

        // 2. Obtener el teléfono del cliente de esta escalación
        const esc = db.prepare('SELECT client_phone FROM escalaciones WHERE id = ?').get(id);

        if (esc) {
          // 3. Si hay notas, agregarlas a la memoria del cliente
          if (notas && notas.trim()) {
            const client = db.prepare('SELECT memory FROM clients WHERE phone = ?').get(esc.client_phone);
            const currentMemory = client ? (client.memory || '') : '';
            const timestamp = new Date().toISOString().split('T')[0];
            const notaFormateada = '\n[PV ' + timestamp + '] ' + notas.trim();
            db.prepare('UPDATE clients SET memory = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ?').run(currentMemory + notaFormateada, esc.client_phone);
            console.log('[PANEL] \uD83D\uDCDD Nota agregada a memoria de ' + esc.client_phone);
          }

          // 4. Si GESTIONADA → mover cliente a completed para sacarlo del panel PV permanentemente
          //    Si DESCARTADA → no cambiar status (puede tener otra razón pendiente)
          if (estado === 'gestionada') {
            const pvList = ['postventa','carnet_pendiente_plus','carnet_pendiente_pro','despacho_pendiente','municion_pendiente','recuperacion_pendiente','bot_asesor_pendiente','devolucion_pendiente'];
            const ph = pvList.map(() => '?').join(', ');
            db.prepare('UPDATE clients SET status = \'completed\', updated_at = CURRENT_TIMESTAMP WHERE phone = ? AND status IN (' + ph + ')').run(esc.client_phone, ...pvList);
            console.log('[PANEL] \u2705 Escalaci\u00f3n #' + id + ' gestionada \u2192 cliente ' + esc.client_phone + ' movido a \'completed\'');
          } else {
            console.log('[PANEL] \uD83D\uDDD1\uFE0F Escalaci\u00f3n #' + id + ' descartada para ' + esc.client_phone + (notas ? ' (con nota)' : ''));
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Devolver cliente a Comercial — resetear status a 'hot' + reiniciar pipeline comercial
  if (url.pathname === '/api/set-bot-directive' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { phone, directive } = JSON.parse(body);
        const directiveValue = directive && directive.trim() ? directive.trim() : null;
        db.prepare('UPDATE clients SET bot_directive = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ?').run(directiveValue, phone);
        console.log('[PANEL] \uD83C\uDFAF Directiva ' + (directiveValue ? 'establecida' : 'limpiada') + ' para ' + phone + (directiveValue ? ': ' + directiveValue.substring(0,60) : ''));
        
        // Responder al panel inmediatamente
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        
        // Si hay directiva activa, ejecutarla en el bot ahora mismo (background)
        if (directiveValue) {
          const http2 = require('http');
          const payload = JSON.stringify({ phone, directive: directiveValue, execute: true });
          const botReq = http2.request(
            { hostname: 'localhost', port: 3001, path: '/execute-directive', method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
                         'Authorization': 'Bearer ' + (process.env.INTERNAL_API_KEY || '') } },
            (botRes) => {
              let d = ''; botRes.on('data', ch => d += ch);
              botRes.on('end', () => console.log('[PANEL] Directive execute response:', d.substring(0,120)));
            }
          );
          botReq.on('error', e => console.log('[PANEL] Bot directive execute error:', e.message));
          botReq.write(payload);
          botReq.end();
        }
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: e.message }));
      }
    });
    return;
  }
  if (url.pathname === '/api/devolver-a-comercial' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { phone } = JSON.parse(body);
        if (!phone) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, msg: 'Falta phone' }));
          return;
        }

        // 1. Resetear status a 'hot' y limpiar campos de post-venta
        db.prepare(`
          UPDATE clients 
          SET status = 'hot', 
              updated_at = CURRENT_TIMESTAMP 
          WHERE phone = ?
        `).run(phone);

        // 2. Detener/resetear secuencia de follow-up para que arranque fresca
        try {
          db.prepare(`
            UPDATE sequences 
            SET is_active = 0
            WHERE client_phone = ? AND type = 'lead'
          `).run(phone);
        } catch(e) { /* tabla puede no existir */ }

        // 3. Recalcular lead score inmediatamente
        try {
          const { calculateScore } = require('./agents/lead_scorer');
          const client = db.prepare('SELECT * FROM clients WHERE phone = ?').get(phone);
          if (client) {
            const newScore = calculateScore(client);
            db.prepare('UPDATE clients SET lead_score = ? WHERE phone = ?').run(newScore, phone);
            console.log(`[PANEL] 📊 Lead score recalculado para ${phone}: ${newScore}`);
          }
        } catch(e) {
          console.warn('[PANEL] No se pudo recalcular lead score:', e.message);
        }

        // 4. Notificar al bot para análisis de coaching (vía API interna)
        try {
          const payload = JSON.stringify({ phone, action: 'devolver_comercial' });
          const botReq = http.request({
            hostname: 'localhost',
            port: 3001,
            path: '/devolver-comercial',
            method: 'POST',
            headers: botHeaders(Buffer.byteLength(payload))
          }, () => {});
          botReq.on('error', () => {}); // silencioso si el bot no tiene ese endpoint
          botReq.write(payload);
          botReq.end();
        } catch(e) { /* silencioso */ }

        console.log(`[PANEL] 🔄 Cliente ${phone} devuelto a Comercial — pipeline comercial reactivado`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, msg: e.message }));
      }
    });
    return;
  }


  // Confirmar o rechazar comprobante — relay al bot en puerto 3001 — relay al bot en puerto 3001
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
          headers: botHeaders(Buffer.byteLength(payload))
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

  // Proxy para confirmar/rechazar carnet
  if (url.pathname === '/api/confirmar-carnet' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = body;
        const botReq = http.request({
          hostname: 'localhost',
          port: 3001,
          path: '/confirmar-carnet',
          method: 'POST',
          headers: botHeaders(Buffer.byteLength(payload))
        }, botRes => {
          let data = '';
          botRes.on('data', chunk => data += chunk);
          botRes.on('end', () => {
            console.log(`[PANEL] 🪪 Carnet procesado:`, data);
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

  // Generar carnet de membresía — relay al bot en puerto 3001
  if (url.pathname === '/api/generar-carnet' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = body;
        const botReq = http.request({
          hostname: 'localhost',
          port: 3001,
          path: '/generar-carnet',
          method: 'POST',
          headers: botHeaders(Buffer.byteLength(payload))
        }, botRes => {
          let data = '';
          botRes.on('data', chunk => data += chunk);
          botRes.on('end', () => {
            console.log(`[PANEL] 🪪 Carnet generado:`, data.substring(0, 200));
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
      headers: botHeaders(2)
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
        const validStatuses = ['new', 'hot', 'warm', 'completed', 'postventa', 'carnet_pendiente_plus', 'carnet_pendiente_pro', 'despacho_pendiente', 'municion_pendiente', 'recuperacion_pendiente', 'bot_asesor_pendiente'];
        console.log(`[PANEL] 📂 cambiar-status: phone="${phone}" status="${status}" válido=${validStatuses.includes(status)}`);
        if (!phone || !validStatuses.includes(status)) {
          console.error(`[PANEL] ❌ cambiar-status rechazado: phone=${JSON.stringify(phone)} status=${JSON.stringify(status)}`);
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
          headers: botHeaders(Buffer.byteLength(payload))
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

  // Carnets pendientes
  if (url.pathname === '/api/carnets') {
    try {
      const carnets = db.prepare(`SELECT id, client_phone, nombre, cedula, vigente_hasta, marca_arma, modelo_arma, serial, imagen_base64, imagen_mime, estado, created_at FROM carnets WHERE estado = 'pendiente' ORDER BY created_at DESC`).all();
      console.log(`[PANEL] 🪪 Carnets cargados: ${carnets.length} pendientes`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(carnets));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Escalaciones pendientes
  if (url.pathname === '/api/escalaciones') {
    try {
      const escalaciones = db.prepare(`
        SELECT e.id, e.client_phone, e.client_name, e.tipo, e.trigger_message, e.memory, e.contexto, e.estado, e.created_at,
               c.name, c.cedula, c.ciudad, c.direccion, c.profesion, c.club_plan, c.club_vigente_hasta,
               c.modelo_arma, c.marca_arma, c.serial_arma, c.foto_cliente_url,
               c.nombre_recibe, c.telefono_recibe, c.direccion_envio, c.barrio_envio, c.ciudad_envio, c.departamento_envio,
               c.has_bought_gun, c.is_club_plus, c.is_club_pro, c.has_ai_bot, c.lead_score
        FROM escalaciones e
        LEFT JOIN clients c ON e.client_phone = c.phone
        WHERE e.estado = 'pendiente' ORDER BY e.created_at DESC
      `).all();
      console.log(`[PANEL] 🚨 Escalaciones cargadas: ${escalaciones.length} pendientes`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(escalaciones));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Carnets de un cliente específico (todos, no solo pendientes)
  if (url.pathname === '/api/carnets-cliente') {
    const phone = url.searchParams.get('phone');
    if (!phone) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Parámetro phone requerido' }));
      return;
    }
    try {
      const clean = phone.replace(/@.*/, '').replace(/\D/g, '');
      const carnets = db.prepare(`
        SELECT id, client_phone, client_name, nombre, cedula, vigente_hasta,
               marca_arma, modelo_arma, serial, plan_tipo, estado, imagen_mime,
               created_at, verified_at
        FROM carnets WHERE client_phone = ? ORDER BY created_at DESC
      `).all(clean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(carnets));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Extraer datos del carnet con Gemini Vision — proxy al bot en puerto 3001
  if (url.pathname === '/api/extraer-datos-carnet' && req.method === 'POST') {
    let bodyData = '';
    req.on('data', chunk => bodyData += chunk);
    req.on('end', () => {
      try {
        const payload = bodyData;
        console.log(`[PANEL] 🔍 Extrayendo datos de carnet con IA...`);
        const botReq = http.request({
          hostname: 'localhost',
          port: 3001,
          path: '/extraer-datos-carnet',
          method: 'POST',
          headers: botHeaders(Buffer.byteLength(payload))
        }, botRes => {
          let data = '';
          botRes.on('data', chunk => data += chunk);
          botRes.on('end', () => {
            console.log(`[PANEL] 🔍 Extracción completada`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(data);
          });
        });
        botReq.on('error', () => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '❌ No se pudo conectar con el bot' }));
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

  // Enviar carnet por WhatsApp — proxy al bot en puerto 3001
  if (url.pathname === '/api/enviar-carnet-whatsapp' && req.method === 'POST') {
    let bodyData = '';
    req.on('data', chunk => bodyData += chunk);
    req.on('end', () => {
      try {
        const payload = bodyData;
        console.log(`[PANEL] 🪪 Enviando carnet por WhatsApp...`);
        const botReq = http.request({
          hostname: 'localhost',
          port: 3001,
          path: '/enviar-carnet-whatsapp',
          method: 'POST',
          headers: botHeaders(Buffer.byteLength(payload))
        }, botRes => {
          let data = '';
          botRes.on('data', chunk => data += chunk);
          botRes.on('end', () => {
            console.log(`[PANEL] 🪪 Carnet procesado:`, data.substring(0, 100));
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

  // Proxy: enviar factura por WhatsApp
  if (url.pathname === '/api/enviar-factura-whatsapp' && req.method === 'POST') {
    let bodyData = '';
    req.on('data', chunk => bodyData += chunk);
    req.on('end', () => {
      try {
        const payload = bodyData;
        console.log(`[PANEL] \ud83e\uddfe Enviando factura por WhatsApp...`);
        const botReq = http.request({
          hostname: 'localhost',
          port: 3001,
          path: '/enviar-factura-whatsapp',
          method: 'POST',
          headers: botHeaders(Buffer.byteLength(payload))
        }, botRes => {
          let data = '';
          botRes.on('data', chunk => data += chunk);
          botRes.on('end', () => {
            console.log(`[PANEL] \ud83e\uddfe Factura procesada`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(data);
          });
        });
        botReq.on('error', () => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'No se pudo conectar con el bot' }));
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

  // Proxy: enviar guía de envío por WhatsApp
  if (url.pathname === '/api/enviar-guia-whatsapp' && req.method === 'POST') {
    let bodyData = '';
    req.on('data', chunk => bodyData += chunk);
    req.on('end', () => {
      try {
        const payload = bodyData;
        console.log(`[PANEL] 📦 Enviando guía de envío por WhatsApp...`);
        const botReq = http.request({
          hostname: 'localhost',
          port: 3001,
          path: '/enviar-guia-whatsapp',
          method: 'POST',
          headers: botHeaders(Buffer.byteLength(payload))
        }, botRes => {
          let data = '';
          botRes.on('data', chunk => data += chunk);
          botRes.on('end', () => {
            console.log(`[PANEL] 📦 Guía procesada:`, data.substring(0, 100));
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

  // Actualizar inventario usando IA (ejecuta el script update_inventory.js)
  if (url.pathname === '/api/update-inventory' && req.method === 'POST') {
    console.log('[PANEL] 📦 Recibida petición para actualizar inventario IA...');
    exec('npm run update-inventory', { cwd: __dirname }, (error, stdout, stderr) => {
      if (error) {
        console.error('[PANEL] ❌ Error actualizando inventario:', error.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Hubo un error al actualizar el inventario. Verifica la terminal externa.' }));
        return;
      }
      console.log('[PANEL] ✅ Inventario actualizado con éxito');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, msg: 'Inventario actualizado correctamente usando Gemini IA' }));
    });
    return;
  }

  // Eventos bidireccionales SSE (Server-Sent Events) para actualizar badges en tiempo real sin polling
  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    // Función para obtener y enviar "count" de carnets y comprobantes al panel
    const sendEvent = () => {
      try {
        const compCount = db.prepare(`SELECT COUNT(*) as c FROM comprobantes WHERE estado = 'pendiente'`).get().c;
        const carnCount = db.prepare(`SELECT COUNT(*) as c FROM carnets WHERE estado = 'pendiente'`).get().c;
        const escCount = db.prepare(`SELECT COUNT(*) as c FROM escalaciones WHERE estado = 'pendiente'`).get().c;
        const payload = JSON.stringify({ comprobantesCount: compCount, carnetsCount: carnCount, escalacionesCount: escCount });
        res.write(`data: ${payload}\n\n`);
      } catch (e) {
        console.error('[SSE] Error enviando actualización:', e.message);
      }
    };

    // Enviar primer dato
    sendEvent();

    // Empujar eventos cada 10 segundos
    const intervalId = setInterval(sendEvent, 10000);

    // Cuando el cliente (navegador) cierra la conexión
    req.on('close', () => {
      clearInterval(intervalId);
    });
    return;
  }

  // Count liviano de comprobantes (para el badge, sin cargar imágenes) [OBSOLETO - SSE Reemplaza esto]
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

  // Count liviano de carnets pendientes (para el badge)
  if (url.pathname === '/api/carnets-count') {
    try {
      const count = db.prepare(`SELECT COUNT(*) as c FROM carnets WHERE estado = 'pendiente'`).get().c;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Panel HTML
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
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
  .panel-right-detail { flex: 0 0 auto; max-height: 50vh; overflow-y: auto; border-bottom: 2px solid #f8514944; display: none; }
  .panel-right-detail.open { display: block; }
  .panel-right-detail::-webkit-scrollbar { width: 4px; }
  .panel-right-detail::-webkit-scrollbar-track { background: #0a0e13; }
  .panel-right-detail::-webkit-scrollbar-thumb { background: #1c2733; border-radius: 3px; }
  .panel-right-chat { flex: 1; overflow-y: auto; min-height: 0; display: flex; flex-direction: column; }
  .panel-right-chat::-webkit-scrollbar { width: 6px; }
  .panel-right-chat::-webkit-scrollbar-track { background: #0a0e13; }
  .panel-right-chat::-webkit-scrollbar-thumb { background: #1c2733; border-radius: 3px; }
  .btn-toggle-detail { background: #1c2733; color: #8b949e; border: 1px solid #30363d; border-radius: 4px; padding: 4px 10px; font-size: 11px; cursor: pointer; font-family: 'Chakra Petch', sans-serif; font-weight: 600; transition: all 0.2s; }
  .btn-toggle-detail:hover { background: #222e3c; color: #e6edf3; }
  .btn-toggle-detail.active { background: #f8514922; color: #f85149; border-color: #f8514944; }
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
  .status-carnet_pendiente_plus, .status-carnet-pendiente-plus { background: #bc8cff22; color: #bc8cff; border: 1px solid #bc8cff44; }
  .status-carnet_pendiente_pro, .status-carnet-pendiente-pro { background: #f0883e22; color: #f0883e; border: 1px solid #f0883e44; }
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
  #viewClientes, #viewComprobantes, #viewCarnets, #viewPostventa, #viewDashboard, #viewEscalaciones { display: none; }
  #viewClientes.active, #viewPostventa.active { display: flex; }
  #viewComprobantes.active, #viewCarnets.active, #viewEscalaciones.active { display: flex; flex-direction: column; padding: 20px 25px; gap: 15px; overflow-y: auto; height: calc(100vh - 265px); }
  #viewDashboard.active { display: flex; flex-direction: column; padding: 20px 25px; gap: 18px; overflow-y: auto; height: calc(100vh - 265px); }
  .dash-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; }
  .dash-card { background: #111820; border: 1px solid #1c2733; border-radius: 8px; padding: 16px; text-align: center; }
  .dash-card .dash-value { font-size: 28px; font-weight: 800; color: #e6edf3; margin: 4px 0; }
  .dash-card .dash-label { font-size: 11px; color: #7d8590; text-transform: uppercase; letter-spacing: 0.5px; }
  .dash-card .dash-sub { font-size: 11px; color: #3fb950; margin-top: 4px; }
  .dash-card .dash-sub.negative { color: #f85149; }
  .dash-funnel { background: #111820; border: 1px solid #1c2733; border-radius: 8px; padding: 16px; }
  .dash-funnel h3 { margin: 0 0 12px 0; font-size: 14px; color: #e6edf3; }
  .funnel-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .funnel-label { width: 100px; font-size: 11px; color: #8b949e; text-align: right; }
  .funnel-bar-bg { flex: 1; height: 22px; background: #0d1117; border-radius: 4px; overflow: hidden; }
  .funnel-bar { height: 100%; border-radius: 4px; display: flex; align-items: center; padding-left: 8px; font-size: 11px; font-weight: 700; color: #fff; min-width: 30px; transition: width 0.5s ease; }
  .dash-section { background: #111820; border: 1px solid #1c2733; border-radius: 8px; padding: 16px; }
  .dash-section h3 { margin: 0 0 10px 0; font-size: 14px; color: #e6edf3; }
  .product-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #1c2733; font-size: 12px; }
  .product-name { color: #e6edf3; text-transform: capitalize; }
  .product-count { color: #8b949e; font-weight: 600; }
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
  .btn-omitir { background: linear-gradient(135deg, #21262d, #30363d); color: #8b949e; border: 1px solid #30363d; border-radius: 4px; padding: 8px 18px; font-size: 11px; font-weight: 600; cursor: pointer; font-family: 'Chakra Petch', sans-serif; text-transform: uppercase; letter-spacing: 1px; white-space: nowrap; }
  .btn-omitir:hover { background: linear-gradient(135deg, #30363d, #3d444d); color: #e6edf3; }
  .btn-omitir:disabled { opacity: 0.5; cursor: not-allowed; }
  .comprobante-empty { display: flex; align-items: center; justify-content: center; height: 200px; color: #3d4f5f; font-size: 15px; text-transform: uppercase; letter-spacing: 2px; font-family: 'Chakra Petch', sans-serif; }
  /* Lightbox para ver imagen completa */
  #imgLightbox { display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:#000000cc; z-index:9999; align-items:center; justify-content:center; cursor:zoom-out; }
  #imgLightbox.open { display:flex; }
  #imgLightbox img { max-width: 90%; max-height: 90%; border-radius: 6px; border: 2px solid #30363d; }
  /* Botones Toggle Bóveda Servicios */
  .btn-toggle { background: #1c2733; color: #8b949e; border: 1px solid #30363d; border-radius: 4px; padding: 6px 12px; font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 5px; font-family: 'Chakra Petch', sans-serif; transition: all 0.2s; white-space: nowrap; }
  .btn-toggle:hover { background: #222e3c; }
  .btn-toggle.on { background: #23863622; color: #3fb950; border-color: #238636; }
  /* CRM Professional Tabs */
  .crm-tabs { display: flex; border-bottom: 2px solid #1c2733; background: #0d1117; }
  .crm-tab { padding: 8px 16px; font-size: 12px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -2px; color: #586776; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; font-family: 'Chakra Petch', sans-serif; transition: all 0.15s; }
  .crm-tab.active { color: #e6edf3; border-bottom-color: #f85149; }
  .crm-tab:hover { color: #e6edf3; }
  .crm-tab-content { display: none; padding: 12px; }
  .crm-tab-content.active { display: block; }
  .crm-header-bar { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: #0d1117; border-bottom: 1px solid #1c2733; flex-wrap: wrap; }
  .crm-header-bar h3 { font-size: 16px; font-family: 'Chakra Petch', sans-serif; font-weight: 700; margin: 0; flex-shrink: 0; }
  .crm-header-bar .crm-meta { display: flex; gap: 12px; font-size: 11px; color: #586776; font-family: 'Share Tech Mono', monospace; flex-wrap: wrap; align-items: center; }
  .crm-field { display: flex; flex-direction: column; gap: 2px; }
  .crm-field label { color: #586776; font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; font-weight: 600; font-family: 'Chakra Petch', sans-serif; }
  .crm-field input, .crm-field select { background: #0d1117; border: 1px solid #1c2733; color: #e6edf3; padding: 6px 10px; border-radius: 4px; font-size: 12px; font-family: 'Rajdhani', sans-serif; box-sizing: border-box; width: 100%; }
  .crm-field input:focus, .crm-field select:focus { border-color: #f85149; outline: none; }
  .crm-field input[readonly] { color: #586776; cursor: default; }
  .crm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .crm-grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
  .crm-toggles { display: flex; gap: 8px; flex-wrap: wrap; padding: 8px 0; }
  .crm-toggle-chip { display: flex; align-items: center; gap: 4px; background: #111820; border: 1px solid #1c2733; padding: 5px 10px; border-radius: 6px; font-size: 11px; cursor: pointer; color: #8b949e; font-family: 'Chakra Petch', sans-serif; font-weight: 600; transition: all 0.15s; user-select: none; }
  .crm-toggle-chip:has(input:checked) { border-color: #3fb950; color: #3fb950; background: #23863615; }
  .crm-toggle-chip input { accent-color: #3fb950; cursor: pointer; }
  .crm-save-row { display: flex; align-items: center; gap: 10px; padding-top: 8px; border-top: 1px solid #1c2733; margin-top: 8px; }
  .crm-save-btn { background: linear-gradient(135deg, #238636, #2ea043); color: white; border: none; padding: 8px 20px; border-radius: 6px; cursor: pointer; font-size: 12px; font-family: 'Chakra Petch', sans-serif; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
  .crm-save-btn:hover { filter: brightness(1.15); }
  .crm-section-title { font-size: 11px; color: #586776; text-transform: uppercase; letter-spacing: 1.2px; font-weight: 700; font-family: 'Chakra Petch', sans-serif; padding-bottom: 6px; border-bottom: 1px solid #1c2733; margin-bottom: 8px; }
  .crm-wa-link { display: inline-flex; align-items: center; gap: 5px; color: #3fb950; font-size: 12px; text-decoration: none; padding: 4px 10px; border: 1px solid #23863644; border-radius: 4px; background: #23863611; }
  .crm-wa-link:hover { background: #23863633; }
  .crm-action-row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
  .crm-action-row select { flex: 1; background: #0d1117; border: 1px solid #1c2733; color: #e6edf3; padding: 8px 10px; border-radius: 6px; font-size: 12px; font-family: 'Chakra Petch', sans-serif; }
  .crm-action-row button { background: #1f6feb; border: none; color: white; padding: 8px 14px; border-radius: 6px; font-size: 12px; cursor: pointer; font-family: 'Chakra Petch', sans-serif; font-weight: 600; white-space: nowrap; }
  .crm-action-row button:hover { filter: brightness(1.15); }
  .crm-action-row button.green { background: #238636; }
  .crm-memory-textarea { width: 100%; background: #0d1117; border: 1px solid #1c2733; border-radius: 6px; padding: 10px; font-size: 12px; color: #8b949e; white-space: pre-wrap; min-height: 80px; max-height: 200px; resize: vertical; font-family: 'Share Tech Mono', monospace; box-sizing: border-box; }
  .crm-memory-textarea:focus { border-color: #bc8cff; outline: none; color: #e6edf3; }
  .crm-carnet-warn { display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px; background: #f8514915; border: 1px solid #f8514944; border-radius: 6px; margin: 6px 12px; font-size: 11px; color: #f85149; font-family: 'Chakra Petch', sans-serif; }
  .crm-carnet-warn .warn-icon { font-size: 14px; flex-shrink: 0; }
  .crm-carnet-warn .warn-text { line-height: 1.4; }
  .crm-carnet-warn .warn-fields { color: #d29922; font-weight: 700; }
  .crm-carnet-ok { display: flex; align-items: center; gap: 6px; padding: 6px 12px; background: #23863615; border: 1px solid #23863644; border-radius: 6px; margin: 6px 12px; font-size: 11px; color: #3fb950; font-family: 'Chakra Petch', sans-serif; }
</style>
</head>
<body>
<div class="header">
  <h1>🔫 Panel <span>Zona Traumática</span></h1>
  <div style="display:flex;align-items:center;gap:8px;">
    <span id="lastUpdate" style="color:#484f58;font-size:12px;"></span>
    <select id="headerActionSelect" style="background:#111820;border:1px solid #30363d;color:#e6edf3;padding:8px 12px;border-radius:6px;font-size:12px;cursor:pointer;font-family:'Chakra Petch',sans-serif;min-width:220px;">
      <option value="">🛠️ Herramientas...</option>
      <option value="inventario">🧠 Actualizar Inventario IA</option>
      <option value="reactivar_normal">🔥 Reactivar Calientes</option>
      <option value="reactivar_ultra">💎 Reactivar Ultra (Todo)</option>
      <option value="reatender_no_leidos">📬 Reatender Mensajes No Leídos</option>
      <option value="migrar">🔄 Migrar Asignados → Calientes</option>
      <option value="resolver_lids">🔍 Resolver LIDs</option>
    </select>
    <button onclick="ejecutarHeaderAccion()" style="background:#1f6feb;border:none;color:white;padding:8px 14px;border-radius:6px;font-size:12px;cursor:pointer;font-family:'Chakra Petch',sans-serif;font-weight:700;white-space:nowrap;">▶ Ejecutar</button>
    <button class="refresh-btn" onclick="refreshAll()">🔄 Actualizar</button>
    <button onclick="mostrarModalAgregar()" style="background:linear-gradient(135deg, #238636, #1a6b2d);color:white;border:none;padding:8px 14px;border-radius:4px;cursor:pointer;font-size:12px;font-family:'Chakra Petch',sans-serif;font-weight:700;text-transform:uppercase;letter-spacing:1px;" title="Agregar un contacto nuevo y enviar primer mensaje del bot">➕ Agregar Cliente</button>
  </div>
</div>

<div id="spamAlerts"></div>

<!-- Tabs de vista principal -->
<div class="main-tabs">
  <div class="main-tab active" id="mainTabComercial" onclick="switchMainTab('comercial')">💼 Comercial</div>
  <div class="main-tab" id="mainTabComprobantes" onclick="switchMainTab('comprobantes')">💰 Por Verificar <span class="badge" id="comprobanteBadge" style="display:none">0</span></div>
  <div class="main-tab" id="mainTabCarnets" onclick="switchMainTab('carnets')">🪪 Carnets <span class="badge" id="carnetsBadge" style="display:none">0</span></div>
  <div class="main-tab" id="mainTabPostventa" onclick="switchMainTab('postventa')">🛠️ Post-venta <span class="badge" id="postventaBadge" style="display:none">0</span></div>
  <div class="main-tab" id="mainTabEscalaciones" onclick="switchMainTab('escalaciones')">🚨 Escalaciones <span class="badge" id="escalacionesBadge" style="display:none">0</span></div>
  <div class="main-tab" id="mainTabDashboard" onclick="switchMainTab('dashboard')">📈 Dashboard</div>
  <div class="main-tab" id="mainTabBroadcast" onclick="switchMainTab('broadcast')" style="color:#c084fc;">📢 Broadcast</div>
</div>

<!-- Vista: Dashboard KPIs -->
<div id="viewDashboard" class="container">
  <div id="dashboardContent" style="width:100%;"><div class="chat-empty">Cargando dashboard...</div></div>
</div>

<!-- Vista: Broadcast -->
<div id="viewBroadcast" class="container" style="display:none;background:#010409;overflow-y:auto;">
  <div id="broadcastContent" style="max-width:900px;margin:0 auto;padding:20px;">
    <div class="chat-empty">Cargando broadcast...</div>
  </div>
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
      <div class="tab" id="scoreSortBtn" onclick="toggleScoreSort()" style="margin-left:auto;cursor:pointer;font-size:11px;">🎯 Score</div>
    </div>
    <div class="panel-body" id="clientList"></div>
  </div>
  <div class="panel panel-right">
    <div class="panel-header">
      <span id="chatTitle">💬 Selecciona un cliente</span>
      <button class="btn-toggle-detail" id="btnToggleDetail" onclick="toggleDetailPanel()" style="display:none;">📋 Info</button>
    </div>
    <div class="panel-right-detail" id="clientDetail"></div>
    <div class="panel-right-chat" id="chatArea"><div class="chat-empty">Selecciona un cliente para ver su conversación</div></div>
  </div>
</div>

<!-- Vista: Comprobantes por verificar -->
<div id="viewComprobantes">
  <div id="comprobantesList"></div>
</div>

<!-- Vista: Carnets por verificar -->
<div id="viewCarnets">
  <div id="carnetsList"></div>
</div>

<!-- Vista: Escalaciones pendientes -->
<div id="viewEscalaciones">
  <div id="escalacionesList"></div>
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
      <div class="tab" data-pvfilter="carnet_pendiente_plus" onclick="setPvFilter('carnet_pendiente_plus',this)">🟢 Carnet Plus</div>
      <div class="tab" data-pvfilter="carnet_pendiente_pro" onclick="setPvFilter('carnet_pendiente_pro',this)">🔴 Carnet Pro</div>
      <div class="tab" data-pvfilter="despacho_pendiente" onclick="setPvFilter('despacho_pendiente',this)">📦 Dispositivo</div>
      <div class="tab" data-pvfilter="municion_pendiente" onclick="setPvFilter('municion_pendiente',this)">🔫 Munición</div>
      <div class="tab" data-pvfilter="recuperacion_pendiente" onclick="setPvFilter('recuperacion_pendiente',this)">🔧 Recuperación</div>
      <div class="tab" data-pvfilter="bot_asesor_pendiente" onclick="setPvFilter('bot_asesor_pendiente',this)">🤖 Bot Asesor</div>
    </div>
    <div class="panel-body" id="postventaList"></div>
  </div>
  <div class="panel panel-right">
    <div class="panel-header">
      <span id="chatTitlePv">💬 Selecciona un cliente</span>
      <button class="btn-toggle-detail" id="btnToggleDetailPv" onclick="toggleDetailPanelPv()" style="display:none;">📋 Info</button>
    </div>
    <div class="panel-right-detail" id="clientDetailPv"></div>
    <div class="panel-right-chat" id="chatAreaPv"><div class="chat-empty">Selecciona un cliente para ver su conversación</div></div>
  </div>
</div>

<!-- Lightbox imagen -->
<div id="imgLightbox" onclick="closeLightbox()"><img id="imgLightboxImg" src="" alt="comprobante"></div>

<!-- Modal Agregar Cliente -->
<div id="modalAgregar" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:9999;display:none;align-items:center;justify-content:center;">
  <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:25px;width:420px;max-width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.5);">
    <h3 style="margin:0 0 15px;color:#e6edf3;font-family:'Chakra Petch',sans-serif;font-size:18px;">➕ Agregar Cliente Nuevo</h3>
    <p style="color:#8b949e;font-size:12px;margin:0 0 15px;">El bot le enviará un primer mensaje personalizado por WhatsApp.</p>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <input id="agregarPhone" type="text" placeholder="Número (ej: 3001234567)" style="background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:10px 14px;border-radius:6px;font-size:14px;font-family:'Rajdhani',sans-serif;">
      <input id="agregarName" type="text" placeholder="Nombre (opcional)" style="background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:10px 14px;border-radius:6px;font-size:14px;font-family:'Rajdhani',sans-serif;">
      <textarea id="agregarContexto" placeholder="Contexto (ej: le interesa Club Plus, quiere ver armas compactas...)" style="background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:10px 14px;border-radius:6px;font-size:13px;font-family:'Rajdhani',sans-serif;resize:none;height:60px;"></textarea>
      <div style="display:flex;gap:10px;margin-top:5px;">
        <button id="btnAgregarEnviar" onclick="agregarCliente()" style="flex:1;background:#238636;color:white;border:none;padding:10px;border-radius:6px;cursor:pointer;font-size:13px;font-family:'Chakra Petch',sans-serif;font-weight:700;">📨 Agregar y Enviar Mensaje</button>
        <button onclick="cerrarModalAgregar()" style="background:#21262d;color:#8b949e;border:1px solid #30363d;padding:10px 16px;border-radius:6px;cursor:pointer;font-size:13px;font-family:'Chakra Petch',sans-serif;">Cancelar</button>
      </div>
      <div id="agregarFeedback" style="font-size:12px;color:#3fb950;min-height:18px;"></div>
    </div>
  </div>
</div>

<!-- Modal Enviar Carnet -->
<div id="modalCarnet" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.75);z-index:9999;align-items:center;justify-content:center;">
  <div style="background:#161b22;border:1px solid #30363d;border-radius:10px;padding:25px;width:500px;max-width:95%;max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.6);">
    <h3 style="margin:0 0 5px;color:#e6edf3;font-family:'Chakra Petch',sans-serif;font-size:18px;">🪪 Enviar Carnet por WhatsApp</h3>
    <p id="carnetModalPhone" style="color:#8b949e;font-size:12px;margin:0 0 15px;"></p>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <!-- Upload imagen -->
      <div style="background:#0d1117;border:2px dashed #30363d;border-radius:8px;padding:20px;text-align:center;cursor:pointer;transition:border-color .2s;" onclick="document.getElementById('carnetFileInput').click()" id="carnetDropZone">
        <input type="file" id="carnetFileInput" accept="image/*" style="display:none;" onchange="previewCarnetImage(this)">
        <div id="carnetPreview" style="display:none;margin-bottom:10px;"><img id="carnetPreviewImg" style="max-width:100%;max-height:200px;border-radius:6px;border:1px solid #30363d;"></div>
        <div id="carnetUploadText" style="color:#8b949e;font-size:13px;">📸 Click para seleccionar la imagen del carnet<br><span style="font-size:11px;color:#484f58;">JPG, PNG — máx 10MB</span></div>
      </div>
      <button id="btnExtraerDatos" onclick="extraerDatosCarnet()" style="display:none;width:100%;background:linear-gradient(135deg,#1f6feb,#388bfd);color:white;border:none;padding:10px;border-radius:6px;cursor:pointer;font-size:13px;font-family:'Chakra Petch',sans-serif;font-weight:700;">🔍 Extraer datos del carnet con IA</button>
      <div id="extractFeedback" style="font-size:12px;min-height:14px;text-align:center;"></div>
      <!-- Plan -->
      <div style="display:flex;gap:10px;">
        <div style="flex:1;">
          <label style="color:#8b949e;font-size:11px;font-weight:bold;">📋 Plan</label>
          <select id="carnetPlan" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:8px;border-radius:6px;font-size:13px;margin-top:4px;">
            <option value="Plan Plus">🟡 Plan Plus ($100k)</option>
            <option value="Plan Pro">🔴 Plan Pro ($150k)</option>
          </select>
        </div>
        <div style="flex:1;">
          <label style="color:#8b949e;font-size:11px;font-weight:bold;">📅 Vigente hasta</label>
          <input type="date" id="carnetVigencia" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:8px;border-radius:6px;font-size:13px;margin-top:4px;box-sizing:border-box;">
        </div>
      </div>
      <!-- Datos del titular -->
      <div style="display:flex;gap:10px;">
        <div style="flex:1;">
          <label style="color:#8b949e;font-size:11px;">Nombre completo</label>
          <input id="carnetNombre" type="text" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:8px;border-radius:6px;font-size:13px;margin-top:4px;box-sizing:border-box;">
        </div>
        <div style="flex:1;">
          <label style="color:#8b949e;font-size:11px;">Cédula</label>
          <input id="carnetCedula" type="text" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:8px;border-radius:6px;font-size:13px;margin-top:4px;box-sizing:border-box;">
        </div>
      </div>
      <!-- Datos del arma -->
      <div style="display:flex;gap:10px;">
        <div style="flex:1;">
          <label style="color:#8b949e;font-size:11px;">Marca arma</label>
          <input id="carnetMarcaArma" type="text" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:8px;border-radius:6px;font-size:13px;margin-top:4px;box-sizing:border-box;">
        </div>
        <div style="flex:1;">
          <label style="color:#8b949e;font-size:11px;">Modelo arma</label>
          <input id="carnetModeloArma" type="text" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:8px;border-radius:6px;font-size:13px;margin-top:4px;box-sizing:border-box;">
        </div>
      </div>
      <div>
        <label style="color:#8b949e;font-size:11px;">Serial del arma</label>
        <input id="carnetSerial" type="text" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:8px;border-radius:6px;font-size:13px;margin-top:4px;box-sizing:border-box;">
      </div>
      <!-- Caption personalizable -->
      <div>
        <label style="color:#8b949e;font-size:11px;">📝 Caption (mensaje que acompaña el carnet)</label>
        <textarea id="carnetCaption" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:8px;border-radius:6px;font-size:12px;margin-top:4px;resize:none;height:50px;box-sizing:border-box;" placeholder="Dejar vacío para caption automático"></textarea>
      </div>
      <!-- Botones -->
      <div style="display:flex;gap:10px;margin-top:5px;">
        <button id="btnEnviarCarnet" onclick="enviarCarnetWhatsApp()" style="flex:1;background:linear-gradient(135deg, #238636, #2ea043);color:white;border:none;padding:12px;border-radius:6px;cursor:pointer;font-size:14px;font-family:'Chakra Petch',sans-serif;font-weight:700;">📨 Enviar Carnet por WhatsApp</button>
        <button onclick="cerrarModalCarnet()" style="background:#21262d;color:#8b949e;border:1px solid #30363d;padding:12px 18px;border-radius:6px;cursor:pointer;font-size:13px;font-family:'Chakra Petch',sans-serif;">Cancelar</button>
      </div>
      <div id="carnetFeedback" style="font-size:12px;min-height:18px;text-align:center;"></div>
    </div>
  </div>
</div>

<!-- Modal Enviar Factura -->
<div id="modalFactura" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.75);z-index:9999;align-items:center;justify-content:center;">
  <div style="background:#161b22;border:1px solid #30363d;border-radius:10px;padding:25px;width:480px;max-width:95%;max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.6);">
    <h3 style="margin:0 0 5px;color:#e6edf3;font-family:'Chakra Petch',sans-serif;font-size:18px;">🧾 Enviar Factura por WhatsApp</h3>
    <p id="facturaModalPhone" style="color:#8b949e;font-size:12px;margin:0 0 15px;"></p>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <!-- Upload imagen factura -->
      <div style="background:#0d1117;border:2px dashed #30363d;border-radius:8px;padding:20px;text-align:center;cursor:pointer;transition:border-color .2s;" onclick="document.getElementById('facturaFileInput').click()" id="facturaDropZone">
        <input type="file" id="facturaFileInput" accept="image/*" style="display:none;" onchange="previewFacturaImage(this)">
        <div id="facturaPreview" style="display:none;margin-bottom:10px;"><img id="facturaPreviewImg" style="max-width:100%;max-height:200px;border-radius:6px;border:1px solid #30363d;"></div>
        <div id="facturaUploadText" style="color:#8b949e;font-size:13px;">📸 Click para adjuntar foto/captura de la factura<br><span style="font-size:11px;color:#484f58;">JPG, PNG — máx 10MB</span></div>
      </div>
      <!-- Valor (Opcional) -->
      <div>
        <label style="color:#8b949e;font-size:11px;font-weight:bold;">💰 Valor de la factura</label>
        <input type="text" id="facturaValor" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:8px;border-radius:6px;font-size:13px;margin-top:4px;box-sizing:border-box;" placeholder="Ej: $150.000">
      </div>
      <!-- Caption personalizable -->
      <div>
        <label style="color:#8b949e;font-size:11px;">📝 Caption (mensaje que acompaña la factura)</label>
        <textarea id="facturaCaption" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:8px;border-radius:6px;font-size:12px;margin-top:4px;resize:none;height:50px;box-sizing:border-box;" placeholder="Dejar vacío para caption automático"></textarea>
      </div>
      <!-- Botones -->
      <div style="display:flex;gap:10px;margin-top:5px;">
        <button id="btnEnviarFactura" onclick="enviarFacturaWhatsApp()" style="flex:1;background:linear-gradient(135deg, #1f6feb, #388bfd);color:white;border:none;padding:12px;border-radius:6px;cursor:pointer;font-size:14px;font-family:'Chakra Petch',sans-serif;font-weight:700;">📨 Enviar Factura por WhatsApp</button>
        <button onclick="cerrarModalFactura()" style="background:#21262d;color:#8b949e;border:1px solid #30363d;padding:12px 18px;border-radius:6px;cursor:pointer;font-size:13px;font-family:'Chakra Petch',sans-serif;">Cancelar</button>
      </div>
      <div id="facturaFeedback" style="font-size:12px;min-height:18px;text-align:center;"></div>
    </div>
  </div>
</div>

<!-- Modal Enviar Guía de Envío -->
<div id="modalGuia" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.75);z-index:9999;align-items:center;justify-content:center;">
  <div style="background:#161b22;border:1px solid #30363d;border-radius:10px;padding:25px;width:480px;max-width:95%;max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.6);">
    <h3 style="margin:0 0 5px;color:#e6edf3;font-family:'Chakra Petch',sans-serif;font-size:18px;">📦 Enviar Guía de Envío por WhatsApp</h3>
    <p id="guiaModalPhone" style="color:#8b949e;font-size:12px;margin:0 0 15px;"></p>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <!-- Upload imagen guía -->
      <div style="background:#0d1117;border:2px dashed #30363d;border-radius:8px;padding:20px;text-align:center;cursor:pointer;transition:border-color .2s;" onclick="document.getElementById('guiaFileInput').click()" id="guiaDropZone">
        <input type="file" id="guiaFileInput" accept="image/*" style="display:none;" onchange="previewGuiaImage(this)">
        <div id="guiaPreview" style="display:none;margin-bottom:10px;"><img id="guiaPreviewImg" style="max-width:100%;max-height:200px;border-radius:6px;border:1px solid #30363d;"></div>
        <div id="guiaUploadText" style="color:#8b949e;font-size:13px;">📸 Click para adjuntar foto/captura de la guía<br><span style="font-size:11px;color:#484f58;">JPG, PNG — máx 10MB (opcional)</span></div>
      </div>
      <!-- Transportadora -->
      <div style="display:flex;gap:10px;">
        <div style="flex:1;">
          <label style="color:#8b949e;font-size:11px;font-weight:bold;">🚚 Transportadora</label>
          <select id="guiaTransportadora" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:8px;border-radius:6px;font-size:13px;margin-top:4px;">
            <option value="Servientrega">Servientrega</option>
            <option value="Interrapidísimo">Interrapidísimo</option>
            <option value="Coordinadora">Coordinadora</option>
            <option value="Envía">Envía</option>
            <option value="TCC">TCC</option>
            <option value="Deprisa">Deprisa</option>
            <option value="otra">Otra...</option>
          </select>
        </div>
        <div style="flex:1;">
          <label style="color:#8b949e;font-size:11px;font-weight:bold;">📋 Número de guía</label>
          <input id="guiaNumero" type="text" placeholder="Ej: 123456789" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:8px;border-radius:6px;font-size:13px;margin-top:4px;box-sizing:border-box;">
        </div>
      </div>
      <!-- Producto enviado -->
      <div>
        <label style="color:#8b949e;font-size:11px;">📦 Producto(s) enviado(s)</label>
        <input id="guiaProducto" type="text" placeholder="Ej: Retay S22 negra + 50 municiones" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:8px;border-radius:6px;font-size:13px;margin-top:4px;box-sizing:border-box;">
      </div>
      <!-- Caption personalizable -->
      <div>
        <label style="color:#8b949e;font-size:11px;">📝 Mensaje personalizado (opcional)</label>
        <textarea id="guiaCaption" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:8px;border-radius:6px;font-size:12px;margin-top:4px;resize:none;height:50px;box-sizing:border-box;" placeholder="Dejar vacío para mensaje automático"></textarea>
      </div>
      <!-- Botones -->
      <div style="display:flex;gap:10px;margin-top:5px;">
        <button id="btnEnviarGuia" onclick="enviarGuiaWhatsApp()" style="flex:1;background:linear-gradient(135deg, #1f6feb, #388bfd);color:white;border:none;padding:12px;border-radius:6px;cursor:pointer;font-size:14px;font-family:'Chakra Petch',sans-serif;font-weight:700;">📨 Enviar Guía por WhatsApp</button>
        <button onclick="cerrarModalGuia()" style="background:#21262d;color:#8b949e;border:1px solid #30363d;padding:12px 18px;border-radius:6px;cursor:pointer;font-size:13px;font-family:'Chakra Petch',sans-serif;">Cancelar</button>
      </div>
      <div id="guiaFeedback" style="font-size:12px;min-height:18px;text-align:center;"></div>
    </div>
  </div>
</div>

<script>
let allData = null;
let currentFilter = 'all';
let selectedPhone = null;
let sortByScore = false;

function toggleScoreSort() {
  sortByScore = !sortByScore;
  const btn = document.getElementById('scoreSortBtn');
  if (btn) btn.textContent = sortByScore ? '🎯 Score ▼' : '🎯 Score';
  renderClients();
}

function mostrarModalAgregar() {
  const modal = document.getElementById('modalAgregar');
  modal.style.display = 'flex';
  document.getElementById('agregarPhone').value = '';
  document.getElementById('agregarName').value = '';
  document.getElementById('agregarContexto').value = '';
  document.getElementById('agregarFeedback').textContent = '';
  document.getElementById('btnAgregarEnviar').disabled = false;
  document.getElementById('btnAgregarEnviar').textContent = '📨 Agregar y Enviar Mensaje';
  setTimeout(() => document.getElementById('agregarPhone').focus(), 100);
}

function cerrarModalAgregar() {
  document.getElementById('modalAgregar').style.display = 'none';
}

async function agregarCliente() {
  const phone = document.getElementById('agregarPhone').value.trim();
  const name = document.getElementById('agregarName').value.trim();
  const contexto = document.getElementById('agregarContexto').value.trim();
  const fb = document.getElementById('agregarFeedback');
  const btn = document.getElementById('btnAgregarEnviar');

  if (!phone || phone.length < 7) {
    fb.style.color = '#f85149';
    fb.textContent = '❌ Ingresa un número válido (mínimo 7 dígitos)';
    return;
  }

  btn.disabled = true;
  btn.textContent = '⏳ Enviando...';
  fb.style.color = '#d29922';
  fb.textContent = 'Registrando cliente y generando mensaje con IA...';

  try {
    const res = await fetch('/api/agregar-cliente', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, name, contexto })
    });
    const data = await res.json();
    if (data.ok) {
      fb.style.color = '#3fb950';
      fb.textContent = '\u2705 ' + (data.message || 'Cliente agregado y mensaje enviado');
      btn.textContent = '\u2705 Enviado';
      // Refrescar datos del panel
      await loadData();
      renderClients();
      // Cerrar modal después de 2s
      setTimeout(() => cerrarModalAgregar(), 2500);
    } else {
      fb.style.color = '#f85149';
      fb.textContent = '\u274c ' + (data.message || data.error || data.msg || 'Error desconocido');
      btn.disabled = false;
      btn.textContent = '\ud83d\udce8 Agregar y Enviar Mensaje';
    }
  } catch(e) {
    fb.style.color = '#f85149';
    fb.textContent = '\u274c No se pudo conectar con el servidor';
    btn.disabled = false;
    btn.textContent = '\ud83d\udce8 Agregar y Enviar Mensaje';
  }
}

async function reactivarCalientes(mode = 'normal') {
  // El botón "Ejecutar" del header es el que dispara esta acción desde el dropdown
  const btn = document.querySelector('#headerActionSelect')?.closest('div')?.querySelector('button');
  const orgText = btn ? btn.textContent : '';
  const orgBg = btn ? btn.style.background : '';
  
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Procesando...';
  }
  try {
    const res = await fetch('/api/reactivar-calientes', { 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
    const data = await res.json();
    if (data.ok) {
      if (btn) {
        btn.textContent = '✅ ' + data.msg;
        btn.style.background = '#238636';
        setTimeout(() => {
          btn.textContent = orgText;
          btn.style.background = orgBg;
          btn.disabled = false;
        }, 5000);
      }
      alert('✅ ' + data.msg);
    } else {
      alert('⚠️ ' + (data.msg || data.error || 'Error desconocido'));
      if (btn) { btn.textContent = orgText; btn.disabled = false; }
    }
  } catch (e) {
    alert('❌ Error conectando con el servidor');
    if (btn) { btn.textContent = orgText; btn.disabled = false; }
  }
}

async function reactivarIndividual(phone, btnElement, mode = 'normal') {
  const oldText = btnElement.innerHTML;
  btnElement.innerHTML = '⏳ Reactivando...';
  btnElement.style.pointerEvents = 'none';
  
  try {
    const res = await fetch('/api/reactivar-individual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, mode })
    });
    const data = await res.json();
    if (data.ok) {
      btnElement.innerHTML = '✅ Reactivado IA';
      btnElement.style.background = '#2ea043';
      btnElement.style.borderColor = '#3fb950';
      btnElement.style.color = '#fff';
    } else {
      alert('⚠️ ' + (data.msg || data.error || 'Error'));
      btnElement.innerHTML = oldText;
      btnElement.style.pointerEvents = 'auto';
    }
  } catch (e) {
    alert('❌ Error conectando con el servidor');
    btnElement.innerHTML = oldText;
    btnElement.style.pointerEvents = 'auto';
  }
}

async function reatenderCliente(phone, btnElement) {
  const oldText = btnElement.innerHTML;
  btnElement.innerHTML = '⏳ Procesando...';
  btnElement.style.pointerEvents = 'none';

  try {
    const res = await fetch('/api/reatender', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      btnElement.innerHTML = '✅ Reatendido';
      btnElement.style.background = '#2ea043';
      btnElement.style.borderColor = '#3fb950';
      btnElement.style.color = '#fff';
    } else {
      alert('⚠️ ' + (data.message || data.error || 'Error'));
      btnElement.innerHTML = oldText;
      btnElement.style.pointerEvents = 'auto';
    }
  } catch (e) {
    alert('❌ Error conectando con el servidor');
    btnElement.innerHTML = oldText;
    btnElement.style.pointerEvents = 'auto';
  }
}

// Dispatcher para dropdown de herramientas del header
function ejecutarHeaderAccion() {
  const sel = document.getElementById('headerActionSelect');
  if (!sel.value) return;
  switch(sel.value) {
    case 'inventario': actualizarInventario(); break;
    case 'reactivar_normal': reactivarCalientes('normal'); break;
    case 'reactivar_ultra': reactivarCalientes('ultra'); break;
    case 'reatender_no_leidos': reatenderNoLeidos(); break;
    case 'migrar': migrarAssigned(); break;
    case 'resolver_lids': resolverLids(); break;
  }
  sel.selectedIndex = 0;
}

async function actualizarInventario() {
  const btn = document.getElementById('btnUpdateInventory');
  const confirmacion = confirm("¿Estás seguro de querer actualizar el inventario con IA basándose en la imagen maestra? Esto podría tomar unos 30 segundos.");
  if (!confirmacion) return;

  if (btn) { btn.disabled = true; btn.textContent = '🧠 Procesando IA... (Unos 30s)'; }
  try {
    const res = await fetch('/api/update-inventory', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      alert('✅ ' + data.msg);
      if (btn) { btn.textContent = '✅ Completado'; btn.style.background = '#238636'; setTimeout(() => { btn.textContent = '🧠 Actualizar Inventario IA'; btn.style.background = 'linear-gradient(135deg, #8a2be2, #4b0082)'; btn.disabled = false; }, 5000); }
    } else {
      alert('⚠️ ' + (data.error || 'Error desconocido'));
      if (btn) { btn.textContent = '🧠 Actualizar Inventario IA'; btn.disabled = false; }
    }
  } catch (e) {
    alert('❌ Error conectando con el servidor para actualizar inventario');
    if (btn) { btn.textContent = '🧠 Actualizar Inventario IA'; btn.disabled = false; }
  }
}

async function resolverLids() {
  try {
    const res = await fetch('/api/resolver-lids', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      if (data.total === 0) {
        alert('✅ Sin LIDs pendientes');
      } else {
        alert('⏳ Procesando ' + data.total + ' LIDs en background... la data se recargará automáticamente.');
        setTimeout(() => loadData(), Math.min(data.total * 1200, 30000));
      }
    } else {
      alert('⚠️ ' + (data.msg || data.error || 'Error'));
    }
  } catch (e) {
    alert('❌ Error conectando con el servidor');
  }
}

async function reatenderNoLeidos() {
  const confirmacion = confirm('📬 ¿Reatender todos los clientes con mensajes no leídos?\\n\\nEl bot responderá automáticamente a los chats pendientes (ignorando los que estés atendiendo manualmente).');
  if (!confirmacion) return;

  try {
    const res = await fetch('/api/reatender-no-leidos', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      alert('✅ Procesando ' + data.total + ' chats en background. El bot responderá a cada uno con delay anti-ban. Ver consola.');
    } else {
      alert('⚠️ ' + (data.msg || data.error || 'No hay chats con mensajes sin leer'));
    }
  } catch (e) {
    alert('❌ Error conectando con el servidor');
  }
}

// Auto-resolver LIDs silenciosamente — se ejecuta después de cada loadData
let _autoLidRunning = false;
let _autoLidLastRun = 0;
const _AUTO_LID_COOLDOWN = 5 * 60 * 1000; // 5 minutos de cooldown si no resolvió nada
async function autoResolverLids() {
  if (_autoLidRunning) return;
  // Cooldown: no repetir si ya corrió recientemente sin éxito
  if (Date.now() - _autoLidLastRun < _AUTO_LID_COOLDOWN) return;
  _autoLidRunning = true;
  try {
    const res = await fetch('/api/resolver-lids', { method: 'POST' });
    const data = await res.json();
    _autoLidLastRun = Date.now();
    if (data.ok && data.total > 0) {
      console.log('[AUTO-LID] ⏳ Procesando ' + data.total + ' en background...');
      setTimeout(() => { _autoLidRunning = false; loadData(); }, Math.min(data.total * 1200, 30000));
      return;
    }
    // total === 0 → cooldown se activa, no vuelve a intentar por 5 min
  } catch(e) { console.error('[AUTO-LID] Error:', e.message); }
  _autoLidRunning = false;
}

async function loadData() {
  const res = await fetch('/api/data');
  allData = await res.json();
  renderStats();
  renderSpamAlerts();
  renderClients();
  document.getElementById('lastUpdate').textContent = 'Actualizado: ' + new Date().toLocaleTimeString();
  // Auto-resolver LIDs si hay pendientes
  autoResolverLids();
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
  // Stats container removed — no-op
}

function renderClients() {
  const PV_ST = ['postventa', 'carnet_pendiente_plus', 'carnet_pendiente_pro', 'despacho_pendiente', 'municion_pendiente', 'recuperacion_pendiente', 'bot_asesor_pendiente'];
  const rawSearch = document.getElementById('searchInput').value.toLowerCase().trim();
  const searchDigits = rawSearch.replace(/[^0-9]/g, '');
  const search = rawSearch;

  // Si no hay búsqueda de texto, ocultamos post-venta, pero si el asesor busca a alguien, lo debe encontrar sin importar el estado.
  let clients = allData.clients;
  if (!search) {
    clients = clients.filter(c => !PV_ST.includes(c.status));
  }

  if (currentFilter === 'new') clients = clients.filter(c => c.status === 'new');
  else if (currentFilter === 'hot') clients = clients.filter(c => (c.lead_score || 0) >= 60);

  if (search) {
    clients = clients.filter(c =>
      (c.name||'').toLowerCase().includes(search) ||
      (searchDigits && c.phone.includes(searchDigits)) ||
      (c.memory||'').toLowerCase().includes(search)
    );
  }

  // Ordenar por lead score si está activado
  if (sortByScore) {
    clients = [...clients].sort((a, b) => (b.lead_score || 0) - (a.lead_score || 0));
  }

  document.getElementById('clientCount').textContent = clients.length;

  const html = clients.map(c => {
    const isHot = (c.lead_score || 0) >= 60;
    const displayName = c.name || (isLid(c.phone) ? 'Sin nombre' : formatPhone(c.phone));
    const initial = (c.name || c.phone).charAt(0).toUpperCase();
    const score = c.lead_score || 0;
    const scoreEmoji = score >= 60 ? '🔥' : score >= 30 ? '⭐' : '';
    const scoreColor = score >= 60 ? '#f85149' : score >= 30 ? '#d29922' : '#8b949e';
    const scoreBadge = score > 0 ? '<span style="margin-left:6px;font-size:11px;color:' + scoreColor + ';font-weight:600;">' + scoreEmoji + score + 'pts</span>' : '';
    return \`<div class="client-row \${selectedPhone === c.phone ? 'active' : ''}" onclick="selectClient('\${c.phone}')">
      <div class="client-avatar">\${initial}</div>
      <div class="client-info">
        <div class="client-name">\${c.name || 'Sin nombre'}\${isHot ? '<span class="hot-badge">🔥 HOT</span>' : ''}\${scoreBadge}</div>
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

async function selectClient(phone, isAutoRefresh = false) {
  selectedPhone = phone;
  renderClients();

  const client = allData.clients.find(c => c.phone === phone);
  const assignment = allData.assignments.find(a => a.client_phone === phone && a.status === 'active');

  document.getElementById('chatTitle').textContent = '💬 ' + (client.name || phone);

  if (!isAutoRefresh) {
    // Show toggle button & open detail panel
    const toggleBtn = document.getElementById('btnToggleDetail');
    toggleBtn.style.display = 'inline-block';
    const detailEl = document.getElementById('clientDetail');
    detailEl.classList.add('open');
    toggleBtn.classList.add('active');
    toggleBtn.textContent = 'Ocultar Info';
  }

  if (!isAutoRefresh) {
    document.getElementById('clientDetail').innerHTML = \`
      <!-- CRM HEADER BAR -->
      <div class="crm-header-bar" id="comHeaderBar">
        <h3>\${client.name || 'Sin nombre'} 
          <select class="client-status status-\${client.status}" onchange="changeStatus('\${client.phone}', this.value)" style="background:none; color:inherit; border:none; outline:none; cursor:pointer; font-weight:inherit; font-family:inherit; font-size:inherit; padding:0 4px; appearance:auto;">
            <option value="new" \${client.status==='new'?'selected':''} style="color:black;">new</option>
            <option value="hot" \${client.status==='hot'?'selected':''} style="color:black;">hot</option>
            <option value="warm" \${client.status==='warm'?'selected':''} style="color:black;">warm</option>
            <option value="completed" \${client.status==='completed'?'selected':''} style="color:black;">completed</option>
            <option value="postventa" \${client.status==='postventa'?'selected':''} style="color:black;">postventa</option>
            <option value="carnet_pendiente_plus" \${client.status==='carnet_pendiente_plus'?'selected':''} style="color:black;">🟢 Carnet Plus</option>
            <option value="carnet_pendiente_pro" \${client.status==='carnet_pendiente_pro'?'selected':''} style="color:black;">🔴 Carnet Pro</option>
            <option value="despacho_pendiente" \${client.status==='despacho_pendiente'?'selected':''} style="color:black;">📦 Dispositivo</option>
            <option value="municion_pendiente" \${client.status==='municion_pendiente'?'selected':''} style="color:black;">🔫 Munición</option>
            <option value="recuperacion_pendiente" \${client.status==='recuperacion_pendiente'?'selected':''} style="color:black;">🔧 Recuperación</option>
            <option value="bot_asesor_pendiente" \${client.status==='bot_asesor_pendiente'?'selected':''} style="color:black;">🤖 Bot Asesor</option>
          </select>
        </h3>
        <div class="crm-meta">
          <span>\${isLid(client.phone) ? '🔒 ' + client.phone : '📱 ' + client.phone}</span>
          <span id="comMsgCount">💬 \${client.interaction_count || 0} msgs</span>
          <span>📅 \${new Date(client.created_at).toLocaleDateString()}</span>
        \${assignment ? '<span>👔 ' + assignment.employee_name + '</span>' : ''}
      </div>
      <div style="margin-left:auto;display:flex;gap:6px;">
        \${waLink(client.phone)}
      </div>
    </div>

    <!-- CARNET DATA COMPLETENESS CHECK -->
    \${(function() {
      const missing = [];
      if (!client.name || client.name.trim().length < 3) missing.push('Nombre completo');
      if (!client.cedula) missing.push('Cédula');
      if (!client.modelo_arma) missing.push('Modelo arma');
      if (!client.marca_arma) missing.push('Marca arma');
      if (!client.serial_arma) missing.push('Serial arma');
      if (!client.club_plan) missing.push('Plan Club');
      if (missing.length === 0) {
        return '<div class="crm-carnet-ok">✅ Datos completos para carnet</div>';
      }
      return '<div class="crm-carnet-warn"><span class="warn-icon">⚠️</span><div class="warn-text">Faltan datos para generar carnet: <span class="warn-fields">' + missing.join(' · ') + '</span></div></div>';
    })()}

    <!-- CRM TABS -->
    <div class="crm-tabs">
      <div class="crm-tab active" onclick="switchCrmTab('\${client.phone}','perfil',this)">📋 Perfil</div>
      <div class="crm-tab" onclick="switchCrmTab('\${client.phone}','notas',this)">🧠 Notas</div>
      <div class="crm-tab" onclick="switchCrmTab('\${client.phone}','acciones',this)">⚡ Acciones</div>
    </div>

    <!-- TAB: PERFIL -->
    <div class="crm-tab-content active" id="crmTab_perfil_\${client.phone}">
      <div class="crm-section-title">Servicios Adquiridos</div>
      <div class="crm-toggles">
        <label class="crm-toggle-chip"><input type="checkbox" \${client.has_bought_gun ? 'checked' : ''} onchange="toggleFlag('\${client.phone}','has_bought_gun',\${client.has_bought_gun||0})"> 🔫 Compró Arma</label>
        <label class="crm-toggle-chip"><input type="checkbox" \${client.is_club_plus ? 'checked' : ''} onchange="toggleFlag('\${client.phone}','is_club_plus',\${client.is_club_plus||0})" style="accent-color:#d29922;"> 🟡 Club Plus</label>
        <label class="crm-toggle-chip"><input type="checkbox" \${client.is_club_pro ? 'checked' : ''} onchange="toggleFlag('\${client.phone}','is_club_pro',\${client.is_club_pro||0})" style="accent-color:#f85149;"> 🔴 Club Pro</label>
        <label class="crm-toggle-chip"><input type="checkbox" \${client.has_ai_bot ? 'checked' : ''} onchange="toggleFlag('\${client.phone}','has_ai_bot',\${client.has_ai_bot||0})" style="accent-color:#1f6feb;"> 🤖 Bot IA</label>
      </div>

      <div class="crm-section-title">Datos Personales</div>
      <div class="crm-grid">
        <div class="crm-field"><label>Nombre</label><input id="prof_name_\${client.phone}" type="text" value="\${client.name || ''}"></div>
        <div class="crm-field"><label>Cédula</label><input id="prof_cedula_\${client.phone}" type="text" value="\${client.cedula || ''}"></div>
        <div class="crm-field"><label>Ciudad</label><input id="prof_ciudad_\${client.phone}" type="text" value="\${client.ciudad || ''}"></div>
        <div class="crm-field"><label>Dirección</label><input id="prof_direccion_\${client.phone}" type="text" value="\${client.direccion || ''}"></div>
        <div class="crm-field"><label>Profesión</label><input id="prof_profesion_\${client.phone}" type="text" value="\${client.profesion || ''}"></div>
        <div class="crm-field"><label>Status</label>
          <select onchange="cambiarStatusCRM('\${client.phone}',this.value)" style="background:#0d1117;border:1px solid #1c2733;color:#e6edf3;padding:6px 10px;border-radius:4px;font-size:12px;">
            <option value="new" \${client.status==='new'?'selected':''}>New</option>
            <option value="hot" \${client.status==='hot'?'selected':''}>🔥 Hot</option>
            <option value="warm" \${client.status==='warm'?'selected':''}>Warm</option>
            <option value="completed" \${client.status==='completed'?'selected':''}>✅ Completed</option>
          </select>
        </div>
      </div>

      <div class="crm-section-title" style="margin-top:10px;">Armamento & Club</div>
      <div class="crm-grid">
        <div class="crm-field"><label>Plan Club</label>
          <select id="prof_club_plan_\${client.phone}">
            <option value="" \${!client.club_plan ? 'selected' : ''}>— Ninguno —</option>
            <option value="Plan Plus" \${client.club_plan === 'Plan Plus' ? 'selected' : ''}>🟡 Plan Plus</option>
            <option value="Plan Pro" \${client.club_plan === 'Plan Pro' ? 'selected' : ''}>🔴 Plan Pro</option>
          </select>
        </div>
        <div class="crm-field"><label>Vigente hasta</label><input id="prof_club_vigente_hasta_\${client.phone}" type="date" value="\${client.club_vigente_hasta || ''}"></div>
        <div class="crm-field"><label>Modelo Arma</label><input id="prof_modelo_arma_\${client.phone}" type="text" value="\${client.modelo_arma || ''}"></div>
        <div class="crm-field"><label>Marca Arma</label><input id="prof_marca_arma_\${client.phone}" type="text" value="\${client.marca_arma || ''}"></div>
        <div class="crm-field"><label>Serial Arma</label><input id="prof_serial_arma_\${client.phone}" type="text" value="\${client.serial_arma || ''}"></div>
      </div>

      <div class="crm-save-row">
        <button class="crm-save-btn" onclick="saveProfile('\${client.phone}', this)">💾 Guardar Todo</button>
        <button class="crm-save-btn" style="background:linear-gradient(135deg,#1a5eb8,#0d3b8a);" onclick="generarCarnet('\${client.phone}', this)">🪪 Generar Carnet</button>
        <div id="prof_feedback_\${client.phone}" style="display:none;color:#3fb950;font-size:12px;">✅ Guardado</div>
      </div>
    </div>

    <!-- TAB: NOTAS -->
    <div class="crm-tab-content" id="crmTab_notas_\${client.phone}">
      <div class="crm-section-title">🧠 Memoria del Bot</div>
      <textarea class="crm-memory-textarea" id="memoryEdit_\${client.phone}">\${(client.memory || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
      <div style="display:flex;gap:8px;margin-top:6px;">
        <button class="crm-save-btn" onclick="saveMemory('\${client.phone}')">💾 Guardar Memoria</button>
        <div id="memoryFeedback_\${client.phone}" style="display:none;color:#3fb950;font-size:12px;align-self:center;">✅ Memoria guardada</div>
      </div>

      <div class="crm-section-title" style="margin-top:14px;">📝 Nota Rápida</div>
      <div class="crm-action-row">
        <select id="quickNote_\${client.phone}">
          <option value="">Seleccionar nota...</option>
          <option value="📦 Dispositivo despachado">📦 Dispositivo despachado</option>
          <option value="💰 Pago recibido y confirmado">💰 Pago recibido</option>
          <option value="🏆 Afiliación al club activa">🏆 Afiliación activa</option>
          <option value="📋 Pendiente: enviar carnet">🕐 Pendiente carnet</option>
          <option value="📋 Pendiente: despachar dispositivo">🕐 Pendiente despacho</option>
          <option value="🚫 Cliente marcado como NO interesado">❌ No interesado</option>
        </select>
        <button class="green" onclick="const s=document.getElementById('quickNote_\${client.phone}');if(s.value){addNote('\${client.phone}',s.value);s.selectedIndex=0;}">✅ Aplicar</button>
      </div>

      <div class="crm-section-title">✏️ Nota Libre</div>
      <div class="crm-action-row">
        <input type="text" id="noteInput_\${client.phone}" placeholder="Escribir nota interna..." onkeydown="if(event.key==='Enter') saveNote('\${client.phone}')" style="flex:1;background:#0d1117;border:1px solid #1c2733;color:#e6edf3;padding:8px 10px;border-radius:6px;font-size:12px;">
        <button class="green" onclick="saveNote('\${client.phone}')">📝 Guardar</button>
      </div>
      <div class="crm-feedback" id="noteFeedback_\${client.phone}" style="font-size:11px;color:#3fb950;height:14px;"></div>

      <!-- ORDEN AL BOT -->
      <div style="margin-top:12px;padding:10px;background:#13111a;border:1px solid #5b21b644;border-radius:8px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <span style="color:#c084fc;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;font-family:'Chakra Petch',sans-serif;">🎯 Dar Orden al Bot</span>
          <span id="directiveIndicator_\${client.phone}" style="font-size:11px;color:#6b7280;">\${client.bot_directive ? '🎯 ' + (client.bot_directive||'').substring(0,45) + ((client.bot_directive||'').length > 45 ? '...' : '') : 'Sin orden activa'}</span>
        </div>
        <textarea id="botDirectiveInput_\${client.phone}" placeholder="Ej: Pídele la ciudad para el envío. / Ofrece renovar el Plan Pro. / Pregunta si ya recibió el paquete." style="width:100%;min-height:55px;background:#0d1117;border:1px solid #6b21a855;border-radius:6px;color:#e6edf3;padding:8px;font-size:12px;font-family:inherit;resize:vertical;box-sizing:border-box;"></textarea>
        <div style="display:flex;gap:6px;margin-top:6px;">
          <button id="btnSendDirective_\${client.phone}" onclick="setBotDirective('\${client.phone}', false)" style="flex:1;background:linear-gradient(135deg,#6b21a8,#9333ea);color:white;border:none;padding:6px 12px;border-radius:5px;cursor:pointer;font-size:11px;font-weight:700;font-family:'Chakra Petch',sans-serif;">🎯 Enviar Orden</button>
          <button id="btnClearDirective_\${client.phone}" onclick="setBotDirective('\${client.phone}', true)" style="background:#1c2733;color:#8b949e;border:1px solid #30363d;padding:6px 10px;border-radius:5px;cursor:pointer;font-size:11px;font-family:'Chakra Petch',sans-serif;">🗑️ Limpiar</button>
        </div>
      </div>
    </div>

    <!-- TAB: ACCIONES -->
    <div class="crm-tab-content" id="crmTab_acciones_\${client.phone}">
      <div class="crm-section-title">⚡ Acciones</div>
      <div class="crm-action-row">
        <select id="quickAction_\${client.phone}">
          <option value="">Seleccionar acción...</option>
          <option value="carnet">🪪 Enviar Carnet por WhatsApp</option>
          <option value="factura">🧾 Enviar Factura por WhatsApp</option>
          <option value="catalogo">📋 Enviar Catálogo</option>
          <option value="solicitar_carnet">📝 Solicitar Datos para Carnet</option>
          <option value="solicitar_envio">🚚 Solicitar Datos para Envío</option>
          <option value="guia">📦 Enviar Guía de Envío</option>
          <option value="reatender">🔄 Reatender (Último Msj)</option>
          <option value="devolver_bot">🤖 Devolver al Bot</option>
          <option value="reactivar_normal">🔥 Reactivar Integración IA</option>
          <option value="reactivar_ultra">💎 Reactivar Ultra (Promos)</option>
          <option value="ignorar">\${client.ignored == 1 ? '🔇 Reactivar (está ignorado)' : '🔇 Silenciar — no es cliente'}</option>
          <option value="resetear">↩️ Resetear a Nuevo</option>
          <option value="completado">✅ Marcar Completado</option>
        </select>
        <button onclick="ejecutarAccion('\${client.phone}', document.getElementById('quickAction_\${client.phone}').value, this)">▶ Ejecutar</button>
      </div>

      <div class="crm-section-title">📦 Mover a Post-venta</div>
      <div class="crm-action-row">
        <select id="pvSelect_\${client.phone}">
          <option value="">Seleccionar destino...</option>
          <option value="carnet_pendiente_plus">🟢 Pendiente Carnet Club Plus</option>
          <option value="carnet_pendiente_pro">🔴 Pendiente Carnet Club Pro</option>
          <option value="despacho_pendiente">📦 Pendiente Envío Dispositivo</option>
          <option value="municion_pendiente">🔫 Pendiente Envío Munición</option>
          <option value="recuperacion_pendiente">🔧 Pendiente Recuperación</option>
          <option value="bot_asesor_pendiente">🤖 Pendiente Bot Asesor</option>
          <option value="postventa">📋 Post-venta general</option>
        </select>
        <button class="green" onclick="moverPostventa('\${client.phone}')">✅ Mover</button>
      </div>

      <div class="crm-section-title" style="margin-top:8px;">🪪 Historial de Carnets</div>
      <div id="carnetHistory_\${client.phone}"></div>
    </div>
  \`;
  } else {
    const msgCountEl = document.getElementById('comMsgCount');
    if (msgCountEl) msgCountEl.textContent = '💬 ' + (client.interaction_count || 0) + ' msgs';
  }

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
  const prevAdminText = document.getElementById('adminReplyInput') ? document.getElementById('adminReplyInput').value : '';

  chatArea.innerHTML = '<div class="chat-container">' + (chatHtml || '<div class="chat-empty">Sin mensajes</div>') + '</div>' +
    '<div style="display:flex;gap:8px;margin-top:10px;padding:10px;background:#161b22;border-radius:8px;border:1px solid #30363d;">' +
      '<textarea id="adminReplyInput" placeholder="Escribir como Álvaro..." style="flex:1;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:8px;resize:none;height:40px;font-family:inherit;font-size:13px;"></textarea>' +
      '<button onclick="enviarMensajeAdmin()" style="background:#1a5276;color:white;border:none;border-radius:6px;padding:8px 16px;cursor:pointer;font-weight:bold;white-space:nowrap;">Enviar 👤</button>' +
    '</div>';
    
  if (prevAdminText) document.getElementById('adminReplyInput').value = prevAdminText;

  if (!isAutoRefresh) {
    // Esperar a que el DOM renderice antes de hacer scroll
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        chatArea.scrollTop = chatArea.scrollHeight;
      });
    });
    // Restore active CRM tab after re-render
    if (activeCrmTab && activeCrmTab !== 'perfil') {
      const tabContent = document.getElementById('crmTab_' + activeCrmTab + '_' + phone);
      if (tabContent) {
        document.querySelectorAll('.crm-tab-content').forEach(c => c.classList.remove('active'));
        document.querySelectorAll('.crm-tab').forEach(t => t.classList.remove('active'));
        tabContent.classList.add('active');
        // Highlight the correct tab
        const tabs = document.querySelectorAll('.crm-tab');
        tabs.forEach(t => { if (t.textContent.toLowerCase().includes(activeCrmTab === 'notas' ? 'notas' : activeCrmTab === 'acciones' ? 'acciones' : 'perfil')) t.classList.add('active'); });
      }
    }

    // Cargar historial de carnets del cliente
    loadCarnetHistory(phone);
  }
}

function toggleDetailPanel() {
  const detail = document.getElementById('clientDetail');
  const btn = document.getElementById('btnToggleDetail');
  const isOpen = detail.classList.toggle('open');
  btn.classList.toggle('active', isOpen);
  btn.textContent = isOpen ? '\ud83d\udccb Ocultar Info' : '\ud83d\udccb Info';
}

function toggleDetailPanelPv() {
  const detail = document.getElementById('clientDetailPv');
  const btn = document.getElementById('btnToggleDetailPv');
  const isOpen = detail.classList.toggle('open');
  btn.classList.toggle('active', isOpen);
  btn.textContent = isOpen ? 'Ocultar Info' : 'Info';
}

let activeCrmTab = 'perfil'; // Remember active tab across re-renders
let activeCrmTabPv = 'perfil'; // Remember active tab across re-renders for PV

function switchCrmTab(phone, tab, el) {
  activeCrmTab = tab;
  document.querySelectorAll('.crm-tab-content').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('.crm-tab').forEach(t => t.classList.remove('active'));
  const target = document.getElementById('crmTab_' + tab + '_' + phone);
  if (target) target.classList.add('active');
  if (el) el.classList.add('active');
}

function switchCrmTabPv(phone, tab, el) {
  activeCrmTabPv = tab;
  const container = document.getElementById('clientDetailPv');
  if (container) {
    container.querySelectorAll('.crm-tab-content').forEach(c => c.classList.remove('active'));
    container.querySelectorAll('.crm-tab').forEach(t => t.classList.remove('active'));
  }
  const target = document.getElementById('crmTabPv_' + tab + '_' + phone);
  if (target) target.classList.add('active');
  if (el) el.classList.add('active');
}

async function cambiarStatusCRM(phone, newStatus) {
  try {
    await fetch('/api/update-client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, data: { status: newStatus } })
    });
    await loadData();
    selectClient(phone);
  } catch(e) { console.error(e); }
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

async function generarCarnet(phone, btn) {
  if (!confirm('¿Generar y enviar el carnet por WhatsApp a este cliente?')) return;
  const orgText = btn.innerHTML;
  btn.innerHTML = '⏳ Generando...';
  btn.disabled = true;
  try {
    const res = await fetch('/api/generar-carnet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (data.ok) {
      btn.innerHTML = '✅ Carnet Enviado';
      btn.style.background = '#238636';
      alert('✅ Carnet ' + data.plan + ' generado y enviado a ' + data.clientName);
      await loadData();
      selectClient(phone);
    } else {
      alert('⚠️ ' + (data.error || 'Error generando carnet'));
      btn.innerHTML = orgText;
      btn.disabled = false;
    }
  } catch(e) {
    alert('❌ Error conectando con el servidor');
    btn.innerHTML = orgText;
    btn.disabled = false;
  }
}

function filterClients() { renderClients(); }

// Detectar si un phone es LID (ID interno de WA, no número real)
function isLid(phone) { return phone && phone.length >= 13; }
// Formatear teléfono legible: 573127983674 → +57 312 798 3674
function formatPhone(phone) {
  if (!phone) return '';
  // Colombiano: 57 + 10 dígitos
  if (phone.startsWith('57') && phone.length === 12) {
    return '+57 ' + phone.substring(2, 5) + ' ' + phone.substring(5, 8) + ' ' + phone.substring(8);
  }
  return '+' + phone;
}
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
  await addNote(phone, input.value.trim());
  input.value = '';
}

async function saveMemory(phone) {
  // Busca en ambos tabs (Comercial y Postventa)
  const ta = document.getElementById('memoryEdit_' + phone) || document.getElementById('memoryEditPv_' + phone);
  if (!ta) return;
  const newMemory = ta.value.trim();
  try {
    const res = await fetch('/api/update-client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, note: newMemory, append: false })
    });
    const data = await res.json();
    if (data.ok) {
      await loadData();
      if (selectedPhone === phone) selectClient(phone);
      if (selectedPhonePv === phone) selectClientPv(phone);
      alert('✅ Memoria CRM guardada');
    } else {
      alert('❌ Error: ' + (data.error || 'desconocido'));
    }
  } catch(e) { alert('❌ Error de conexión'); }
}

async function saveProfile(phone, btn) {
  if (!btn) return;
  const originalText = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Guardando...';
  
  const profileData = {
    name: document.getElementById('prof_name_' + phone)?.value.trim() || '',
    cedula: document.getElementById('prof_cedula_' + phone)?.value.trim() || '',
    ciudad: document.getElementById('prof_ciudad_' + phone)?.value.trim() || '',
    direccion: document.getElementById('prof_direccion_' + phone)?.value.trim() || '',
    profesion: document.getElementById('prof_profesion_' + phone)?.value.trim() || '',
    club_plan: document.getElementById('prof_club_plan_' + phone)?.value || '',
    club_vigente_hasta: document.getElementById('prof_club_vigente_hasta_' + phone)?.value || '',
    modelo_arma: document.getElementById('prof_modelo_arma_' + phone)?.value.trim() || '',
    marca_arma: document.getElementById('prof_marca_arma_' + phone)?.value.trim() || '',
    serial_arma: document.getElementById('prof_serial_arma_' + phone)?.value.trim() || ''
  };

  try {
    const res = await fetch('/api/update-client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, profileData })
    });
    const data = await res.json();
    if (data.ok) {
      const fb = document.getElementById('prof_feedback_' + phone);
      if (fb) {
        fb.style.display = 'block';
        setTimeout(() => { if(fb) fb.style.display = 'none'; }, 4000);
      }
      await loadData();
      selectedPhone = phone;
      // No llamamos selectClient(phone) para no borrar lo que el usuario estaba escribiendo, 
      // o bien lo llamamos si queremos actualizar los nombres arriba. Arriba se actualizan solos al tipear? No.
      // Mejor lo llamamos suave.
      document.getElementById('chatTitle').textContent = '💬 ' + (profileData.name || phone);
    } else {
      alert('❌ Error guardando ficha: ' + data.error);
    }
  } catch(e) { 
    console.error(e);
    alert('❌ Error conectando con el panel');
  } finally {
    btn.innerHTML = originalText;
  }
}


async function toggleFlag(phone, flag, currentValue) {
  const newValue = currentValue === 1 ? false : true; // boolean
  try {
    const res = await fetch('/api/toggle-client-flag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, flag, value: newValue })
    });
    const data = await res.json();
    if (data.ok) {
      await loadData();
      selectClient(phone);
    } else {
      alert('❌ Error actualizando flag: ' + data.error);
    }
  } catch (e) {
    alert('❌ Error conectando con servidor local');
  }
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

// Dispatcher para dropdown de acciones — Comercial
function ejecutarAccion(phone, action, btn) {
  if (!action) return;
  const sel = document.getElementById('quickAction_' + phone);
  switch(action) {
    case 'carnet': abrirModalCarnet(phone); break;
    case 'factura': abrirModalFactura(phone); break;
    case 'catalogo': enviarCatalogo(phone, btn); break;
    case 'solicitar_carnet': solicitarDatosCarnet(phone, btn); break;
    case 'solicitar_envio': solicitarDatosEnvio(phone, btn); break;
    case 'guia': abrirModalGuia(phone); break;
    case 'reatender': reatenderCliente(phone, btn); break;
    case 'devolver_bot': devolverAlBot(phone); break;
    case 'reactivar_normal': reactivarIndividual(phone, btn, 'normal'); break;
    case 'reactivar_ultra': reactivarIndividual(phone, btn, 'ultra'); break;
    case 'ignorar': { const c = allData.clients.find(c => c.phone === phone); toggleIgnored(phone, c && c.ignored ? 0 : 1); break; }
    case 'resetear': changeStatus(phone, 'new'); break;
    case 'completado': changeStatus(phone, 'completed'); break;
    default: break;
  }
  if (sel) sel.selectedIndex = 0;
}

// Dispatcher para dropdown de acciones — Post-venta
function ejecutarAccionPv(phone, action, btn) {
  if (!action) return;
  const sel = document.getElementById('quickActionPv_' + phone);
  switch(action) {
    case 'carnet': abrirModalCarnet(phone); break;
    case 'factura': abrirModalFactura(phone); break;
    case 'catalogo': enviarCatalogo(phone, btn); break;
    case 'solicitar_carnet': solicitarDatosCarnet(phone, btn); break;
    case 'solicitar_envio': solicitarDatosEnvio(phone, btn); break;
    case 'guia': abrirModalGuia(phone); break;
    case 'reatender': reatenderCliente(phone, btn); break;
    case 'devolver_bot': devolverAlBot(phone); break;
    case 'reactivar_normal': reactivarIndividual(phone, btn, 'normal'); break;
    case 'reactivar_ultra': reactivarIndividual(phone, btn, 'ultra'); break;
    case 'seguimiento_pv': reatenderPostventaPv(phone, btn); break;
    case 'devolver_comercial': changeStatusPv(phone, 'new'); break;
    case 'completado': changeStatusPv(phone, 'completed'); break;
    default: break;
  }
  if (sel) sel.selectedIndex = 0;
}


// ===== SOLICITAR DATOS PARA CARNET =====
async function solicitarDatosCarnet(phone, btn) {
  const originalText = btn.textContent;
  btn.textContent = '⏳ Enviando...';
  btn.style.pointerEvents = 'none';
  try {
    const mensaje = '📋 *Datos necesarios para tu Carnet Digital:*\\n\\n' +
      'Para poder generar tu carnet necesito que me envíes lo siguiente:\\n\\n' +
      '1️⃣ *Nombre completo*\\n' +
      '2️⃣ *Número de cédula*\\n' +
      '3️⃣ *Marca del arma*\\n' +
      '4️⃣ *Modelo del arma*\\n' +
      '5️⃣ *Número de serial del arma*\\n' +
      '6️⃣ *📸 Foto de frente* (selfie clara, sin gafas, buena luz)\\n\\n' +
      'Apenas me envíes todo, generamos tu carnet de una 🙌';
    const res = await fetch('/api/enviar-mensaje', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message: mensaje })
    });
    const data = await res.json();
    if (data.ok) {
      btn.textContent = '✅ Enviado';
      btn.style.background = '#1a3a2a';
      setTimeout(() => { btn.textContent = originalText; btn.style.pointerEvents = ''; btn.style.background = ''; }, 4000);
    } else {
      btn.textContent = '❌ Error';
      alert('Error: ' + (data.error || 'desconocido'));
      setTimeout(() => { btn.textContent = originalText; btn.style.pointerEvents = ''; }, 3000);
    }
  } catch(e) {
    btn.textContent = '❌ Error';
    alert('No se pudo conectar con el bot');
    setTimeout(() => { btn.textContent = originalText; btn.style.pointerEvents = ''; }, 3000);
  }
}

// ===== SOLICITAR DATOS PARA ENVÍO =====
async function solicitarDatosEnvio(phone, btn) {
  const originalText = btn.textContent;
  btn.textContent = '⏳ Enviando...';
  btn.style.pointerEvents = 'none';
  try {
    const mensaje = '🚚 *Datos de envío:*\\n\\n' +
      'Para poder despachar tu pedido necesito los siguientes datos:\\n\\n' +
      '1️⃣ *Nombre completo de quien recibe*\\n' +
      '2️⃣ *Número de cédula de quien recibe*\\n' +
      '3️⃣ *Teléfono de contacto*\\n' +
      '4️⃣ *Dirección completa* (incluye barrio)\\n' +
      '5️⃣ *Ciudad*\\n' +
      '6️⃣ *Departamento*\\n\\n' +
      'Apenas me confirmes, coordinamos el envío 📦';
    const res = await fetch('/api/enviar-mensaje', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message: mensaje })
    });
    const data = await res.json();
    if (data.ok) {
      btn.textContent = '✅ Enviado';
      btn.style.background = '#1a3a2a';
      setTimeout(() => { btn.textContent = originalText; btn.style.pointerEvents = ''; btn.style.background = ''; }, 4000);
    } else {
      btn.textContent = '❌ Error';
      alert('Error: ' + (data.error || 'desconocido'));
      setTimeout(() => { btn.textContent = originalText; btn.style.pointerEvents = ''; }, 3000);
    }
  } catch(e) {
    btn.textContent = '❌ Error';
    alert('No se pudo conectar con el bot');
    setTimeout(() => { btn.textContent = originalText; btn.style.pointerEvents = ''; }, 3000);
  }
}

async function enviarCatalogo(phone, btn) {
  if (!confirm('¿Enviar catálogo completo con fotos a este cliente? Se enviarán todas las referencias disponibles.')) return;
  const originalText = btn.textContent;
  btn.textContent = '⏳ Enviando...';
  btn.style.pointerEvents = 'none';
  btn.style.opacity = '0.6';
  try {
    const res = await fetch('/api/enviar-catalogo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (data.ok) {
      btn.textContent = '✅ Catálogo enviado';
      btn.style.background = '#1a3a2a';
      const fb = document.getElementById('noteFeedback_' + phone);
      if (fb) {
        fb.textContent = '📋 Catálogo enviándose en background — puede tardar unos minutos';
        setTimeout(() => { if(fb) fb.textContent = ''; }, 6000);
      }
      setTimeout(() => {
        btn.textContent = originalText;
        btn.style.pointerEvents = '';
        btn.style.opacity = '';
      }, 10000);
    } else {
      alert('❌ ' + (data.error || 'Error enviando catálogo'));
      btn.textContent = originalText;
      btn.style.pointerEvents = '';
      btn.style.opacity = '';
    }
  } catch(e) {
    alert('❌ Error conectando con el bot. ¿Está corriendo?');
    btn.textContent = originalText;
    btn.style.pointerEvents = '';
    btn.style.opacity = '';
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
      alert('✅ Migración lista: ' + data.migrados + ' clientes pasados de "asignados" → 🔥 Calientes');
      await loadData();
    } else { alert('Error: ' + (data.error || 'desconocido')); }
  } catch(e) { alert('Error de conexión'); }
  if (btn) { btn.disabled = false; btn.textContent = '🔄 Migrar Asignados → Calientes'; }
}

async function loadComprobanteBadge(count) {
  const badge = document.getElementById('comprobanteBadge');
  if (badge) {
    if (count > 0) { badge.textContent = count; badge.style.display = 'inline'; }
    else badge.style.display = 'none';
  }
}

async function loadCarnetsBadge(count) {
  const badge = document.getElementById('carnetsBadge');
  if (badge) {
    if (count > 0) { badge.textContent = count; badge.style.display = 'inline'; }
    else badge.style.display = 'none';
  }
}

// Escuchar Server-Sent Events (SSE) para badges sin hacer pollling
const eventSource = new EventSource('/api/events');
eventSource.onmessage = function(event) {
  try {
    const data = JSON.parse(event.data);
    loadComprobanteBadge(data.comprobantesCount);
    loadCarnetsBadge(data.carnetsCount);
    // Escalaciones badge
    const escBadge = document.getElementById('escalacionesBadge');
    if (escBadge && data.escalacionesCount !== undefined) {
      if (data.escalacionesCount > 0) { escBadge.textContent = data.escalacionesCount; escBadge.style.display = 'inline'; }
      else escBadge.style.display = 'none';
    }
  } catch(e) {}
};

async function refreshAll() {
  await loadData();
  // Badge post-venta (todos los status del grupo PV)
  if (allData) {
    const pvStatuses = ['postventa', 'carnet_pendiente_plus', 'carnet_pendiente_pro', 'despacho_pendiente', 'municion_pendiente', 'recuperacion_pendiente', 'bot_asesor_pendiente'];
    const pvCount = allData.clients.filter(c => pvStatuses.includes(c.status)).length;
    const badge = document.getElementById('postventaBadge');
    if (badge) { badge.textContent = pvCount; badge.style.display = pvCount > 0 ? 'inline' : 'none'; }
  }
  // Si estamos en post-venta, refrescar la lista
  if (currentMainTab === 'postventa') renderPostventa();
  if (currentMainTab === 'comprobantes') loadComprobantes();
  if (currentMainTab === 'carnets') loadCarnets();
  if (selectedPhone && currentMainTab === 'comercial') selectClient(selectedPhone, true);
  if (selectedPhonePv && currentMainTab === 'postventa') selectClientPv(selectedPhonePv, true);
}

// Carga inicial de datos
refreshAll();

// Auto-refresh cada 10 segundos — sincroniza con WhatsApp en tiempo real
let _loadingData = false;
setInterval(async () => {
  if (_loadingData) return;
  _loadingData = true;
  try { await refreshAll(); } catch(e) {}
  _loadingData = false;
}, 10000);

// ====== VISTA PRINCIPAL TABS ======
let currentMainTab = 'comercial';

function switchMainTab(tab) {
  currentMainTab = tab;
  document.getElementById('mainTabComercial').classList.toggle('active', tab === 'comercial');
  document.getElementById('mainTabComprobantes').classList.toggle('active', tab === 'comprobantes');
  document.getElementById('mainTabCarnets').classList.toggle('active', tab === 'carnets');
  document.getElementById('mainTabPostventa').classList.toggle('active', tab === 'postventa');
  document.getElementById('mainTabEscalaciones').classList.toggle('active', tab === 'escalaciones');
  document.getElementById('mainTabDashboard').classList.toggle('active', tab === 'dashboard');
  document.getElementById('viewClientes').classList.toggle('active', tab === 'comercial');
  document.getElementById('viewComprobantes').classList.toggle('active', tab === 'comprobantes');
  document.getElementById('viewCarnets').classList.toggle('active', tab === 'carnets');
  document.getElementById('viewPostventa').classList.toggle('active', tab === 'postventa');
  document.getElementById('viewEscalaciones').classList.toggle('active', tab === 'escalaciones');
  document.getElementById('viewDashboard').classList.toggle('active', tab === 'dashboard');
  if (tab === 'comprobantes') loadComprobantes();
  if (tab === 'carnets') loadCarnets();
  if (tab === 'escalaciones') loadEscalaciones();
  if (tab === 'postventa') renderPostventa();
  if (tab === 'dashboard') loadDashboard();
  if (tab === 'broadcast') { renderBroadcastTab(); setTimeout(loadBroadcastStatus, 400); }
  document.getElementById('viewBroadcast').style.display = (tab === 'broadcast') ? 'block' : 'none';
  document.getElementById('mainTabBroadcast').classList.toggle('active', tab === 'broadcast');
}

// ====== POST-VENTA ======
let selectedPhonePv = null;
let currentPvFilter = 'all';

// Todos los status que pertenecen a post-venta
const PV_STATUSES = ['postventa', 'carnet_pendiente_plus', 'carnet_pendiente_pro', 'despacho_pendiente', 'municion_pendiente', 'recuperacion_pendiente', 'bot_asesor_pendiente'];

const PV_LABELS = {
  'postventa': 'Post-venta',
  'carnet_pendiente_plus': '🟢 Carnet Plus',
  'carnet_pendiente_pro': '🔴 Carnet Pro',
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

async function selectClientPv(phone, isAutoRefresh = false) {
  selectedPhonePv = phone;
  renderPostventa();
  const client = allData.clients.find(c => c.phone === phone);
  const assignment = allData.assignments.find(a => a.client_phone === phone && a.status === 'active');
  document.getElementById('chatTitlePv').textContent = '💬 ' + (client.name || phone);
  if (!isAutoRefresh) {
    const toggleBtnPv = document.getElementById('btnToggleDetailPv');
    toggleBtnPv.style.display = 'inline-block';
    document.getElementById('clientDetailPv').classList.add('open');
    toggleBtnPv.classList.add('active');
    toggleBtnPv.textContent = 'Ocultar Info';
  }
  const statusClass = 'status-' + (client.status || 'postventa').replace(/_/g, '-');
  const statusLabel = PV_LABELS[client.status] || client.status || 'postventa';
  
  if (!isAutoRefresh) {
    document.getElementById('clientDetailPv').innerHTML = \`
      <div class="client-detail">
        <div class="crm-header-bar" id="pvHeaderBar">
          <h3>\${client.name || 'Sin nombre'} 
            <select class="client-status \${statusClass}" onchange="changeStatusPv('\${client.phone}', this.value)" style="background:none; color:inherit; border:none; outline:none; cursor:pointer; font-weight:inherit; font-family:inherit; font-size:inherit; padding:0 4px; appearance:auto;">
              <option value="postventa" \${(client.status||'postventa')==='postventa'?'selected':''} style="color:black;">Post-venta</option>
              <option value="carnet_pendiente_plus" \${client.status==='carnet_pendiente_plus'?'selected':''} style="color:black;">🟢 Carnet Plus</option>
              <option value="carnet_pendiente_pro" \${client.status==='carnet_pendiente_pro'?'selected':''} style="color:black;">🔴 Carnet Pro</option>
              <option value="despacho_pendiente" \${client.status==='despacho_pendiente'?'selected':''} style="color:black;">📦 Dispositivo</option>
              <option value="municion_pendiente" \${client.status==='municion_pendiente'?'selected':''} style="color:black;">🔫 Munición</option>
              <option value="recuperacion_pendiente" \${client.status==='recuperacion_pendiente'?'selected':''} style="color:black;">🔧 Recuperación</option>
              <option value="bot_asesor_pendiente" \${client.status==='bot_asesor_pendiente'?'selected':''} style="color:black;">🤖 Bot Asesor</option>
            </select>
          </h3>
          <div class="crm-meta">
            <span>\${isLid(client.phone) ? '🔒 ' + client.phone : '📱 ' + client.phone}</span>
            <span id="pvMsgCount">💬 \${client.interaction_count || 0} msgs</span>
            <span>📅 \${new Date(client.created_at).toLocaleDateString()}</span>
          \${assignment ? '<span>👔 ' + assignment.employee_name + '</span>' : ''}
        </div>
        <div style="margin-left:auto;display:flex;gap:6px;">
          \${waLink(client.phone)}
        </div>
      </div>

      <!-- CARNET DATA COMPLETENESS CHECK PV -->
      \${(function() {
        const missing = [];
        if (!client.name || client.name.trim().length < 3) missing.push('Nombre completo');
        if (!client.cedula) missing.push('Cédula');
        if (!client.modelo_arma) missing.push('Modelo arma');
      if (!client.marca_arma) missing.push('Marca arma');
        if (!client.serial_arma) missing.push('Serial arma');
        if (!client.club_plan) missing.push('Plan Club');
        if (missing.length === 0) {
          return '<div class="crm-carnet-ok">✅ Datos completos para carnet</div>';
        }
        return '<div class="crm-carnet-warn"><span class="warn-icon">⚠️</span><div class="warn-text">Faltan datos para generar carnet: <span class="warn-fields">' + missing.join(' · ') + '</span></div></div>';
      })()}

      <!-- CRM TABS PV -->
      <div class="crm-tabs">
        <div class="crm-tab active" onclick="switchCrmTabPv('\${client.phone}','perfil',this)">📋 Perfil</div>
        <div class="crm-tab" onclick="switchCrmTabPv('\${client.phone}','notas',this)">🧠 Notas</div>
        <div class="crm-tab" onclick="switchCrmTabPv('\${client.phone}','acciones',this)">⚡ Acciones</div>
      </div>

      <!-- TAB: PERFIL (PV) -->
      <div class="crm-tab-content active" id="crmTabPv_perfil_\${client.phone}">
        <div class="crm-section-title">🔒 Bóveda de Servicios</div>
        <div class="crm-toggles" style="margin-bottom:12px;">
          <label class="crm-toggle-chip"><input type="checkbox" \${client.has_bought_gun ? 'checked' : ''} onchange="toggleFlagPv('\${client.phone}', 'has_bought_gun', \${client.has_bought_gun || 0})"> 🔫 Compró Arma</label>
          <label class="crm-toggle-chip"><input type="checkbox" \${client.is_club_plus ? 'checked' : ''} onchange="toggleFlagPv('\${client.phone}', 'is_club_plus', \${client.is_club_plus || 0})" style="accent-color:#d29922;"> 🟡 Club Plus</label>
          <label class="crm-toggle-chip"><input type="checkbox" \${client.is_club_pro ? 'checked' : ''} onchange="toggleFlagPv('\${client.phone}', 'is_club_pro', \${client.is_club_pro || 0})" style="accent-color:#f85149;"> 🔴 Club Pro</label>
          <label class="crm-toggle-chip"><input type="checkbox" \${client.has_ai_bot ? 'checked' : ''} onchange="toggleFlagPv('\${client.phone}', 'has_ai_bot', \${client.has_ai_bot || 0})" style="accent-color:#1f6feb;"> 🤖 Bot IA</label>
        </div>

        <div class="crm-section-title">📋 Ficha CRM Completa — Datos Personales</div>
        <div class="crm-grid">
          <div class="crm-field"><label>Nombre</label><input id="prof_name_\${client.phone}" type="text" value="\${client.name || ''}"></div>
          <div class="crm-field"><label>Cédula</label><input id="prof_cedula_\${client.phone}" type="text" value="\${client.cedula || ''}"></div>
          <div class="crm-field"><label>Ciudad</label><input id="prof_ciudad_\${client.phone}" type="text" value="\${client.ciudad || ''}"></div>
          <div class="crm-field"><label>Dirección</label><input id="prof_direccion_\${client.phone}" type="text" value="\${client.direccion || ''}"></div>
          <div class="crm-field"><label>Profesión</label><input id="prof_profesion_\${client.phone}" type="text" value="\${client.profesion || ''}"></div>
        </div>

        <div class="crm-section-title" style="margin-top:10px;">Armamento & Club</div>
        <div class="crm-grid">
          <div class="crm-field"><label>Plan Club</label>
            <select id="prof_club_plan_\${client.phone}">
              <option value="" \${!client.club_plan ? 'selected' : ''}>— Ninguno —</option>
              <option value="Plan Plus" \${client.club_plan === 'Plan Plus' ? 'selected' : ''}>🟡 Plan Plus</option>
              <option value="Plan Pro" \${client.club_plan === 'Plan Pro' ? 'selected' : ''}>🔴 Plan Pro</option>
            </select>
          </div>
          <div class="crm-field"><label>Vigente hasta</label><input id="prof_club_vigente_hasta_\${client.phone}" type="date" value="\${client.club_vigente_hasta || ''}"></div>
          <div class="crm-field"><label>Modelo arma</label><input id="prof_modelo_arma_\${client.phone}" type="text" value="\${client.modelo_arma || ''}"></div>
          <div class="crm-field"><label>Serial arma</label><input id="prof_serial_arma_\${client.phone}" type="text" value="\${client.serial_arma || ''}"></div>
        </div>
        <div class="crm-save-row">
          <button class="crm-save-btn" onclick="saveProfile('\${client.phone}', this)">💾 Guardar Ficha CRM</button>
          <div id="prof_feedback_\${client.phone}" style="display:none;color:#3fb950;font-size:12px;">✅ Ficha guardada</div>
        </div>
      </div>

      <!-- TAB: NOTAS (PV) -->
      <div class="crm-tab-content" id="crmTabPv_notas_\${client.phone}">
        <div class="crm-section-title">🧠 Memoria CRM</div>
        <textarea class="crm-memory-textarea" id="memoryEditPv_\${client.phone}">\${(client.memory || '').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
        <div style="display:flex;gap:8px;margin-top:6px;">
          <button class="crm-save-btn" onclick="saveMemory('\${client.phone}')">💾 Guardar Memoria</button>
          <div id="memoryFeedbackPv_\${client.phone}" style="display:none;color:#3fb950;font-size:12px;align-self:center;">✅ Memoria guardada</div>
        </div>

        <div class="crm-section-title" style="margin-top:14px;">📝 Nota rápida</div>
        <div class="crm-action-row">
          <select id="quickNotePv_\${client.phone}">
            <option value="">📝 Nota rápida...</option>
            <option value="📦 Dispositivo despachado">📦 Dispositivo despachado</option>
            <option value="💰 Pago recibido y confirmado">💰 Pago recibido</option>
            <option value="🏆 Afiliación al club activa">🏆 Afiliación activa</option>
            <option value="🔫 Munición despachada">🔫 Munición enviada</option>
            <option value="🔧 Dispositivo en recuperación">🔧 En recuperación</option>
            <option value="📋 Pendiente: enviar carnet">🕐 Pendiente carnet</option>
            <option value="📋 Pendiente: despachar dispositivo">🕐 Pendiente despacho</option>
            <option value="✅ Caso resuelto">✅ Caso resuelto</option>
          </select>
          <button class="green" onclick="const s=document.getElementById('quickNotePv_\${client.phone}');if(s.value){addNotePv('\${client.phone}',s.value);s.selectedIndex=0;}">✅ Aplicar</button>
        </div>

        <div class="crm-section-title">✏️ Nota Libre</div>
        <div class="crm-action-row">
          <input type="text" class="crm-note-input" id="notePvInput_\${client.phone}" placeholder="Nota interna libre..." onkeydown="if(event.key==='Enter') saveNotePv('\${client.phone}')" style="flex:1;">
          <button class="green" onclick="saveNotePv('\${client.phone}')">📝 Guardar</button>
        </div>
        <div class="crm-feedback" id="notePvFeedback_\${client.phone}" style="font-size:11px;color:#3fb950;height:14px;"></div>
      </div>

      <!-- TAB: ACCIONES (PV) -->
      <div class="crm-tab-content" id="crmTabPv_acciones_\${client.phone}">
        <div class="crm-section-title">⚡ Acciones Rápidas</div>
        <div class="crm-action-row">
          <select id="quickActionPv_\${client.phone}">
            <option value="">⚡ Acción...</option>
            <option value="carnet">🪪 Enviar Carnet por WhatsApp</option>
            <option value="factura">🧾 Enviar Factura por WhatsApp</option>
            <option value="catalogo">📋 Enviar Catálogo</option>
            <option value="guia">📦 Enviar Guía de Envío</option>
            <option value="reatender">🔄 Reatender (Último Msj)</option>
            <option value="devolver_bot">🤖 Devolver al Bot</option>
            <option value="reactivar_normal">🔥 Reactivar Integración IA</option>
            <option value="reactivar_ultra">💎 Reactivar Ultra (Promos)</option>
            <option value="seguimiento_pv">📬 Seguimiento Post-venta (IA)</option>
            <option value="devolver_comercial">↩️ Devolver a Comercial</option>
            <option value="completado">🏁 Marcar completado</option>
          </select>
          <button onclick="ejecutarAccionPv('\${client.phone}', document.getElementById('quickActionPv_\${client.phone}').value, this)">▶ Ejecutar</button>
        </div>

        <div class="crm-section-title">📂 Categorizar Post-venta</div>
        <div class="crm-action-row">
          <select id="categorizePv_\${client.phone}">
            <option value="">📂 Categorizar...</option>
            <option value="carnet_pendiente_plus">🟢 Pend. Carnet Plus</option>
            <option value="carnet_pendiente_pro">🔴 Pend. Carnet Pro</option>
            <option value="despacho_pendiente">📦 Pend. Dispositivo</option>
            <option value="municion_pendiente">🔫 Pend. Munición</option>
            <option value="recuperacion_pendiente">🔧 Pend. Recuperación</option>
            <option value="bot_asesor_pendiente">🤖 Pend. Bot Asesor</option>
          </select>
          <button class="green" onclick="const s=document.getElementById('categorizePv_\${client.phone}');if(s.value){changeStatusPv('\${client.phone}',s.value);s.selectedIndex=0;}">✅ Aplicar</button>
        </div>

        <div class="crm-section-title" style="margin-top:8px;">🪪 Historial de Carnets</div>
        <div id="carnetHistory_\${client.phone}"></div>
      </div>
    </div>
  \`;
  } else {
    const msgCountEl = document.getElementById('pvMsgCount');
    if (msgCountEl) msgCountEl.textContent = '💬 ' + (client.interaction_count || 0) + ' msgs';
  }
  const res = await fetch('/api/chat?phone=' + phone);
  const messages = await res.json();
  const chatHtml = messages.map(m => \`
    <div style="display:flex;flex-direction:column;align-items:\${m.role === 'user' ? 'flex-start' : 'flex-end'};">
      <div class="chat-bubble chat-\${m.role}" \${m.role === 'admin' ? 'style="background:#1a5276;border:1px solid #2980b9;"' : ''}>\${m.role === 'admin' ? '👤 ' : ''}\${m.message}</div>
      <div class="chat-time">\${m.role === 'admin' ? 'Álvaro • ' : ''}\${new Date(m.created_at).toLocaleString()}</div>
    </div>
  \`).join('');
  const chatArea = document.getElementById('chatAreaPv');
  // Avoid re-rendering the admin reply textarea if not necessary, but since it's mixed with chat messages we have to:
  const prevAdminTextPv = document.getElementById('adminReplyInputPv') ? document.getElementById('adminReplyInputPv').value : '';
  
  chatArea.innerHTML = '<div class="chat-container">' + (chatHtml || '<div class="chat-empty">Sin mensajes</div>') + '</div>' +
    '<div style="display:flex;gap:8px;margin-top:10px;padding:10px;background:#161b22;border-radius:8px;border:1px solid #30363d;">' +
      '<textarea id="adminReplyInputPv" placeholder="Escribir como Álvaro..." style="flex:1;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:8px;resize:none;height:40px;font-family:inherit;font-size:13px;"></textarea>' +
      '<button onclick="enviarMensajeAdminPv()" style="background:#1a5276;color:white;border:none;border-radius:6px;padding:8px 16px;cursor:pointer;font-weight:bold;white-space:nowrap;">Enviar 👤</button>' +
    '</div>';
    
  if (prevAdminTextPv) document.getElementById('adminReplyInputPv').value = prevAdminTextPv;

  if (!isAutoRefresh) {
    requestAnimationFrame(() => requestAnimationFrame(() => { chatArea.scrollTop = chatArea.scrollHeight; }));

    if (activeCrmTabPv && activeCrmTabPv !== 'perfil') {
      const tabContentPv = document.getElementById('crmTabPv_' + activeCrmTabPv + '_' + phone);
      if (tabContentPv) {
        const pContainer = document.getElementById('clientDetailPv');
        pContainer.querySelectorAll('.crm-tab-content').forEach(c => c.classList.remove('active'));
        pContainer.querySelectorAll('.crm-tab').forEach(t => t.classList.remove('active'));
        tabContentPv.classList.add('active');
        pContainer.querySelectorAll('.crm-tab').forEach(t => { if (t.textContent.toLowerCase().includes(activeCrmTabPv === 'notas' ? 'notas' : activeCrmTabPv === 'acciones' ? 'acciones' : 'perfil')) t.classList.add('active'); });
      }
    }

    loadCarnetHistory(phone);
  }
}

// Helpers post-venta — refrescan la vista PV en lugar de la comercial
async function addNotePv(phone, note) {
  try {
    const res = await fetch('/api/update-client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, note, append: true })
    });
    const data = await res.json();
    if (data.ok) {
      await loadData();
      renderPostventa();
      selectedPhonePv = phone;
      selectClientPv(phone);
      const fb = document.getElementById('notePvFeedback_' + phone);
      if (fb) { fb.textContent = '✅ Guardado: ' + note; setTimeout(() => { if(fb) fb.textContent = ''; }, 3000); }
    } else {
      const fb = document.getElementById('notePvFeedback_' + phone);
      if (fb) fb.textContent = '❌ Error: ' + (data.error || 'desconocido');
    }
  } catch(e) { console.error(e); }
}

async function saveNotePv(phone) {
  const input = document.getElementById('notePvInput_' + phone);
  if (!input || !input.value.trim()) return;
  await addNotePv(phone, input.value.trim());
  input.value = '';
}

async function toggleFlagPv(phone, flag, currentValue) {
  const newValue = currentValue === 1 ? false : true;
  try {
    const res = await fetch('/api/toggle-client-flag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, flag, value: newValue })
    });
    const data = await res.json();
    if (data.ok) {
      await loadData();
      selectClientPv(phone);
    } else {
      alert('❌ Error actualizando flag: ' + data.error);
    }
  } catch (e) {
    alert('❌ Error conectando con servidor local');
  }
}

async function changeStatusPv(phone, status) {
  try {
    const res = await fetch('/api/update-client', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, note: '', append: true, status })
    });
    const data = await res.json();
    if (data.ok) {
      await loadData();
      renderPostventa();
      selectedPhonePv = phone;
      selectClientPv(phone);
      const fb = document.getElementById('notePvFeedback_' + phone);
      if (fb) {
        fb.textContent = '✅ Estado actualizado a: ' + (PV_LABELS[status] || status);
        setTimeout(() => { if(fb) fb.textContent = ''; }, 3000);
      }
    }
  } catch(e) { console.error(e); }
}

async function reatenderPostventaPv(phone, btn) {
  const original = btn.textContent;
  btn.textContent = '⏳ Enviando...';
  btn.style.pointerEvents = 'none';
  try {
    const res = await fetch('/api/reatender-postventa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (data.ok) {
      btn.textContent = '✅ Enviado';
      btn.style.background = '#1a3a2a';
      btn.style.color = '#3fb950';
      const fb = document.getElementById('notePvFeedback_' + phone);
      if (fb) { fb.textContent = '✅ Seguimiento enviado — el bot contactó al cliente'; setTimeout(() => { if(fb) fb.textContent = ''; }, 5000); }
      // Refrescar chat para ver el mensaje enviado
      setTimeout(() => selectClientPv(phone), 2000);
    } else {
      btn.textContent = '❌ Error';
      alert('Error: ' + (data.message || data.error || 'desconocido'));
    }
  } catch(e) {
    btn.textContent = '❌ Error';
    alert('No se pudo conectar con el bot');
  }
  setTimeout(() => { btn.textContent = original; btn.style.pointerEvents = ''; btn.style.background = ''; btn.style.color = ''; }, 4000);
}

async function enviarMensajeAdminPv() {
  const input = document.getElementById('adminReplyInputPv');
  const message = (input.value || '').trim();
  if (!message || !selectedPhonePv) return;
  input.disabled = true;
  try {
    const res = await fetch('/api/enviar-mensaje', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: selectedPhonePv, message })
    });
    const data = await res.json();
    if (data.ok) {
      input.value = '';
      selectClientPv(selectedPhonePv); // refrescar chat
    } else {
      alert('❌ ' + (data.error || 'Error enviando'));
    }
  } catch (e) {
    alert('❌ Error conectando con el bot');
  }
  input.disabled = false;
}

// ====== ESCALACIONES ======
async function loadEscalaciones() {
  try {
    const res = await fetch('/api/escalaciones');
    const escalaciones = await res.json();
    
    const badge = document.getElementById('escalacionesBadge');
    if (escalaciones.length > 0) { badge.textContent = escalaciones.length; badge.style.display = 'inline'; }
    else badge.style.display = 'none';

    const container = document.getElementById('escalacionesList');
    if (escalaciones.length === 0) {
      container.innerHTML = '<div style="text-align:center;color:#7d8590;padding:40px;font-size:14px;">✅ No hay escalaciones pendientes</div>';
      return;
    }

    container.innerHTML = escalaciones.map(e => {
      const tipoLabel = e.tipo === 'postventa' ? '🛠️ POST-VENTA' : '🔥 LEAD CALIENTE';
      const tipoColor = e.tipo === 'postventa' ? '#d29922' : '#f85149';
      const fecha = new Date(e.created_at + 'Z');
      const hace = Math.round((Date.now() - fecha.getTime()) / 60000);
      const tiempoStr = hace < 60 ? hace + ' min' : Math.round(hace/60) + 'h';
      const triggerClean = (e.trigger_message || '').substring(0, 200);
      const memoryClean = (e.memory || '').substring(0, 300);
      
      // === DATOS CRM ESTRUCTURADOS ===
      const hasCrmData = e.cedula || e.modelo_arma || e.ciudad;
      
      // Campos para carnet
      const carnetFields = [
        { label: 'Nombre', value: e.name || e.client_name, icon: '👤' },
        { label: 'Cédula', value: e.cedula, icon: '🪪' },
        { label: 'Ciudad', value: e.ciudad, icon: '📍' },
        { label: 'Marca Arma', value: e.marca_arma, icon: '🔫' },
        { label: 'Modelo Arma', value: e.modelo_arma, icon: '🔧' },
        { label: 'Serial', value: e.serial_arma, icon: '🔢' },
        { label: 'Plan Club', value: e.club_plan, icon: '🏆' },
      ];
      const carnetMissing = carnetFields.filter(f => !f.value);
      const carnetReady = carnetMissing.length === 0;
      
      // Campos de envío
      const envioFields = [
        { label: 'Recibe', value: e.nombre_recibe, icon: '📦' },
        { label: 'Tel. Recibe', value: e.telefono_recibe, icon: '📱' },
        { label: 'Dirección', value: e.direccion_envio, icon: '🏠' },
        { label: 'Barrio', value: e.barrio_envio, icon: '🗺️' },
        { label: 'Ciudad Envío', value: e.ciudad_envio, icon: '🌆' },
        { label: 'Depto', value: e.departamento_envio, icon: '📫' },
      ];
      const hasEnvio = envioFields.some(f => f.value);
      
      // Badges de servicios
      const badges = [];
      if (e.has_bought_gun) badges.push('🔫 Arma');
      if (e.is_club_plus) badges.push('🟡 Plus');
      if (e.is_club_pro) badges.push('🔴 Pro');
      if (e.has_ai_bot) badges.push('🤖 Bot IA');
      
      // Helper para renderizar campo
      function renderField(f) {
        return '<div style="background:#0d1117;border-radius:4px;padding:6px 8px;display:flex;flex-direction:column;gap:2px;">' +
          '<span style="color:#7d8590;font-size:9px;text-transform:uppercase;">' + f.icon + ' ' + f.label + '</span>' +
          '<span style="color:' + (f.value ? '#e6edf3' : '#f8514960') + ';font-size:12px;font-weight:' + (f.value ? '600' : '400') + ';">' + (f.value || '— falta —') + '</span>' +
        '</div>';
      }

      return '<div style="background:#111820;border:1px solid #1c2733;border-left:4px solid ' + tipoColor + ';border-radius:8px;padding:16px;margin-bottom:12px;">' +
        // Header
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
          '<span style="font-weight:700;color:' + tipoColor + ';font-size:13px;">' + tipoLabel + ' #' + e.id + '</span>' +
          '<div style="display:flex;gap:6px;align-items:center;">' +
            (badges.length > 0 ? badges.map(function(b) { return '<span style="background:#1c2733;padding:2px 6px;border-radius:3px;font-size:10px;color:#8b949e;">' + b + '</span>'; }).join('') : '') +
            '<span style="color:#7d8590;font-size:11px;">hace ' + tiempoStr + '</span>' +
          '</div>' +
        '</div>' +
        // Client name + phone
        '<div style="margin-bottom:8px;display:flex;align-items:center;gap:8px;">' +
          '<span style="color:#e6edf3;font-weight:600;font-size:15px;">' + (e.name || e.client_name || 'Sin nombre') + '</span>' +
          '<a href="https://wa.me/' + e.client_phone + '" target="_blank" style="color:#58a6ff;text-decoration:none;font-size:12px;">📲 ' + e.client_phone + '</a>' +
          (e.lead_score ? '<span style="background:#1a3a2a;color:#3fb950;padding:2px 6px;border-radius:3px;font-size:10px;font-weight:600;">Score: ' + e.lead_score + '</span>' : '') +
        '</div>' +
        // Trigger message
        '<div style="background:#0d1117;border-radius:6px;padding:10px;margin-bottom:10px;">' +
          '<div style="color:#7d8590;font-size:10px;text-transform:uppercase;margin-bottom:4px;">Lo que disparó la alerta:</div>' +
          '<div style="color:#e6edf3;font-size:13px;">"' + triggerClean + '"</div>' +
        '</div>' +
        // === DATOS PARA CARNET ===
        '<div style="background:#0b1622;border:1px solid #1c2733;border-radius:6px;padding:10px;margin-bottom:10px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
            '<span style="color:#58a6ff;font-size:11px;font-weight:700;text-transform:uppercase;">🪪 Datos para Carnet</span>' +
            (carnetReady 
              ? '<span style="color:#3fb950;font-size:10px;font-weight:600;">✅ COMPLETO</span>'
              : '<span style="color:#f85149;font-size:10px;font-weight:600;">⚠️ Faltan ' + carnetMissing.length + ' campos</span>') +
          '</div>' +
          '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px;">' +
            carnetFields.map(renderField).join('') +
          '</div>' +
          (e.foto_cliente_url ? '<div style="margin-top:8px;"><span style="color:#7d8590;font-size:9px;text-transform:uppercase;">📸 Selfie:</span> <span style="color:#3fb950;font-size:11px;">✅ Recibida</span></div>' : '<div style="margin-top:8px;"><span style="color:#f85149;font-size:11px;">📸 Selfie: — falta —</span></div>') +
        '</div>' +
        // === DATOS DE ENVÍO (solo si hay) ===
        (hasEnvio ? 
          '<div style="background:#0b1622;border:1px solid #1c2733;border-radius:6px;padding:10px;margin-bottom:10px;">' +
            '<span style="color:#d29922;font-size:11px;font-weight:700;text-transform:uppercase;">🚚 Datos de Envío</span>' +
            '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px;margin-top:8px;">' +
              envioFields.filter(function(f) { return f.value; }).map(renderField).join('') +
            '</div>' +
          '</div>'
        : '') +
        // Memory (colapsable, solo si hay y es diferente a los campos)
        (memoryClean ? '<details style="margin-bottom:10px;">' +
          '<summary style="color:#7d8590;font-size:11px;cursor:pointer;padding:4px 0;">📋 Ver memoria completa del bot</summary>' +
          '<div style="background:#0d1117;border-radius:6px;padding:10px;margin-top:6px;">' +
            '<div style="color:#8b949e;font-size:12px;white-space:pre-wrap;">' + memoryClean + '</div>' +
          '</div>' +
        '</details>' : '') +
        // === ACCIONES RAPIDAS ===
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;padding:8px;background:#0d1117;border-radius:6px;border:1px solid #1c2733;">' +
          '<span style="color:#7d8590;font-size:10px;width:100%;text-transform:uppercase;margin-bottom:2px;">⚡ Acciones rápidas</span>' +
          (!carnetReady ? '<button onclick="solicitarDatosCarnet(\\\'' + e.client_phone + '\\\', this)" style="background:#1a3a5c;color:#58a6ff;border:none;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:11px;">📋 Solicitar Datos Carnet</button>' : '') +
          (!hasEnvio ? '<button onclick="solicitarDatosEnvio(\\\'' + e.client_phone + '\\\', this)" style="background:#3d2b00;color:#d29922;border:none;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:11px;">🚚 Solicitar Datos Envío</button>' : '') +
          (carnetReady ? '<button onclick="generarCarnet(\\\'' + e.client_phone + '\\\', this)" style="background:#1a3a2a;color:#3fb950;border:none;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;">🪪 Generar Carnet</button>' : '') +
          '<button onclick="switchMainTab(\\\'comercial\\\'); setTimeout(function(){ selectClient(\\\'' + e.client_phone + '\\\'); }, 300)" style="background:#21262d;color:#8b949e;border:none;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:11px;">👁️ Ver Perfil</button>' +
          '<button onclick="devolverAComercial(\\\'' + e.client_phone + '\\\', this)" style="background:#2d1a3a;color:#c084fc;border:1px solid #6b21a8;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;">🔄 Devolver a Comercial</button>' +
        '</div>' +
        // Nota textarea
        '<div style="margin-bottom:10px;"><textarea id="escNota_' + e.id + '" placeholder="📝 Agregar nota o contexto para el bot (ej: ya se le envió el carnet, cliente recogió en tienda, etc.)" style="width:100%;min-height:50px;background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#e6edf3;padding:8px;font-size:12px;font-family:inherit;resize:vertical;"></textarea></div>' +
        '<div style="display:flex;gap:8px;">' +
          '<button onclick="resolverEscalacion(' + e.id + ',\\\'gestionada\\\')" style="background:#238636;color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600;">✅ Gestionada</button>' +
          '<button onclick="resolverEscalacion(' + e.id + ',\\\'descartada\\\')" style="background:#484f58;color:#ccc;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px;">❌ Descartar</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (err) {
    console.error('Error cargando escalaciones:', err);
  }
}

async function resolverEscalacion(id, estado) {
  const textarea = document.getElementById('escNota_' + id);
  const notas = textarea ? textarea.value.trim() : '';
  try {
    await fetch('/api/resolver-escalacion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, estado, notas })
    });
    loadEscalaciones();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function devolverAComercial(phone, btn) {
  if (!confirm('¿Devolver este cliente a la pestaña Comercial? Su status cambiará a "hot".')) return;
  const orgText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳...';
  try {
    const res = await fetch('/api/devolver-a-comercial', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    });
    const data = await res.json();
    if (data.ok) {
      btn.textContent = '✅ Listo';
      setTimeout(() => loadEscalaciones(), 1500);
    } else {
      alert('Error: ' + (data.msg || 'No se pudo cambiar el status'));
      btn.textContent = orgText;
      btn.disabled = false;
    }
  } catch (e) {
    alert('❌ Error de conexión');
    btn.textContent = orgText;
    btn.disabled = false;
  }
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
      const tipoClass = (c.tipo === 'club' || c.tipo === 'club_plus' || c.tipo === 'club_pro') ? 'tipo-club' : c.tipo === 'producto' ? 'tipo-producto' : c.tipo === 'bot_asesor' ? 'tipo-bot' : 'tipo-desconocido';
      const tipoLabel = c.tipo === 'club_plus' ? '🟡 Club Plus' : c.tipo === 'club_pro' ? '🔴 Club Pro' : c.tipo === 'club' ? '🏆 Club ZT' : c.tipo === 'producto' ? '📦 Producto' : c.tipo === 'bot_asesor' ? '🤖 Bot Asesor' : '❓ Desconocido';
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
          </div><!-- /comprobante-info -->
          <div class="comprobante-actions">
            <div style="margin-bottom:8px;">
              <span style="color:#8b949e;font-size:11px;">📋 Tipo(s) de compra:</span>
              <div id="tipoChecks_\${c.id}" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">
                <label style="display:flex;align-items:center;gap:3px;background:#111820;border:1px solid #30363d;padding:3px 8px;border-radius:4px;font-size:11px;cursor:pointer;color:#e6edf3;">
                  <input type="checkbox" value="club_plus" \${c.tipo === 'club_plus' || c.tipo === 'club' || c.tipo === 'club_y_bot' ? 'checked' : ''} style="accent-color:#d29922;"> 🟡 Club Plus ($100k)
                </label>
                <label style="display:flex;align-items:center;gap:3px;background:#111820;border:1px solid #30363d;padding:3px 8px;border-radius:4px;font-size:11px;cursor:pointer;color:#e6edf3;">
                  <input type="checkbox" value="club_pro" \${c.tipo === 'club_pro' ? 'checked' : ''} style="accent-color:#f85149;"> 🔴 Club Pro ($150k)
                </label>
                <label style="display:flex;align-items:center;gap:3px;background:#111820;border:1px solid #30363d;padding:3px 8px;border-radius:4px;font-size:11px;cursor:pointer;color:#e6edf3;">
                  <input type="checkbox" value="bot_asesor" \${c.tipo === 'bot_asesor' || c.tipo === 'club_y_bot' ? 'checked' : ''} style="accent-color:#1f6feb;"> 🤖 Bot Asesor
                </label>
                <label style="display:flex;align-items:center;gap:3px;background:#111820;border:1px solid #30363d;padding:3px 8px;border-radius:4px;font-size:11px;cursor:pointer;color:#e6edf3;">
                  <input type="checkbox" value="producto" \${c.tipo === 'producto' ? 'checked' : ''} style="accent-color:#d29922;" onchange="toggleProductoDropdown('\${c.id}', this.checked)"> 📦 Producto/Arma
                </label>
              </div>
              <div id="productoDropdown_\${c.id}" style="display:\${c.tipo === 'producto' ? 'block' : 'none'};margin-top:6px;">
                <select id="productoSelect_\${c.id}" onchange="toggleProductoInput('\${c.id}', this.value)" style="background:#111820;color:#e6edf3;border:1px solid #d29922;border-radius:4px;padding:4px 8px;font-size:11px;width:100%;margin-bottom:4px;">
                  <option value="">-- Tipo de producto --</option>
                  <option value="Pistola">🔫 Pistola</option>
                  <option value="Munición">🔴 Munición</option>
                  <option value="Otro">📦 Otro</option>
                </select>
                <input type="text" id="productoDetalle_\${c.id}" placeholder="Ej: Ekol Firat Compact Negro" style="display:none;background:#111820;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:4px 8px;font-size:11px;width:100%;box-sizing:border-box;">
              </div>
            </div>
            <button class="btn-confirmar" id="btn_confirm_\${c.id}" onclick="confirmarComprobante(\${c.id}, 'confirmar', '\${c.client_phone}')">✅ Confirmar pago</button>
            <button class="btn-rechazar" id="btn_reject_\${c.id}" onclick="confirmarComprobante(\${c.id}, 'rechazar', '\${c.client_phone}')">❌ Rechazar</button>
            <button class="btn-omitir" id="btn_omit_\${c.id}" onclick="confirmarComprobante(\${c.id}, 'omitir', '\${c.client_phone}')">⏭️ Omitir</button>
          </div>
        </div>
      \`;
    }).join('');
  } catch(e) {
    console.error('Error cargando comprobantes:', e);
  }
}

function confirmarComprobante(id, accion, phone) {
  const container = document.getElementById('tipoChecks_' + id);
  const checked = container ? Array.from(container.querySelectorAll('input[type=checkbox]:checked')).map(cb => cb.value) : [];
  
  if (accion === 'omitir') {
    if (!confirm('¿Omitir este comprobante? Se quitará del panel sin notificar al cliente.')) return;
    return accionComprobante(id, 'omitir', phone, '', '');
  }
  if (accion === 'confirmar' && checked.length === 0) {
    alert('⚠️ Selecciona al menos un tipo de compra antes de confirmar.');
    return;
  }
  
  // Enviar como string separado por comas: "club,bot_asesor" o "producto" etc.
  const tipo = checked.join(',');
  const productoSelect = document.getElementById('productoSelect_' + id);
  const productoDetalle = document.getElementById('productoDetalle_' + id);
  const prodTipo = productoSelect ? productoSelect.value : '';
  const prodDetalle = productoDetalle ? productoDetalle.value.trim() : '';
  const productoName = (checked.includes('producto') && prodTipo) ? (prodDetalle ? prodTipo + ' - ' + prodDetalle : prodTipo) : '';
  if (accion === 'confirmar' && checked.includes('producto') && !productoName) {
    alert('⚠️ Selecciona qué producto es antes de confirmar.');
    return;
  }
  accionComprobante(id, accion, phone, tipo, productoName);
}
function toggleProductoDropdown(id, show) {
  const dd = document.getElementById('productoDropdown_' + id);
  if (dd) dd.style.display = show ? 'block' : 'none';
}

function toggleProductoInput(id, val) {
  const inp = document.getElementById('productoDetalle_' + id);
  if (inp) {
    inp.style.display = val ? 'block' : 'none';
    inp.placeholder = val === 'Pistola' ? 'Ej: Ekol Firat Compact Negro' : val === 'Munición' ? 'Ej: Rubber Ball 9mm x2' : 'Ej: Funda táctica';
    inp.value = '';
  }
}

async function accionComprobante(id, accion, phone, tipo, productoName) {
  const btnConfirm = document.getElementById('btn_confirm_' + id);
  const btnReject = document.getElementById('btn_reject_' + id);
  const btnOmit = document.getElementById('btn_omit_' + id);
  if (btnConfirm) btnConfirm.disabled = true;
  if (btnReject) btnReject.disabled = true;
  if (btnOmit) btnOmit.disabled = true;
  if (accion === 'confirmar' && btnConfirm) btnConfirm.textContent = '⏳ Confirmando...';
  if (accion === 'rechazar' && btnReject) btnReject.textContent = '⏳ Rechazando...';
  if (accion === 'omitir' && btnOmit) btnOmit.textContent = '⏳ Omitiendo...';

  try {
    const controller = new AbortController();
    const _timeout = setTimeout(() => controller.abort(), 30000);
    const res = await fetch('/api/confirmar-comprobante', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, accion, phone, tipo, productoName: productoName || undefined }),
      signal: controller.signal
    });
    clearTimeout(_timeout);
    const data = await res.json();
    if (data.ok) {
      const card = document.getElementById('comp_' + id);
      if (card) {
        card.style.opacity = '0.4';
        card.style.pointerEvents = 'none';
        let status;
        if (data.accion === 'omitir' || accion === 'omitir') {
          status = '<div style="color:#8b949e;font-size:13px;font-weight:700;margin-top:8px;">⏭️ Omitido — sin notificación</div>';
        } else if (!data.waSent) {
          const accionLabel = accion === 'confirmar' ? '✅ BD actualizada' : '❌ BD actualizada';
          status = '<div style="color:#d29922;font-size:13px;font-weight:700;margin-top:8px;">' + accionLabel + ' — ⚠️ No se pudo notificar al cliente por WhatsApp (' + (data.waWarning || 'error LID') + '). Notifícalo manualmente.</div>';
        } else {
          status = accion === 'confirmar'
            ? '<div style="color:#3fb950;font-size:13px;font-weight:700;margin-top:8px;">✅ Pago confirmado — bot solicitando datos al cliente</div>'
            : '<div style="color:#f85149;font-size:13px;font-weight:700;margin-top:8px;">❌ Rechazado — bot notificó al cliente</div>';
        }
        card.querySelector('.comprobante-actions').innerHTML = status;
      }
      if (currentMainTab === 'comprobantes') setTimeout(loadComprobantes, 2000);
    } else {
      alert('❌ Error: ' + (data.error || 'No se pudo conectar con el bot'));
      if (btnConfirm) { btnConfirm.disabled = false; btnConfirm.textContent = '✅ Confirmar pago'; }
      if (btnReject) { btnReject.disabled = false; btnReject.textContent = '❌ Rechazar'; }
      if (btnOmit) { btnOmit.disabled = false; btnOmit.textContent = '⏭️ Omitir'; }
    }
  } catch(e) {
    if (e.name === 'AbortError') {
      alert('⏳ La confirmación está tardando, pero probablemente ya se procesó. Recarga para verificar.');
    } else {
      console.error('Error comprobante:', e); alert('❌ Error: ' + (e.message || 'red'));
    }
    if (btnConfirm) { btnConfirm.disabled = false; btnConfirm.textContent = '✅ Confirmar pago'; }
    if (btnReject) { btnReject.disabled = false; btnReject.textContent = '❌ Rechazar'; }
    if (btnOmit) { btnOmit.disabled = false; btnOmit.textContent = '⏭️ Omitir'; }
  }
}

// ====== CARNETS ======
async function loadCarnets() {
  try {
    const res = await fetch('/api/carnets');
    const carnets = await res.json();

    const badge = document.getElementById('carnetsBadge');
    if (carnets.length > 0) {
      badge.textContent = carnets.length;
      badge.style.display = 'inline';
    } else {
      badge.style.display = 'none';
    }

    const container = document.getElementById('carnetsList');
    if (!carnets.length) {
      container.innerHTML = '<div class="comprobante-empty">✅ No hay carnets pendientes de verificar</div>';
      return;
    }

    container.innerHTML = carnets.map(c => {
      // Re-construir data para la vista compatible
      let extraData = {
        nombre: c.nombre,
        cedula: c.cedula,
        club: 'Club ZT Plus/Pro', 
        arma: c.modelo_arma,
        serial: c.serial
      };
      
      const fecha = new Date(c.created_at).toLocaleString('es-CO');
      const imgHtml = c.imagen_base64
        ? \`<img class="comprobante-img" src="data:\${c.imagen_mime};base64,\${c.imagen_base64}" alt="carnet" onclick="openLightbox(this.src)" title="Click para ver completo">\`
        : \`<div class="comprobante-img-placeholder">📄 Sin carnet</div>\`;

      const safeDataText = encodeURIComponent(JSON.stringify({nombres: c.nombre, cedula: c.cedula, arma: c.modelo_arma, serial: c.serial}));

      return \`
        <div class="comprobante-card" id="carn_\${c.id}">
          \${imgHtml}
          <div class="comprobante-info">
            <div class="comprobante-name">\${extraData.nombre || 'Nombre no detectado'}</div>
            <div class="comprobante-phone">📱 \${c.client_phone}</div>
            <div class="comprobante-detail" style="margin-top: 5px;">
              <strong>Cédula:</strong> \${extraData.cedula || 'N/A'}<br>
              <strong>Club:</strong> \${extraData.club || 'N/A'} <br>
              <strong>Arma:</strong> \${extraData.arma || 'N/A'}<br>
              <strong>Serial:</strong> \${extraData.serial || 'N/A'}
            </div>
            <div><span class="comprobante-tipo tipo-club">🪪 Carnet ZT</span></div>
            <div class="comprobante-time">📅 \${fecha}</div>
            <div style="margin-top:8px;"><a href="https://wa.me/\${c.client_phone}" target="_blank" style="color:#3fb950;font-size:12px;text-decoration:none;">📲 Abrir en WhatsApp</a></div>
          </div><!-- /comprobante-info -->
          <div class="comprobante-actions">
            <!-- Menú de Plan y Vigencia al Aprobar -->
            <div style="margin-bottom:8px;background:#0d1117;padding:8px;border-radius:6px;border:1px dashed #30363d;">
              <div style="margin-bottom:6px;">
                <span style="color:#3fb950;font-size:11px;font-weight:bold;">✅ Plan a asignar (Aprobar):</span>
                <select id="plan_carnet_\${c.id}" style="width:100%;background:#111820;border:1px solid #3fb950;color:#e6edf3;padding:4px;border-radius:4px;font-size:12px;cursor:pointer;margin-top:4px;">
                  <option value="Plan Plus">🟡 Plan Plus ($100k) - Default</option>
                  <option value="Plan Pro">🔴 Plan Pro ($150k)</option>
                </select>
              </div>
              <div>
                <span style="color:#58a6ff;font-size:11px;font-weight:bold;">📅 Vence el (Leído por IA):</span>
                <input type="date" id="vigencia_carnet_\${c.id}" value="\${c.vigencia_hasta || ''}" style="width:100%;background:#111820;border:1px solid #1f6feb;color:#e6edf3;padding:4px;border-radius:4px;font-size:12px;margin-top:4px;">
              </div>
            </div>
            <!-- Botón Aprobar -->
            <button class="btn-confirmar" id="btn_carn_confirm_\${c.id}" onclick="accionCarnet(\${c.id}, 'confirmar', '\${c.client_phone}', '\${safeDataText}')">✅ Aprobar y Actualizar Ficha</button>

            <!-- Menú de Razón al Rechazar -->
            <div style="margin-top:12px;margin-bottom:8px;">
              <span style="color:#f85149;font-size:11px;">❌ Razón de rechazo:</span>
              <select id="razon_rechazo_\${c.id}" style="width:100%;background:#111820;border:1px solid #f85149;color:#e6edf3;padding:4px;border-radius:4px;font-size:12px;cursor:pointer;margin-top:4px;">
                <option value="ilegible">📄 Ilegible o borroso</option>
                <option value="vencido">⏳ Documento vencido</option>
                <option value="inconsistencia">🚫 Inconsistencia en datos / Falso</option>
                <option value="otro_club">🚫 Carnet de otro club</option>
              </select>
            </div>
            <!-- Botón Rechazar -->
            <button class="btn-rechazar" id="btn_carn_reject_\${c.id}" onclick="accionCarnet(\${c.id}, 'rechazar', '\${c.client_phone}', '')">❌ Notificar Rechazo</button>
            <button style="margin-top:8px;width:100%;background:#21262d;border:1px solid #30363d;color:#8b949e;padding:7px 12px;border-radius:6px;font-size:12px;cursor:pointer;font-family:'Chakra Petch',sans-serif;font-weight:600;" id="btn_carn_omit_\${c.id}" onclick="accionCarnet(\${c.id}, 'omitir', '\${c.client_phone}', '')">⏭️ Omitir (sin notificar)</button>
          </div>
        </div>
      \`;
    }).join('');
  } catch(e) {
    console.error('Error cargando carnets:', e);
  }
}

async function accionCarnet(id, accion, phone, carnetDataEncoded) {
  const btnConfirm = document.getElementById('btn_carn_confirm_' + id);
  const btnReject = document.getElementById('btn_carn_reject_' + id);
  if (btnConfirm) btnConfirm.disabled = true;
  if (btnReject) btnReject.disabled = true;
  
  if (accion === 'confirmar' && btnConfirm) btnConfirm.textContent = '⏳ Aprobando...';
  if (accion === 'rechazar' && btnReject) btnReject.textContent = '⏳ Rechazando...';

  let carnetData = {};
  try {
    if (carnetDataEncoded) {
      carnetData = JSON.parse(decodeURIComponent(carnetDataEncoded));
    }
  } catch(e) {}

  // Extraer plan, vigencia o razón de rechazo de los UI seleccionados
  let planAprobado = null;
  let vigenciaAprobada = null;
  let razonRechazo = null;

  if (accion === 'confirmar') {
    const selPlan = document.getElementById('plan_carnet_' + id);
    if (selPlan) planAprobado = selPlan.value;
    const inputVigencia = document.getElementById('vigencia_carnet_' + id);
    if (inputVigencia) vigenciaAprobada = inputVigencia.value;

    if (!vigenciaAprobada) {
      if (!confirm('⚠️ No has ingresado la fecha de vigencia del carnet. ¿Deseas aprobarlo sin fecha de expiración?')) return;
    }
  } else if (accion === 'rechazar') {
    const selRazon = document.getElementById('razon_rechazo_' + id);
    if (selRazon) razonRechazo = selRazon.value;
  }

  try {
    const res = await fetch('/api/confirmar-carnet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, accion, phone, carnetData, planAprobado, vigenciaAprobada, razonRechazo })
    });
    const data = await res.json();
    if (data.ok) {
      const card = document.getElementById('carn_' + id);
      if (card) {
        card.style.opacity = '0.4';
        card.style.pointerEvents = 'none';
        let status;
        if (!data.waSent) {
          status = '<div style="color:#d29922;font-size:13px;font-weight:700;margin-top:8px;">⚠️ BD actualizada pero falló WhatsApp.</div>';
        } else {
          status = accion === 'confirmar'
            ? '<div style="color:#3fb950;font-size:13px;font-weight:700;margin-top:8px;">✅ Carnet Aprobado y Perfil Actualizado</div>'
            : '<div style="color:#f85149;font-size:13px;font-weight:700;margin-top:8px;">❌ Rechazado — bot notificó al cliente</div>';
        }
        card.querySelector('.comprobante-actions').innerHTML = status;
      }
      if (currentMainTab === 'carnets') setTimeout(loadCarnets, 2000);
    } else {
      alert('❌ Error: ' + (data.error || 'No se pudo conectar con el bot'));
      if (btnConfirm) { btnConfirm.disabled = false; btnConfirm.textContent = '✅ Aprobar y Actualizar Ficha'; }
      if (btnReject) { btnReject.disabled = false; btnReject.textContent = '❌ Rechazar (Ilegible/Falso)'; }
    }
  } catch(e) {
    console.error('Error comprobante:', e); alert('❌ Error: ' + (e.message || 'red'));
    if (btnConfirm) { btnConfirm.disabled = false; btnConfirm.textContent = '✅ Aprobar y Actualizar Ficha'; }
    if (btnReject) { btnReject.disabled = false; btnReject.textContent = '❌ Rechazar (Ilegible/Falso)'; }
  }
}


// ===== BROADCAST TAB =====

function renderBroadcastTab() {
  var container = document.getElementById('broadcastContent');
  if (!container) return;
  container.innerHTML = '';

  // Header
  var header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;';
  var headerLeft = document.createElement('div');
  var h2 = document.createElement('h2');
  h2.style.cssText = 'color:#c084fc;font-family:"Chakra Petch",sans-serif;font-size:20px;margin:0;';
  h2.textContent = '\u{1F4E2} Centro de Broadcast';
  var p = document.createElement('p');
  p.style.cssText = 'color:#7d8590;font-size:12px;margin:4px 0 0 0;';
  p.textContent = 'Env\u00edos autom\u00e1ticos a grupos y estados, y blast masivo al CRM';
  headerLeft.appendChild(h2); headerLeft.appendChild(p);
  var refreshBtn = document.createElement('button');
  refreshBtn.onclick = loadBroadcastStatus;
  refreshBtn.style.cssText = 'background:#1c2733;color:#58a6ff;border:1px solid #30363d;padding:8px 14px;border-radius:6px;cursor:pointer;font-size:12px;';
  refreshBtn.textContent = '\u{1F504} Actualizar';
  header.appendChild(headerLeft); header.appendChild(refreshBtn);
  container.appendChild(header);

  // Cards de grupos y estados
  var grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;';

  function makeSchedulerCard(id, label, hours, queueId, sendType) {
    var card = document.createElement('div');
    card.style.cssText = 'background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:16px;';
    
    var topRow = document.createElement('div');
    topRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;';
    var lbl = document.createElement('span');
    lbl.style.cssText = 'color:#e6edf3;font-weight:700;font-size:13px;';
    lbl.textContent = label;
    
    var toggleWrap = document.createElement('div');
    toggleWrap.id = 'toggle' + id + 'Wrap';
    toggleWrap.style.cssText = 'width:44px;height:24px;background:#2d1a3a;border-radius:12px;cursor:pointer;position:relative;border:1px solid #6b21a8;transition:background 0.2s;';
    toggleWrap.onclick = function() { toggleBroadcast(sendType); };
    var thumb = document.createElement('div');
    thumb.id = 'toggle' + id + 'Thumb';
    thumb.style.cssText = 'width:18px;height:18px;background:#6b21a8;border-radius:50%;position:absolute;top:2px;left:2px;transition:left 0.2s;';
    toggleWrap.appendChild(thumb);
    
    topRow.appendChild(lbl); topRow.appendChild(toggleWrap);
    card.appendChild(topRow);
    
    var hoursDiv = document.createElement('div');
    hoursDiv.style.cssText = 'color:#7d8590;font-size:11px;';
    hoursDiv.textContent = 'Horarios: ' + hours + ' (hora Colombia)';
    card.appendChild(hoursDiv);
    
    var queueDiv = document.createElement('div');
    queueDiv.id = queueId;
    queueDiv.style.cssText = 'color:#7d8590;font-size:11px;margin-top:4px;';
    queueDiv.textContent = 'Cargando...';
    card.appendChild(queueDiv);
    
    var btn = document.createElement('button');
    btn.style.cssText = 'margin-top:10px;background:#1a3a2a;color:#3fb950;border:1px solid #238636;padding:5px 12px;border-radius:5px;cursor:pointer;font-size:11px;font-weight:700;width:100%;';
    btn.textContent = '\u26A1 Enviar Ahora';
    btn.onclick = function() { sendBroadcastNow(sendType); };
    card.appendChild(btn);
    return card;
  }

  grid.appendChild(makeSchedulerCard('Groups', '\u{1F465} Grupos', '8h, 13h, 19h', 'groupsQueueInfo', 'groups'));
  grid.appendChild(makeSchedulerCard('Status', '\u{1F4F8} Estados', '9h, 14h, 18h, 22h', 'statusQueueInfo', 'status'));
  container.appendChild(grid);

  // Blast CRM
  var blastCard = document.createElement('div');
  blastCard.style.cssText = 'background:#0d1117;border:1px solid rgba(107,33,168,0.27);border-radius:10px;padding:18px;';
  
  var blastHeader = document.createElement('div');
  blastHeader.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:14px;';
  var blastIcon = document.createElement('span');
  blastIcon.style.fontSize = '18px';
  blastIcon.textContent = '\u{1F3AF}';
  var blastInfo = document.createElement('div');
  var blastTitle = document.createElement('div');
  blastTitle.style.cssText = 'color:#c084fc;font-weight:700;font-size:14px;font-family:"Chakra Petch",sans-serif;';
  blastTitle.textContent = 'Blast Masivo CRM';
  var blastDesc = document.createElement('div');
  blastDesc.style.cssText = 'color:#7d8590;font-size:11px;';
  blastDesc.textContent = 'Env\u00eda un mensaje a un segmento de tu base de datos';
  blastInfo.appendChild(blastTitle); blastInfo.appendChild(blastDesc);
  blastHeader.appendChild(blastIcon); blastHeader.appendChild(blastInfo);
  blastCard.appendChild(blastHeader);

  // Segmentos
  var segLabel = document.createElement('label');
  segLabel.style.cssText = 'color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;display:block;margin-bottom:6px;';
  segLabel.textContent = 'Segmento destino';
  blastCard.appendChild(segLabel);
  
  var segRow = document.createElement('div');
  segRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;';
  var segs = [
    { id: 'todos', label: '\u{1F310} Todos', color: '#58a6ff' },
    { id: 'hot', label: '\u{1F525} Hot/Warm', color: '#f85149' },
    { id: 'nuevos', label: '\u{1F195} Nuevos', color: '#58a6ff' },
    { id: 'afiliados', label: '\u2705 Afiliados', color: '#3fb950' },
    { id: 'no_afiliados', label: '\u23F3 No Afiliados', color: '#d29922' }
  ];
  segs.forEach(function(s) {
    var sbtn = document.createElement('button');
    sbtn.id = 'blseg_' + s.id;
    sbtn.style.cssText = 'background:#1c2733;color:' + s.color + ';border:1px solid #30363d;padding:5px 12px;border-radius:5px;cursor:pointer;font-size:11px;';
    sbtn.textContent = s.label;
    sbtn.onclick = function() { selectBlastSeg(s.id, sbtn); };
    segRow.appendChild(sbtn);
  });
  blastCard.appendChild(segRow);
  
  var segPreview = document.createElement('div');
  segPreview.id = 'blastSegPreview';
  segPreview.style.cssText = 'color:#7d8590;font-size:11px;margin-bottom:12px;';
  segPreview.textContent = 'Selecciona segmento \u2192 Estimar \u2192 Lanzar';
  blastCard.appendChild(segPreview);

  // Textarea del mensaje
  var msgLabel = document.createElement('label');
  msgLabel.style.cssText = 'color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;display:block;margin-bottom:6px;';
  msgLabel.textContent = 'Mensaje';
  blastCard.appendChild(msgLabel);
  var textarea = document.createElement('textarea');
  textarea.id = 'blastMsg';
  textarea.placeholder = 'Escribe el mensaje que recibiran los clientes del segmento...';
  textarea.style.cssText = 'width:100%;min-height:90px;background:#161b22;border:1px solid #30363d;border-radius:6px;color:#e6edf3;padding:10px;font-size:13px;font-family:inherit;resize:vertical;box-sizing:border-box;';
  blastCard.appendChild(textarea);
  var warn = document.createElement('div');
  warn.style.cssText = 'color:#7d8590;font-size:10px;margin:4px 0 12px 0;';
  warn.textContent = '\u26A0\uFE0F Se envia tal cual. Revisalo bien antes de lanzar.';
  blastCard.appendChild(warn);

  // Botones de acción
  var actRow = document.createElement('div');
  actRow.style.cssText = 'display:flex;gap:8px;align-items:center;';
  var estBtn = document.createElement('button');
  estBtn.onclick = estimarBlast;
  estBtn.style.cssText = 'background:#1c2733;color:#d29922;border:1px solid #d29922;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700;';
  estBtn.textContent = '\u{1F50D} Estimar Alcance';
  var sendBtn = document.createElement('button');
  sendBtn.onclick = lanzarBlast;
  sendBtn.style.cssText = 'background:linear-gradient(135deg,#6b21a8,#9333ea);color:white;border:none;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700;font-family:"Chakra Petch",sans-serif;';
  sendBtn.textContent = '\u{1F4E2} LANZAR BLAST';
  var feedbackDiv = document.createElement('div');
  feedbackDiv.id = 'blastFeedback';
  feedbackDiv.style.cssText = 'flex:1;font-size:12px;';
  actRow.appendChild(estBtn); actRow.appendChild(sendBtn); actRow.appendChild(feedbackDiv);
  blastCard.appendChild(actRow);

  container.appendChild(blastCard);

  // Seleccionar 'todos' por defecto
  selectBlastSeg('todos', document.getElementById('blseg_todos'));
}

var blastSegmento = 'todos';
var bgEnabled = false, bsEnabled = false;

function selectBlastSeg(seg, btn) {
  blastSegmento = seg;
  ['todos','hot','nuevos','afiliados','no_afiliados'].forEach(function(s) {
    var b = document.getElementById('blseg_' + s);
    if (b) { b.style.border = '1px solid #30363d'; b.style.fontWeight = '400'; }
  });
  if (btn) { btn.style.border = '2px solid #c084fc'; btn.style.fontWeight = '700'; }
  var pv = document.getElementById('blastSegPreview');
  if (pv) pv.textContent = 'Segmento: ' + seg + ' \u2014 haz clic en Estimar para ver el alcance';
}

async function estimarBlast() {
  var msg = (document.getElementById('blastMsg') || {}).value || 'PREVIEW';
  try {
    var r = await fetch('/api/broadcast/blast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mensaje: msg || 'PREVIEW', segmento: blastSegmento, preview: true }) });
    var d = await r.json();
    var pv = document.getElementById('blastSegPreview');
    if (d.ok && pv) pv.innerHTML = '<span style="color:#d29922;font-weight:700;">\u{1F4CA} ' + d.total + ' clientes</span>' + (d.muestra ? ' \u2014 ej: ' + d.muestra.join(', ') : '');
  } catch(e) { console.error('Error estimando:', e); }
}

// Cola de destinatarios activa para el blast
var _blastQueue = [];
var _blastMsg = '';

async function lanzarBlast() {
  var msgEl = document.getElementById('blastMsg');
  var msg = msgEl ? msgEl.value.trim() : '';
  if (!msg) { alert('Escribe el mensaje primero'); return; }
  var fb = document.getElementById('blastFeedback');
  if (fb) fb.innerHTML = '<span style="color:#d29922;">\u23F3 Cargando lista de destinatarios...</span>';

  try {
    var r = await fetch('/api/broadcast/blast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mensaje: msg, segmento: blastSegmento, preview: true })
    });
    var d = await r.json();
    if (!d.ok) {
      if (fb) fb.innerHTML = '<span style="color:#f85149;">\u274C ' + (d.msg || 'Error al cargar') + '</span>';
      return;
    }
    _blastQueue = (d.clientes || []).map(function(cl) { return { phone: cl.phone, name: cl.name || cl.phone, status: cl.status || '', checked: true }; });
    _blastMsg = msg;
    if (fb) fb.textContent = '';
    abrirQueueModal();
  } catch(e) {
    if (fb) fb.innerHTML = '<span style="color:#f85149;">\u274C Error de conexi\u00f3n</span>';
  }
}

function abrirQueueModal() {
  // Remover modal previo si existe
  var prev = document.getElementById('blastQueueModal');
  if (prev) prev.parentNode.removeChild(prev);

  var modal = document.createElement('div');
  modal.id = 'blastQueueModal';
  modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;';

  var box = document.createElement('div');
  box.style.cssText = 'background:#0d1117;border:1px solid #6b21a8;border-radius:12px;width:680px;max-width:95vw;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;';

  // Header del modal
  var hdr = document.createElement('div');
  hdr.style.cssText = 'padding:16px 20px;border-bottom:1px solid #21262d;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;';
  var hdrLeft = document.createElement('div');
  var hdrTitle = document.createElement('div');
  hdrTitle.style.cssText = 'color:#c084fc;font-weight:700;font-size:16px;font-family:"Chakra Petch",sans-serif;';
  hdrTitle.textContent = '\u{1F4CB} Confirmar Cola de Broadcast';
  var hdrSub = document.createElement('div');
  hdrSub.style.cssText = 'color:#7d8590;font-size:11px;margin-top:2px;';
  hdrSub.textContent = 'Revisa y ajusta los destinatarios antes de enviar';
  hdrLeft.appendChild(hdrTitle); hdrLeft.appendChild(hdrSub);
  var closeBtn = document.createElement('button');
  closeBtn.onclick = function() { modal.parentNode.removeChild(modal); };
  closeBtn.style.cssText = 'background:none;border:none;color:#7d8590;font-size:20px;cursor:pointer;padding:4px 8px;';
  closeBtn.textContent = '\u00D7';
  hdr.appendChild(hdrLeft); hdr.appendChild(closeBtn);
  box.appendChild(hdr);

  // Preview del mensaje
  var msgPreview = document.createElement('div');
  msgPreview.style.cssText = 'margin:12px 20px;background:#161b22;border:1px solid #30363d;border-radius:6px;padding:10px 14px;color:#e6edf3;font-size:12px;line-height:1.5;flex-shrink:0;max-height:80px;overflow-y:auto;';
  msgPreview.textContent = _blastMsg;
  box.appendChild(msgPreview);

  // Toolbar: seleccionar todos / quitar spam
  var toolbar = document.createElement('div');
  toolbar.style.cssText = 'padding:8px 20px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #21262d;flex-shrink:0;';
  var countLabel = document.createElement('span');
  countLabel.id = 'queueCount';
  countLabel.style.cssText = 'color:#7d8590;font-size:12px;flex:1;';
  
  function updateCount() {
    var sel = _blastQueue.filter(function(x) { return x.checked; }).length;
    countLabel.textContent = sel + ' de ' + _blastQueue.length + ' destinatarios seleccionados';
  }
  updateCount();

  var selAllBtn = document.createElement('button');
  selAllBtn.style.cssText = 'background:#1c2733;color:#58a6ff;border:1px solid #30363d;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;';
  selAllBtn.textContent = '\u2705 Todos';
  selAllBtn.onclick = function() {
    _blastQueue.forEach(function(x) { x.checked = true; });
    renderQueueRows();
    updateCount();
  };
  var deselBtn = document.createElement('button');
  deselBtn.style.cssText = 'background:#1c2733;color:#f85149;border:1px solid #30363d;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;';
  deselBtn.textContent = '\u274C Ninguno';
  deselBtn.onclick = function() {
    _blastQueue.forEach(function(x) { x.checked = false; });
    renderQueueRows();
    updateCount();
  };
  var searchInput = document.createElement('input');
  searchInput.placeholder = '\u{1F50D} Buscar...';
  searchInput.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:4px;color:#e6edf3;padding:4px 8px;font-size:11px;width:140px;';
  searchInput.oninput = function() { renderQueueRows(searchInput.value.toLowerCase()); };
  toolbar.appendChild(countLabel); toolbar.appendChild(selAllBtn); toolbar.appendChild(deselBtn); toolbar.appendChild(searchInput);
  box.appendChild(toolbar);

  // Lista de destinatarios
  var listContainer = document.createElement('div');
  listContainer.id = 'queueListContainer';
  listContainer.style.cssText = 'overflow-y:auto;flex:1;padding:8px 20px;';

  var STATUS_COLORS = { hot: '#f85149', warm: '#d29922', afiliado: '#3fb950', new: '#58a6ff', prospect: '#58a6ff', completed: '#8b949e' };

  function renderQueueRows(filter) {
    listContainer.innerHTML = '';
    var filtered = filter ? _blastQueue.filter(function(x) { return (x.name + x.phone).toLowerCase().includes(filter); }) : _blastQueue;
    
    filtered.forEach(function(item) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 4px;border-bottom:1px solid #161b22;';
      
      var chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = item.checked;
      chk.style.cssText = 'width:16px;height:16px;cursor:pointer;accent-color:#9333ea;';
      chk.onchange = function() { item.checked = chk.checked; updateCount(); };
      
      var nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'flex:1;color:#e6edf3;font-size:12px;';
      nameSpan.textContent = item.name || item.phone;
      
      var phoneSpan = document.createElement('span');
      phoneSpan.style.cssText = 'color:#7d8590;font-size:11px;font-family:monospace;';
      phoneSpan.textContent = item.phone;
      
      var statusBadge = document.createElement('span');
      statusBadge.style.cssText = 'font-size:10px;padding:2px 6px;border-radius:3px;background:#1c2733;color:' + (STATUS_COLORS[item.status] || '#7d8590') + ';border:1px solid currentColor;';
      statusBadge.textContent = item.status || '?';
      
      var removeBtn = document.createElement('button');
      removeBtn.style.cssText = 'background:none;border:none;color:#f85149;cursor:pointer;font-size:13px;padding:0 2px;';
      removeBtn.textContent = '\u{1F5D1}';
      removeBtn.title = 'Eliminar de la cola';
      removeBtn.onclick = function() {
        _blastQueue = _blastQueue.filter(function(x) { return x.phone !== item.phone; });
        row.parentNode.removeChild(row);
        updateCount();
      };
      
      row.appendChild(chk); row.appendChild(nameSpan); row.appendChild(phoneSpan); row.appendChild(statusBadge); row.appendChild(removeBtn);
      listContainer.appendChild(row);
    });
    
    if (filtered.length === 0) {
      var empty = document.createElement('div');
      empty.style.cssText = 'text-align:center;color:#7d8590;padding:30px;font-size:13px;';
      empty.textContent = filter ? 'No hay resultados para "' + filter + '"' : 'Cola vac\u00eda';
      listContainer.appendChild(empty);
    }
  }
  renderQueueRows();
  box.appendChild(listContainer);

  // Footer con botones de confirmar
  var footer = document.createElement('div');
  footer.style.cssText = 'padding:14px 20px;border-top:1px solid #21262d;display:flex;align-items:center;gap:10px;flex-shrink:0;';
  var cancelBtn2 = document.createElement('button');
  cancelBtn2.onclick = function() { modal.parentNode.removeChild(modal); };
  cancelBtn2.style.cssText = 'background:#1c2733;color:#7d8590;border:1px solid #30363d;padding:10px 20px;border-radius:6px;cursor:pointer;font-size:13px;';
  cancelBtn2.textContent = 'Cancelar';
  var confirmBtn = document.createElement('button');
  confirmBtn.style.cssText = 'background:linear-gradient(135deg,#1a6b2d,#238636);color:white;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:700;font-family:"Chakra Petch",sans-serif;';
  confirmBtn.id = 'blastConfirmBtn';
  
  function updateConfirmBtn() {
    var sel = _blastQueue.filter(function(x) { return x.checked; }).length;
    confirmBtn.textContent = '\u{1F4E8} CONFIRMAR ENV\u00cdO (' + sel + ' mensajes)';
  }
  updateConfirmBtn();
  
  // Observer para actualizar el botón cuando cambia el count
  var origUpdateCount = updateCount;
  updateCount = function() { origUpdateCount(); updateConfirmBtn(); };

  var statusDiv = document.createElement('div');
  statusDiv.style.cssText = 'flex:1;font-size:12px;';

  confirmBtn.onclick = async function() {
    var selectedPhones = _blastQueue.filter(function(x) { return x.checked; }).map(function(x) { return x.phone; });
    if (selectedPhones.length === 0) { alert('No hay destinatarios seleccionados'); return; }
    confirmBtn.disabled = true;
    confirmBtn.textContent = '\u23F3 Enviando...';
    statusDiv.innerHTML = '<span style="color:#d29922;">Iniciando blast de ' + selectedPhones.length + ' mensajes...</span>';
    try {
      var r = await fetch('/api/broadcast/blast-confirmed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mensaje: _blastMsg, phones: selectedPhones })
      });
      var d = await r.json();
      if (d.ok) {
        statusDiv.innerHTML = '<span style="color:#3fb950;">\u2705 ' + d.msg + '</span>';
        confirmBtn.textContent = '\u2705 Enviando en background';
        setTimeout(function() { modal.parentNode.removeChild(modal); }, 2500);
        var fb = document.getElementById('blastFeedback');
        if (fb) fb.innerHTML = '<span style="color:#3fb950;">\u2705 Blast confirmado: ' + selectedPhones.length + ' mensajes en cola</span>';
      } else {
        statusDiv.innerHTML = '<span style="color:#f85149;">\u274C ' + (d.msg || 'Error') + '</span>';
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Reintentar';
      }
    } catch(e) {
      statusDiv.innerHTML = '<span style="color:#f85149;">\u274C Error de conexi\u00f3n</span>';
      confirmBtn.disabled = false;
    }
  };
  footer.appendChild(cancelBtn2); footer.appendChild(confirmBtn); footer.appendChild(statusDiv);
  box.appendChild(footer);

  modal.appendChild(box);
  modal.onclick = function(e) { if (e.target === modal) modal.parentNode.removeChild(modal); };
  document.body.appendChild(modal);
}

async function loadBroadcastStatus() {
  try {
    var r = await fetch('/api/broadcast/status');
    var d = await r.json();
    if (!d.ok) return;
    var s = d.settings || {};
    bgEnabled = !!s.groups_enabled; bsEnabled = !!s.status_enabled;
    _setToggle('Groups', bgEnabled); _setToggle('Status', bsEnabled);
    var gq = d.queues.groups; var sq = d.queues.status;
    var gi = document.getElementById('groupsQueueInfo'); if (gi) gi.textContent = 'Cola: ' + Math.max(0, gq.total - gq.current) + ' img restantes (' + gq.current + '/' + gq.total + ')';
    var si = document.getElementById('statusQueueInfo'); if (si) si.textContent = 'Cola: ' + Math.max(0, sq.total - sq.current) + ' img restantes (' + sq.current + '/' + sq.total + ')';
  } catch(e) { console.log('Broadcast status no disponible:', e.message); }
}

function _setToggle(id, on) {
  var wrap = document.getElementById('toggle' + id + 'Wrap');
  var thumb = document.getElementById('toggle' + id + 'Thumb');
  if (!wrap || !thumb) return;
  wrap.style.background = on ? '#1a3a2a' : '#2d1a3a';
  wrap.style.borderColor = on ? '#238636' : '#6b21a8';
  thumb.style.background = on ? '#3fb950' : '#6b21a8';
  thumb.style.left = on ? '22px' : '2px';
}

async function toggleBroadcast(type) {
  var cur = type === 'groups' ? bgEnabled : bsEnabled;
  var nv = !cur;
  if (type === 'groups') bgEnabled = nv; else bsEnabled = nv;
  _setToggle(type === 'groups' ? 'Groups' : 'Status', nv);
  try {
    var payload = type === 'groups' ? { groups_enabled: nv } : { status_enabled: nv };
    var r = await fetch('/api/broadcast/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    var d = await r.json();
    if (d.ok) { bgEnabled = !!d.settings.groups_enabled; bsEnabled = !!d.settings.status_enabled; _setToggle('Groups', bgEnabled); _setToggle('Status', bsEnabled); }
  } catch(e) { if (type === 'groups') bgEnabled = !nv; else bsEnabled = !nv; _setToggle(type === 'groups' ? 'Groups' : 'Status', !nv); }
}

async function sendBroadcastNow(type) {
  // Abrir modal de preview en vez de enviar directamente
  if (type === 'groups') {
    await abrirGruposModal();
  } else if (type === 'status') {
    await abrirStatusModal();
  }
}

async function abrirGruposModal() {
  var loadDiv = document.getElementById('groupsQueueInfo');
  if (loadDiv) loadDiv.textContent = 'Cargando preview...';
  var prev = document.getElementById('gruposPreviewModal');
  if (prev) prev.parentNode.removeChild(prev);

  var data;
  try {
    var r = await fetch('/api/broadcast/groups-preview');
    data = await r.json();
  } catch(e) { alert('Error conectando con el bot'); return; }
  if (!data.ok) { alert('Error: ' + (data.msg || 'Sin datos')); return; }

  var modal = document.createElement('div');
  modal.id = 'gruposPreviewModal';
  modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;';

  var box = document.createElement('div');
  box.style.cssText = 'background:#0d1117;border:1px solid #6b21a8;border-radius:12px;width:720px;max-width:96vw;max-height:88vh;display:flex;flex-direction:column;overflow:hidden;';

  // Header
  var hdr = document.createElement('div');
  hdr.style.cssText = 'padding:14px 20px;border-bottom:1px solid #21262d;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;';
  var htxt = document.createElement('div');
  var htitle = document.createElement('div');
  htitle.style.cssText = 'color:#c084fc;font-weight:700;font-size:15px;font-family:"Chakra Petch",sans-serif;';
  htitle.textContent = '\u{1F465} Broadcast a Grupos — Confirmar Envio';
  var hsub = document.createElement('div');
  hsub.style.cssText = 'color:#7d8590;font-size:11px;margin-top:2px;';
  hsub.textContent = 'Rev\u00edsa la imagen y los grupos destino antes de enviar';
  htxt.appendChild(htitle); htxt.appendChild(hsub);
  var xbtn = document.createElement('button');
  xbtn.onclick = function() { modal.parentNode.removeChild(modal); };
  xbtn.style.cssText = 'background:none;border:none;color:#7d8590;font-size:20px;cursor:pointer;';
  xbtn.textContent = '\u00D7';
  hdr.appendChild(htxt); hdr.appendChild(xbtn);
  box.appendChild(hdr);

  // Layout: imagen izq + grupos der
  var body = document.createElement('div');
  body.style.cssText = 'display:flex;gap:0;flex:1;overflow:hidden;';

  // Panel izquierdo: imagen + caption
  var imgPanel = document.createElement('div');
  imgPanel.style.cssText = 'width:280px;flex-shrink:0;border-right:1px solid #21262d;padding:14px;display:flex;flex-direction:column;gap:10px;overflow-y:auto;';

  if (data.nextImage) {
    var imgTitle = document.createElement('div');
    imgTitle.style.cssText = 'color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:0.8px;';
    imgTitle.textContent = 'IMAGEN A ENVIAR';
    imgPanel.appendChild(imgTitle);

    var imgEl = document.createElement('img');
    imgEl.src = '/api/broadcast/image?path=' + encodeURIComponent(data.nextImage.relativePath);
    imgEl.style.cssText = 'width:100%;border-radius:6px;border:1px solid #21262d;object-fit:cover;max-height:200px;';
    imgEl.onerror = function() { imgEl.style.display='none'; noImgDiv.style.display='flex'; };
    var noImgDiv = document.createElement('div');
    noImgDiv.style.cssText = 'display:none;background:#161b22;border:1px solid #30363d;border-radius:6px;height:120px;align-items:center;justify-content:center;color:#7d8590;font-size:12px;';
    noImgDiv.textContent = '\u{1F5BC}\uFE0F Imagen no disponible';
    imgPanel.appendChild(imgEl); imgPanel.appendChild(noImgDiv);

    var pathDiv = document.createElement('div');
    pathDiv.style.cssText = 'color:#7d8590;font-size:10px;word-break:break-all;background:#161b22;padding:4px 6px;border-radius:4px;';
    pathDiv.textContent = data.nextImage.relativePath;
    imgPanel.appendChild(pathDiv);

    if (data.nextImage.productoInfo) {
      var pi = data.nextImage.productoInfo;
      var prodDiv = document.createElement('div');
      prodDiv.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:6px;padding:8px;font-size:11px;';
      var prodTitle = document.createElement('div');
      prodTitle.style.cssText = 'color:#c084fc;font-weight:700;margin-bottom:4px;';
      prodTitle.textContent = pi.titulo || 'Producto';
      var prodInfo = document.createElement('div');
      prodInfo.style.cssText = 'color:#7d8590;line-height:1.6;';
      prodInfo.innerHTML = '\u{1F3F7}\uFE0F ' + (pi.marca||'') + '<br>\u{1F4B2} Plus: ' + (pi.precio_plus||'-') + ' | Pro: ' + (pi.precio_pro||'-');
      prodDiv.appendChild(prodTitle); prodDiv.appendChild(prodInfo);
      imgPanel.appendChild(prodDiv);
    }

    // Texto personalizado
    var txtLabel = document.createElement('div');
    txtLabel.style.cssText = 'color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:0.8px;';
    txtLabel.textContent = 'TEXTO (dejar vac\u00edo para auto-generar con IA)';
    imgPanel.appendChild(txtLabel);
    var txtArea = document.createElement('textarea');
    txtArea.id = 'gruposBroadcastText';
    txtArea.placeholder = '(Se generar\u00e1 autom\u00e1ticamente con Gemini IA...)';
    txtArea.style.cssText = 'width:100%;min-height:70px;background:#161b22;border:1px solid #30363d;border-radius:4px;color:#e6edf3;padding:6px;font-size:11px;resize:vertical;box-sizing:border-box;';
    imgPanel.appendChild(txtArea);

    // Botón saltar imagen
    var skipBtn = document.createElement('button');
    skipBtn.style.cssText = 'background:#1c2733;color:#d29922;border:1px solid #d29922;padding:6px;border-radius:5px;cursor:pointer;font-size:11px;';
    skipBtn.textContent = '\u23E9 Saltar esta imagen';
    skipBtn.onclick = async function() {
      var r2 = await fetch('/api/broadcast/skip-image', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ type: 'groups' }) });
      var d2 = await r2.json();
      if (d2.ok) {
        pathDiv.textContent = d2.nextImage ? d2.nextImage.relativePath : 'Fin de cola';
        imgEl.src = d2.nextImage ? '/api/broadcast/image?path=' + encodeURIComponent(d2.nextImage.relativePath) : '';
        var qi = document.getElementById('queuePosGroups');
        if (qi) qi.textContent = 'Pos ' + d2.newIndex + '/' + d2.total;
      }
    };
    imgPanel.appendChild(skipBtn);

    var queuePos = document.createElement('div');
    queuePos.id = 'queuePosGroups';
    queuePos.style.cssText = 'color:#7d8590;font-size:10px;text-align:center;';
    queuePos.textContent = 'Pos ' + data.queuePos + '/' + data.queueTotal;
    imgPanel.appendChild(queuePos);
  } else {
    var noQueue = document.createElement('div');
    noQueue.style.cssText = 'color:#f85149;font-size:12px;text-align:center;padding:20px;';
    noQueue.textContent = '\u274C No hay im\u00e1genes en la cola';
    imgPanel.appendChild(noQueue);
  }
  body.appendChild(imgPanel);

  // Panel derecho: grupos
  var groupsPanel = document.createElement('div');
  groupsPanel.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:hidden;';

  var gHeader = document.createElement('div');
  gHeader.style.cssText = 'padding:10px 14px;border-bottom:1px solid #21262d;display:flex;align-items:center;gap:8px;flex-shrink:0;';
  var gCount = document.createElement('span');
  gCount.style.cssText = 'color:#7d8590;font-size:12px;flex:1;';

  var grupos = data.grupos || [];
  var gruposChecked = grupos.map(function(g) { return { id: g.id, name: g.name, participants: g.participants, checked: true }; });

  function updateGroupCount() {
    var sel = gruposChecked.filter(function(x) { return x.checked; }).length;
    gCount.textContent = sel + ' de ' + gruposChecked.length + ' grupos seleccionados';
  }
  updateGroupCount();

  var selAllG = document.createElement('button');
  selAllG.style.cssText = 'background:#1c2733;color:#58a6ff;border:1px solid #30363d;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:11px;';
  selAllG.textContent = '\u2705 Todos';
  selAllG.onclick = function() { gruposChecked.forEach(function(x){x.checked=true;}); renderGroups(); updateGroupCount(); };
  var deselG = document.createElement('button');
  deselG.style.cssText = 'background:#1c2733;color:#f85149;border:1px solid #30363d;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:11px;';
  deselG.textContent = '\u274C Ninguno';
  deselG.onclick = function() { gruposChecked.forEach(function(x){x.checked=false;}); renderGroups(); updateGroupCount(); };
  gHeader.appendChild(gCount); gHeader.appendChild(selAllG); gHeader.appendChild(deselG);
  groupsPanel.appendChild(gHeader);

  var gList = document.createElement('div');
  gList.style.cssText = 'overflow-y:auto;flex:1;padding:8px 14px;';

  function renderGroups() {
    gList.innerHTML = '';
    if (gruposChecked.length === 0) {
      var noG = document.createElement('div');
      noG.style.cssText = 'text-align:center;color:#7d8590;padding:30px;font-size:13px;';
      noG.textContent = 'No se encontraron grupos en WhatsApp';
      gList.appendChild(noG);
      return;
    }
    gruposChecked.forEach(function(g) {
      var row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 4px;border-bottom:1px solid #161b22;';
      var chk = document.createElement('input');
      chk.type = 'checkbox'; chk.checked = g.checked;
      chk.style.cssText = 'width:15px;height:15px;cursor:pointer;accent-color:#9333ea;';
      chk.onchange = function() { g.checked = chk.checked; updateGroupCount(); };
      var lbl = document.createElement('span');
      lbl.style.cssText = 'flex:1;color:#e6edf3;font-size:12px;';
      lbl.textContent = g.name || g.id;
      if (g.participants) {
        var badge = document.createElement('span');
        badge.style.cssText = 'color:#7d8590;font-size:10px;';
        badge.textContent = g.participants + ' miembros';
        row.appendChild(chk); row.appendChild(lbl); row.appendChild(badge);
      } else {
        row.appendChild(chk); row.appendChild(lbl);
      }
      gList.appendChild(row);
    });
  }
  renderGroups();
  groupsPanel.appendChild(gList);
  body.appendChild(groupsPanel);
  box.appendChild(body);

  // Footer
  var footer = document.createElement('div');
  footer.style.cssText = 'padding:12px 20px;border-top:1px solid #21262d;display:flex;gap:10px;align-items:center;flex-shrink:0;';
  var cancelBtn = document.createElement('button');
  cancelBtn.onclick = function() { modal.parentNode.removeChild(modal); };
  cancelBtn.style.cssText = 'background:#1c2733;color:#7d8590;border:1px solid #30363d;padding:9px 18px;border-radius:6px;cursor:pointer;font-size:13px;';
  cancelBtn.textContent = 'Cancelar';
  var confirmBtn = document.createElement('button');
  confirmBtn.style.cssText = 'background:linear-gradient(135deg,#1a6b2d,#238636);color:white;border:none;padding:9px 22px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:700;font-family:"Chakra Petch",sans-serif;';
  var statusDiv = document.createElement('div');
  statusDiv.style.cssText = 'flex:1;font-size:12px;';

  function updateConfirmG() {
    var sel = gruposChecked.filter(function(x){return x.checked;}).length;
    confirmBtn.textContent = '\u{1F4E4} ENVIAR A ' + sel + ' GRUPOS';
  }
  var orig = updateGroupCount;
  updateGroupCount = function() { orig(); updateConfirmG(); };
  updateConfirmG();

  confirmBtn.onclick = async function() {
    var selIds = gruposChecked.filter(function(x){return x.checked;}).map(function(x){return x.id;});
    if (selIds.length === 0) { alert('Selecciona al menos un grupo'); return; }
    var txtEl = document.getElementById('gruposBroadcastText');
    var customText = txtEl ? txtEl.value.trim() : '';
    confirmBtn.disabled = true; confirmBtn.textContent = '\u23F3 Enviando...';
    statusDiv.innerHTML = '<span style="color:#d29922;">Iniciando envio a ' + selIds.length + ' grupos (esto puede tardar)...</span>';
    try {
      var r = await fetch('/api/broadcast/groups-confirmed', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ groupIds: selIds, customText: customText || null })
      });
      var d = await r.json();
      if (d.ok) {
        statusDiv.innerHTML = '<span style="color:#3fb950;">\u2705 ' + d.msg + '</span>';
        confirmBtn.textContent = '\u2705 En progreso';
        setTimeout(function(){ modal.parentNode.removeChild(modal); }, 2500);
        loadBroadcastStatus();
      } else {
        statusDiv.innerHTML = '<span style="color:#f85149;">\u274C ' + (d.msg||'Error') + '</span>';
        confirmBtn.disabled = false; updateConfirmG();
      }
    } catch(e) {
      statusDiv.innerHTML = '<span style="color:#f85149;">\u274C Error de conexion</span>';
      confirmBtn.disabled = false; updateConfirmG();
    }
  };
  footer.appendChild(cancelBtn); footer.appendChild(confirmBtn); footer.appendChild(statusDiv);
  box.appendChild(footer);
  modal.appendChild(box);
  modal.onclick = function(e){ if(e.target===modal) modal.parentNode.removeChild(modal); };
  document.body.appendChild(modal);
}

async function abrirStatusModal() {
  var prev = document.getElementById('statusPreviewModal');
  if (prev) prev.parentNode.removeChild(prev);

  var data;
  try {
    var r = await fetch('/api/broadcast/status-preview');
    data = await r.json();
  } catch(e) { alert('Error conectando con el bot'); return; }
  if (!data.ok) { alert('Error: ' + (data.msg||'Sin datos')); return; }

  var modal = document.createElement('div');
  modal.id = 'statusPreviewModal';
  modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;';

  var box = document.createElement('div');
  box.style.cssText = 'background:#0d1117;border:1px solid #c084fc;border-radius:12px;width:460px;max-width:95vw;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;';

  var hdr2 = document.createElement('div');
  hdr2.style.cssText = 'padding:14px 20px;border-bottom:1px solid #21262d;display:flex;align-items:center;justify-content:space-between;';
  var htitle2 = document.createElement('div');
  htitle2.style.cssText = 'color:#c084fc;font-weight:700;font-size:15px;font-family:"Chakra Petch",sans-serif;';
  htitle2.textContent = '\u{1F4F8} Publicar Estado — Confirmar';
  var xbtn2 = document.createElement('button');
  xbtn2.onclick = function() { modal.parentNode.removeChild(modal); };
  xbtn2.style.cssText = 'background:none;border:none;color:#7d8590;font-size:20px;cursor:pointer;';
  xbtn2.textContent = '\u00D7';
  hdr2.appendChild(htitle2); hdr2.appendChild(xbtn2);
  box.appendChild(hdr2);

  var body2 = document.createElement('div');
  body2.style.cssText = 'padding:16px 20px;overflow-y:auto;flex:1;';

  if (data.nextImage) {
    var imgEl2 = document.createElement('img');
    imgEl2.src = '/api/broadcast/image?path=' + encodeURIComponent(data.nextImage.relativePath);
    imgEl2.style.cssText = 'width:100%;border-radius:8px;border:1px solid #21262d;max-height:250px;object-fit:cover;margin-bottom:12px;';
    body2.appendChild(imgEl2);

    var pathDiv2 = document.createElement('div');
    pathDiv2.style.cssText = 'color:#7d8590;font-size:10px;word-break:break-all;margin-bottom:12px;';
    pathDiv2.textContent = data.nextImage.relativePath + ' (pos ' + data.queuePos + '/' + (data.queueTotal||'?') + ')';
    body2.appendChild(pathDiv2);

    var txt2Label = document.createElement('label');
    txt2Label.style.cssText = 'color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:0.8px;display:block;margin-bottom:5px;';
    txt2Label.textContent = 'TEXTO DEL ESTADO (vac\u00edo = auto con IA)';
    body2.appendChild(txt2Label);
    var txt2 = document.createElement('textarea');
    txt2.id = 'statusBroadcastText';
    txt2.placeholder = '(Gemini IA generar\u00e1 el texto autom\u00e1ticamente)';
    txt2.style.cssText = 'width:100%;min-height:80px;background:#161b22;border:1px solid #30363d;border-radius:5px;color:#e6edf3;padding:8px;font-size:12px;resize:vertical;box-sizing:border-box;margin-bottom:10px;';
    body2.appendChild(txt2);

    var skipBtn2 = document.createElement('button');
    skipBtn2.style.cssText = 'background:#1c2733;color:#d29922;border:1px solid #d29922;padding:5px 12px;border-radius:5px;cursor:pointer;font-size:11px;width:100%;margin-bottom:4px;';
    skipBtn2.textContent = '\u23E9 Saltar esta imagen';
    skipBtn2.onclick = async function() {
      var r2 = await fetch('/api/broadcast/skip-image', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ type: 'status' }) });
      var d2 = await r2.json();
      if (d2.ok && d2.nextImage) {
        imgEl2.src = '/api/broadcast/image?path=' + encodeURIComponent(d2.nextImage.relativePath);
        pathDiv2.textContent = d2.nextImage.relativePath + ' (pos ' + d2.newIndex + '/' + d2.total + ')';
      }
    };
    body2.appendChild(skipBtn2);
  } else {
    var noQ2 = document.createElement('div');
    noQ2.style.cssText = 'color:#f85149;text-align:center;padding:30px;';
    noQ2.textContent = '\u274C No hay im\u00e1genes en la cola de estados';
    body2.appendChild(noQ2);
  }
  box.appendChild(body2);

  var footer2 = document.createElement('div');
  footer2.style.cssText = 'padding:12px 20px;border-top:1px solid #21262d;display:flex;gap:10px;align-items:center;';
  var cancel2 = document.createElement('button');
  cancel2.onclick = function(){ modal.parentNode.removeChild(modal); };
  cancel2.style.cssText = 'background:#1c2733;color:#7d8590;border:1px solid #30363d;padding:9px 16px;border-radius:6px;cursor:pointer;font-size:13px;';
  cancel2.textContent = 'Cancelar';
  var confirm2 = document.createElement('button');
  confirm2.style.cssText = 'flex:1;background:linear-gradient(135deg,#6b21a8,#9333ea);color:white;border:none;padding:9px 20px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:700;font-family:"Chakra Petch",sans-serif;';
  confirm2.textContent = '\u{1F4F8} PUBLICAR ESTADO';
  confirm2.onclick = async function() {
    var txtEl2 = document.getElementById('statusBroadcastText');
    var customText2 = txtEl2 ? txtEl2.value.trim() : '';
    confirm2.disabled = true; confirm2.textContent = '\u23F3 Publicando...';
    try {
      var r = await fetch('/api/broadcast/status-confirmed', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ customText: customText2 || null })
      });
      var d = await r.json();
      if (d.ok) {
        confirm2.textContent = '\u2705 Publicado!';
        setTimeout(function(){ modal.parentNode.removeChild(modal); }, 2000);
        loadBroadcastStatus();
      } else {
        confirm2.innerHTML = '\u274C Error: ' + (d.msg||'?');
        confirm2.disabled = false;
      }
    } catch(e) { confirm2.textContent = '\u274C Error'; confirm2.disabled = false; }
  };
  footer2.appendChild(cancel2); footer2.appendChild(confirm2);
  box.appendChild(footer2);
  modal.appendChild(box);
  modal.onclick = function(e){ if(e.target===modal) modal.parentNode.removeChild(modal); };
  document.body.appendChild(modal);
}

// ===== ORDEN PERSONALIZADA AL BOT (Admin Directive) =====
// ===== ORDEN PERSONALIZADA AL BOT (Admin Directive) =====
// ===== ORDEN PERSONALIZADA AL BOT (Admin Directive) =====
async function setBotDirective(phone, clearOnly) {
  const ta = document.getElementById('botDirectiveInput_' + phone)
          || document.getElementById('botDirectiveInputPv_' + phone)
          || document.getElementById('botDirectiveInputEsc_' + phone);
  const directive = clearOnly ? '' : (ta ? ta.value.trim() : '');
  const btn = clearOnly
    ? (document.getElementById('btnClearDirective_' + phone) || document.getElementById('btnClearDirectivePv_' + phone) || document.getElementById('btnClearDirectiveEsc_' + phone))
    : (document.getElementById('btnSendDirective_' + phone) || document.getElementById('btnSendDirectivePv_' + phone) || document.getElementById('btnSendDirectiveEsc_' + phone));

  if (!clearOnly && !directive) { alert('Escribe la orden primero'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '⏳...'; }

  try {
    const res = await fetch('/api/set-bot-directive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, directive })
    });
    const data = await res.json();
    if (data.ok) {
      if (ta) ta.value = '';
      // Actualizar indicador visual
      const indicator = document.getElementById('directiveIndicator_' + phone)
                     || document.getElementById('directiveIndicatorPv_' + phone)
                     || document.getElementById('directiveIndicatorEsc_' + phone);
      if (indicator) {
        if (directive) {
          indicator.innerHTML = '<span style="color:#f59e0b;font-size:11px;">🎯 Orden activa: ' + directive.substring(0,60) + (directive.length > 60 ? '...' : '') + '</span>';
        } else {
          indicator.innerHTML = '<span style="color:#6b7280;font-size:11px;">Sin orden activa</span>';
        }
      }
      if (btn) { btn.textContent = clearOnly ? '🗑️ Limpiar' : '🎯 Enviar Orden'; btn.disabled = false; }
    } else {
      alert('Error: ' + (data.msg || 'No se pudo guardar'));
      if (btn) { btn.textContent = clearOnly ? '🗑️ Limpiar' : '🎯 Enviar Orden'; btn.disabled = false; }
    }
  } catch(e) {
    alert('Error de conexión');
    if (btn) { btn.textContent = clearOnly ? '🗑️ Limpiar' : '🎯 Enviar Orden'; btn.disabled = false; }
  }
}

// ====== CARNETS — MODAL Y ENVÍO ======
let carnetTargetPhone = null;
let carnetImageBase64 = null;
let carnetImageMime = null;

function abrirModalCarnet(phone) {
  carnetTargetPhone = phone;
  carnetImageBase64 = null;
  carnetImageMime = null;
  
  // Pre-llenar datos del cliente
  const client = allData.clients.find(c => c.phone === phone);
  document.getElementById('carnetModalPhone').textContent = '📱 Cliente: ' + (client?.name || phone) + ' (' + phone + ')';
  document.getElementById('carnetNombre').value = client?.name || '';
  document.getElementById('carnetCedula').value = client?.cedula || '';
  document.getElementById('carnetMarcaArma').value = '';
  document.getElementById('carnetModeloArma').value = client?.modelo_arma || '';
  document.getElementById('carnetSerial').value = client?.serial_arma || '';
  document.getElementById('carnetCaption').value = '';
  document.getElementById('carnetPreview').style.display = 'none';
  document.getElementById('carnetUploadText').style.display = 'block';
  document.getElementById('carnetFileInput').value = '';
  document.getElementById('carnetFeedback').textContent = '';
  document.getElementById('carnetFeedback').style.color = '';
  document.getElementById('btnEnviarCarnet').disabled = false;
  document.getElementById('btnEnviarCarnet').textContent = '📨 Enviar Carnet por WhatsApp';
  
  // Auto-seleccionar plan según bóveda
  if (client?.is_club_pro) document.getElementById('carnetPlan').value = 'Plan Pro';
  else document.getElementById('carnetPlan').value = 'Plan Plus';
  
  // Default vigencia: 1 año desde hoy
  const nextYear = new Date();
  nextYear.setFullYear(nextYear.getFullYear() + 1);
  document.getElementById('carnetVigencia').value = nextYear.toISOString().split('T')[0];
  
  const modal = document.getElementById('modalCarnet');
  modal.style.display = 'flex';
}

function cerrarModalCarnet() {
  document.getElementById('modalCarnet').style.display = 'none';
  carnetTargetPhone = null;
  carnetImageBase64 = null;
  carnetImageMime = null;
}

function previewCarnetImage(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    alert('⚠️ La imagen es demasiado grande (máx 10MB)');
    return;
  }
  const reader = new FileReader();
  reader.onload = function(e) {
    const result = e.target.result;
    carnetImageMime = file.type || 'image/jpeg';
    carnetImageBase64 = result.split(',')[1]; // quitar el data:... prefix
    document.getElementById('carnetPreviewImg').src = result;
    document.getElementById('carnetPreview').style.display = 'block';
    document.getElementById('carnetUploadText').style.display = 'none';
    document.getElementById('carnetDropZone').style.borderColor = '#3fb950';
    document.getElementById('btnExtraerDatos').style.display = 'block';
    document.getElementById('extractFeedback').textContent = '';
  };
  reader.readAsDataURL(file);
}

async function enviarCarnetWhatsApp() {
  if (!carnetTargetPhone) { alert('Error: no hay cliente seleccionado'); return; }
  if (!carnetImageBase64) { alert('⚠️ Selecciona una imagen del carnet primero'); return; }
  
  const btn = document.getElementById('btnEnviarCarnet');
  const fb = document.getElementById('carnetFeedback');
  btn.disabled = true;
  btn.textContent = '⏳ Enviando carnet...';
  fb.textContent = '';
  
  const payload = {
    phone: carnetTargetPhone,
    imagenBase64: carnetImageBase64,
    imagenMime: carnetImageMime || 'image/jpeg',
    caption: document.getElementById('carnetCaption').value.trim() || '',
    carnetData: {
      nombre: document.getElementById('carnetNombre').value.trim(),
      cedula: document.getElementById('carnetCedula').value.trim(),
      vigente_hasta: document.getElementById('carnetVigencia').value,
      marca_arma: document.getElementById('carnetMarcaArma').value.trim(),
      modelo_arma: document.getElementById('carnetModeloArma').value.trim(),
      serial: document.getElementById('carnetSerial').value.trim(),
      plan_tipo: document.getElementById('carnetPlan').value
    }
  };
  
  try {
    const res = await fetch('/api/enviar-carnet-whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.ok) {
      if (data.waSent) {
        fb.style.color = '#3fb950';
        fb.textContent = '✅ Carnet enviado por WhatsApp y guardado en la BD';
        btn.textContent = '✅ Enviado';
        btn.style.background = '#238636';
      } else {
        fb.style.color = '#d29922';
        fb.textContent = '⚠️ Carnet guardado en BD pero no se pudo enviar por WhatsApp: ' + (data.waWarning || 'error');
        btn.textContent = '⚠️ Guardado (WA falló)';
      }
      // Recargar datos y refrescar vista
      await loadData();
      if (selectedPhone === carnetTargetPhone) selectClient(carnetTargetPhone);
      if (selectedPhonePv === carnetTargetPhone) selectClientPv(carnetTargetPhone);
      setTimeout(cerrarModalCarnet, 3000);
    } else {
      fb.style.color = '#f85149';
      fb.textContent = '❌ Error: ' + (data.error || 'desconocido');
      btn.disabled = false;
      btn.textContent = '📨 Enviar Carnet por WhatsApp';
    }
  } catch (e) {
    fb.style.color = '#f85149';
    fb.textContent = '❌ Error de conexión con el servidor';
    btn.disabled = false;
    btn.textContent = '📨 Enviar Carnet por WhatsApp';
  }
}

async function extraerDatosCarnet() {
  if (!carnetImageBase64) { alert('Primero sube la imagen del carnet'); return; }
  const btn = document.getElementById('btnExtraerDatos');
  const fb = document.getElementById('extractFeedback');
  btn.disabled = true;
  btn.textContent = '⏳ Extrayendo datos con IA...';
  fb.style.color = '#8b949e';
  fb.textContent = 'Analizando imagen...';
  try {
    const res = await fetch('/api/extraer-datos-carnet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imagenBase64: carnetImageBase64, imagenMime: carnetImageMime || 'image/jpeg' })
    });
    const data = await res.json();
    if (data.ok) {
      const d = data.datos;
      if (d.nombre) document.getElementById('carnetNombre').value = d.nombre;
      if (d.cedula) document.getElementById('carnetCedula').value = d.cedula;
      if (d.marca_arma) document.getElementById('carnetMarcaArma').value = d.marca_arma;
      if (d.modelo_arma) document.getElementById('carnetModeloArma').value = d.modelo_arma;
      if (d.serial) document.getElementById('carnetSerial').value = d.serial;
      if (d.vigente_hasta) document.getElementById('carnetVigencia').value = d.vigente_hasta;
      if (d.plan_tipo) {
        const sel = document.getElementById('carnetPlan');
        for (let opt of sel.options) {
          if (opt.value.toLowerCase().includes(d.plan_tipo.toLowerCase())) { sel.value = opt.value; break; }
        }
      }
      fb.style.color = '#3fb950';
      fb.textContent = '✅ Datos extraídos — revisa y corrige si es necesario';
      btn.textContent = '✅ Datos extraídos';
      btn.style.background = '#238636';
    } else {
      fb.style.color = '#f85149';
      fb.textContent = '❌ ' + (data.error || 'No se pudieron extraer los datos');
      btn.textContent = '🔍 Extraer datos del carnet con IA';
      btn.disabled = false;
    }
  } catch (e) {
    fb.style.color = '#f85149';
    fb.textContent = '❌ Error de conexión';
    btn.textContent = '🔍 Extraer datos del carnet con IA';
    btn.disabled = false;
  }
}

// ====== FACTURA ======
let facturaTargetPhone = null;
let facturaImageBase64 = null;
let facturaImageMime = null;

function abrirModalFactura(phone) {
  facturaTargetPhone = phone;
  facturaImageBase64 = null;
  facturaImageMime = null;
  const client = allData.clients.find(c => c.phone === phone);
  document.getElementById('facturaModalPhone').textContent = '\ud83d\udccb Cliente: ' + (client?.name || phone) + ' (' + phone + ')';
  document.getElementById('facturaPreview').style.display = 'none';
  document.getElementById('facturaUploadText').style.display = 'block';
  document.getElementById('facturaDropZone').style.borderColor = '#30363d';
  document.getElementById('facturaFileInput').value = '';
  document.getElementById('facturaValor').value = '';
  document.getElementById('facturaCaption').value = '';
  document.getElementById('facturaFeedback').textContent = '';
  document.getElementById('btnEnviarFactura').disabled = false;
  document.getElementById('btnEnviarFactura').textContent = '\ud83d\udce8 Enviar Factura por WhatsApp';
  document.getElementById('btnEnviarFactura').style.background = 'linear-gradient(135deg, #1f6feb, #388bfd)';
  document.getElementById('modalFactura').style.display = 'flex';
}

function cerrarModalFactura() {
  document.getElementById('modalFactura').style.display = 'none';
  facturaTargetPhone = null;
  facturaImageBase64 = null;
  facturaImageMime = null;
}

function previewFacturaImage(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    alert('\u26a0\ufe0f La imagen es demasiado grande (m\u00e1x 10MB)');
    return;
  }
  const reader = new FileReader();
  reader.onload = function(e) {
    const result = e.target.result;
    facturaImageMime = file.type || 'image/jpeg';
    facturaImageBase64 = result.split(',')[1];
    document.getElementById('facturaPreviewImg').src = result;
    document.getElementById('facturaPreview').style.display = 'block';
    document.getElementById('facturaUploadText').style.display = 'none';
    document.getElementById('facturaDropZone').style.borderColor = '#3fb950';
  };
  reader.readAsDataURL(file);
}

async function enviarFacturaWhatsApp() {
  if (!facturaTargetPhone) { alert('Error: no hay cliente seleccionado'); return; }
  if (!facturaImageBase64) { alert('\u26a0\ufe0f Selecciona una imagen de la factura primero'); return; }
  
  const btn = document.getElementById('btnEnviarFactura');
  const fb = document.getElementById('facturaFeedback');
  btn.disabled = true;
  btn.textContent = '\u23f3 Enviando factura...';
  fb.textContent = '';
  
  const payload = {
    phone: facturaTargetPhone,
    imagenBase64: facturaImageBase64,
    imagenMime: facturaImageMime || 'image/jpeg',
    valor: document.getElementById('facturaValor').value.trim() || '',
    caption: document.getElementById('facturaCaption').value.trim() || ''
  };
  
  try {
    const res = await fetch('/api/enviar-factura-whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.ok) {
      fb.style.color = '#3fb950';
      fb.textContent = '\u2705 Factura enviada por WhatsApp';
      btn.textContent = '\u2705 Enviada';
      btn.style.background = '#238636';
      await loadData();
      if (selectedPhone === facturaTargetPhone) selectClient(facturaTargetPhone);
      if (selectedPhonePv === facturaTargetPhone) selectClientPv(facturaTargetPhone);
      setTimeout(cerrarModalFactura, 3000);
    } else {
      fb.style.color = '#f85149';
      fb.textContent = '\u274c Error: ' + (data.error || 'desconocido');
      btn.disabled = false;
      btn.textContent = '\ud83d\udce8 Enviar Factura por WhatsApp';
    }
  } catch (e) {
    fb.style.color = '#f85149';
    fb.textContent = '\u274c Error de conexi\u00f3n con el servidor';
    btn.disabled = false;
    btn.textContent = '\ud83d\udce8 Enviar Factura por WhatsApp';
  }
}

// ====== GUÍA DE ENVÍO ======
let guiaTargetPhone = null;
let guiaImageBase64 = null;
let guiaImageMime = null;

function abrirModalGuia(phone) {
  guiaTargetPhone = phone;
  guiaImageBase64 = null;
  guiaImageMime = null;
  
  const client = allData.clients.find(c => c.phone === phone);
  document.getElementById('guiaModalPhone').textContent = '📱 Cliente: ' + (client?.name || phone) + ' (' + phone + ')';
  document.getElementById('guiaNumero').value = '';
  document.getElementById('guiaProducto').value = client?.modelo_arma ? client.modelo_arma : '';
  document.getElementById('guiaCaption').value = '';
  document.getElementById('guiaPreview').style.display = 'none';
  document.getElementById('guiaUploadText').style.display = 'block';
  document.getElementById('guiaFileInput').value = '';
  document.getElementById('guiaFeedback').textContent = '';
  document.getElementById('guiaFeedback').style.color = '';
  document.getElementById('btnEnviarGuia').disabled = false;
  document.getElementById('btnEnviarGuia').textContent = '📨 Enviar Guía por WhatsApp';
  document.getElementById('guiaDropZone').style.borderColor = '#30363d';
  document.getElementById('guiaTransportadora').selectedIndex = 0;
  
  document.getElementById('modalGuia').style.display = 'flex';
}

function cerrarModalGuia() {
  document.getElementById('modalGuia').style.display = 'none';
  guiaTargetPhone = null;
  guiaImageBase64 = null;
  guiaImageMime = null;
}

function previewGuiaImage(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { alert('⚠️ La imagen es demasiado grande (máx 10MB)'); return; }
  const reader = new FileReader();
  reader.onload = function(e) {
    const result = e.target.result;
    guiaImageMime = file.type || 'image/jpeg';
    guiaImageBase64 = result.split(',')[1];
    document.getElementById('guiaPreviewImg').src = result;
    document.getElementById('guiaPreview').style.display = 'block';
    document.getElementById('guiaUploadText').style.display = 'none';
    document.getElementById('guiaDropZone').style.borderColor = '#3fb950';
  };
  reader.readAsDataURL(file);
}

async function enviarGuiaWhatsApp() {
  if (!guiaTargetPhone) { alert('Error: no hay cliente seleccionado'); return; }
  const numero = document.getElementById('guiaNumero').value.trim();
  const transportadora = document.getElementById('guiaTransportadora').value;
  if (!numero) { alert('⚠️ Ingresa el número de guía'); return; }
  
  const btn = document.getElementById('btnEnviarGuia');
  const fb = document.getElementById('guiaFeedback');
  btn.disabled = true;
  btn.textContent = '⏳ Enviando guía...';
  fb.textContent = '';
  
  const payload = {
    phone: guiaTargetPhone,
    transportadora,
    numeroGuia: numero,
    producto: document.getElementById('guiaProducto').value.trim() || '',
    caption: document.getElementById('guiaCaption').value.trim() || '',
    imagenBase64: guiaImageBase64 || null,
    imagenMime: guiaImageMime || null
  };
  
  try {
    const res = await fetch('/api/enviar-guia-whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.ok) {
      fb.style.color = '#3fb950';
      fb.textContent = '✅ Guía enviada por WhatsApp y registrada';
      btn.textContent = '✅ Enviada';
      btn.style.background = '#238636';
      await loadData();
      if (selectedPhone === guiaTargetPhone) selectClient(guiaTargetPhone);
      if (selectedPhonePv === guiaTargetPhone) selectClientPv(guiaTargetPhone);
      setTimeout(cerrarModalGuia, 3000);
    } else {
      fb.style.color = '#f85149';
      fb.textContent = '❌ Error: ' + (data.error || 'desconocido');
      btn.disabled = false;
      btn.textContent = '📨 Enviar Guía por WhatsApp';
    }
  } catch (e) {
    fb.style.color = '#f85149';
    fb.textContent = '❌ Error de conexión con el servidor';
    btn.disabled = false;
    btn.textContent = '📨 Enviar Guía por WhatsApp';
  }
}

function toggleCarnetSection(el) {
  var next = el.nextElementSibling;
  next.style.display = next.style.display === 'none' ? 'block' : 'none';
  el.querySelector('.toggle-arrow').textContent = next.style.display === 'none' ? '▶' : '▼';
}

async function loadCarnetHistory(phone) {
  var container = document.getElementById('carnetHistory_' + phone);
  if (!container) return;
  try {
    var res2 = await fetch('/api/carnets-cliente?phone=' + phone);
    var carnets = await res2.json();
    if (!carnets || carnets.length === 0) { container.innerHTML = ''; return; }
    var estadoColors = { enviado: '#3fb950', confirmado: '#3fb950', pendiente: '#d29922', rechazado: '#f85149' };
    var estadoIcons = { enviado: '📨', confirmado: '✅', pendiente: '⏳', rechazado: '❌' };
    var html = '<div style="background:#0d1117;border:1px solid #30363d;border-radius:8px;overflow:hidden;">';
    html += '<div onclick="toggleCarnetSection(this)" style="padding:10px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;background:#161b22;border-bottom:1px solid #30363d;">';
    html += '<span class="toggle-arrow" style="color:#8b949e;font-size:12px;">▶</span>';
    html += '<span style="color:#d4a0ff;font-weight:700;font-size:13px;">🪪 Historial de Carnets (' + carnets.length + ')</span></div>';
    html += '<div style="display:none;padding:10px;">';
    carnets.forEach(function(c) {
      var fecha = new Date(c.created_at).toLocaleDateString('es-CO');
      var plan = c.plan_tipo || 'N/A';
      var color = estadoColors[c.estado] || '#8b949e';
      var icon = estadoIcons[c.estado] || '📋';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:#111820;border:1px solid #21262d;border-radius:6px;margin-bottom:6px;font-size:12px;">';
      html += '<div><span style="color:' + color + ';font-weight:700;">' + icon + ' ' + (c.estado ? c.estado.toUpperCase() : 'N/A') + '</span>';
      html += '<span style="color:#8b949e;"> — </span><span style="color:#e6edf3;">' + plan + '</span></div>';
      html += '<div style="color:#8b949e;font-size:11px;text-align:right;">';
      html += '<div>' + (c.nombre || '') + (c.cedula ? ' (CC: ' + c.cedula + ')' : '') + '</div>';
      html += '<div>' + (c.modelo_arma ? '🔫 ' + c.modelo_arma + ' S/N: ' + (c.serial || 'N/A') : '') + '</div>';
      html += '<div>📅 ' + fecha + (c.vigente_hasta ? ' → Vence: ' + c.vigente_hasta : '') + '</div>';
      html += '</div></div>';
    });
    html += '</div></div>';
    container.innerHTML = html;
  } catch (e) {
    console.error('Error cargando carnets:', e);
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

// ====== DASHBOARD KPIs ======
async function loadDashboard() {
  try {
    const res = await fetch('/api/dashboard');
    const d = await res.json();
    const container = document.getElementById('dashboardContent');

    // Funnel colors
    var funnelColors = { new: '#388bfd', hot: '#f85149', warm: '#d29922', assigned: '#a371f7', completed: '#3fb950', cold: '#8b949e', postventa: '#3fb950' };
    var funnelLabels = { new: 'Nuevos', hot: 'Calientes', warm: 'Tibios', assigned: 'Asignados', completed: 'Completados', cold: 'Fríos', postventa: 'Post-venta' };

    // Max for funnel bars
    var maxFunnel = Math.max(...d.funnel.map(function(f) { return f.count; }), 1);

    // KPI Cards
    var html = '<div class="dash-grid">';
    html += '<div class="dash-card"><div class="dash-label">Total CRM</div><div class="dash-value">' + d.total + '</div></div>';
    html += '<div class="dash-card"><div class="dash-label">Conversión</div><div class="dash-value">' + d.conversionRate + '%</div><div class="dash-sub">Completados / Total</div></div>';
    html += '<div class="dash-card"><div class="dash-label">Esta Semana</div><div class="dash-value">' + d.thisWeek + '</div>';
    html += '<div class="dash-sub ' + (d.weekTrend < 0 ? 'negative' : '') + '">' + (d.weekTrend >= 0 ? '↑' : '↓') + ' ' + Math.abs(d.weekTrend) + ' vs semana anterior</div></div>';
    html += '<div class="dash-card"><div class="dash-label">Mensajes Hoy</div><div class="dash-value">' + d.msgsToday + '</div></div>';
    html += '<div class="dash-card"><div class="dash-label">Pagos Confirmados</div><div class="dash-value">' + d.confirmedThisMonth + '</div><div class="dash-sub">Este mes</div></div>';
    html += '</div>';

    // Score Distribution
    html += '<div class="dash-grid" style="margin-top:4px;">';
    html += '<div class="dash-card" style="border-left:3px solid #f85149;"><div class="dash-label">🔥 Hot (≥60pts)</div><div class="dash-value">' + d.scoreDistribution.hot + '</div></div>';
    html += '<div class="dash-card" style="border-left:3px solid #d29922;"><div class="dash-label">⭐ Warm (30-59)</div><div class="dash-value">' + d.scoreDistribution.warm + '</div></div>';
    html += '<div class="dash-card" style="border-left:3px solid #8b949e;"><div class="dash-label">❄️ Cold (1-29)</div><div class="dash-value">' + d.scoreDistribution.cold + '</div></div>';
    html += '</div>';

    // Funnel
    html += '<div class="dash-funnel"><h3>📊 Pipeline / Funnel</h3>';
    d.funnel.forEach(function(f) {
      var pct = Math.round((f.count / maxFunnel) * 100);
      var color = funnelColors[f.status] || '#8b949e';
      var label = funnelLabels[f.status] || f.status;
      html += '<div class="funnel-row">';
      html += '<div class="funnel-label">' + label + '</div>';
      html += '<div class="funnel-bar-bg"><div class="funnel-bar" style="width:' + pct + '%;background:' + color + ';">' + f.count + '</div></div>';
      html += '</div>';
    });
    html += '</div>';

    // Two columns: Products + Active Sequences
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">';

    // Top Products
    html += '<div class="dash-section"><h3>🏆 Productos Más Consultados</h3>';
    if (d.topProducts.length === 0) {
      html += '<div style="color:#8b949e;font-size:12px;">Sin datos aún</div>';
    } else {
      d.topProducts.forEach(function(p) {
        html += '<div class="product-row"><span class="product-name">' + p.product + '</span><span class="product-count">' + p.count + ' menciones</span></div>';
      });
    }
    html += '</div>';

    // Active Sequences
    html += '<div class="dash-section"><h3>🤖 Agentes Activos</h3>';
    var seqLabels = { lead: '🔄 Follow-up', payment: '💰 Pagos', despacho: '📦 Despachos', onboarding: '🎓 Onboarding' };
    if (d.activeSequences.length === 0) {
      html += '<div style="color:#8b949e;font-size:12px;">Sin secuencias activas</div>';
    } else {
      d.activeSequences.forEach(function(s) {
        var lbl = seqLabels[s.type] || s.type;
        html += '<div class="product-row"><span class="product-name">' + lbl + '</span><span class="product-count">' + s.count + ' activas</span></div>';
      });
    }
    html += '</div></div>';

    container.innerHTML = html;
  } catch (e) {
    console.error('Error cargando dashboard:', e);
    document.getElementById('dashboardContent').innerHTML = '<div class="chat-empty">Error cargando dashboard</div>';
  }
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
