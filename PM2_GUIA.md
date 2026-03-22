# 🛠️ Guía PM2 — Negrobot

## Arrancar el bot (primera vez o después de reiniciar el PC)

```bash
pm2 start ecosystem.config.js
```

---

## Comandos del día a día

| Comando | Qué hace |
|---------|----------|
| `pm2 status` | Ver si el bot está corriendo (`online` = bien) |
| `pm2 logs negrobot` | Ver logs en tiempo real (solo lo nuevo) |
| `pm2 logs negrobot --lines 1000` | Historial + tiempo real |
| `pm2 restart negrobot` | Reiniciar (después de cambios al código) |
| `pm2 stop negrobot` | Detener el bot |
| `pm2 start negrobot` | Arrancar el bot (si lo detuviste) |
| `pm2 delete negrobot` | Eliminar de PM2 completamente |

---

## Cosas importantes

- **`Ctrl+C` en los logs NO mata el bot** — solo sales de la vista de logs
- **Cerrar la terminal NO mata el bot** — sigue corriendo en background
- Si el bot se cae por error de Puppeteer, **PM2 lo reinicia solo en 5 segundos**
- Los logs se guardan en `output.log` y `error.log` dentro de la carpeta del bot

---

## Flujo típico

1. Enciendes el PC → `pm2 start ecosystem.config.js`
2. Monitorear → `pm2 logs negrobot --lines 1000` (dejar abierto)
3. Hiciste cambio al código → `pm2 restart negrobot`
4. Ver errores recientes → `pm2 logs negrobot --lines 100 --nostream`
