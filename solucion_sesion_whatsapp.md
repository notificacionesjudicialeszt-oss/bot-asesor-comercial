# Solución Definitiva al Problema de Sesión en WhatsApp Web JS

Uno de los problemas más comunes al desarrollar y mantener bots en producción con la librería `whatsapp-web.js` es la **corrupción de la sesión** o los **cierres inesperados** del navegador interno (Chromium). Esto provoca que el bot exija escanear el código QR repetidamente o simplemente se quede colgado al iniciar.

Aquí detallamos los tres pilares de la solución completa que implementamos en este bot para garantizar la estabilidad de la sesión.

---

## 1. Uso Correcto de `LocalAuth` con Directorio Fijo

Por defecto, la sesión se guarda en una carpeta `.wwebjs_auth`. En entornos donde el script se reinicia o interactúa con otros procesos, esta capeta se puede corromper fácilmente si no se centraliza.

**Solución:** Extraer los datos de sesión a una carpeta dedicada y administrada (por ejemplo, `./session`).

```javascript
const { Client, LocalAuth } = require('whatsapp-web.js');

const client = new Client({
  // Mover la persistencia a una carpeta explícita y fuera del root oculto
  authStrategy: new LocalAuth({ dataPath: './session' }), 
  // ...
});
```

---

## 2. Argumentos de Estabilización de Puppeteer

`whatsapp-web.js` utiliza Puppeteer (Chromium) por debajo. En entornos de servidor (especialmente Windows Server, VPS o Linux sin entorno gráfico), Chromium se queda sin memoria compartida o choca con los sandboxes de seguridad del sistema operativo, corrompiendo el guardado de la base de datos IndexedDB de WhatsApp.

**Solución:** Pasar argumentos críticos ("flags") al lanzar Puppeteer para optimizar su uso de memoria y desactivar barreras de sandbox irrelevantes para un bot.

```javascript
  puppeteer: {
    headless: false, // Mantener en false para debugeo visual o true para producción en VPS
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',                    // Desactiva el sandbox de seguridad (Crítico en VPS/Servidores)
      '--disable-setuid-sandbox',        // Relacionado con permisos en Linux/Windows
      '--disable-dev-shm-usage',         // Evita que Chromium se quede sin memoria compartida (Causa #1 de crashes)
      '--disable-accelerated-2d-canvas', // Optimización de rendimiento gráfico (el bot no dibuja nada)
      '--no-first-run',                  // Evita la pantalla de "Bienvenido a Chrome" en el primer inicio
    ]
  }
```

---

## 3. Apagado Elegante (Graceful Shutdown) - ¡El Más Importante!

La **principal causa** por la que el código QR vuelve a aparecer es porque el proceso de Node.js se mata a la fuerza (por ejemplo, cerrando la terminal de golpe con la 'X', presionando `Ctrl+C`, o cuando un gestor como PM2 o Nodemon reinicia el bot). 

Si a Chromium le apagan el proceso mientras está escribiendo en su base de datos local (IndexedDB de WhatsApp), la sesión se daña, WhatsApp la rechaza por seguridad en el siguiente inicio, y pide escanear el QR de nuevo.

**Solución:** Capturar las señales de apagado del sistema operativo e indicarle a WhatsApp que cierre sus bases de datos *antes* de matar el proceso.

```javascript
// ============================================
// GRACEFUL SHUTDOWN — prevenir corrupción de sesión
// ============================================
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log(`\n[BOT] ⚠️ Señal ${signal} recibida. Cerrando limpiamente la sesión...`);
  try {
    // client.destroy() es CRÍTICO. Le dice a Chromium que termine de escribir 
    // en el disco duro y cierre las conexiones a IndexedDB de forma segura.
    await client.destroy(); 
    console.log('[BOT] ✅ Sesión de WhatsApp guardada y cerrada correctamente.');
  } catch (e) {
    console.error('[BOT] Error apagando el cliente de WhatsApp:', e.message);
  } finally {
    process.exit(0);
  }
}

// Capturar Ctrl+C
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Capturar cierres de gestores de procesos (como PM2)
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// (Opcional) Capturar cierres del sistema en Windows
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
```

### 💡 Regla de Oro en Desarrollo:
Nunca cierres la ventana de la terminal repentinamente. Siempre usa **`Ctrl + C`** y espera a ver el mensaje `"✅ Sesión de WhatsApp guardada y cerrada correctamente"` antes de cerrar o reiniciar.
