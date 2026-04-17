---
description: Preparar y desplegar un sitio web a producción (Namecheap File Manager)
---

# Desplegar Sitio Web

## Pasos

1. **Auditar el proyecto antes de deploy**
   - Verificar que todos los assets existen y están referenciados correctamente
   - Verificar que no hay rutas absolutas locales (deben ser relativas)
   - Verificar que no hay `console.log` de debug
   - Verificar meta tags SEO (title, description, og:image)

2. **Crear carpeta de deploy**
// turbo
```powershell
New-Item -ItemType Directory -Path "<proyecto>/deploy" -Force
```

3. **Copiar archivos necesarios**
   - HTML, CSS, JS
   - Carpeta `assets/` con imágenes optimizadas
   - Cualquier archivo JSON de datos
   - Favicon si existe

4. **Optimizar para producción**
   - Minificar CSS si es grande
   - Comprimir imágenes (WebP cuando sea posible)
   - Verificar que las rutas son relativas

5. **Verificar estructura final**
// turbo
```powershell
Get-ChildItem -Path "<proyecto>/deploy" -Recurse | Format-Table Name, Length, Directory
```

6. **Instrucciones de subida**
   - Ir a Namecheap → cPanel → File Manager
   - Navegar a `public_html/` (o subdirectorio)
   - Subir todo el contenido de `deploy/`
   - Verificar en el dominio que funciona

7. **Post-deploy**
   - Abrir la URL en el navegador y verificar visualmente
   - Probar en mobile
   - Verificar que SSL está activo (https)
