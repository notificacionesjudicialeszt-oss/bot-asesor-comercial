# 🛡️ Mejores Prácticas — Negrobot (WhatsApp + whatsapp-web.js)

Documento de referencia para mantener el bot estable, seguro y profesional.

---

## 1. Estabilidad de Puppeteer/Chrome

| Práctica | Estado actual | Recomendación |
|----------|:---:|---|
| Watchdog global (`detached Frame`, etc.) | ✅ Implementado | Mantener siempre activo |
| PM2 con auto-restart | ✅ Implementado | Usar `start_bot.bat` solo como backup |
| Matar procesos Chrome viejos antes de arrancar | ⚠️ Manual | Agregar limpieza automática al inicio de `index.js` |
| Modo headless en Puppeteer | ✅ | No cambiar a `false` en producción, solo para debug |

### Tip: Limpieza automática de Chrome al arrancar
Agregar al inicio de `index.js`:
```js
const { execSync } = require('child_process');
try { execSync('taskkill /F /IM chrome.exe', { stdio: 'ignore' }); } catch(e) {}
```

---

## 2. Anti-Ban de WhatsApp

WhatsApp banea cuentas que envían demasiados mensajes en poco tiempo.

| Regla | Valor recomendado | Tu bot |
|-------|:-:|:-:|
| Delay entre mensajes individuales | 3-5 seg | ✅ 3-5s |
| Delay entre grupos (broadcaster) | 1-3 min | ✅ 60-180s |
| Pausa larga cada N mensajes | Cada 50 msgs, 30s | ✅ |
| Máximo broadcasts por hora | < 50 | ✅ Controlado por horarios |
| Texto único por grupo (anti-firma) | Sí | ✅ Gemini genera texto único |

### ⚠️ Cosas que NO hacer
- Nunca enviar el mismo mensaje exacto a > 5 personas seguidas
- No enviar a contactos que nunca te han escrito (alto riesgo de reporte)
- No bajar el delay anti-ban a menos de 3 segundos

---

## 3. Manejo de Sesión

| Práctica | Recomendación |
|----------|---|
| Carpeta de sesión | `./session` — ya configurado correctamente |
| Sesión corrupta | El handler de `auth_failure` ya la limpia y reinicia |
| Múltiples instancias | **NUNCA** correr 2 bots con la misma sesión simultáneamente |
| Backup de sesión | Copiar `./session` cuando el bot está apagado, antes de cambios grandes |

---

## 4. Estructura del Código

Tu `index.js` tiene **4400+ líneas** en un solo archivo. Funciona, pero dificulta:
- Encontrar bugs
- Hacer cambios sin romper otra cosa
- Entender qué hace cada parte

### Refactorización recomendada (cuando tengas tiempo)

```
index.js (500 líneas)      → Solo arranque, client.on, y routing
├── handlers/
│   ├── message.js          → procesarMensaje()
│   ├── media.js            → manejo de audios, imágenes, PDFs
│   └── postanalysis.js     → análisis post-respuesta
├── broadcasters/
│   ├── groups.js           → sendGroupBroadcast, startGroupBroadcaster
│   ├── status.js           → sendStatusBroadcast, startStatusBroadcaster
│   └── queue.js            → buildImageQueue, getNextImage
├── api/
│   └── server.js           → startReactivacionServer, todos los endpoints
└── utils/
    ├── gemini.js            → geminiGenerate, rotateKeys
    └── safeSend.js          → sendMessage con retry
```

> No es urgente pero cuando quieras hacer cambios grandes, ayudaría mucho.

---

## 5. Base de Datos y Persistencia

| Qué se persiste | Dónde | Correcto |
|---|---|:---:|
| Clientes y CRM | `crm.db` (SQLite) | ✅ |
| Historial de conversaciones | `crm.db` | ✅ |
| Cola de broadcast | `broadcast_queue.json` | ✅ |
| Catálogo de productos | `catalogo_contexto.json` | ✅ |
| Enviados de broadcast masivo | `broadcast_enviados.json` | ✅ |

### ⚠️ Precauciones
- **Nunca borrar `crm.db`** — contiene toda la data de clientes
- **`broadcast_queue.json`** se puede borrar sin problema (se reconstruye solo)
- Hacer backup de `crm.db` periódicamente (copia manual o script)

---

## 6. API Keys de Gemini

| Práctica | Estado |
|----------|:---:|
| Rotación automática de keys | ✅ |
| Múltiples keys en `.env` | ✅ |
| Safety settings desactivados | ✅ (necesario para el negocio) |

### Tip
Si solo tienes 1 key y se agota el quota, el bot no puede responder. Recomendable tener **mínimo 2 keys** en `GEMINI_API_KEYS`.

---

## 7. Monitoreo y Logs

| Herramienta | Comando |
|---|---|
| Ver logs en vivo | `pm2 logs negrobot --lines 1000` |
| Ver errores recientes | `pm2 logs negrobot --lines 100 --nostream` |
| Estado del bot | `pm2 status` |
| Reiniciar | `pm2 restart negrobot` |
| Logs históricos | `output.log` y `error.log` en la carpeta del bot |

---

## 8. Seguridad

- ✅ `.env` está en `.gitignore` (las API keys no se suben a Git)
- ⚠️ Si subes a Git, asegúrate de que `crm.db`, `session/`, y `broadcast_*.json` también estén en `.gitignore`
- ⚠️ Nunca compartir la carpeta `session/` — quien la tenga puede usar tu WhatsApp
