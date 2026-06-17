// PM2 Ecosystem Configuration para Coter Pro
// Uso: pm2 start ecosystem.config.js --env production

module.exports = {
  apps: [
    {
      name: 'coter-pro',
      script: 'server.js',
      instances: 2,
      exec_mode: 'cluster',
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      merge_logs: true,
      // Auto-restart
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '500M',
      // Graceful shutdown
      kill_timeout: 10000,
      listen_timeout: 5000,
      // Health check
      wait_ready: true,
    },
  ],
};
