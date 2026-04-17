---
description: Auditar un proyecto existente para identificar problemas y oportunidades de mejora
---

# Auditar Proyecto Existente

## Pasos

1. **Listar estructura del proyecto**
// turbo
```powershell
Get-ChildItem -Path "<proyecto>" -Recurse -Depth 3 | Format-Table Mode, Name, Length
```

2. **Revisar calidad del código**
   - ¿HTML semántico? (uso correcto de header, main, section, article, footer)
   - ¿CSS organizado? (variables, no estilos repetidos, responsive)
   - ¿JS limpio? (no hay errores en consola, código modular)
   - ¿Hay código muerto o comentado que sobra?

3. **Verificar SEO**
   - Title tag descriptivo
   - Meta description
   - Heading hierarchy (un solo H1 por página)
   - Alt text en imágenes
   - Favicon

4. **Verificar rendimiento**
   - ¿Imágenes optimizadas? (no PNGs de 5MB)
   - ¿CSS/JS minificado? (para producción)
   - ¿Lazy loading en imágenes?
   - ¿Fonts optimizados? (display=swap)

5. **Verificar responsividad**
   - Abrir en navegador con viewport mobile (375px)
   - Abrir con viewport tablet (768px)
   - Verificar que el layout no se rompe

6. **Verificar accesibilidad**
   - Contraste de colores suficiente
   - Elementos interactivos con focus states
   - Labels en formularios

7. **Verificar seguridad** (si aplica)
   - No hay tokens/keys expuestos en el código
   - No hay datos sensibles hardcodeados
   - HTTPS configurado

8. **Generar reporte**
   - Crear un artifact con los hallazgos
   - Priorizar: 🔴 Crítico, 🟡 Mejora, 🟢 Sugerencia
   - Proponer plan de acción para los issues encontrados
