---
description: Reglas obligatorias para editar panel.js sin romper el frontend (escapado de template literals)
---

# Panel.js Editing Rules — Template Literal Escaping

> SIEMPRE seguir estas reglas al editar panel.js en negrobot.

## Arquitectura
- `panel.js` tiene una funcion `getHTML()` (linea ~1498) que retorna un template literal MASIVO (~4000 lineas)
- Contiene TODO el HTML, CSS y JavaScript del frontend
- Dentro de `<script>` hay template literals ANIDADOS con \` para HTML dinamico
- Los escapes se interpretan DOS veces: por Node.js y por el browser

## REGLAS CRITICAS

### Regla 1: NUNCA usar \n en strings dentro de `<script>`
Dentro del template literal de getHTML(), `\\n` se convierte en newline REAL que ROMPE los strings JS.

**MAL:**
```js
alert('Linea1\\nLinea2');  // se convierte en newline real, ROMPE el string
```
**BIEN:**
```js
alert('Linea1' + String.fromCharCode(10) + 'Linea2');
```

### Regla 2: NUNCA usar backticks en codigo nuevo
Usar concatenacion de strings:

**MAL:** `` `<div>${x}</div>` ``

**BIEN:** `'<div>' + x + '</div>'`

### Regla 3: Usar var, no const/let para funciones nuevas del frontend

### Regla 4: Para onclick con argumentos string, usar codigos numericos
**MAL:** `onclick="func('stringArg', id)"` (pesadilla de escapado)
**BIEN:** `onclick="func(1, id)"` y mapear numeros a tipos en la funcion

### Regla 5: NUNCA usar \t, \r u otras secuencias de escape
Mismo problema que \n. Usar String.fromCharCode().

## Verificacion OBLIGATORIA (despues de CADA edicion)

### Paso 1: Sintaxis Node
```powershell
node -c panel.js
```

### Paso 2: Parse del JS frontend (EL CRITICO — node -c NO detecta estos errores!)
```powershell
node -e "const http=require('http');http.get('http://localhost:3000',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{const s=d.split('<script>');const js=s[s.length-1].split('</script>')[0];try{new Function(js);console.log('FRONTEND JS: OK')}catch(e){console.log('FRONTEND JS ERROR:',e.message)}});});"
```
Debe decir "FRONTEND JS: OK". Si falla, el panel mostrara COMERCIAL (0).

## Patron seguro para agregar Boton + Funcion

1. **Boton** → dentro del template anidado de selectClient, en crm-save-row (~linea 2460)
2. **Funcion JS** → antes del comentario "// Lightbox" (~linea 5388), usando var y String.fromCharCode
3. **API Endpoint** → codigo server-side (lineas 244+), Node.js normal, sin problemas de escapado

## Numeros de linea clave
- getHTML() inicia: ~1498
- `<script>` inicia: ~1750
- Botones del perfil: ~2460
- Punto de insercion de funciones: ~5388 (antes de Lightbox)
- Template literal termina: ~5475
