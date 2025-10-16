module.exports = {
  apps: [
    {
      name: "portal-ijero",
      script: "start.cjs",
      env: { NODE_ENV: "production", PORT: "3001" },
      // Auto-reload on file changes (including EJS)
      watch: ["app", "views", "public"],
      ignore_watch: ["node_modules", ".git", "logs", "tmp"],
      watch_delay: 500,
      watch_options: { usePolling: true, interval: 1000 } // reliable on cPanel/jailshell
    }
  ]
};
