---
description: Crear un nuevo proyecto web desde cero con estructura profesional
---

# Crear Nuevo Proyecto Web

## Pasos

1. **Definir requisitos** — Preguntar al usuario:
   - ¿Qué tipo de proyecto? (landing page, web app, dashboard, bot)
   - ¿Público objetivo?
   - ¿Paleta de colores o referencia visual?
   - ¿Funcionalidades clave?
   - ¿Se necesita hosting? (Namecheap u otro)

2. **Crear estructura de proyecto**
// turbo
```powershell
New-Item -ItemType Directory -Path "<nombre-proyecto>" -Force
Set-Location "<nombre-proyecto>"
```

3. **Crear archivos base**
   - `index.html` — Estructura HTML5 semántica con SEO
   - `styles.css` — Design system completo (variables CSS, tipografía, colores)
   - `script.js` — Lógica si aplica
   - `assets/` — Carpeta para imágenes y recursos

4. **Implementar diseño premium**
   - Google Fonts (Inter, Outfit, o la que el usuario prefiera)
   - Paleta de colores curada (no colores genéricos)
   - Animaciones suaves (transitions, hover effects)
   - Mobile-first responsive
   - Glassmorphism / gradientes sutiles según el estilo

5. **Implementar contenido**
   - Textos reales (NO lorem ipsum)
   - Imágenes generadas con `generate_image` si se necesitan
   - CTAs claros y visibles

6. **Verificar**
   - Abrir en navegador y revisar visualmente
   - Probar responsive (mobile/tablet/desktop)
   - Verificar que todos los links funcionan

7. **Documentar**
   - Crear `README.md` con descripción del proyecto
   - Si va a Namecheap, preparar la carpeta `deploy/`
