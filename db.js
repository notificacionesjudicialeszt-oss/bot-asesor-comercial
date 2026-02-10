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
  // last_interaction ya no se usa — usamos updated_at

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

  console.log('[DB] Base de datos inicializada correctamente');
}

// ============================================
// OPERACIONES DE CLIENTES
// ============================================

// Buscar cliente por teléfono
function getClient(phone) {
  return db.prepare('SELECT * FROM clients WHERE phone = ?').get(phone);
}

// Crear o actualizar cliente
function upsertClient(phone, data = {}) {
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

    // Siempre incrementar interacciones y actualizar fecha
    fields.push('interaction_count = interaction_count + 1');
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(phone);
    db.prepare(`UPDATE clients SET ${fields.join(', ')} WHERE phone = ?`).run(...values);

    return getClient(phone);
  } else {
    // Crear nuevo cliente
    db.prepare(`
      INSERT INTO clients (phone, name, email, notes, memory, status, interaction_count)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(
      phone,
      data.name || '',
      data.email || '',
      data.notes || '',
      data.memory || '',
      data.status || 'new'
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
  db.prepare("UPDATE clients SET status = 'new', memory = '', interaction_count = 0, updated_at = CURRENT_TIMESTAMP WHERE phone = ?").run(phone);
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
// EXPORTAR
// ============================================
module.exports = {
  db,
  initDatabase,
  // Clientes
  getClient,
  upsertClient,
  getAllClients,
  getClientMemory,
  updateClientMemory,
  getClientProfile,
  updateClientNotes,
  resetClient,
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
};
