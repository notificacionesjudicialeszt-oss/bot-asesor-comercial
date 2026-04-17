---
description: Clonar sistema completo de ventas para una nueva marca — Bot WhatsApp IA + Panel CRM + Landing Page Premium (arquetipos, psicología oscura, Three.js/GSAP, liquid glass)
---

# Clonar Sistema de Ventas Completo

Este workflow ejecuta **dos skills independientes** para crear una réplica completa del sistema de ventas.

## Skills Involucrados

| # | Skill | Qué genera | Archivo |
|---|-------|-----------|---------|
| 1 | **clone-sales-bot** | Bot WhatsApp IA + Panel CRM | `.agents/skills/clone-sales-bot/SKILL.md` |
| 2 | **clone-landing-page** | Landing Page Premium + Arquetipos | `.agents/skills/clone-landing-page/SKILL.md` |

> [!NOTE]
> Cada skill es **independiente** — puedes ejecutar solo el bot, solo la landing, o ambos.

## Pasos (Sistema Completo)

### Parte 1: Bot + CRM
1. Leer skill: `c:\Users\Alvaro Ocampo\Documents\claude\.agents\skills\clone-sales-bot\SKILL.md`
2. Seguir fases en orden:
   - FASE 1: Recolectar datos del negocio + SEO/Naming + Identidad de marca
   - FASE 2: Auditoría de puertos (detectar colisiones)
   - FASE 3: Scraping de productos
   - FASE 4: Descarga de imágenes
   - FASE 5: Generación de los 20 módulos del bot
   - FASE 6: npm install + PM2 + QR scan
   - FASE 7: Verificación post-despliegue (checklist de 12 puntos)

### Parte 2: Landing Page Premium
3. Leer skill: `c:\Users\Alvaro Ocampo\Documents\claude\.agents\skills\clone-landing-page\SKILL.md`
4. Seguir fases en orden:
   - FASE 1: Datos (reusar los de la Parte 1 si ya se hizo)
   - FASE 2: Obtener productos (products.json)
   - FASE 3: Landing page base (estructura, secciones, SEO)
   - FASE 4: Experiencia dual premium (psicología oscura + Three.js/GSAP + liquid glass)
   - FASE 5: Sistema de arquetipos (gamificación)
   - FASE 6: Verificación

## Referencias
- Bot template: `c:\Users\Alvaro Ocampo\Documents\claude\golden-honey\bot\`
- Landing base: `c:\Users\Alvaro Ocampo\Documents\claude\golden-honey\`
- Landing premium: `c:\Users\Alvaro Ocampo\Documents\claude\tfp-sport\`

## Reglas
- NO saltarse la auditoría de puertos (bot FASE 2). Si se omite, los bots colisionan.
- La landing page puede crearse con o sin el bot — es autónoma.
