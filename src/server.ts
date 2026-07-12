import app from './app';
import { config } from './config';
import { verifyConnection } from './db/connection';

async function start(): Promise<void> {
  try {
    console.log('Verifying database connection...');
    await verifyConnection();
    console.log('Database connection verified.');
  } catch (err) {
    console.error('Failed to connect to database:', err);
    process.exit(1);
  }

  app.listen(config.port, () => {
    console.log(`Server running on port ${config.port} [${config.nodeEnv}]`);
  });
}

start();
