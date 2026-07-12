import express, { Request, Response, NextFunction } from 'express';
import healthRouter from './routes/health';
import syncRouter from './routes/sync.js';
import metricsRouter from './routes/metrics.js';
import { AppError } from './shared/errors.js';

const app = express();

// --- Middleware ---
app.use(express.json());

// --- Routes ---
app.use(healthRouter);
app.use(syncRouter);
app.use(metricsRouter);

// --- 404 handler ---
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// --- Global error handler ---
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.message,
    });
    return;
  }

  // Unexpected errors — log but don't leak internals
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
  });
});

export default app;
