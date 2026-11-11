import type { Logger } from '../../common/logger';
import { acquireLease } from '../jobs/lease.model';
import type { AttemptService } from './attempt.service';

export interface SweeperDeps {
  attempts: AttemptService;
  logger: Logger;
  intervalMs?: number; // guide: every 30 seconds
  leaseMs?: number; // a little shorter than the interval, so exactly one instance runs each round
  batchSize?: number; // bounded batches
  now?: () => Date;
}

/**
 * Deadline sweeper (guide Section 8). A student who closes the laptop never sends another request, so the deadline cannot
 * depend on client traffic: this job finalizes expired attempts every 30 s using the SAME idempotent function as the
 * lazy path. A database lease makes one instance run per round (no Redis needed, T-05); a duplicate run is harmless anyway.
 * If this job is down, lazy finalization continues and the teacher can finalize expired attempts by hand.
 */
export class AttemptSweeper {
  private timer?: NodeJS.Timeout;
  private running = false;
  private current: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: SweeperDeps) {}

  start(): void {
    this.timer = setInterval(() => {
      this.current = this.runOnce().catch((err) => this.d.logger.error({ err }, 'sweeper_error'));
    }, this.d.intervalMs ?? 30_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.current;
  }

  async runOnce(opts: { ignoreLease?: boolean } = {}): Promise<{ skipped: boolean; finalized: number; graded: number }> {
    if (this.running) return { skipped: true, finalized: 0, graded: 0 };
    this.running = true;
    try {
      const now = this.d.now ? this.d.now() : new Date();
      if (!opts.ignoreLease && !(await acquireLease('attempt-sweeper', this.d.leaseMs ?? 25_000, now))) {
        return { skipped: true, finalized: 0, graded: 0 };
      }
      const batch = this.d.batchSize ?? 200;
      const finalized = await this.d.attempts.finalizeExpired({ limit: batch });
      const graded = await this.d.attempts.gradePending(batch);
      if (finalized > 0 || graded > 0) this.d.logger.info({ finalized, graded }, 'sweeper_round');
      return { skipped: false, finalized, graded };
    } finally {
      this.running = false;
    }
  }
}
