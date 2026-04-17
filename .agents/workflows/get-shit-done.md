---
description: Protocolo general de trabajo profesional — cómo abordar cualquier tarea de forma organizada
---

# Get Shit Done — Protocolo de Trabajo

Este workflow es el protocolo estándar para abordar cualquier tarea. Úsalo como guía general.

## Clasificar la tarea

### 🟢 Tarea Simple (< 5 minutos)
Ejemplos: cambiar un color, agregar un texto, fix de typo, agregar un console.log
- **Acción**: Ejecutar directamente sin plan
- **No necesita**: Plan, aprobación, walkthrough

### 🟡 Tarea Media (15-60 minutos)
Ejemplos: agregar un feature al bot, crear un componente nuevo, refactorizar una sección
- **Acción**: Crear plan breve → pedir aprobación → ejecutar
- **Necesita**: `implementation_plan.md` con los cambios propuestos

### 🔴 Tarea Compleja (> 1 hora)
Ejemplos: nuevo proyecto desde cero, rediseño completo, nuevo sistema/pipeline
- **Acción**: Investigar → Plan detallado → Aprobación → Task list → Ejecutar → Walkthrough
- **Necesita**: Plan completo, task.md, walkthrough.md al final

### 🔵 Tarea Recurrente
Ejemplos: otra landing page, otro documento legal, otro deploy
- **Acción**: Verificar si existe un Skill o Workflow → Usarlo
- **Si no existe**: Crear el skill/workflow mientras se ejecuta la primera vez

## Principios

1. **Verificar antes de asumir** — Siempre leer el código real antes de proponer cambios
2. **Planificar antes de ejecutar** — Para tareas medianas/complejas
3. **Probar lo que se hace** — Abrir en navegador, ejecutar tests
4. **Documentar lo importante** — Walkthroughs para cambios significativos
5. **No reinventar la rueda** — Si hay un skill o patrón existente, reutilizarlo
6. **Mobile first** — Siempre diseñar para mobile primero
7. **Premium por defecto** — Nunca entregar algo que se vea "básico"

## Cuando el usuario dice "no funciona"

1. Pedir contexto: ¿Qué error ves? ¿Qué esperabas que pasara?
2. Revisar la consola del navegador (si es web)
3. Revisar los logs del servidor (si es backend)
4. Verificar que los archivos existen y están bien referenciados
5. **NUNCA asumir** — siempre verificar

## Cuando el usuario quiere algo visual

1. Preguntar por referencia visual si no la da (¿Qué estilo te gusta? ¿Oscuro/claro?)
2. Usar paleta de colores curada (no rojo/azul genéricos)
3. Google Fonts siempre (no fuentes del sistema)
4. Animaciones suaves (0.3s ease transitions)
5. Glassmorphism / gradientes cuando sea apropiado
6. Probar visualmente antes de entregar
