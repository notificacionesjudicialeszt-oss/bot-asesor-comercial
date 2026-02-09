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
      status TEXT DEFAULT 'new',
      source TEXT DEFAULT 'whatsapp',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

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
    if (data.status) { fields.push('status = ?'); values.push(data.status); }

    if (fields.length > 0) {
      fields.push('updated_at = CURRENT_TIMESTAMP');
      values.push(phone);
      db.prepare(`UPDATE clients SET ${fields.join(', ')} WHERE phone = ?`).run(...values);
    }

    return getClient(phone);
  } else {
    // Crear nuevo cliente
    db.prepare(`
      INSERT INTO clients (phone, name, email, notes, status)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      phone,
      data.name || '',
      data.email || '',
      data.notes || '',
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
// EXPORTAR
// ============================================
module.exports = {
  db,
  initDatabase,
  // Clientes
  getClient,
  upsertClient,
  getAllClients,
  // Empleados
  getEmployee,
  getEmployeeByPhone,
  getActiveEmployees,
  upsertEmployee,
  // Asignaciones
  getActiveAssignment,
  createAssignment,
  // Conversaciones
  saveMessage,
  getConversationHistory,
  clearConversation,
  // Stats
  getStats
};
