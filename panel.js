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
  const silentRoutes = ['/api/data', '/api/events', '/api/chat', '/'];
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
            'modelo_arma', 'serial_arma'
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
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
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
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
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
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
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
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
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
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
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

  // Confirmar o rechazar comprobante \u2014 relay al bot en puerto 3001 — relay al bot en puerto 3001
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
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
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
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
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
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
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
        const payload = JSON.stringify({ comprobantesCount: compCount, carnetsCount: carnCount });
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
  #viewClientes, #viewComprobantes, #viewCarnets, #viewPostventa { display: none; }
  #viewClientes.active, #viewPostventa.active { display: flex; }
  #viewComprobantes.active, #viewCarnets.active { display: flex; flex-direction: column; padding: 20px 25px; gap: 15px; overflow-y: auto; height: calc(100vh - 265px); }
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
  const btn = mode === 'ultra' ? document.getElementById('btnReactivarUltra') : document.getElementById('btnReactivar');
  const orgText = btn.textContent;
  const orgBg = btn.style.background;
  
  btn.disabled = true;
  btn.textContent = '⏳ Procesando...';
  try {
    const res = await fetch('/api/reactivar-calientes', { 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
    const data = await res.json();
    if (data.ok) {
      btn.textContent = '✅ ' + data.msg;
      btn.style.background = '#238636';
      setTimeout(() => {
        btn.textContent = orgText;
        btn.style.background = orgBg;
        btn.disabled = false;
      }, 5000);
    } else {
      alert('⚠️ ' + (data.msg || data.error || 'Error desconocido'));
      btn.textContent = orgText;
      btn.disabled = false;
    }
  } catch (e) {
    alert('❌ Error conectando con el servidor');
    btn.textContent = orgText;
    btn.disabled = false;
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
    const displayName = c.name || (isLid(c.phone) ? 'Sin nombre' : formatPhone(c.phone));
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

  // Show toggle button & open detail panel
  const toggleBtn = document.getElementById('btnToggleDetail');
  toggleBtn.style.display = 'inline-block';
  const detailEl = document.getElementById('clientDetail');
  detailEl.classList.add('open');
  toggleBtn.classList.add('active');
  toggleBtn.textContent = 'Ocultar Info';

  document.getElementById('clientDetail').innerHTML = \`
    <!-- CRM HEADER BAR -->
    <div class="crm-header-bar">
      <h3>\${client.name || 'Sin nombre'} <span class="client-status status-\${client.status}">\${client.status}</span></h3>
      <div class="crm-meta">
        <span>\${isLid(client.phone) ? '🔒 ' + client.phone : '📱 ' + client.phone}</span>
        <span>💬 \${client.interaction_count || 0} msgs</span>
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
        <div class="crm-field"><label>Serial Arma</label><input id="prof_serial_arma_\${client.phone}" type="text" value="\${client.serial_arma || ''}"></div>
      </div>

      <div class="crm-save-row">
        <button class="crm-save-btn" onclick="saveProfile('\${client.phone}')">💾 Guardar Todo</button>
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
    </div>

    <!-- TAB: ACCIONES -->
    <div class="crm-tab-content" id="crmTab_acciones_\${client.phone}">
      <div class="crm-section-title">⚡ Acciones</div>
      <div class="crm-action-row">
        <select id="quickAction_\${client.phone}">
          <option value="">Seleccionar acción...</option>
          <option value="carnet">🪪 Enviar Carnet por WhatsApp</option>
          <option value="catalogo">📋 Enviar Catálogo</option>
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

function switchCrmTab(phone, tab, el) {
  activeCrmTab = tab;
  document.querySelectorAll('.crm-tab-content').forEach(c => c.classList.remove('active'));
  document.querySelectorAll('.crm-tab').forEach(t => t.classList.remove('active'));
  const target = document.getElementById('crmTab_' + tab + '_' + phone);
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

async function saveProfile(phone) {
  const btn = document.querySelector(\`button[onclick="saveProfile('\${phone}')"]\`);
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
    case 'catalogo': enviarCatalogo(phone, btn); break;
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
    case 'catalogo': enviarCatalogo(phone, btn); break;
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
      alert(\`✅ Migración lista: \${data.migrados} clientes pasados de "asignados" → 🔥 Calientes\`);
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
  // Re-seleccionar cliente activo para actualizar chat y detalles en tiempo real
  if (selectedPhone && currentMainTab === 'comercial') selectClient(selectedPhone);
  if (selectedPhonePv && currentMainTab === 'postventa') selectClientPv(selectedPhonePv);
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
  document.getElementById('viewClientes').classList.toggle('active', tab === 'comercial');
  document.getElementById('viewComprobantes').classList.toggle('active', tab === 'comprobantes');
  document.getElementById('viewCarnets').classList.toggle('active', tab === 'carnets');
  document.getElementById('viewPostventa').classList.toggle('active', tab === 'postventa');
  if (tab === 'comprobantes') loadComprobantes();
  if (tab === 'carnets') loadCarnets();
  if (tab === 'postventa') renderPostventa();
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

async function selectClientPv(phone) {
  selectedPhonePv = phone;
  renderPostventa();
  const client = allData.clients.find(c => c.phone === phone);
  const assignment = allData.assignments.find(a => a.client_phone === phone && a.status === 'active');
  document.getElementById('chatTitlePv').textContent = '💬 ' + (client.name || phone);
  const toggleBtnPv = document.getElementById('btnToggleDetailPv');
  toggleBtnPv.style.display = 'inline-block';
  document.getElementById('clientDetailPv').classList.add('open');
  toggleBtnPv.classList.add('active');
  toggleBtnPv.textContent = 'Ocultar Info';
  const statusClass = 'status-' + (client.status || 'postventa').replace(/_/g, '-');
  const statusLabel = PV_LABELS[client.status] || client.status || 'postventa';
  document.getElementById('clientDetailPv').innerHTML = \`
    <div class="client-detail">
      <h3>\${client.name || 'Sin nombre'} <span class="client-status \${statusClass}">\${statusLabel}</span></h3>
      <div class="detail-grid">
        <div class="detail-item"><span class="dl">\${isLid(client.phone) ? '🔒 ID WA:' : '📱 Teléfono:'}</span> <span class="dv">\${isLid(client.phone) ? '<span style=\\"color:#8b949e;font-size:11px;\\">' + client.phone + ' (privado)</span>' : client.phone}</span></div>
        <div class="detail-item"><span class="dl">💬 Mensajes:</span> <span class="dv">\${client.interaction_count || 0}</span></div>
        <div class="detail-item"><span class="dl">📅 Registro:</span> <span class="dv">\${new Date(client.created_at).toLocaleDateString()}</span></div>
        <div class="detail-item"><span class="dl">👔 Asignado:</span> <span class="dv">\${assignment ? assignment.employee_name : 'No'}</span></div>
      </div>

      <!-- BÓVEDA PV: collapsible -->
      <div style="margin-top:15px;background:#0d1117;border:1px solid #30363d;border-radius:8px;overflow:hidden;">
        <div onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'; this.querySelector('.toggle-arrow').textContent = this.nextElementSibling.style.display === 'none' ? '▶' : '▼';" style="padding:8px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;background:#161b22;border-bottom:1px solid #30363d;">
          <span class="toggle-arrow" style="color:#8b949e;font-size:12px;">▼</span>
          <span style="color:#3fb950;font-weight:700;font-size:12px;font-family:'Chakra Petch',sans-serif;">🔒 Bóveda de Servicios</span>
        </div>
        <div style="padding:10px 14px;">
          <div style="display:flex; gap: 12px; flex-wrap: wrap;">
            <label style="display:flex;align-items:center;gap:3px;background:#111820;border:1px solid #30363d;padding:4px 10px;border-radius:4px;font-size:12px;cursor:pointer;color:#e6edf3;">
              <input type="checkbox" \${client.has_bought_gun ? 'checked' : ''} onchange="toggleFlagPv('\${client.phone}', 'has_bought_gun', \${client.has_bought_gun || 0})" style="accent-color:#3fb950;"> 🔫 Compró Arma
            </label>
            <label style="display:flex;align-items:center;gap:3px;background:#111820;border:1px solid #30363d;padding:4px 10px;border-radius:4px;font-size:12px;cursor:pointer;color:#e6edf3;">
              <input type="checkbox" \${client.is_club_plus ? 'checked' : ''} onchange="toggleFlagPv('\${client.phone}', 'is_club_plus', \${client.is_club_plus || 0})" style="accent-color:#d29922;"> 🟡 Club Plus
            </label>
            <label style="display:flex;align-items:center;gap:3px;background:#111820;border:1px solid #30363d;padding:4px 10px;border-radius:4px;font-size:12px;cursor:pointer;color:#e6edf3;">
              <input type="checkbox" \${client.is_club_pro ? 'checked' : ''} onchange="toggleFlagPv('\${client.phone}', 'is_club_pro', \${client.is_club_pro || 0})" style="accent-color:#f85149;"> 🔴 Club Pro
            </label>
            <label style="display:flex;align-items:center;gap:3px;background:#111820;border:1px solid #30363d;padding:4px 10px;border-radius:4px;font-size:12px;cursor:pointer;color:#e6edf3;">
              <input type="checkbox" \${client.has_ai_bot ? 'checked' : ''} onchange="toggleFlagPv('\${client.phone}', 'has_ai_bot', \${client.has_ai_bot || 0})" style="accent-color:#1f6feb;"> 🤖 Bot IA
            </label>
          </div>
        </div>
      </div>

      <!-- MEMORIA CRM PV: collapsible -->
      <div style="margin-top:10px;background:#0d1117;border:1px solid #30363d;border-radius:8px;overflow:hidden;">
        <div onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'; this.querySelector('.toggle-arrow').textContent = this.nextElementSibling.style.display === 'none' ? '▶' : '▼';" style="padding:8px 14px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;background:#161b22;border-bottom:1px solid #30363d;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="toggle-arrow" style="color:#8b949e;font-size:12px;">▼</span>
            <span style="color:#bc8cff;font-weight:700;font-size:12px;font-family:'Chakra Petch',sans-serif;">🧠 Memoria CRM</span>
          </div>
          <button onclick="event.stopPropagation();saveMemory('\${client.phone}')" style="background:#238636;color:white;border:none;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-family:'Chakra Petch',sans-serif;">💾 Guardar</button>
        </div>
        <div style="padding:10px 14px;">
          <textarea id="memoryEditPv_\${client.phone}" style="width:100%;background:#111820;border:1px solid #1c2733;border-radius:4px;padding:10px;font-size:12px;color:#8b949e;white-space:pre-wrap;min-height:70px;max-height:160px;resize:vertical;font-family:'Share Tech Mono',monospace;box-sizing:border-box;">\${(client.memory || '').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
        </div>
      </div>

      <!-- ACCIONES PV: collapsible -->
      <div style="margin-top:10px;background:#0d1117;border:1px solid #30363d;border-radius:8px;overflow:hidden;">
        <div onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'; this.querySelector('.toggle-arrow').textContent = this.nextElementSibling.style.display === 'none' ? '▶' : '▼';" style="padding:8px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;background:#161b22;border-bottom:1px solid #30363d;">
          <span class="toggle-arrow" style="color:#8b949e;font-size:12px;">▶</span>
          <span style="color:#58a6ff;font-weight:700;font-size:12px;font-family:'Chakra Petch',sans-serif;">⚡ Acciones Rápidas</span>
        </div>
        <div style="display:none;padding:10px 14px;">

          <!-- NOTA RÁPIDA PV (dropdown) -->
          <div style="display:flex;align-items:center;gap:8px;">
            <select id="quickNotePv_\${client.phone}" style="flex:1;background:#111820;border:1px solid #30363d;color:#e6edf3;padding:7px 10px;border-radius:6px;font-size:12px;cursor:pointer;font-family:'Chakra Petch',sans-serif;">
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
            <button onclick="const s=document.getElementById('quickNotePv_\${client.phone}');if(s.value){addNotePv('\${client.phone}',s.value);s.selectedIndex=0;}" style="background:#238636;border:none;color:white;padding:7px 14px;border-radius:6px;font-size:12px;cursor:pointer;font-family:'Chakra Petch',sans-serif;white-space:nowrap;">✅ Aplicar</button>
          </div>

          <!-- CATEGORIZAR PV (dropdown) -->
          <div style="display:flex;align-items:center;gap:8px;">
            <select id="categorizePv_\${client.phone}" style="flex:1;background:#111820;border:1px solid #30363d;color:#e6edf3;padding:7px 10px;border-radius:6px;font-size:12px;cursor:pointer;font-family:'Chakra Petch',sans-serif;">
              <option value="">📂 Categorizar...</option>
              <option value="carnet_pendiente_plus">🟢 Pend. Carnet Plus</option>
              <option value="carnet_pendiente_pro">🔴 Pend. Carnet Pro</option>
              <option value="despacho_pendiente">📦 Pend. Dispositivo</option>
              <option value="municion_pendiente">🔫 Pend. Munición</option>
              <option value="recuperacion_pendiente">🔧 Pend. Recuperación</option>
              <option value="bot_asesor_pendiente">🤖 Pend. Bot Asesor</option>
            </select>
            <button onclick="const s=document.getElementById('categorizePv_\${client.phone}');if(s.value){changeStatusPv('\${client.phone}',s.value);s.selectedIndex=0;}" style="background:#1f6feb;border:none;color:white;padding:7px 14px;border-radius:6px;font-size:12px;cursor:pointer;font-family:'Chakra Petch',sans-serif;white-space:nowrap;">▶ Aplicar</button>
          </div>

          <!-- ACCIÓN PV (dropdown) -->
          <div style="display:flex;align-items:center;gap:8px;">
            <select id="quickActionPv_\${client.phone}" style="flex:1;background:#111820;border:1px solid #30363d;color:#e6edf3;padding:7px 10px;border-radius:6px;font-size:12px;cursor:pointer;font-family:'Chakra Petch',sans-serif;">
              <option value="">⚡ Acción...</option>
              <option value="carnet">🪪 Enviar Carnet por WhatsApp</option>
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
            <button onclick="ejecutarAccionPv('\${client.phone}', document.getElementById('quickActionPv_\${client.phone}').value, this)" style="background:#1f6feb;border:none;color:white;padding:7px 14px;border-radius:6px;font-size:12px;cursor:pointer;font-family:'Chakra Petch',sans-serif;white-space:nowrap;">▶ Ejecutar</button>
          </div>
        </div>

        <!-- NOTA LIBRE PV -->
        <div class="crm-note-row" style="margin-top:8px;">
          <input class="crm-note-input" id="notePvInput_\${client.phone}" type="text" placeholder="Nota interna libre..." onkeydown="if(event.key==='Enter') saveNotePv('\${client.phone}')">
          <button class="crm-note-btn" onclick="saveNotePv('\${client.phone}')">📝</button>
        </div>
        <div class="crm-feedback" id="notePvFeedback_\${client.phone}"></div>
      </div>
      <!-- FICHA CRM EDITABLE (PV) -->
      <div style="margin-top:15px;background:#0d1117;border:1px solid #30363d;border-radius:8px;overflow:hidden;">
        <div onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'; this.querySelector('.toggle-arrow').textContent = this.nextElementSibling.style.display === 'none' ? '▶' : '▼';" style="padding:10px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;background:#161b22;border-bottom:1px solid #30363d;">
          <span class="toggle-arrow" style="color:#8b949e;font-size:12px;">▶</span>
          <span style="color:#58a6ff;font-weight:700;font-size:13px;font-family:'Chakra Petch',sans-serif;">📋 Ficha CRM Completa — Datos Editables</span>
        </div>
        <div style="display:none;padding:14px;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <div><label style="color:#8b949e;font-size:10px;">Nombre</label><input id="prof_name_\${client.phone}" type="text" value="\${client.name || ''}" style="width:100%;background:#111820;border:1px solid #30363d;color:#e6edf3;padding:6px 10px;border-radius:4px;font-size:12px;box-sizing:border-box;"></div>
            <div><label style="color:#8b949e;font-size:10px;">Cédula</label><input id="prof_cedula_\${client.phone}" type="text" value="\${client.cedula || ''}" style="width:100%;background:#111820;border:1px solid #30363d;color:#e6edf3;padding:6px 10px;border-radius:4px;font-size:12px;box-sizing:border-box;"></div>
            <div><label style="color:#8b949e;font-size:10px;">Ciudad</label><input id="prof_ciudad_\${client.phone}" type="text" value="\${client.ciudad || ''}" style="width:100%;background:#111820;border:1px solid #30363d;color:#e6edf3;padding:6px 10px;border-radius:4px;font-size:12px;box-sizing:border-box;"></div>
            <div><label style="color:#8b949e;font-size:10px;">Dirección</label><input id="prof_direccion_\${client.phone}" type="text" value="\${client.direccion || ''}" style="width:100%;background:#111820;border:1px solid #30363d;color:#e6edf3;padding:6px 10px;border-radius:4px;font-size:12px;box-sizing:border-box;"></div>
            <div><label style="color:#8b949e;font-size:10px;">Profesión</label><input id="prof_profesion_\${client.phone}" type="text" value="\${client.profesion || ''}" style="width:100%;background:#111820;border:1px solid #30363d;color:#e6edf3;padding:6px 10px;border-radius:4px;font-size:12px;box-sizing:border-box;"></div>
            <div><label style="color:#8b949e;font-size:10px;">Plan Club</label><select id="prof_club_plan_\${client.phone}" style="width:100%;background:#111820;border:1px solid #30363d;color:#e6edf3;padding:6px 10px;border-radius:4px;font-size:12px;box-sizing:border-box;"><option value="" \${!client.club_plan ? 'selected' : ''}>— Ninguno —</option><option value="Plan Plus" \${client.club_plan === 'Plan Plus' ? 'selected' : ''}>🟡 Plan Plus</option><option value="Plan Pro" \${client.club_plan === 'Plan Pro' ? 'selected' : ''}>🔴 Plan Pro</option></select></div>
            <div><label style="color:#8b949e;font-size:10px;">Vigente hasta</label><input id="prof_club_vigente_hasta_\${client.phone}" type="date" value="\${client.club_vigente_hasta || ''}" style="width:100%;background:#111820;border:1px solid #30363d;color:#e6edf3;padding:6px 10px;border-radius:4px;font-size:12px;box-sizing:border-box;"></div>
            <div><label style="color:#8b949e;font-size:10px;">Modelo arma</label><input id="prof_modelo_arma_\${client.phone}" type="text" value="\${client.modelo_arma || ''}" style="width:100%;background:#111820;border:1px solid #30363d;color:#e6edf3;padding:6px 10px;border-radius:4px;font-size:12px;box-sizing:border-box;"></div>
            <div style="grid-column:1/-1;"><label style="color:#8b949e;font-size:10px;">Serial arma</label><input id="prof_serial_arma_\${client.phone}" type="text" value="\${client.serial_arma || ''}" style="width:100%;background:#111820;border:1px solid #30363d;color:#e6edf3;padding:6px 10px;border-radius:4px;font-size:12px;box-sizing:border-box;"></div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;margin-top:10px;">
            <button onclick="saveProfile('\${client.phone}')" style="background:linear-gradient(135deg,#238636,#2ea043);color:white;border:none;padding:8px 18px;border-radius:6px;cursor:pointer;font-size:12px;font-family:'Chakra Petch',sans-serif;font-weight:700;">💾 Guardar Ficha CRM</button>
            <div id="prof_feedback_\${client.phone}" style="display:none;color:#3fb950;font-size:12px;">✅ Ficha guardada</div>
          </div>
        </div>
      </div>
      <!-- HISTORIAL DE CARNETS (PV) -->
      <div id="carnetHistory_\${client.phone}" style="margin-top:10px;"></div>
      <div style="margin-top:10px;">\${waLink(client.phone)}</div>
    </div>
  \`;
  const res = await fetch('/api/chat?phone=' + phone);
  const messages = await res.json();
  const chatHtml = messages.map(m => \`
    <div style="display:flex;flex-direction:column;align-items:\${m.role === 'user' ? 'flex-start' : 'flex-end'};">
      <div class="chat-bubble chat-\${m.role}" \${m.role === 'admin' ? 'style="background:#1a5276;border:1px solid #2980b9;"' : ''}>\${m.role === 'admin' ? '👤 ' : ''}\${m.message}</div>
      <div class="chat-time">\${m.role === 'admin' ? 'Álvaro • ' : ''}\${new Date(m.created_at).toLocaleString()}</div>
    </div>
  \`).join('');
  const chatArea = document.getElementById('chatAreaPv');
  chatArea.innerHTML = '<div class="chat-container">' + (chatHtml || '<div class="chat-empty">Sin mensajes</div>') + '</div>' +
    '<div style="display:flex;gap:8px;margin-top:10px;padding:10px;background:#161b22;border-radius:8px;border:1px solid #30363d;">' +
      '<textarea id="adminReplyInputPv" placeholder="Escribir como Álvaro..." style="flex:1;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:8px;resize:none;height:40px;font-family:inherit;font-size:13px;"></textarea>' +
      '<button onclick="enviarMensajeAdminPv()" style="background:#1a5276;color:white;border:none;border-radius:6px;padding:8px 16px;cursor:pointer;font-weight:bold;white-space:nowrap;">Enviar 👤</button>' +
    '</div>';
  requestAnimationFrame(() => requestAnimationFrame(() => { chatArea.scrollTop = chatArea.scrollHeight; }));
  loadCarnetHistory(phone);
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
                  <input type="checkbox" value="producto" \${c.tipo === 'producto' ? 'checked' : ''} style="accent-color:#d29922;"> 📦 Producto/Arma
                </label>
              </div>
            </div>
            <button class="btn-confirmar" id="btn_confirm_\${c.id}" onclick="confirmarComprobante(\${c.id}, 'confirmar', '\${c.client_phone}')">✅ Confirmar pago</button>
            <button class="btn-rechazar" id="btn_reject_\${c.id}" onclick="confirmarComprobante(\${c.id}, 'rechazar', '\${c.client_phone}')">❌ Rechazar</button>
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
  
  if (accion === 'confirmar' && checked.length === 0) {
    alert('⚠️ Selecciona al menos un tipo de compra antes de confirmar.');
    return;
  }
  
  // Enviar como string separado por comas: "club,bot_asesor" o "producto" etc.
  const tipo = checked.join(',');
  accionComprobante(id, accion, phone, tipo);
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
              </select>
            </div>
            <!-- Botón Rechazar -->
            <button class="btn-rechazar" id="btn_carn_reject_\${c.id}" onclick="accionCarnet(\${c.id}, 'rechazar', '\${c.client_phone}', '')">❌ Notificar Rechazo</button>
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
    alert('❌ Error de red. ¿Está corriendo el panel?');
    if (btnConfirm) { btnConfirm.disabled = false; btnConfirm.textContent = '✅ Aprobar y Actualizar Ficha'; }
    if (btnReject) { btnReject.disabled = false; btnReject.textContent = '❌ Rechazar (Ilegible/Falso)'; }
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
    html += "<div onclick=\\"this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'; this.querySelector('.toggle-arrow').textContent = this.nextElementSibling.style.display === 'none' ? '▶' : '▼';\\" style=\\"padding:10px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;background:#161b22;border-bottom:1px solid #30363d;\\">";
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
