// ============================================
// router.js - Sistema de Asignación Round-Robin
// ============================================
// Asigna clientes a empleados por turnos rotativos.
// Ejemplo con 4 empleados:
//   Cliente 1 → Empleado 1
//   Cliente 2 → Empleado 2
//   Cliente 3 → Empleado 3
//   Cliente 4 → Empleado 4
//   Cliente 5 → Empleado 1 (vuelve al inicio)

const db = require('./db');

// Variable para rastrear el último empleado asignado
let lastAssignedIndex = -1;

// ============================================
// FUNCIONES PRINCIPALES
// ============================================

/**
 * Obtener el próximo empleado en la rotación
 * Si un cliente ya tiene asignación activa, devuelve ese mismo empleado
 */
function assignClient(clientPhone) {
  // 1. Verificar si el cliente ya tiene una asignación activa
  const existingAssignment = db.getActiveAssignment(clientPhone);
  if (existingAssignment) {
    console.log(`[ROUTER] Cliente ${clientPhone} ya asignado a ${existingAssignment.employee_name}`);
    return existingAssignment;
  }

  // 2. Obtener empleados activos
  const employees = db.getActiveEmployees();

  if (employees.length === 0) {
    console.log('[ROUTER] No hay empleados activos disponibles');
    return null;
  }

  // 3. Round-robin: avanzar al siguiente empleado
  lastAssignedIndex = (lastAssignedIndex + 1) % employees.length;
  const selectedEmployee = employees[lastAssignedIndex];

  // 4. Crear la asignación en la BD
  const assignment = db.createAssignment(clientPhone, selectedEmployee.id);

  console.log(`[ROUTER] Cliente ${clientPhone} → ${selectedEmployee.name} (turno ${lastAssignedIndex + 1}/${employees.length})`);

  return assignment;
}

/**
 * Generar mensaje de derivación para enviar al cliente
 */
function getHandoffMessage(assignment, businessName) {
  return `¡Gracias por tu interés! 🎯\n\n` +
    `Te voy a comunicar con *${assignment.employee_name}*, quien te atenderá personalmente.\n\n` +
    `Su número de WhatsApp es:\n` +
    `📱 wa.me/${assignment.employee_phone}\n\n` +
    `También puedes esperar a que ${assignment.employee_name} se comunique contigo.\n\n` +
    `_${businessName} - Atención personalizada_`;
}

/**
 * Generar mensaje de notificación para el empleado
 */
function getEmployeeNotification(clientPhone, clientName, context) {
  const name = clientName || 'Cliente nuevo';
  return `🔔 *Nueva asignación de cliente*\n\n` +
    `📋 *Cliente:* ${name}\n` +
    `📱 *Número:* wa.me/${clientPhone.replace('@c.us', '')}\n\n` +
    `💬 *Contexto de la conversación:*\n${context}\n\n` +
    `_Por favor, comunícate con el cliente lo antes posible._`;
}

/**
 * Inicializar el índice de round-robin basado en la BD
 * (para mantener la rotación justa después de reiniciar el bot)
 */
function initRouter() {
  const employees = db.getActiveEmployees();

  if (employees.length === 0) {
    console.log('[ROUTER] No hay empleados configurados aún');
    return;
  }

  // Buscar el empleado con más asignaciones para continuar la rotación
  let maxAssignments = 0;
  let maxIndex = -1;

  employees.forEach((emp, index) => {
    if (emp.assignments_count >= maxAssignments) {
      maxAssignments = emp.assignments_count;
      maxIndex = index;
    }
  });

  // El último que fue asignado es el que tiene más, así el siguiente será el correcto
  lastAssignedIndex = maxIndex;

  console.log(`[ROUTER] Inicializado. Próximo empleado en turno: ${employees[(maxIndex + 1) % employees.length].name}`);
}

// ============================================
// EXPORTAR
// ============================================
module.exports = {
  assignClient,
  getHandoffMessage,
  getEmployeeNotification,
  initRouter
};
