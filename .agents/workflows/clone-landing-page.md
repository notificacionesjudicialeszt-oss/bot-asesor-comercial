---
name: clone-landing-page
description: Clona una Landing Page Premium con catálogo dinámico de productos, psicología oscura de ventas (20 gatillos), experiencia responsiva unificada (Three.js 3D + GSAP + liquid glass + CSS reveals), sistema de arquetipos con gamificación, y SEO optimizado. Puede usarse independientemente o junto con clone-sales-bot.
---

# 🌐 Skill: Clonar Landing Page Premium

## Descripción
Este skill crea una **landing page de alta conversión** para cualquier marca/negocio. Es completamente independiente del bot de WhatsApp — puede usarse solo o como complemento del skill `clone-sales-bot`.

### ¿Qué genera?
- Landing page con catálogo dinámico de productos
- Diseño dark premium responsive (mobile-first)
- **20 gatillos de psicología oscura** de ventas documentados con `<!-- GATILLO: -->` comments
- **Experiencia responsiva unificada**: Three.js 3D particles (desktop), GSAP ScrollTrigger, liquid glass, CSS scroll reveals — TODO en un solo código con media queries
- **Sistema de arquetipos** con gamificación (perfiles de cliente → plan personalizado)
- Mini-quiz para indecisos
- SEO completo (meta tags, JSON-LD, Open Graph)
- Integración WhatsApp en todos los CTAs

## Prerequisitos
- Catálogo de productos (URL de tienda online, JSON manual, o `catalogo_contexto.json` del skill `clone-sales-bot`)
- Número de WhatsApp para CTAs
- Identidad de marca (colores, logo, tipografía) — si no existe, este skill la genera

## Relación con clone-sales-bot

| Escenario | Qué hacer |
|-----------|-----------|
| Ya ejecuté `clone-sales-bot` | Usar el `catalogo_contexto.json` y la identidad de marca ya definidos |
| Solo quiero la landing page | Este skill incluye su propia fase de datos — es autónomo |
| Quiero actualizar una landing existente | Usar este skill como referencia para modificar los archivos |

---

## FLUJO DE EJECUCIÓN

### FASE 1: Recolección de Datos

Si ya se ejecutó `clone-sales-bot`, reusar los datos de las Fases 1-1C de ese skill. Si no, recolectar:

```
DATOS OBLIGATORIOS:
1. nombre_marca        → Nombre del negocio
2. url_tienda          → URL de la tienda online (para scraping de productos)
3. tipo_tienda         → "shopify" | "woocommerce" | "custom" | "manual"
4. whatsapp_numero     → Número completo con código país (ej: "573150177199")
5. ciudades_cobertura  → Lista de ciudades donde opera
6. directorio_destino  → Dónde crear el proyecto

DATOS OPCIONALES (se generan si no se proporcionan):
7. color_primario      → Color de acento de la marca (default: genera paleta)
8. color_secundario    → Color secundario
9. font_headlines      → Fuente para títulos (default: Outfit)
10. font_body          → Fuente para cuerpo (default: Inter)
11. instagram          → Handle de Instagram
12. metodos_pago       → Métodos de pago aceptados
13. horario            → Horario de atención
```

#### 1.1 Identidad Visual (si no existe)

Si el usuario NO tiene identidad visual definida, generar recomendaciones:

**Paleta de colores por sector:**

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

**Tipografía:**
- Headlines: Outfit, Clash Display, o Montserrat Bold
- Body text: Inter (legibilidad máxima)
- Siempre Google Fonts (gratis, CDN rápido)

**Logo (generar con generate_image):**
- Minimalismo (funcionar a 32×32px como favicon Y a 500×500px)
- Sin elementos cliché del nicho
- Versiones: completo, icono solo, monocromo

---

### FASE 2: Obtener Productos

#### 2A. Si ya existe `catalogo_contexto.json` (del skill clone-sales-bot):
Transformar al formato frontend (ver sección 2D).

#### 2B. Si es Shopify:
```javascript
// Shopify expone productos en: https://DOMINIO/products.json
Invoke-WebRequest -Uri "https://DOMINIO/products.json" -OutFile "products_raw.json"
```

#### 2C. Si es WooCommerce o Custom:
Usar `browser_subagent` para scrappear la página y extraer productos.

#### 2D. Formato `products.json` (Frontend)

Crear `products.json` con esta estructura:
```json
[
  {
    "name": "Nombre del Producto",
    "brand": "Marca",
    "category": "categoria_slug",
    "type": "Tipo de producto",
    "capacity": "Tamaño/peso",
    "price": 149000,
    "comparePrice": 180000,
    "image": "https://cdn.shopify.com/...",
    "description": "Descripción corta para la card",
    "tag": "🔥 Popular",
    "available": true,
    "variants": ["Sabor 1", "Sabor 2"],
    "keywords": ["keyword1", "keyword2"]
  }
]
```

---

### FASE 3: Landing Page Base

Crear la estructura del sitio web:

```
{directorio_destino}/
├── index.html       # Landing page principal
├── styles.css       # Diseño responsive UNIFICADO (dark premium + liquid glass + media queries)
├── fx.js            # Three.js particles + GSAP ScrollTrigger (ES Module, carga condicional >768px)
├── script.js        # Core: productos, FOMO, countdown, arquetipos
└── products.json    # Catálogo en formato frontend
```

> [!IMPORTANT]
> **UNA SOLA VERSIÓN RESPONSIVA** — NO crear archivos separados de estilos para desktop/mobile (nada de `desktop.css` ni `mobile.css`). Todo va en `styles.css` con media queries. `fx.js` se carga como módulo ES solo en desktop (`import()` condicional). Three.js canvas se oculta automáticamente en mobile vía CSS (`display: none`).

#### 3.1 `index.html`

Secciones obligatorias:
1. **Barra de urgencia top** — "PROMO DEL MES" con stock limitado (GATILLO: Urgencia)
2. **Nav** — Logo + links internos + CTA WhatsApp siempre visible
3. **Hero** — Headline con keyword principal, badge de confianza, CTA doble (WhatsApp + Ver Productos)
4. **Archetype Selector** — Cards de perfiles de cliente dentro del hero (ver FASE 5)
5. **Trust Bar** — Contadores animados (clientes, productos, ciudades, % calidad)
6. **Plan Personalizado** — Sección reactiva (oculta hasta selección de arquetipo)
7. **Mini-Quiz** — Para indecisos (2 preguntas → arquetipo)
8. **Productos** — Grid con filtros por categoría, cards con imagen/precio/botón WhatsApp
9. **¿Por Qué Nosotros?** — 6 cards con ventajas competitivas
10. **Cómo Pedir** — 3 pasos (Elige → WhatsApp → Recibe)
11. **Testimoniales** — 3 opiniones realistas adaptadas al sector
12. **CTA Urgencia + Countdown** — Timer evergreen + botón WhatsApp
13. **FAQ** — 5-6 preguntas frecuentes accordion
14. **Footer** — Logo, links, copyright, disclaimer si aplica
15. **Notificación FOMO flotante** — "[Nombre] de [Ciudad] acaba de comprar [Producto]"

**SEO obligatorio:**
- Title tag con keyword principal + ciudad/país
- Meta description con propuesta de valor
- Open Graph tags
- JSON-LD (LocalBusiness o Store)
- Canonical URL (si se conoce el dominio)
- Alt text en imágenes

**WhatsApp integration:**
- Todos los CTAs → `wa.me/{whatsapp_numero}`
- Botón flotante de WhatsApp siempre visible
- Cada producto → botón "Pedir" con mensaje pre-armado

**CDN Scripts (en `<head>` y antes de `</body>`):**
```html
<!-- En el <head>: -->
<script type="importmap">
  { "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.172.0/build/three.module.js" } }
</script>

<!-- Antes de </body>: -->
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/ScrollTrigger.min.js"></script>
<script src="script.js"></script>
<script type="module">
  // Three.js solo en desktop (>768px)
  if (window.innerWidth > 768) {
    import('./fx.js').then(m => m.init());
  }

  // IntersectionObserver UNIVERSAL (funciona en TODOS los dispositivos)
  const obs = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); });
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal-up').forEach(el => obs.observe(el));
</script>
```

> [!WARNING]
> **NO crear lógica separada desktop/mobile.** Las animaciones GSAP que usen `x` horizontal en cards dentro de grids multi-columna causan overlap — usar solo `y` (vertical) y `opacity` en esos casos.

#### 3.2 `styles.css` (UNIFICADO)

TODO en un solo archivo con media queries. Usar el esquema de colores definido en FASE 1:
- Tema oscuro con acento del color de marca
- Mobile-first responsive
- Hover effects y micro-animaciones
- CSS custom properties para fácil personalización
- Google Fonts (Inter para body, Outfit para headlines)
- Cards con glassmorphism (liquid glass)
- Scroll reveal CSS (`.reveal-up` con `IntersectionObserver`)
- Neon glow en botones CTA
- Three.js canvas styling + z-index stack
- `@media (max-width: 768px)` para ocultar canvas y adaptar grids
- `@media (min-width: 769px)` para GSAP states, hover effects, grid 4 columnas

#### 3.3 `script.js`

Funcionalidades core (compartidas desktop + mobile):
- Carga dinámica de productos desde `products.json`
- Filtros por categoría
- FAQ accordion
- Smooth scroll
- Nav scroll effect
- Hamburger menu mobile
- Countdown evergreen (5 días, se reinicia automáticamente)
- Live notifications FOMO (datos reales del catálogo)
- Scarcity per product (badges "Últimas X unidades")
- Promo stock decrement (baja cada 2 min)
- Sistema de arquetipos (ver FASE 5)

---

### FASE 4: Experiencia Premium Responsiva

> [!IMPORTANT]
> **Esta fase es OBLIGATORIA** — siempre se ejecuta. Todo va en UN SOLO código responsivo. Three.js y GSAP se cargan condicionalmente en desktop, los CSS scroll reveals funcionan en todos los dispositivos.

#### 4.1 Gatillos de Psicología Oscura (aplicar al HTML)

Cada gatillo se documenta con `<!-- GATILLO: Nombre -->`. Lista obligatoria:

| # | Gatillo | Implementación |
|---|---------|----------------|
| 1 | **Barra de urgencia top** | `<div class="promo-bar">` con "PROMO DEL MES" + stock limitado |
| 2 | **CTA siempre visible** | Botón WhatsApp en nav — nunca desaparece |
| 3 | **Dolor→Agitación→Solución** | Hero headline que nombra el PROBLEMA del cliente |
| 4 | **Urgencia temporal** | Badge rojo con pulse-dot: "Solo X [unidades] a precio especial" |
| 5 | **Prueba social masiva** | Avatares circulares + "+X,XXX clientes confían en [marca]" + estrellas |
| 6 | **Autoridad numérica** | Floating cards con cifras (productos, % calidad, cobertura) |
| 7 | **FOMO en tiempo real** | Notificación flotante: "[Nombre] de [Ciudad] acaba de comprar [Producto]" |
| 8 | **Identidad tribal** | "Los que [hacen X en serio] nos eligen" |
| 9 | **Anclaje de precio** | Mostrar valor real de algo gratis ("Envío vale $X pero es GRATIS") |
| 10 | **Reciprocidad** | Ofrecer algo gratis antes de pedir (asesoría, guía, consulta) |
| 11 | **Micro-commitments** | Opciones de personalización ("Arma tu [combo/kit/pedido]") |
| 12 | **Reducción de barrera** | "Un solo mensaje y listo — respondemos en 5 minutos" |
| 13 | **Especificidad** | Testimonios con datos concretos (kilos, días, meses) |
| 14 | **Dirección al canal** | Testimonios mencionan al bot/asesor para dirigir a WhatsApp |
| 15 | **Countdown evergreen** | Timer que siempre muestra 5 días (se reinicia automáticamente) |
| 16 | **Aversión a la pérdida** | "Después vuelven a precio regular" |
| 17 | **FOMO social** | "X personas compraron en las últimas 48 horas" |
| 18 | **Reversión de riesgo** | "Si hay cualquier problema, te devolvemos tu dinero" |
| 19 | **Escasez por producto** | Badges "🔴 Últimas X unidades" en product cards (aleatorio) |
| 20 | **Stock decrementando** | El número de promo baja cada 2 minutos en la barra top |

#### 4.2 Secciones HTML adicionales

Agregar al `index.html`:

```html
<!-- Barra de urgencia top -->
<div class="promo-bar" id="promoBar">
  <span>⚡ <strong>PROMO DEL MES:</strong> [Combos/Packs] con <strong>hasta -X%</strong> · Envío GRATIS 🇨🇴 · <span id="promoStock">Solo quedan X disponibles</span></span>
  <button onclick="this.parentElement.style.display='none'" class="promo-close">✕</button>
</div>

<!-- Scroll progress bar (desktop) -->
<div class="scroll-progress"></div>

<!-- Three.js Canvas en el hero (desktop only) -->
<section class="hero">
  <canvas id="heroCanvas"></canvas>
  <!-- ... hero content ... -->
</section>

<!-- Live notification FOMO -->
<div class="live-notification" id="liveNotification">
  <div class="notif-avatar">🛒</div>
  <div class="notif-text">
    <strong id="notifName">Nombre de Ciudad</strong>
    <span id="notifAction">acaba de comprar Producto</span>
    <small id="notifTime">hace X minutos</small>
  </div>
</div>

<!-- Urgency CTA con Countdown -->
<section class="urgency-cta">
  <h2>⚡ [Oferta] Solo Este Mes</h2>
  <p>Después vuelven a precio regular. <strong>No te quedes sin tu descuento.</strong></p>
  <div class="countdown">
    <div class="countdown-item"><span class="num" id="cd-days">0</span><span class="lbl">Días</span></div>
    <div class="countdown-item"><span class="num" id="cd-hours">0</span><span class="lbl">Horas</span></div>
    <div class="countdown-item"><span class="num" id="cd-mins">0</span><span class="lbl">Min</span></div>
    <div class="countdown-item"><span class="num" id="cd-secs">0</span><span class="lbl">Seg</span></div>
  </div>
  <a href="https://wa.me/{numero}" class="btn-urgency">💬 Aprovechar Oferta →</a>
  <p class="urgency-micro">🔥 <strong>X personas</strong> compraron en las últimas 48 horas</p>
</section>
```

#### 4.3 Estilos responsivos unificados (dentro de `styles.css`)

Todo va en UN SOLO `styles.css` con media queries:

```css
/* ═══ BASE (todos los dispositivos) ═══ */
#heroCanvas { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 1; pointer-events: none; }
.hero { position: relative; overflow: hidden; }
.hero-inner { position: relative; z-index: 2; }
.scroll-progress { position: fixed; top: 0; left: 0; height: 3px; background: linear-gradient(90deg, var(--primary), var(--accent)); z-index: 9999; transform-origin: left; transform: scaleX(0); width: 100%; }

/* Scroll reveal universal */
.reveal-up { opacity: 0; transform: translateY(30px); transition: opacity 0.6s ease, transform 0.6s cubic-bezier(0.34, 1.56, 0.64, 1); }
.reveal-up.visible { opacity: 1; transform: translateY(0); }

/* Liquid glass (todos los dispositivos) */
:root { --glass-bg: rgba(16, 22, 34, 0.6); --glass-border: rgba(var(--primary-rgb), 0.15); --glass-blur: 20px; }
.product-card, .why-card, .step-card, .testimonial-card, .faq-item {
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur)) saturate(1.3);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(1.3);
  border: 1px solid var(--glass-border);
}

/* Neon glow en botones */
.btn-primary { box-shadow: 0 0 15px rgba(var(--primary-rgb), 0.3); animation: btnGlow 2s ease-in-out infinite; }

/* ═══ DESKTOP (>768px) ═══ */
@media (min-width: 769px) {
  .products-grid { grid-template-columns: repeat(4, 1fr); }
  .product-card { transition: all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1); }
  .product-card:hover { transform: translateY(-8px) scale(1.02); box-shadow: 0 0 30px rgba(var(--primary-rgb), 0.15); }
}

/* ═══ MOBILE (<768px) ═══ */
@media (max-width: 768px) {
  #heroCanvas { display: none !important; } /* Canvas se oculta */
  .products-grid { grid-template-columns: 1fr; }
}
```

> [!WARNING]
> **REGLA DE ORO para animaciones en grids:** NUNCA usar `transform: translateX()` ni GSAP `x:` en cards dentro de grids multi-columna. Las cards se montan unas encima de otras durante la animación. Usar SOLO `y` (vertical) y `opacity`.

#### 4.4 Three.js + GSAP (dentro de `script.js` o como módulo condicional)

Three.js y GSAP se inicializan SOLO en desktop, pero viven en el mismo flujo:

```javascript
// En script.js o en un módulo importado condicionalmente:
if (window.innerWidth > 768) {
  initParticleHero();  // Three.js particles
  initGSAP();          // GSAP ScrollTrigger
}

// IntersectionObserver SIEMPRE activo (funciona en mobile Y desktop)
const obs = new IntersectionObserver(...);
document.querySelectorAll('.reveal-up').forEach(el => obs.observe(el));
```

Contenido de las funciones:

1. **`initParticleHero()`** — Three.js:
   - 1200 partículas pequeñas (tamaño máx 1.5) con `ShaderMaterial`
   - Paleta monocromática (tonos del color primario solamente)
   - Alpha al 22% máximo (`NormalBlending`, NO AdditiveBlending)
   - Reactivas al mouse, fade al scrollear
   - **Las partículas son DECORATIVAS, no deben tapar el texto**

2. **`initGSAP()`** — GSAP ScrollTrigger:
   - Hero text: fade-up (NO slide horizontal)
   - Cards en grids: `y` + `opacity` + `stagger` (NUNCA `x`)
   - Section headers: fade-up
   - Scroll progress bar: `scrub`
   - Botones magnéticos: mouse-follow con `elastic.out`

#### 4.6 Modificaciones a `script.js`

Agregar al script core (compartido desktop + mobile):

```javascript
// === PROMO BAR ===
const promoBar = document.getElementById('promoBar');
if (promoBar) document.getElementById('nav').classList.add('has-promo');

// === COUNTDOWN EVERGREEN (5 días desde ahora) ===
function updateCountdown() {
  const end = new Date();
  end.setDate(end.getDate() + 5); // ✅ Correcto — maneja cambio de mes
  end.setHours(23, 59, 59, 0);
  const diff = end - new Date();
  // ... update cd-days, cd-hours, cd-mins, cd-secs
}
setInterval(updateCountdown, 1000);

// === LIVE NOTIFICATIONS (FOMO) ===
// ⚠️ IMPORTANTE: Generar los datos con info REAL del catálogo del negocio:
//   - nombres: usar nombres comunes del país/ciudad del cliente
//   - ciudades: usar SOLO las ciudades de cobertura del negocio
//   - productos: usar nombres EXACTOS del catalogo_contexto.json
const fakeOrders = [
  { name: '[Nombre] de [Ciudad de cobertura]', action: 'acaba de pedir [Producto real del catálogo]', time: 'hace X minutos' },
  // ... 8-10 entries combinando ciudades y productos reales del catálogo
];
// Show first at 8s, then every 25-40s (random interval)

// === SCARCITY PER PRODUCT ===
function getScarcityText(product) {
  if (product.isCombo) return `🔴 Solo ${3 + Math.floor(Math.random() * 6)} disponibles`;
  if (product.comparePrice) return '⚡ Precio especial por tiempo limitado';
  if (Math.random() > 0.6) return `🔴 Últimas ${5 + Math.floor(Math.random() * 10)} unidades`;
  return '';
}

// === PROMO STOCK DECREMENT ===
let promoStockCount = 12;
setInterval(() => {
  if (promoStockCount > 2) {
    promoStockCount--;
    document.getElementById('promoStock').textContent = `Solo quedan ${promoStockCount} disponibles`;
  }
}, 120000); // Every 2min

// === INTERSECTION OBSERVER ===
// IntersectionObserver se define en el script inline del HTML (universal, todos los dispositivos)
// Three.js y GSAP se cargan condicionalmente solo en desktop (>768px)
```

---

### FASE 5: Sistema de Arquetipos (Gamificación)

> [!IMPORTANT]
> **Esta es la característica más avanzada y el mayor diferenciador.** La diferencia entre una landing genérica y una máquina de conversión es la **interactividad**. El hero se convierte en un selector de objetivos que personaliza TODA la experiencia. Esto elimina la fricción del cliente indeciso y genera micro-compromisos antes de llegar a WhatsApp.

#### ¿Qué es el Archetype System?

En vez de un hero estático, el hero muestra **tarjetas de arquetipo** (perfiles de cliente). Al hacer clic:
1. El headline del hero cambia para hablarle DIRECTAMENTE a ese perfil
2. La imagen del hero cambia al producto más relevante
3. El color de acento de TODA la página cambia al color del arquetipo
4. Aparece una sección "Tu Plan Personalizado" con 3 productos recomendados
5. El catálogo se filtra automáticamente a la categoría del arquetipo
6. Un testimonio relevante aparece bajo los productos recomendados
7. El botón de WhatsApp lleva un mensaje pre-armado específico para ese perfil

**Resultado**: El usuario llega a WhatsApp ya pre-cualificado.

#### 5.1 Identificar los Arquetipos del Negocio

Mapear los arquetipos del nicho específico. Ejemplos por sector:

| Sector | Arquetipos sugeridos |
|--------|---------------------|
| **Suplementos** | Principiante / Masa / Avanzado / Quemar grasa / Wellness |
| **Vapes THC** | Principiante / Experiencia / Relajación / Creatividad / Social |
| **Ropa deportiva** | Gym / Crossfit / Running / Casual / Pro Atleta |
| **Tecnología** | Gamer / Creativo / Profesional / Estudiante / Home Office |
| **Belleza** | Natural / Anti-age / Acné / Hidratación / Luminosidad |

Cada arquetipo necesita:
```javascript
const ARCHETYPES = {
  nombre_arquetipo: {
    emoji: '🌱',
    color: '#22c55e',        // Color de acento para este perfil
    colorRGB: '34, 197, 94', // Mismo color en RGB para transparencias
    
    // Hero content (cambia al seleccionar)
    headline: 'Headline que DUELE al cliente ideal',
    headlineSpan: 'La promesa de transformación',
    desc: 'Descripción personalizada 2-3 oraciones',
    heroImage: 'URL CDN del producto estrella para este perfil',
    
    // Plan section (aparece debajo del hero)
    planTag: '🌱 Tu Plan',
    planTitle: 'Título del plan personalizado',
    planSubtitle: 'Subtítulo de 1 frase',
    products: ['Nombre Exacto Producto 1', 'Nombre 2', 'Nombre 3'], // Deben coincidir con products.json
    productRoles: ['⭐ Rol del producto 1', '🔥 Rol 2', '✅ Rol 3'],
    
    // Testimonial reactivo (aparece en el plan)
    testimonial: {
      quote: 'Testimonio específico para este perfil. Con datos concretos.',
      name: 'Nombre A.',
      loc: '📍 Ciudad · Cliente desde Mes Año',
      initials: 'NA'
    },
    
    // WhatsApp integration
    waMessage: 'Mensaje pre-armado: "Hola! [contexto del arquetipo]. ¿Qué me recomiendan?"',
    filterCategory: 'slug_categoria_del_catalogo' // Filtra el grid automáticamente
  }
};
```

#### 5.2 Secciones HTML Adicionales

Agregar al hero (ANTES del cierre `</section>`):

```html
<!-- ═══════ ARCHETYPE SELECTOR ═══════ -->
<div class="archetype-selector" id="archetypeSelector">
  <!-- Una card por arquetipo -->
  <button class="archetype-card" data-archetype="nombre_arquetipo" aria-label="Descripción">
    <span class="archetype-emoji">🌱</span>
    <span class="archetype-label">Nombre Corto</span>
    <span class="archetype-sub">Subtítulo 1 frase</span>
    <span class="archetype-check">✓</span>
  </button>
  <!-- ... más cards ... -->
</div>

<!-- Instruction prompt (pulsing, desaparece al primer click) -->
<div class="archetype-prompt" id="archetypePrompt">
  <span class="prompt-hand">👆</span>
  <span class="prompt-text">Elige tu objetivo y te armamos tu plan personalizado</span>
</div>

<!-- Hover preview (texto debajo de las cards al hacer hover) -->
<div class="archetype-preview" id="archetypePreview"></div>
```

Agregar DESPUÉS del hero (sección nueva):

```html
<!-- ═══════ REACTIVE PLAN SECTION (oculto hasta selección) ═══════ -->
<section class="plan-section" id="planSection" style="display:none;">
  <div class="plan-inner">
    <div class="plan-header">
      <span class="tag" id="planTag">Tu Plan</span>
      <h2 id="planTitle">Tu Plan Personalizado</h2>
      <p id="planSubtitle">Basado en tu objetivo.</p>
    </div>
    <div class="plan-grid" id="planGrid">
      <!-- Populated by JS: 3 productos con imagen, rol, precio -->
    </div>
    <div class="plan-total" id="planTotal">
      <!-- Total + ahorro vs compra individual -->
    </div>
    <a href="#" target="_blank" class="btn-primary plan-cta" id="planCTA">
      💬 Pedir Mi Plan por WhatsApp →
    </a>
    <!-- Testimonio reactivo al arquetipo -->
    <div class="plan-testimonial" id="planTestimonial"></div>
  </div>
</section>

<!-- ═══════ MINI-QUIZ (para indecisos) ═══════ -->
<section class="quiz-section" id="quizSection">
  <div class="quiz-inner">
    <div class="quiz-icon">🤔</div>
    <h3>¿No sabes cuál elegir?</h3>
    <p>Respondé 2 preguntas rápidas y te decimos tu plan ideal.</p>
    <div class="quiz-questions" id="quizQuestions">
      <div class="quiz-step" id="quizStep1">
        <p class="quiz-q">Pregunta 1 (ej: ¿Cuánto tiempo llevas...?)</p>
        <div class="quiz-options">
          <button class="quiz-opt" data-q1="opcion1" onclick="quizAnswer(1,'opcion1')">🌱 Opción 1</button>
          <button class="quiz-opt" data-q1="opcion2" onclick="quizAnswer(1,'opcion2')">💪 Opción 2</button>
        </div>
      </div>
      <div class="quiz-step" id="quizStep2" style="display:none;">
        <p class="quiz-q">Pregunta 2 (ej: ¿Cuál es tu objetivo?)</p>
        <div class="quiz-options">
          <button class="quiz-opt" onclick="quizAnswer(2,'masa')">💪 Objetivo A</button>
          <button class="quiz-opt" onclick="quizAnswer(2,'definir')">🔥 Objetivo B</button>
        </div>
      </div>
    </div>
  </div>
</section>
```

#### 5.3 JavaScript del Archetype System

Funciones clave a implementar en `script.js`:

```javascript
// ═══ CORE: Seleccionar arquetipo ═══
function selectArchetype(key) {
  const arch = ARCHETYPES[key];
  // 1. Actualizar headline y descripción del hero
  // 2. Transición de imagen (fade out → cambiar src → fade in)
  // 3. Aplicar color CSS custom property (--archetype-color, --archetype-rgb)
  // 4. Aplicar gradient al heroSpan con lightenColor()
  // 5. Marcar la card seleccionada como active + atenuar las otras
  // 6. Construir y mostrar el plan section con buildPlanSection(arch)
  // 7. Ocultar el quiz section
  // 8. Scroll suave al plan section
  // 9. Auto-filtrar el catálogo a la categoría del arquetipo
  // 10. Notificar al desktop-fx.js para cambiar el color de partículas Three.js
  //     → window.updateParticleColors(arch.color)
}

// ═══ Construir plan section ═══
function buildPlanSection(arch) {
  // Renderizar 3 productos con: imagen, rol, precio actual, precio anterior
  // Calcular total del plan y ahorro vs compra individual
  // Construir CTA con mensaje WhatsApp pre-armado del arquetipo
  // Renderizar testimonio específico del arquetipo
}

// ═══ Quiz logic ═══
function quizAnswer(step, value) {
  // Paso 1: guardar respuesta, mostrar step 2
  // Paso 2: mapear combinación de respuestas → arquetipo → selectArchetype()
}

// ═══ Hover previews ═══
// Usar HOVER_PREVIEWS dict → mostrar/ocultar en mouseenter/mouseleave

// ═══ Color utility ═══
function lightenColor(hex, percent) {
  // Aclarar un color hex para crear gradientes del archetype color
}
```

#### 5.4 CSS para el Archetype System

Agregar a `styles.css`:

```css
/* ═══ ARCHETYPE SELECTOR ═══ */
.archetype-selector { display: flex; gap: 12px; flex-wrap: wrap; }
.archetype-card { 
  background: rgba(255,255,255,0.03);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px;
  padding: 16px 12px;
  cursor: pointer;
  transition: all 0.3s;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  min-width: 80px;
}
.archetype-card:hover { border-color: var(--archetype-color, var(--primary)); transform: translateY(-2px); }
.archetype-card.active { 
  border-color: var(--archetype-color, var(--primary));
  background: rgba(var(--archetype-rgb, var(--primary-rgb)), 0.1);
  box-shadow: 0 0 20px rgba(var(--archetype-rgb, var(--primary-rgb)), 0.15);
}
.archetype-check { display: none; color: var(--archetype-color, var(--primary)); font-size: 12px; }
.archetype-card.active .archetype-check { display: block; }

/* ═══ PLAN SECTION ═══ */
.plan-section { background: var(--bg-secondary); padding: 80px 20px; }
.plan-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 24px; }
.plan-product { 
  border: 1px solid rgba(255,255,255,0.08); border-radius: 16px;
  padding: 20px; animation: planFadeIn 0.5s ease forwards; opacity: 0;
}
@keyframes planFadeIn { to { opacity: 1; transform: translateY(0); } }

/* ═══ QUIZ ═══ */
.quiz-section { padding: 60px 20px; text-align: center; }
.quiz-opts { display: flex; flex-direction: column; gap: 12px; max-width: 400px; margin: 20px auto 0; }
.quiz-opt { 
  background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 12px; padding: 16px; cursor: pointer; transition: all 0.2s;
}
.quiz-opt:hover, .quiz-opt.selected { 
  border-color: var(--primary); background: rgba(var(--primary-rgb), 0.1); 
}
```

#### 5.5 Cuándo implementar vs cuándo omitir arquetipos

| Condición | Decisión |
|-----------|----------|
| Negocio con múltiples tipos de cliente | ✅ IMPLEMENTAR — caso ideal |
| Catálogo con categorías diferenciadas | ✅ IMPLEMENTAR |
| Un solo tipo de producto genérico | ⚠️ SIMPLIFICAR — 2-3 arquetipos simples |
| Cliente no tiene claridad sobre arquetipos | 🔍 INVESTIGAR — preguntar al usuario |

**Regla de oro**: Si el negocio puede responder "¿Para quién es este producto?", hay arquetipos. Siempre los hay.

---

### FASE 6: Verificación

Checklist final:

- [ ] Landing page carga correctamente en navegador
- [ ] Productos se renderizan desde `products.json`
- [ ] Filtros de categoría funcionan
- [ ] Todos los botones WhatsApp abren `wa.me/{numero}` con mensaje pre-armado
- [ ] Responsive: verificar en mobile y desktop
- [ ] Desktop: Three.js particles visibles, GSAP animations funcionando
- [ ] Mobile: Liquid glass visible, scroll reveals funcionando
- [ ] Arquetipos: al seleccionar uno, cambia hero + aparece plan + filtra catálogo
- [ ] Quiz: mapea respuestas al arquetipo correcto
- [ ] Countdown funciona y muestra tiempo restante
- [ ] Notificaciones FOMO aparecen periódicamente
- [ ] SEO: verificar título, meta description, JSON-LD
- [ ] Favicon cargado
- [ ] Google Fonts cargando (Outfit + Inter)
- [ ] No hay errores en console del navegador

---

## REFERENCIAS DE IMPLEMENTACIÓN

**Landing page base (catálogo + diseño dark premium):**
```
c:\Users\Alvaro Ocampo\Documents\claude\golden-honey\
├── index.html, styles.css, script.js, products.json
```

**Landing page premium (dual experience + psicología oscura + arquetipos):**
```
c:\Users\Alvaro Ocampo\Documents\claude\tfp-sport\
├── index.html       # HTML con todos los gatillos + canvas + CDN scripts
├── styles.css       # Base styles compartidos
├── desktop.css      # Desktop-only (GSAP states, 4-col grid)
├── mobile.css       # Mobile-only (liquid glass, neon glow)
├── desktop-fx.js    # Three.js particles + GSAP ScrollTrigger
├── script.js        # Core: products, FOMO, countdown, arquetipos
└── products.json    # Product data
```

**Referencia de psicología oscura (gatillos documentados):**
```
c:\Users\Alvaro Ocampo\Documents\claude\psicologia-oscura-ventas\
├── index.html       # Landing con gatillos documentados con <!-- GATILLO: -->
└── styles.css
```
