import { Router } from 'express';
import type { Request, Response } from 'express';
import { RevenueMetricsService } from '../metrics/revenue.js';
import { pool } from '../db/connection.js';

const router = Router();
const service = new RevenueMetricsService(pool);

router.get('/metrics/revenue', async (req: Request, res: Response): Promise<void> => {
    try {
      const from = req.query.from as string;
      const to = req.query.to as string;

      if (!from || !to) {
        res.status(400).json({ error: 'Missing required query parameters: from, to' });
        return;
      }

      if (isNaN(Date.parse(from)) || isNaN(Date.parse(to))) {
        res.status(400).json({ error: 'Invalid date format for from or to' });
        return;
      }

      const summary = await service.getSummary({ from, to });
      res.json(summary);
    } catch (err) {
      console.error('[Metrics] Error getting revenue summary:', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  router.get('/metrics/revenue/daily', async (req: Request, res: Response): Promise<void> => {
    try {
      const from = req.query.from as string;
      const to = req.query.to as string;

      if (!from || !to) {
        res.status(400).json({ error: 'Missing required query parameters: from, to' });
        return;
      }

      if (isNaN(Date.parse(from)) || isNaN(Date.parse(to))) {
        res.status(400).json({ error: 'Invalid date format for from or to' });
        return;
      }

      const breakdown = await service.getDailyBreakdown({ from, to });
      res.json(breakdown);
    } catch (err) {
      console.error('[Metrics] Error getting daily revenue breakdown:', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

export default router;
