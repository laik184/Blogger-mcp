import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = openDatabase(config.databasePath);
const server = createApp(config, db).listen(config.port, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', event: 'server_started', port: config.port, environment: config.nodeEnv, publishEnabled: config.publishEnabled }));
});

function shutdown(signal) {
  console.log(JSON.stringify({ level: 'info', event: 'server_stopping', signal }));
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
