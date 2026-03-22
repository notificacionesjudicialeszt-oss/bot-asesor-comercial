module.exports = {
  apps: [{
    name: 'negrobot',
    script: 'index.js',
    cwd: __dirname,
    // Reiniciar automáticamente si el proceso se cae
    autorestart: true,
    // Esperar 5 segundos antes de reiniciar
    restart_delay: 5000,
    // Máximo 10 reinicios en 60 segundos (si se cae demasiado, algo está muy mal)
    max_restarts: 10,
    min_uptime: '10s',
    // Guardar logs con fecha
    time: true,
    // Logs separados
    error_file: './error.log',
    out_file: './output.log',
    // Combinar logs stdout+stderr en un solo archivo
    merge_logs: true,
    // Variables de entorno
    env: {
      NODE_ENV: 'production'
    }
  }]
};
