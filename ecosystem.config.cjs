module.exports = {
  apps: [{
    name: "solfarm",
    cwd: "/home/alex/farm",
    script: "./run.sh",
    interpreter: "/bin/bash",
    env: { NODE_ENV: "development", PORT: "3000" },
    autorestart: true,
    max_restarts: 10,
    restart_delay: 3000,
    // Disable timestamps to reduce writes
    time: false,
    // Redirect all logs to /dev/null
    error_file: '/dev/null',
    out_file: '/dev/null',
    // Disable log rotation (prevents any log file creation)
    log_date_format: '',
    // Disable log file creation entirely
    disable_logs: true,
  }]
};