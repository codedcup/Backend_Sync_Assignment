import type { Pool } from 'pg';

export interface DateRange {
  from: string; // ISO format
  to: string;   // ISO format
}

export interface RevenueSummary {
  totalAmount: number;
  currency: string;
}

export interface DailyRevenueBucket {
  date: string; // YYYY-MM-DD
  amount: number;
  currency: string;
}

export interface RevenueBreakdown {
  currency: string;
  totalAmount: number;
  days: DailyRevenueBucket[];
}

/**
 * Metric Service for canonical revenue.
 * Current collected revenue attributed by the source payment creation timestamp.
 *
 * Rules:
 * - Only payments with normalized_status = 'collected' are eligible.
 * - Time filtering uses `source_created_at`.
 * - Interval semantics: `from <= source_created_at < to`.
 */
export class RevenueMetricsService {
  constructor(private readonly pool: Pool) {}

  /**
   * Private helper defining the canonical eligibility base query.
   */
  private getCanonicalBaseQuery(): string {
    return `
      SELECT 
        amount, 
        currency, 
        source_created_at
      FROM payments
      WHERE 
        normalized_status = 'collected'
        AND source_created_at >= $1 
        AND source_created_at < $2
    `;
  }

  async getSummary(range: DateRange): Promise<RevenueSummary> {
    const result = await this.pool.query(
      `
      WITH eligible AS (
        ${this.getCanonicalBaseQuery()}
      )
      SELECT 
        COALESCE(SUM(amount), 0)::int AS "totalAmount",
        MAX(currency) AS currency
      FROM eligible
      `,
      [range.from, range.to]
    );

    const row = result.rows[0];
    return {
      totalAmount: row.totalAmount,
      currency: row.currency || 'USD',
    };
  }

  async getDailyBreakdown(range: DateRange): Promise<RevenueBreakdown> {
    // Both summary and daily breakdown must consume the same canonical semantic policy.
    // However, they should independently aggregate.
    const result = await this.pool.query(
      `
      WITH eligible AS (
        ${this.getCanonicalBaseQuery()}
      )
      SELECT 
        TO_CHAR(source_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS bucket_date,
        SUM(amount)::int AS amount,
        MAX(currency) AS currency
      FROM eligible
      GROUP BY bucket_date
      ORDER BY bucket_date ASC
      `,
      [range.from, range.to]
    );

    let totalAmount = 0;
    let currency = 'USD';

    const days: DailyRevenueBucket[] = result.rows.map(row => {
      totalAmount += row.amount;
      if (row.currency) currency = row.currency;
      
      return {
        date: row.bucket_date,
        amount: row.amount,
        currency: row.currency || 'USD',
      };
    });

    return {
      currency,
      totalAmount,
      days,
    };
  }
}
