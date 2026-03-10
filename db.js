// ============================================
// db.js - Módulo de Base de Datos SQLite
// ============================================
// Maneja todas las tablas del CRM:
// - clients: datos de cada cliente
// - conversations: historial de conversaciones
// - employees: datos de empleados
// - assignments: qué cliente está asignado a qué empleado

const Database = require('better-sqlite3');
const path = require('path');

// Crear/abrir la base de datos (se crea el archivo si no existe)
const db = new Database(path.join(__dirname, 'crm.db'));

// Activar WAL mode para mejor rendimiento
db.pragma('journal_mode = WAL');

// ============================================
// CREAR TABLAS
// ============================================
function initDatabase() {
  // Tabla de clientes
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      name TEXT DEFAULT '',
      email TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      memory TEXT DEFAULT '',
      status TEXT DEFAULT 'new',
      source TEXT DEFAULT 'whatsapp',
      interaction_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migración: agregar columnas nuevas si la tabla ya existía
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN memory TEXT DEFAULT ''`);
    console.log('[DB] Columna memory agregada');
  } catch (e) { /* ya existe */ }
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN interaction_count INTEGER DEFAULT 0`);
    console.log('[DB] Columna interaction_count agregada');
  } catch (e) { /* ya existe */ }
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN ignored INTEGER DEFAULT 0`);
    console.log('[DB] Columna ignored agregada');
  } catch (e) { /* ya existe */ }
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN spam_flag INTEGER DEFAULT 0`);
    console.log('[DB] Columna spam_flag agregada');
  } catch (e) { /* ya existe */ }
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN chat_id TEXT DEFAULT ''`);
    console.log('[DB] Columna chat_id agregada');
  } catch (e) { /* ya existe */ }
  // last_interaction ya no se usa — usamos updated_at

  // Nuevas banderas booleanas de estado de cliente
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN has_bought_gun INTEGER DEFAULT 0`);
    console.log('[DB] Columna has_bought_gun agregada');
  } catch (e) { /* ya existe */ }
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN is_club_plus INTEGER DEFAULT 0`);
    console.log('[DB] Columna is_club_plus agregada');
  } catch (e) { /* ya existe */ }
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN is_club_pro INTEGER DEFAULT 0`);
    console.log('[DB] Columna is_club_pro agregada');
  } catch (e) { /* ya existe */ }
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN has_ai_bot INTEGER DEFAULT 0`);
    console.log('[DB] Columna has_ai_bot agregada');
  } catch (e) { /* ya existe */ }

  // === Columnas de Ficha Completa del Cliente ===
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN cedula TEXT DEFAULT ''`);
    console.log('[DB] Columna cedula agregada');
  } catch (e) { /* ya existe */ }
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN ciudad TEXT DEFAULT ''`);
    console.log('[DB] Columna ciudad agregada');
  } catch (e) { /* ya existe */ }
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN direccion TEXT DEFAULT ''`);
    console.log('[DB] Columna direccion agregada');
  } catch (e) { /* ya existe */ }
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN profesion TEXT DEFAULT ''`);
    console.log('[DB] Columna profesion agregada');
  } catch (e) { /* ya existe */ }
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN club_plan TEXT DEFAULT ''`);
    console.log('[DB] Columna club_plan agregada');
  } catch (e) { /* ya existe */ }
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN club_vigente_hasta TEXT DEFAULT ''`);
    console.log('[DB] Columna club_vigente_hasta agregada');
  } catch (e) { /* ya existe */ }
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN serial_arma TEXT DEFAULT ''`);
    console.log('[DB] Columna serial_arma agregada');
  } catch (e) { /* ya existe */ }
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN modelo_arma TEXT DEFAULT ''`);
    console.log('[DB] Columna modelo_arma agregada');
  } catch (e) { /* ya existe */ }
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN carnet_qr_url TEXT DEFAULT ''`);
    console.log('[DB] Columna carnet_qr_url agregada');
  } catch (e) { /* ya existe */ }

  // Flag: catálogo de fotos ya enviado al cliente
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN catalogo_enviado INTEGER DEFAULT 0`);
    console.log('[DB] Columna catalogo_enviado agregada');
  } catch (e) { /* ya existe */ }

  // Migración: agregar plan_tipo a carnets
  try {
    db.exec(`ALTER TABLE carnets ADD COLUMN plan_tipo TEXT DEFAULT ''`);
    console.log('[DB] Columna plan_tipo agregada a carnets');
  } catch (e) { /* ya existe */ }

  // Tabla de empleados
  db.exec(`
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      is_active INTEGER DEFAULT 1,
      assignments_count INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Tabla de asignaciones (qué cliente va con qué empleado)
  db.exec(`
    CREATE TABLE IF NOT EXISTS assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_phone TEXT NOT NULL,
      employee_id INTEGER NOT NULL,
      status TEXT DEFAULT 'active',
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
  `);

  // Tabla de conversaciones (historial de mensajes)
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_phone TEXT NOT NULL,
      role TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Tabla de comprobantes pendientes de verificación
  db.exec(`
    CREATE TABLE IF NOT EXISTS comprobantes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_phone TEXT NOT NULL,
      client_name TEXT DEFAULT '',
      info TEXT DEFAULT '',
      imagen_base64 TEXT,
      imagen_mime TEXT DEFAULT 'image/jpeg',
      tipo TEXT DEFAULT 'desconocido',
      estado TEXT DEFAULT 'pendiente',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      verified_at DATETIME
    )
  `);

  // Tabla de carnets de Club ZT para verificación
  db.exec(`
    CREATE TABLE IF NOT EXISTS carnets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_phone TEXT NOT NULL,
      client_name TEXT DEFAULT '',
      imagen_base64 TEXT,
      imagen_mime TEXT DEFAULT 'image/jpeg',
      qr_contenido TEXT DEFAULT '',
      nombre TEXT DEFAULT '',
      cedula TEXT DEFAULT '',
      vigente_hasta TEXT DEFAULT '',
      marca_arma TEXT DEFAULT '',
      modelo_arma TEXT DEFAULT '',
      serial TEXT DEFAULT '',
      estado TEXT DEFAULT 'pendiente',
      verificado_por TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      verified_at DATETIME
    )
  `);

  // Tabla de archivos del cliente (fotos, comprobantes, carnets, selfies)
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_phone TEXT NOT NULL,
      tipo TEXT NOT NULL,
      descripcion TEXT DEFAULT '',
      imagen_base64 TEXT,
      imagen_mime TEXT DEFAULT 'image/jpeg',
      referencia_id INTEGER DEFAULT 0,
      referencia_tabla TEXT DEFAULT '',
      subido_por TEXT DEFAULT 'cliente',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('[DB] Base de datos inicializada correctamente');
}

// ============================================
// OPERACIONES DE CLIENTES
// ============================================

// Buscar cliente por teléfono
function getClient(phone) {
  const clean = phone.replace(/@.*/, '').replace(/\D/g, '');
  return db.prepare('SELECT * FROM clients WHERE phone = ?').get(clean);
}

// Crear o actualizar cliente
function upsertClient(phone, data = {}) {
  // Normalizar phone: quitar @c.us, @lid, @g.us y cualquier no-dígito
  phone = phone.replace(/@.*/, '').replace(/\D/g, '');
  if (!phone) return null;

  const existing = getClient(phone);

  if (existing) {
    // Actualizar solo los campos que se pasen
    const fields = [];
    const values = [];

    if (data.name) { fields.push('name = ?'); values.push(data.name); }
    if (data.email) { fields.push('email = ?'); values.push(data.email); }
    if (data.notes) { fields.push('notes = ?'); values.push(data.notes); }
    if (data.memory) { fields.push('memory = ?'); values.push(data.memory); }
    if (data.status) { fields.push('status = ?'); values.push(data.status); }
    if (data.chat_id) { fields.push('chat_id = ?'); values.push(data.chat_id); }
    if (data.has_bought_gun !== undefined) { fields.push('has_bought_gun = ?'); values.push(data.has_bought_gun ? 1 : 0); }
    if (data.is_club_plus !== undefined) { fields.push('is_club_plus = ?'); values.push(data.is_club_plus ? 1 : 0); }
    if (data.is_club_pro !== undefined) { fields.push('is_club_pro = ?'); values.push(data.is_club_pro ? 1 : 0); }
    if (data.has_ai_bot !== undefined) { fields.push('has_ai_bot = ?'); values.push(data.has_ai_bot ? 1 : 0); }
    // Nuevos campos de ficha completa
    if (data.cedula !== undefined) { fields.push('cedula = ?'); values.push(data.cedula); }
    if (data.ciudad !== undefined) { fields.push('ciudad = ?'); values.push(data.ciudad); }
    if (data.direccion !== undefined) { fields.push('direccion = ?'); values.push(data.direccion); }
    if (data.profesion !== undefined) { fields.push('profesion = ?'); values.push(data.profesion); }
    if (data.club_plan !== undefined) { fields.push('club_plan = ?'); values.push(data.club_plan); }
    if (data.club_vigente_hasta !== undefined) { fields.push('club_vigente_hasta = ?'); values.push(data.club_vigente_hasta); }
    if (data.serial_arma !== undefined) { fields.push('serial_arma = ?'); values.push(data.serial_arma); }
    if (data.modelo_arma !== undefined) { fields.push('modelo_arma = ?'); values.push(data.modelo_arma); }
    if (data.carnet_qr_url !== undefined) { fields.push('carnet_qr_url = ?'); values.push(data.carnet_qr_url); }

    // Siempre incrementar interacciones y actualizar fecha
    fields.push('interaction_count = interaction_count + 1');
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(phone);
    db.prepare(`UPDATE clients SET ${fields.join(', ')} WHERE phone = ?`).run(...values);

    return getClient(phone);
  } else {
    // Crear nuevo cliente
    db.prepare(`
      INSERT INTO clients (phone, chat_id, name, email, notes, memory, status, interaction_count, has_bought_gun, is_club_plus, is_club_pro, has_ai_bot)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      phone,
      data.chat_id || '',
      data.name || '',
      data.email || '',
      data.notes || '',
      data.memory || '',
      data.status || 'new',
      data.has_bought_gun ? 1 : 0,
      data.is_club_plus ? 1 : 0,
      data.is_club_pro ? 1 : 0,
      data.has_ai_bot ? 1 : 0
    );

    console.log(`[DB] Nuevo cliente registrado: ${phone}`);
    return getClient(phone);
  }
}

// Listar todos los clientes
function getAllClients() {
  return db.prepare('SELECT * FROM clients ORDER BY updated_at DESC').all();
}

// ============================================
// OPERACIONES DE EMPLEADOS
// ============================================

// Obtener empleado por ID
function getEmployee(id) {
  return db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
}

// Obtener empleado por teléfono
function getEmployeeByPhone(phone) {
  return db.prepare('SELECT * FROM employees WHERE phone = ?').get(phone);
}

// Obtener todos los empleados activos
function getActiveEmployees() {
  return db.prepare('SELECT * FROM employees WHERE is_active = 1 ORDER BY id').all();
}

// Agregar o actualizar empleado
function upsertEmployee(name, phone) {
  const existing = getEmployeeByPhone(phone);

  if (existing) {
    db.prepare('UPDATE employees SET name = ?, is_active = 1 WHERE phone = ?').run(name, phone);
    return getEmployeeByPhone(phone);
  } else {
    db.prepare('INSERT INTO employees (name, phone) VALUES (?, ?)').run(name, phone);
    console.log(`[DB] Empleado registrado: ${name} (${phone})`);
    return getEmployeeByPhone(phone);
  }
}

// Incrementar contador de asignaciones de un empleado
function incrementAssignments(employeeId) {
  db.prepare('UPDATE employees SET assignments_count = assignments_count + 1 WHERE id = ?').run(employeeId);
}

// ============================================
// OPERACIONES DE ASIGNACIONES
// ============================================

// Obtener asignación activa de un cliente
function getActiveAssignment(clientPhone) {
  return db.prepare(`
    SELECT a.*, e.name as employee_name, e.phone as employee_phone
    FROM assignments a
    JOIN employees e ON a.employee_id = e.id
    WHERE a.client_phone = ? AND a.status = 'active'
    ORDER BY a.assigned_at DESC
    LIMIT 1
  `).get(clientPhone);
}

// Crear nueva asignación
function createAssignment(clientPhone, employeeId) {
  // Cerrar asignaciones previas del mismo cliente
  db.prepare(`
    UPDATE assignments SET status = 'completed', completed_at = CURRENT_TIMESTAMP
    WHERE client_phone = ? AND status = 'active'
  `).run(clientPhone);

  // Crear nueva asignación
  db.prepare(`
    INSERT INTO assignments (client_phone, employee_id) VALUES (?, ?)
  `).run(clientPhone, employeeId);

  incrementAssignments(employeeId);

  console.log(`[DB] Cliente ${clientPhone} asignado a empleado ID ${employeeId}`);
  return getActiveAssignment(clientPhone);
}

// ============================================
// OPERACIONES DE CONVERSACIONES
// ============================================

// Guardar mensaje en historial
function saveMessage(clientPhone, role, message) {
  db.prepare(`
    INSERT INTO conversations (client_phone, role, message) VALUES (?, ?, ?)
  `).run(clientPhone, role, message);
}

// Obtener historial de conversación (últimos N mensajes)
function getConversationHistory(clientPhone, limit = 10) {
  return db.prepare(`
    SELECT role, message, created_at
    FROM conversations
    WHERE client_phone = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(clientPhone, limit).reverse(); // reverse para orden cronológico
}

// Limpiar historial de un cliente
function clearConversation(clientPhone) {
  db.prepare('DELETE FROM conversations WHERE client_phone = ?').run(clientPhone);
}

// ============================================
// OPERACIONES DE CARNETS
// ============================================

// Guardar un carnet recibido para verificación
function saveCarnet(clientPhone, clientName, imagenBase64, imagenMime, datos = {}) {
  return db.prepare(`
    INSERT INTO carnets (client_phone, client_name, imagen_base64, imagen_mime, qr_contenido, nombre, cedula, vigente_hasta, marca_arma, modelo_arma, serial)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    clientPhone,
    clientName || '',
    imagenBase64 || '',
    imagenMime || 'image/jpeg',
    datos.qr_contenido || '',
    datos.nombre || '',
    datos.cedula || '',
    datos.vigente_hasta || '',
    datos.marca_arma || '',
    datos.modelo_arma || '',
    datos.serial || ''
  );
}

// Obtener carnets pendientes de verificar
function getCarnetsPendientes() {
  return db.prepare(`SELECT * FROM carnets WHERE estado = 'pendiente' ORDER BY created_at DESC`).all();
}

// Cambiar estado de un carnet (verificado / rechazado)
function updateCarnetEstado(id, estado, verificadoPor = '') {
  db.prepare(`UPDATE carnets SET estado = ?, verificado_por = ?, verified_at = CURRENT_TIMESTAMP WHERE id = ?`).run(estado, verificadoPor, id);
}

// Obtener todos los carnets de un cliente
function getCarnetsByClient(phone) {
  phone = phone.replace(/@.*/, '').replace(/\D/g, '');
  return db.prepare(`
    SELECT id, client_phone, client_name, nombre, cedula, vigente_hasta,
           marca_arma, modelo_arma, serial, plan_tipo, estado, imagen_mime,
           created_at, verified_at
    FROM carnets WHERE client_phone = ? ORDER BY created_at DESC
  `).all(phone);
}

// Guardar un carnet enviado/creado desde el panel
function saveCarnetFromPanel(clientPhone, clientName, imagenBase64, imagenMime, datos = {}) {
  return db.prepare(`
    INSERT INTO carnets (client_phone, client_name, imagen_base64, imagen_mime, qr_contenido, nombre, cedula, vigente_hasta, marca_arma, modelo_arma, serial, plan_tipo, estado)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enviado')
  `).run(
    clientPhone,
    clientName || '',
    imagenBase64 || '',
    imagenMime || 'image/jpeg',
    datos.qr_contenido || '',
    datos.nombre || '',
    datos.cedula || '',
    datos.vigente_hasta || '',
    datos.marca_arma || '',
    datos.modelo_arma || '',
    datos.serial || '',
    datos.plan_tipo || ''
  );
}

// Obtener todos los carnets (no solo pendientes)
function getAllCarnets() {
  return db.prepare(`
    SELECT id, client_phone, client_name, nombre, cedula, vigente_hasta,
           marca_arma, modelo_arma, serial, plan_tipo, estado, imagen_mime,
           created_at, verified_at
    FROM carnets ORDER BY created_at DESC
  `).all();
}

// ============================================
// ESTADÍSTICAS
// ============================================

function getStats() {
  const totalClients = db.prepare('SELECT COUNT(*) as count FROM clients').get().count;
  const newClients = db.prepare("SELECT COUNT(*) as count FROM clients WHERE status = 'new'").get().count;
  const activeAssignments = db.prepare("SELECT COUNT(*) as count FROM assignments WHERE status = 'active'").get().count;
  const totalMessages = db.prepare('SELECT COUNT(*) as count FROM conversations').get().count;

  const employeeStats = db.prepare(`
    SELECT e.name, e.phone, e.assignments_count,
           (SELECT COUNT(*) FROM assignments WHERE employee_id = e.id AND status = 'active') as active_now
    FROM employees e
    WHERE e.is_active = 1
    ORDER BY e.id
  `).all();

  return {
    totalClients,
    newClients,
    activeAssignments,
    totalMessages,
    employees: employeeStats
  };
}

// ============================================
// REPORTES / INFORMES
// ============================================

// Informe general del negocio
function getGeneralReport() {
  const totalClients = db.prepare('SELECT COUNT(*) as count FROM clients').get().count;
  const newClients = db.prepare("SELECT COUNT(*) as count FROM clients WHERE status = 'new'").get().count;
  const assignedClients = db.prepare("SELECT COUNT(*) as count FROM clients WHERE status = 'assigned'").get().count;
  const totalMessages = db.prepare('SELECT COUNT(*) as count FROM conversations').get().count;
  const activeAssignments = db.prepare("SELECT COUNT(*) as count FROM assignments WHERE status = 'active'").get().count;

  // Clientes hoy
  const clientsToday = db.prepare(`
    SELECT COUNT(*) as count FROM clients
    WHERE date(created_at) = date('now')
  `).get().count;

  // Clientes esta semana
  const clientsThisWeek = db.prepare(`
    SELECT COUNT(*) as count FROM clients
    WHERE created_at >= datetime('now', '-7 days')
  `).get().count;

  // Mensajes hoy
  const messagesToday = db.prepare(`
    SELECT COUNT(*) as count FROM conversations
    WHERE date(created_at) = date('now')
  `).get().count;

  // Derivaciones hoy
  const handoffsToday = db.prepare(`
    SELECT COUNT(*) as count FROM assignments
    WHERE date(assigned_at) = date('now')
  `).get().count;

  // Productos más consultados (de las conversaciones)
  const recentClientMessages = db.prepare(`
    SELECT message FROM conversations
    WHERE role = 'user' AND created_at >= datetime('now', '-7 days')
  `).all();

  // Clientes sin atender (new y sin asignación)
  const unattendedClients = db.prepare(`
    SELECT c.phone, c.name, c.created_at, c.interaction_count
    FROM clients c
    WHERE c.status = 'new'
    AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.client_phone = c.phone AND a.status = 'active')
    ORDER BY c.created_at DESC
    LIMIT 5
  `).all();

  // Stats por empleado
  const employeeStats = db.prepare(`
    SELECT e.name, e.phone, e.assignments_count,
           (SELECT COUNT(*) FROM assignments WHERE employee_id = e.id AND status = 'active') as active_now,
           (SELECT COUNT(*) FROM assignments WHERE employee_id = e.id AND date(assigned_at) = date('now')) as today
    FROM employees e
    WHERE e.is_active = 1
    ORDER BY e.id
  `).all();

  return {
    totalClients, newClients, assignedClients, totalMessages, activeAssignments,
    clientsToday, clientsThisWeek, messagesToday, handoffsToday,
    unattendedClients, employeeStats, recentClientMessages
  };
}

// Informe de ventas/pipeline
function getSalesReport() {
  // Pipeline por estado
  const pipeline = db.prepare(`
    SELECT status, COUNT(*) as count FROM clients GROUP BY status
  `).all();

  // Clientes asignados pendientes (derivados pero no cerrados)
  const pendingClients = db.prepare(`
    SELECT c.phone, c.name, c.memory, a.assigned_at, e.name as employee_name
    FROM clients c
    JOIN assignments a ON a.client_phone = c.phone AND a.status = 'active'
    JOIN employees e ON a.employee_id = e.id
    ORDER BY a.assigned_at DESC
    LIMIT 10
  `).all();

  // Clientes con intención de compra (que tienen memoria con "comprar" o "interesado")
  const hotLeads = db.prepare(`
    SELECT phone, name, memory, updated_at
    FROM clients
    WHERE memory LIKE '%comprar%' OR memory LIKE '%listo%' OR memory LIKE '%interesado%' OR memory LIKE '%presupuesto%'
    ORDER BY updated_at DESC
    LIMIT 10
  `).all();

  // Carga por empleado
  const employeeLoad = db.prepare(`
    SELECT e.name, e.assignments_count,
           (SELECT COUNT(*) FROM assignments WHERE employee_id = e.id AND status = 'active') as active_now
    FROM employees e WHERE e.is_active = 1
  `).all();

  return { pipeline, pendingClients, hotLeads, employeeLoad };
}

// Actualizar notas de un cliente
function updateClientNotes(phone, notes) {
  db.prepare(`
    UPDATE clients SET notes = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ?
  `).run(notes, phone);
}

// Resetear cliente (limpiar historial y volver a new)
function resetClient(phone) {
  db.prepare('DELETE FROM conversations WHERE client_phone = ?').run(phone);
  db.prepare("UPDATE assignments SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE client_phone = ? AND status = 'active'").run(phone);
  db.prepare("UPDATE clients SET status = 'new', memory = '', interaction_count = 0, has_bought_gun = 0, is_club_plus = 0, is_club_pro = 0, has_ai_bot = 0, updated_at = CURRENT_TIMESTAMP WHERE phone = ?").run(phone);
}

// Cerrar asignación de un cliente
function closeAssignment(clientPhone) {
  const assignment = getActiveAssignment(clientPhone);
  if (!assignment) return null;
  db.prepare("UPDATE assignments SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE client_phone = ? AND status = 'active'").run(clientPhone);
  db.prepare("UPDATE clients SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE phone = ?").run(clientPhone);
  return assignment;
}

// ============================================
// MEMORIA DEL CLIENTE
// ============================================

// Migrar un cliente de un phone viejo (LID) al número real resuelto
function migrateClientPhone(oldPhone, newPhone) {
  oldPhone = oldPhone.replace(/@.*/, '').replace(/\D/g, '');
  newPhone = newPhone.replace(/@.*/, '').replace(/\D/g, '');
  const migrate = db.transaction(() => {
    db.prepare('UPDATE clients       SET phone = ? WHERE phone = ?').run(newPhone, oldPhone);
    db.prepare('UPDATE conversations SET client_phone = ? WHERE client_phone = ?').run(newPhone, oldPhone);
    db.prepare('UPDATE assignments   SET client_phone = ? WHERE client_phone = ?').run(newPhone, oldPhone);
  });
  migrate();
  console.log(`[DB] 📱 Migrado: ${oldPhone} → ${newPhone}`);
}

// Obtener el chat_id correcto para enviar mensajes (con fallback a @c.us)
function getClientChatId(phone) {
  const client = getClient(phone);
  if (client && client.chat_id) return client.chat_id;
  // fallback: construir @c.us con solo dígitos
  return phone.replace(/@.*/g, '').replace(/\D/g, '') + '@c.us';
}

// Obtener memoria de un cliente
function getClientMemory(phone) {
  const client = getClient(phone);
  return client?.memory || '';
}

// Actualizar memoria de un cliente (reemplaza completamente)
function updateClientMemory(phone, memory) {
  db.prepare(`
    UPDATE clients SET memory = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ?
  `).run(memory, phone);
}

// Obtener perfil completo del cliente (para comando !client)
function getClientProfile(phone) {
  const client = getClient(phone);
  if (!client) return null;

  const assignment = getActiveAssignment(phone);
  const messageCount = db.prepare(
    'SELECT COUNT(*) as count FROM conversations WHERE client_phone = ?'
  ).get(phone).count;

  const lastMessages = getConversationHistory(phone, 5);

  return {
    ...client,
    assignedTo: assignment ? assignment.employee_name : null,
    totalMessages: messageCount,
    recentMessages: lastMessages,
  };
}

// ============================================
// IGNORAR CONTACTO
// ============================================
function setIgnored(phone, ignored = true) {
  db.prepare('UPDATE clients SET ignored = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ?')
    .run(ignored ? 1 : 0, phone);
}

function isIgnored(phone) {
  const client = getClient(phone);
  return client ? client.ignored === 1 : false;
}

// ============================================
// SPAM FLAG — posible bot/loop
// ============================================
function setSpamFlag(phone, flagged = true) {
  db.prepare('UPDATE clients SET spam_flag = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ?')
    .run(flagged ? 1 : 0, phone);
}

function isSpamFlagged(phone) {
  const client = getClient(phone);
  return client ? client.spam_flag === 1 : false;
}

function getSpamFlagged() {
  return db.prepare('SELECT * FROM clients WHERE spam_flag = 1 ORDER BY updated_at DESC').all();
}

// Clientes cuyo phone es un LID (>=13 dígitos) — pendientes de resolver a número real
function getLidClients() {
  return db.prepare(`
    SELECT phone, name, chat_id FROM clients
    WHERE length(phone) >= 13
    ORDER BY updated_at DESC
  `).all();
}

// ============================================
// EXPORTAR
// ============================================
// ============================================
// ARCHIVOS DEL CLIENTE (fotos, comprobantes, carnets, selfies)
// ============================================
function saveClientFile(phone, tipo, descripcion, imagenBase64, imagenMime, subidoPor = 'cliente', referenciaId = 0, referenciatabla = '') {
  return db.prepare(`
    INSERT INTO client_files (client_phone, tipo, descripcion, imagen_base64, imagen_mime, subido_por, referencia_id, referencia_tabla)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(phone, tipo, descripcion || '', imagenBase64 || '', imagenMime || 'image/jpeg', subidoPor, referenciaId, referenciatabla);
}

function getClientFiles(phone) {
  return db.prepare(`
    SELECT id, tipo, descripcion, imagen_mime, subido_por, referencia_id, referencia_tabla, created_at
    FROM client_files WHERE client_phone = ? ORDER BY created_at DESC
  `).all(phone);
}

function getClientFilesByTipo(phone, tipo) {
  return db.prepare(`
    SELECT * FROM client_files WHERE client_phone = ? AND tipo = ? ORDER BY created_at DESC
  `).all(phone, tipo);
}

function getClientFile(id) {
  return db.prepare('SELECT * FROM client_files WHERE id = ?').get(id);
}

// ============================================
// DOSSIER COMPLETO DEL CLIENTE (Agent System)
// Consulta TODAS las tablas para dar contexto total al modelo de IA
// ============================================
function getClientAllComprobantes(phone) {
  phone = phone.replace(/@.*/, '').replace(/\D/g, '');
  return db.prepare(`
    SELECT id, tipo, estado, info, created_at, verified_at
    FROM comprobantes WHERE client_phone = ? ORDER BY created_at DESC
  `).all(phone);
}

function getClientAllCarnets(phone) {
  phone = phone.replace(/@.*/, '').replace(/\D/g, '');
  return db.prepare(`
    SELECT id, estado, nombre, cedula, vigente_hasta, marca_arma, modelo_arma, serial, created_at, verified_at
    FROM carnets WHERE client_phone = ? ORDER BY created_at DESC
  `).all(phone);
}

function buildClientDossier(phone) {
  phone = phone.replace(/@.*/, '').replace(/\D/g, '');
  const profile = getClient(phone);
  if (!profile) return null;

  const memory = profile.memory || '';
  const comprobantes = getClientAllComprobantes(phone);
  const carnets = getClientAllCarnets(phone);
  const files = getClientFiles(phone);
  const history = getConversationHistory(phone, 30);
  const assignment = getActiveAssignment(phone);

  // Estadísticas
  const totalMessages = db.prepare(
    'SELECT COUNT(*) as count FROM conversations WHERE client_phone = ?'
  ).get(phone).count;
  const firstMsg = db.prepare(
    'SELECT MIN(created_at) as first FROM conversations WHERE client_phone = ?'
  ).get(phone).first;

  return {
    profile,
    memory,
    documents: {
      comprobantes,
      carnets,
      files
    },
    history,
    assignment: assignment ? { employee: assignment.employee_name, since: assignment.assigned_at } : null,
    stats: {
      totalMessages,
      firstContact: firstMsg || profile.created_at,
      lastContact: profile.updated_at,
      interactionCount: profile.interaction_count
    }
  };
}

// Generar resumen de documentos en texto (para inyectar en prompt de IA)
function buildDocumentSummary(phone) {
  phone = phone.replace(/@.*/, '').replace(/\D/g, '');
  const comprobantes = getClientAllComprobantes(phone);
  const carnets = getClientAllCarnets(phone);
  const files = getClientFiles(phone);

  const lines = [];

  if (comprobantes.length > 0) {
    lines.push('📄 COMPROBANTES DE PAGO:');
    comprobantes.forEach(c => {
      const fecha = c.created_at ? new Date(c.created_at).toLocaleDateString('es-CO') : '?';
      const estado = c.estado === 'pendiente' ? '⏳ PENDIENTE DE VERIFICAR' :
        c.estado === 'verificado' ? '✅ VERIFICADO' : `❌ ${c.estado.toUpperCase()}`;
      lines.push(`  - ${fecha}: ${c.info || 'sin detalle'} | Tipo: ${c.tipo} | Estado: ${estado}`);
    });
  }

  if (carnets.length > 0) {
    lines.push('🪪 CARNETS:');
    carnets.forEach(c => {
      const fecha = c.created_at ? new Date(c.created_at).toLocaleDateString('es-CO') : '?';
      const estado = c.estado === 'pendiente' ? '⏳ PENDIENTE' :
        c.estado === 'verificado' ? '✅ VERIFICADO' : `❌ ${c.estado.toUpperCase()}`;
      lines.push(`  - ${fecha}: ${c.nombre || '?'} (CC: ${c.cedula || '?'}) | Vigente hasta: ${c.vigente_hasta || '?'} | Estado: ${estado}`);
    });
  }

  if (files.length > 0) {
    lines.push('📎 ARCHIVOS RECIBIDOS:');
    files.forEach(f => {
      const fecha = f.created_at ? new Date(f.created_at).toLocaleDateString('es-CO') : '?';
      lines.push(`  - ${fecha}: [${f.tipo}] ${f.descripcion || 'sin descripción'} (enviado por: ${f.subido_por})`);
    });
  }

  if (lines.length === 0) return '';
  return lines.join('\n');
}

// ============================================
// HELPER: actualizar flag booleano de cliente
// ============================================
function updateClientFlag(phone, flagName, value) {
  const allowed = ['has_bought_gun', 'is_club_plus', 'is_club_pro', 'has_ai_bot', 'ignored', 'spam_flag', 'catalogo_enviado'];
  if (!allowed.includes(flagName)) return;
  db.prepare(`UPDATE clients SET ${flagName} = ?, updated_at = CURRENT_TIMESTAMP WHERE phone = ?`).run(value ? 1 : 0, phone);
}

// Marcar que ya se le enviaron fotos del catálogo a un cliente
function markCatalogSent(phone) {
  phone = phone.replace(/@.*/, '').replace(/\D/g, '');
  db.prepare('UPDATE clients SET catalogo_enviado = 1, updated_at = CURRENT_TIMESTAMP WHERE phone = ?').run(phone);
}

// Verificar si ya se le enviaron fotos del catálogo
function isCatalogSent(phone) {
  phone = phone.replace(/@.*/, '').replace(/\D/g, '');
  const client = db.prepare('SELECT catalogo_enviado FROM clients WHERE phone = ?').get(phone);
  return client ? client.catalogo_enviado === 1 : false;
}

module.exports = {
  db,
  initDatabase,
  // Clientes
  getClient,
  upsertClient,
  getAllClients,
  getClientChatId,
  migrateClientPhone,
  getClientMemory,
  updateClientMemory,
  getClientProfile,
  updateClientNotes,
  resetClient,
  setIgnored,
  isIgnored,
  setSpamFlag,
  isSpamFlagged,
  getSpamFlagged,
  getLidClients,
  updateClientFlag,
  // Empleados
  getEmployee,
  getEmployeeByPhone,
  getActiveEmployees,
  upsertEmployee,
  // Asignaciones
  getActiveAssignment,
  createAssignment,
  closeAssignment,
  // Conversaciones
  saveMessage,
  getConversationHistory,
  clearConversation,
  // Stats & Reportes
  getStats,
  getGeneralReport,
  getSalesReport,
  // Comprobantes
  saveComprobante,
  getComprobantesPendientes,
  updateComprobanteEstado,
  // Carnets
  saveCarnet,
  getCarnetsPendientes,
  updateCarnetEstado,
  getCarnetsByClient,
  saveCarnetFromPanel,
  getAllCarnets,
  // Archivos del cliente
  saveClientFile,
  getClientFiles,
  getClientFilesByTipo,
  getClientFile,
  // Dossier / Agent System
  buildClientDossier,
  buildDocumentSummary,
  getClientAllComprobantes,
  getClientAllCarnets,
  // Catálogo enviado
  markCatalogSent,
  isCatalogSent,
};

// ============================================
// COMPROBANTES DE PAGO
// ============================================
function saveComprobante(phone, name, info, imagenBase64, imagenMime, tipo) {
  return db.prepare(`
    INSERT INTO comprobantes (client_phone, client_name, info, imagen_base64, imagen_mime, tipo, estado)
    VALUES (?, ?, ?, ?, ?, ?, 'pendiente')
  `).run(phone, name || '', info || '', imagenBase64 || '', imagenMime || 'image/jpeg', tipo || 'desconocido');
}

function getComprobantesPendientes() {
  return db.prepare(`
    SELECT * FROM comprobantes WHERE estado = 'pendiente' ORDER BY created_at DESC
  `).all();
}

function updateComprobanteEstado(id, estado) {
  return db.prepare(`
    UPDATE comprobantes SET estado = ?, verified_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(estado, id);
}
