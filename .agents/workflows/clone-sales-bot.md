---
name: clone-sales-bot
description: Clona el Bot de Ventas WhatsApp con IA (Gemini) + Panel CRM para una nueva marca. Incluye scraping de productos, descarga de imágenes, catálogo inteligente, sistema de imágenes, knowledge base, identidad de marca y despliegue con PM2. Para la Landing Page Premium, usar el skill separado clone-landing-page.
---

# 🤖 Skill: Clonar Bot de Ventas WhatsApp + Panel CRM

## Descripción
Este skill crea una **réplica completa y profesional** del sistema de ventas automatizado por WhatsApp (Bot + Panel CRM) para cualquier marca/negocio. Incluye:

- Bot de WhatsApp con IA (Gemini) para venta consultiva
- Panel CRM web con dashboard, gestión de leads y comprobantes
- Scraping automático de productos desde Shopify u otra fuente
- Descarga organizada de imágenes de productos
- Sistema de imágenes inteligente que envía fotos automáticamente
- Knowledge base personalizada para la marca
- Configuración PM2 para producción
- Watchdog anti-crash (clonado de NegroBot)

> [!TIP]
> **¿Necesitas también la Landing Page?** Usa el skill separado **`clone-landing-page`** para generar la web con catálogo dinámico, psicología oscura, experiencia dual desktop/mobile y sistema de arquetipos.

## Prerequisitos
- Node.js >= 18
- PM2 instalado globalmente (`npm i -g pm2`)
- API keys de Gemini (mínimo 3 para rotación)
- Número de WhatsApp dedicado para el bot
- Acceso a la tienda/sitio web de donde se van a scrappear productos

## Arquitectura del Bot (Referencia: VapeTHC/NegroBot)

```
bot/
├── index.js              # Entry point — WhatsApp client + message routing
├── config.js             # Configuración global (env vars → objeto)
├── db.js                 # SQLite — clientes, mensajes, comprobantes, CRM
├── client_flow.js        # Flujo conversacional — Gemini chat + memoria
├── prompts.js            # System prompts — personalidad del bot
├── gemini.js             # Wrapper Gemini — rotación de keys, safety
├── search.js             # Motor de búsqueda de productos (fuzzy match)
├── images.js             # Detección y envío automático de imágenes
├── admin_commands.js      # Comandos !admin por WhatsApp
├── api_server.js         # API HTTP interna para panel → bot
├── panel.js              # Panel CRM web (HTML embebido, standalone)
├── broadcasters.js       # Broadcasting a grupos/estados
├── recovery.js           # Recovery de chats perdidos
├── tts.js                # Text-to-speech (notas de voz)
├── router.js             # Router de mensajes por tipo
├── knowledge_base.json   # Base de conocimiento del negocio
├── catalogo_contexto.json # Catálogo completo de productos
├── ecosystem.config.js   # PM2 config (bot + panel como procesos)
├── package.json          # Dependencias
├── .env                  # Variables de entorno (SECRETO)
├── .env.example          # Plantilla de variables
├── .gitignore            # Exclusiones
├── download_images.js    # Script para descargar imágenes de Shopify
└── imagenes/             # Imágenes de productos organizadas por categoría
    ├── disposables_thc/
    ├── cartuchos/
    ├── extractos/
    ├── baterias/
    └── nicotina/
```

---

## FLUJO DE EJECUCIÓN (Paso a Paso)

### FASE 1: Recolección de Información

Antes de crear cualquier archivo, recolectar del usuario:

```
DATOS OBLIGATORIOS:
1. nombre_marca        → Nombre del negocio (ej: "VapeTHC")
2. url_tienda          → URL de la tienda online o sitio web de productos
3. tipo_tienda         → "shopify" | "woocommerce" | "custom" | "manual"
4. whatsapp_numero     → Número completo con código país (ej: "573150177199")
5. propietario_nombre  → Nombre del dueño/admin
6. ciudades_cobertura  → Lista de ciudades donde opera
7. gemini_api_keys     → 3 API keys de Gemini (separadas por coma)
8. directorio_destino  → Dónde crear el proyecto

DATOS OPCIONALES:
9. personalidad_bot    → Nombre y estilo del asistente IA (default: genera uno)
10. tema_panel         → Colores del panel CRM (default: dark + gold)
11. horario            → Horario de atención
12. metodos_pago       → Métodos de pago aceptados
13. instagram          → Handle de Instagram (si tiene)
```

### FASE 1B: Investigación SEO y Dominio

**Si el usuario NO tiene un nombre/dominio definido, o si quiere validar su decisión**, ejecutar esta investigación:

#### 1B.1 Análisis de Keywords con Google Trends
Buscar en Google Trends (https://trends.google.com/trends/) las keywords del nicho:
- Nombre del producto/servicio principal
- Variantes de búsqueda que usan los clientes
- Comparar entre 3-5 términos candidatos
- Filtrar por país (Colombia) y rango temporal (últimos 12 meses)
- Identificar keywords con tendencia al alza

#### 1B.2 Análisis de Dominio
Buscar disponibilidad de dominios que:
- Contengan la keyword principal del nicho
- Sean cortos (máximo 15 caracteres)
- Usen extensiones .co, .com.co, o .com
- No tengan guiones ni números
- Sean fáciles de deletrear por teléfono

#### 1B.3 Evaluación del Nombre (Matriz de Puntaje)
Evaluar cada nombre candidato en esta matriz:

| Criterio | Peso | Descripción |
|----------|------|-------------|
| SEO directo | ⭐⭐⭐⭐⭐ | ¿Google lo posiciona naturalmente en búsquedas del nicho? |
| Memorabilidad | ⭐⭐⭐⭐ | ¿Es fácil de recordar? ¿Menos de 3 sílabas? |
| Simplicidad | ⭐⭐⭐⭐⭐ | ¿Se puede deletrear por WhatsApp sin confusión? |
| Dominio disponible | ⭐⭐⭐⭐ | ¿El .co o .com está libre? |
| Riesgo legal | ⭐⭐ | ¿Menciona sustancias directamente? ¿Puede atraer regulación? |
| Escalabilidad | ⭐⭐⭐ | ¿Si el negocio crece a otros productos, el nombre sigue sirviendo? |
| Percepción premium | ⭐⭐⭐ | ¿Suena profesional o suena genérico/cliché? |

#### 1B.4 Recomendaciones de Naming (según investigación de branding 2025-2026)

**Estrategias de naming exitosas (evitar clichés del nicho):**
- **Evocativo/Lifestyle**: Nombres que sugieren el RESULTADO no el producto (ej: "Level", "Sunday Goods", "Elevate")
- **Abstract/Minimalista**: Cortos, modernos, brandeables (ej: "Stiiizy", "Kiva")
- **Heritage/Craft**: Implican artesanía y calidad (ej: "The Botanist", "Ayrloom")
- **Asociación de calidad**: Nombres de otra industria premium (ej: "Tweed" — tela de lujo)

**Lo que NO hacer:**
- Nombres que describan el producto literalmente (difíciles de proteger como marca)
- Puns o juegos de palabras del nicho (alienan consumidores modernos)
- Términos genéricos del sector que todo el mundo usa

**Regla de psicología de sonido:**
- Consonantes duras (K, X, T) → transmiten poder e innovación
- Consonantes suaves (L, M, S) → transmiten confort y confianza
- Nombres de 6-8 caracteres → los más memorables según estudios
- Si es fácil de pronunciar, el cerebro le da más confianza

**Presentar al usuario**: 3-5 opciones de nombres con su evaluación en la matriz.

### FASE 1C: Auditoría de Identidad de Marca

**Si el usuario NO tiene identidad visual definida**, generar recomendaciones basadas en investigación:

#### 1C.1 Psicología de Colores

Recomendar paleta basada en el sector del negocio:

| Color | Psicología | Mejor para |
|-------|-----------|------------|
| **Negro + Dorado** | Lujo, exclusividad, premium | Productos high-end, tech, cannabis |
| **Verde oscuro + Crema** | Natural, orgánico, confianza | Wellness, salud, ecológico |
| **Azul + Blanco** | Profesional, confiable, limpio | Servicios, tecnología, finanzas |
| **Rojo + Negro** | Energía, urgencia, poder | Fitness, deportes, streetwear |
| **Morado + Plata** | Creatividad, misterio, premium | Moda, arte, experiencias |

**Reglas de marca premium:**
- Base oscura (matte black) + acentos metálicos = posicionamiento luxury
- Nunca usar más de 3 colores principales
- Un color primario (70%), un secundario (20%), un acento (10%)
- Probar los colores en tema oscuro Y claro

#### 1C.2 Tipografía

**Recomendaciones por sector:**
- **Logo/Headlines**: Outfit, Clash Display, o Montserrat Bold (moderno, premium)
- **Body text**: Inter (legibilidad máxima, tech-forward)
- **Alternativa elegante**: Serif de alto contraste para headlines + Sans para body

**Reglas:**
- NO usar fuentes de sistema (Arial, Times New Roman)
- NO usar fuentes "temáticas" que parezcan cliché del nicho
- Siempre Google Fonts (gratis, CDN rápido)
- Par tipográfico: Una display para títulos + una neutra para texto

#### 1C.3 Logo

**Generar logo con generate_image** usando estos principios:
- Minimalismo (debe funcionar a 32x32px como favicon Y a 500x500px)
- El icono debe funcionar SOLO, sin texto
- Versiones: completo, icono solo, horizontal, monocromo
- Colores de la paleta definida
- Sin elementos cliché del nicho (ej: no hojas literales para cannabis, no pesas para fitness)

#### 1C.4 Voz de Marca

Definir la personalidad del asistente IA basándose en el negocio:

| Dimensión | Preguntar al usuario o sugerir |
|-----------|-------------------------------|
| Nombre del asistente | Nombre humano, acorde a la cultura local |
| Tono | Cercano vs formal, técnico vs simple |
| Vocabulario | Términos específicos del sector |
| Regionalismo | Adaptado a la ciudad/país del negocio |
| Diferenciador | ¿Qué hace especial a este bot vs un humano? |

**Regla clave**: El bot VENDE consultivamente (asesora), no empuja producto. El tono debe generar confianza, no presión.

#### 1C.5 Posicionamiento Competitivo

Analizar la competencia directa del usuario:

| Lo que analizar | Cómo |
|-----------------|------|
| Canal de venta del competidor | ¿Tienen WhatsApp? ¿Es manual o automatizado? |
| Velocidad de respuesta | ¿Cuánto tardan en contestar? |
| CRM/Seguimiento | ¿Hacen follow-up a leads fríos? |
| Personalización | ¿Le preguntan al cliente qué necesita? |
| Cobertura geográfica | ¿Dónde operan vs dónde opera el usuario? |

**Presentar al usuario**: Tabla comparativa mostrando SUS ventajas vs la competencia.

La ventaja competitiva de ESTE sistema siempre es:
1. Respuesta instantánea 24/7 vs humano que tarda horas
2. Venta consultiva personalizada vs catálogo genérico
3. Seguimiento automatizado de leads vs olvidar clientes
4. CRM con datos de cada cliente vs memoria humana

---

### FASE 2: Auditoría de Puerto y Colisiones

**ANTES de crear archivos**, verificar qué puertos están en uso:

```powershell
# Windows
netstat -ano | Select-String "LISTENING" | Select-String ":300[0-9]|:400[0-9]|:500[0-9]"

# Verificar bots PM2 existentes
pm2 jlist
```

**Regla de asignación de puertos:**
- Puerto base 3000/3001 → primer bot
- Puerto base 4000/4001 → segundo bot  
- Puerto base 5000/5001 → tercer bot
- Puerto base 6000/6001 → cuarto bot
- Y así sucesivamente (+1000 por bot)

Seleccionar el primer rango libre. Guardar como `PANEL_PORT` y `API_PORT`.

### FASE 3: Scraping de Productos

#### 3A. Si es Shopify:
```javascript
// Shopify expone todos los productos en:
// https://DOMINIO/products.json
// https://DOMINIO/products.json?page=2 (si hay paginación)

// Descargar:
Invoke-WebRequest -Uri "https://DOMINIO/products.json" -OutFile "products_raw.json"
```

Luego parsear `products_raw.json` y crear `catalogo_contexto.json` con esta estructura:
```json
{
  "categorias": {
    "Nombre Categoría": [
      {
        "titulo": "Nombre completo del producto",
        "marca": "Marca",
        "modelo": "Modelo/variante",
        "capacidad": "Tamaño/peso",
        "tipo": "Tipo de producto",
        "precio": "$XXX.XXX",
        "precio_anterior": "$XXX.XXX (si hay descuento)",
        "descripcion": "Descripción completa para el bot",
        "variantes": ["Variante 1", "Variante 2"],
        "disponible": true,
        "tag": "🔥 Etiqueta visual",
        "keywords": ["keyword1", "keyword2"]
      }
    ]
  }
}
```

#### 3B. Si es WooCommerce:
```
// WooCommerce REST API:
// https://DOMINIO/wp-json/wc/v3/products?per_page=100
// Requiere consumer_key y consumer_secret
// Si no hay API, usar browser_subagent para scrappear
```

#### 3C. Si es Custom/Manual:
Usar `browser_subagent` para navegar la página, extraer productos con selectores CSS, y construir el JSON manualmente.

### FASE 4: Descarga de Imágenes

Crear `download_images.js` que:
1. Lee `products_raw.json`
2. Categoriza cada producto
3. Descarga la imagen principal en `imagenes/{categoria}/`
4. Sanitiza nombres de archivo

```javascript
// Estructura de carpetas esperada:
// imagenes/
//   categoria_1/Nombre_Producto.webp
//   categoria_2/Otro_Producto.jpg
```

Ejecutar: `node download_images.js`

### FASE 5: Generación del Bot (20 módulos)

**IMPORTANTE: No copiar los archivos del bot de referencia manualmente. Usar el bot de referencia como template y ADAPTAR cada archivo para la nueva marca.**

El bot de referencia está en: `c:\Users\Alvaro Ocampo\Documents\claude\golden-honey\bot\`

Para cada módulo, leer el archivo de referencia y crear una versión adaptada:

#### 5.1 `package.json`
```json
{
  "name": "{nombre_marca_lowercase}-bot",
  "version": "1.0.0", 
  "description": "{nombre_marca} — Bot de ventas consultivas + CRM",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "panel": "node panel.js",
    "dev": "node index.js & node panel.js"
  },
  "dependencies": {
    "@google/generative-ai": "^0.24.0",
    "better-sqlite3": "^11.8.1",
    "dotenv": "^16.4.7",
    "puppeteer": "^24.4.0",
    "qrcode-terminal": "^0.12.0",
    "whatsapp-web.js": "^1.26.1-alpha.3"
  },
  "engines": { "node": ">=18.0.0" }
}
```

#### 5.2 `.env` y `.env.example`
```env
MODE=direct
GEMINI_API_KEYS={key1},{key2},{key3}
BUSINESS_NAME={nombre_marca}
BUSINESS_PHONE={whatsapp_numero}
EMPLOYEES={propietario_nombre}:{whatsapp_numero}
IGNORE_GROUPS=true
DEBUG=true
INTERNAL_API_KEY={nombre_marca_lowercase}-secret-{año}
PANEL_PORT={puerto_panel}
API_PORT={puerto_api}
AUDITORS=
ENABLE_TTS=false
```

#### 5.3 Módulos del bot (copiar y adaptar de referencia)

Para cada uno de estos archivos, leer la versión de referencia y adaptar:

| Archivo | Qué adaptar |
|---------|-------------|
| `config.js` | Nombre del negocio en defaults |
| `db.js` | Copiar tal cual (genérico) |
| `gemini.js` | Copiar tal cual (genérico) |
| `search.js` | Copiar tal cual (genérico, lee catalogo_contexto.json) |
| `images.js` | Copiar tal cual (genérico, busca en imagenes/) |
| `admin_commands.js` | Copiar tal cual (genérico) |
| `api_server.js` | Cambiar puerto default fallback |
| `panel.js` | Cambiar tema/colores/nombre de marca, puerto default |
| `client_flow.js` | Copiar tal cual (genérico) |
| `prompts.js` | **CRÍTICO**: Reescribir personalidad del bot para la nueva marca |
| `recovery.js` | Copiar tal cual |
| `tts.js` | Copiar tal cual |
| `broadcasters.js` | Copiar tal cual |
| `router.js` | Copiar tal cual |
| `index.js` | Cambiar nombre en logs, verificar puertos |
| `ecosystem.config.js` | Cambiar nombres de procesos PM2 |

#### 5.4 `prompts.js` — **El más importante**

Este archivo define LA PERSONALIDAD del bot. Debe adaptarse 100% a la nueva marca:

```javascript
// Elementos a personalizar:
// 1. Nombre del asistente virtual
// 2. Personalidad y tono (formal, informal, técnico, etc.)
// 3. Área de expertise (vapers, ropa, tecnología, etc.)
// 4. FAQ específicas del negocio
// 5. Políticas de venta (envíos, pagos, garantías)
// 6. Ciudades de cobertura
// 7. Horario de atención
// 8. Instrucciones de seguridad (qué NO debe hacer/decir el bot)
```

#### 5.5 `knowledge_base.json`

Crear con la información del negocio:
```json
{
  "negocio": {
    "nombre": "{nombre_marca}",
    "tipo": "Descripción del tipo de negocio",
    "descripcion": "Descripción completa",
    "whatsapp": "{numero_sin_codigo_pais}",
    "cobertura": ["Ciudad 1", "Ciudad 2"],
    "horario": "Horario de atención"
  },
  "ventajas": ["Ventaja 1", "Ventaja 2"],
  "categorias": {
    "categoria_1": "Descripción de la categoría"
  },
  "faq": [
    {"pregunta": "...", "respuesta": "..."}
  ],
  "politicas": {
    "envio": "...",
    "pago": "...",
    "garantia": "..."
  }
}
```

#### 5.6 `panel.js` — Adaptaciones visuales

El panel usa HTML/CSS inline. Buscar y reemplazar:
- `VapeTHC` → `{nombre_marca}` (en títulos y headers)
- Color tema gold `#D4A017` → color de la marca (si cambia)
- Color fondo `#0A0A0F` → mantener dark o cambiar si la marca lo requiere
- Fallback de puertos → `{PANEL_PORT}` y `{API_PORT}`

#### 5.7 `ecosystem.config.js`

```javascript
module.exports = {
  apps: [
    {
      name: '{nombre_marca_lowercase}-bot',
      script: 'index.js',
      cwd: __dirname,
      watch: false,
      max_memory_restart: '500M',
      env: { NODE_ENV: 'production' },
      error_file: './logs/bot-error.log',
      out_file: './logs/bot-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 5000,
      max_restarts: 10,
    },
    {
      name: '{nombre_marca_lowercase}-panel',
      script: 'panel.js',
      cwd: __dirname,
      watch: false,
      max_memory_restart: '200M',
      env: { NODE_ENV: 'production' },
      error_file: './logs/panel-error.log',
      out_file: './logs/panel-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 3000,
      max_restarts: 10,
    }
  ]
};
```


> [!NOTE]
> **Landing Page Premium**: La generación de la Landing Page (catálogo web, psicología oscura de ventas, experiencia dual desktop/mobile, sistema de arquetipos con gamificación) se separó a su propio skill independiente:
> **`clone-landing-page`** → `c:\Users\Alvaro Ocampo\Documents\claude\.agents\skills\clone-landing-page\SKILL.md`

### FASE 6: Instalación y Arranque

```bash
# 1. Instalar dependencias
cd {directorio_destino}/bot
npm install

# 2. Crear directorio de logs
mkdir logs

# 3. Verificar sintaxis de todos los archivos
for file in *.js; do node -c "$file"; done

# 4. Arrancar con PM2
pm2 start ecosystem.config.js

# 5. Ver logs (esperar QR)
pm2 logs {nombre_marca_lowercase}-bot

# 6. Escanear QR con WhatsApp del número dedicado

# 7. Verificar panel
curl http://localhost:{PANEL_PORT}

# 8. Guardar configuración PM2
pm2 save
```

### FASE 7: Verificación Post-Despliegue

Checklist final:
- [ ] Bot conectado a WhatsApp (log: "✅ WhatsApp conectado")
- [ ] Panel accesible en http://localhost:{PANEL_PORT}
- [ ] API respondiendo en http://localhost:{API_PORT}
- [ ] Imágenes descargadas en imagenes/ (verificar conteo)
- [ ] Catálogo cargado (log: "Catálogo cargado: X productos")
- [ ] Knowledge base cargada (log: "Knowledge base cargada")
- [ ] Enviar mensaje de prueba desde otro número
- [ ] Verificar que el bot responde con personalidad correcta
- [ ] Verificar que envía imágenes de productos automáticamente
- [ ] Probar comando admin (!status, !help) desde número admin
- [ ] Verificar que no hay colisión de puertos con otros bots
- [ ] `pm2 save` ejecutado para persistencia

---

## ERRORES COMUNES Y SOLUCIONES

| Error | Causa | Solución |
|-------|-------|----------|
| `EADDRINUSE` | Puerto ocupado por otro bot | Cambiar PANEL_PORT y API_PORT en .env |
| `ProtocolError: Execution context destroyed` | Puppeteer crash | El watchdog lo maneja automáticamente |
| `auth_failure` | Sesión WhatsApp corrupta | El bot limpia sesión y pide QR nuevo |
| `429 Too Many Requests` | Gemini rate limit | El sistema rota entre 3 keys automáticamente |
| `SQLITE_BUSY` | Base de datos bloqueada | Verificar que no hay dos instancias del mismo bot |
| `No such file: imagenes/` | No se descargaron imágenes | Ejecutar `node download_images.js` |

## REFERENCIA: Bot Template

La implementación de referencia completa está en:
```
c:\Users\Alvaro Ocampo\Documents\claude\golden-honey\bot\
```

Cada archivo de este directorio sirve como template. Los archivos genéricos (db.js, gemini.js, search.js, images.js, client_flow.js, admin_commands.js, recovery.js, tts.js, broadcasters.js, router.js) se pueden copiar sin modificación. Los archivos específicos de marca (prompts.js, knowledge_base.json, catalogo_contexto.json, panel.js, config.js, index.js, ecosystem.config.js, .env) deben adaptarse con la información del nuevo negocio.
