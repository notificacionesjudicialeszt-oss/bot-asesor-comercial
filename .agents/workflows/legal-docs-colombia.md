---
name: legal-docs-colombia
description: Genera documentos legales colombianos profesionales (derechos de petición, tutelas, apelaciones, nulidad de acto administrativo) en formato Word (.docx) con la normativa y estructura legal vigente.
---

# Generador de Documentos Legales Colombianos

Este skill permite generar documentos legales formales para el sistema jurídico colombiano, con formato profesional en Word (.docx).

## Dependencias

- Skill `generate-docx` (debe estar instalado)
- Python 3.x con `python-docx`

## Tipos de Documentos Soportados

### 1. Derecho de Petición
- **Base Legal**: Artículo 23 de la Constitución Política de Colombia, Ley 1755 de 2015
- **Término de respuesta**: 15 días hábiles (consultas 10 días, información 10 días, documentos 10 días)
- **Ante**: Cualquier entidad pública o privada que preste servicios públicos

### 2. Acción de Tutela
- **Base Legal**: Artículo 86 de la Constitución Política, Decreto 2591 de 1991
- **Término para fallo**: 10 días hábiles
- **Requisito de subsidiariedad**: Solo procede cuando no exista otro medio de defensa judicial, salvo perjuicio irremediable
- **Ante**: Cualquier juez de la República

### 3. Recurso de Apelación
- **Base Legal**: Ley 1437 de 2011 (CPACA), Arts. 74-80
- **Término para interponer**: 10 días hábiles siguientes a la notificación del acto
- **Ante**: Superior jerárquico de quien expidió el acto

### 4. Nulidad del Acto Administrativo (Nulidad Simple y Nulidad y Restablecimiento del Derecho)
- **Base Legal**: Arts. 137-138 del CPACA (Ley 1437 de 2011)
- **Caducidad**: Nulidad simple: no caduca. Nulidad y restablecimiento: 4 meses
- **Ante**: Jurisdicción de lo Contencioso Administrativo

---

## Cómo Generar un Documento

### Paso 1: Recopilar la información del usuario

Antes de generar cualquier documento, debes solicitar al usuario la siguiente información según el tipo:

#### Para TODOS los documentos:
- Nombre completo del peticionario/accionante
- Número de cédula de ciudadanía
- Dirección de notificación (física y/o correo electrónico)
- Teléfono de contacto
- Ciudad donde se radica el documento

#### Específico por tipo:

**Derecho de Petición:**
- Entidad destino (nombre completo)
- Funcionario destino (si se conoce)
- Hechos relevantes (narrativa cronológica)
- Qué se solicita específicamente (petición concreta)
- Pruebas o documentos soporte (si los tiene)

**Acción de Tutela:**
- Juez destinatario (o "Juez de la República" genérico)
- Entidad/persona accionada
- Derechos fundamentales vulnerados o amenazados
- Hechos con fechas y detalles
- Pretensiones concretas
- Si ha agotado otros medios de defensa
- Si hay perjuicio irremediable (para procedencia con medio judicial existente)
- Si solicita medida provisional
- Pruebas

**Recurso de Apelación:**
- Acto administrativo que se impugna (número, fecha, entidad)
- Hechos que motivan la inconformidad
- Fundamentos jurídicos de la inconformidad
- Pretensión concreta (qué se pide: revocar, modificar, adicionar)
- Pruebas adicionales

**Nulidad del Acto Administrativo:**
- Acto administrativo demandado (identificación completa)
- Normas superiores violadas con concepto de violación
- Tipo de pretensión: nulidad simple (Art. 137) o nulidad y restablecimiento del derecho (Art. 138)
- Causales de nulidad invocadas (Art. 137 CPACA):
  - Infracción de normas superiores
  - Falta de competencia
  - Expedición irregular
  - Desconocimiento del derecho de audiencias y defensa
  - Falsa motivación
  - Desviación de las atribuciones propias
- Restablecimiento del derecho pretendido (si aplica)
- Indemnización de perjuicios (si se solicita)

### Paso 2: Generar la especificación JSON

Usa la plantilla del tipo de documento correspondiente ubicada en:
```
.agents/skills/legal-docs-colombia/templates/
```

### Paso 3: Generar el documento

Crea un script Python temporal que use la información del usuario para generar el .docx. Usa como referencia los scripts en:
```
.agents/skills/legal-docs-colombia/scripts/
```

Ejecuta el script con:
```powershell
python <script_temporal.py>
```

---

## Formato del Documento Legal

Todos los documentos legales deben seguir este formato estándar:

### Tipografía y Márgenes
- **Fuente**: Times New Roman o Arial, 12pt
- **Interlineado**: 1.5
- **Márgenes**: Superior 3cm, Inferior 3cm, Izquierdo 3cm, Derecho 3cm
- **Alineación de cuerpo**: Justificado
- **Papel**: Carta (Letter)

### Estructura General
1. **Encabezado**: Ciudad y fecha
2. **Destinatario**: Señor/Señora + cargo + entidad + ciudad
3. **Referencia/Asunto**: Breve descripción
4. **Cuerpo**:
   - Identificación del peticionario
   - Hechos (numerados)
   - Fundamentos de derecho (con citas normativas)
   - Petición/Pretensiones (numeradas)
   - Pruebas (listado)
   - Notificaciones
5. **Despedida formal**
6. **Firma**: Nombre, CC, dirección, teléfono, correo

### Lenguaje
- Formal y respetuoso
- Tercera persona o primera persona formal
- Citas legales completas con artículos y leyes
- Evitar lenguaje coloquial
- Ser preciso y conciso en los hechos

---

## Advertencias Legales

> ⚠️ **IMPORTANTE**: Este skill genera documentos con estructura legal estándar. NO constituye asesoría jurídica profesional. Los documentos generados son plantillas/borradores que deben ser revisados por un abogado titulado antes de ser radicados. El uso de estos documentos es responsabilidad exclusiva del usuario.

> ⚠️ **NOTA**: Siempre incluir la advertencia de que el documento es un borrador generado por IA y debe ser revisado por un profesional del derecho antes de su presentación formal.
