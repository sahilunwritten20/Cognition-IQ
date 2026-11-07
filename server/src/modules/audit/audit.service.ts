import type { Types } from 'mongoose';
import type { Logger } from '../../common/logger';
import { AuditLog } from './audit.model';

export interface AuditEvent {
  collegeId: Types.ObjectId;
  actorId?: Types.ObjectId | string;
  action: string;
  targetType?: string;
  targetId?: string;
  /** Never put passwords, tokens, secrets or answer keys here. */
  summary?: Record<string, unknown>;
  requestId?: string;
  ip?: string;
}

/**
 * Append-only by construction: the application only ever creates audit rows (no update/delete API).
 * Known limitation (risk register): failures are logged, not thrown, so a failed audit write does
 * not undo the action. Revisit with transactions once multi-document flows exist (Step 3+).
 */
export class AuditService {
  constructor(private readonly logger: Logger) {}

  async record(event: AuditEvent): Promise<void> {
    try {
      await AuditLog.create(event);
    } catch (err) {
      this.logger.error({ err, action: event.action }, 'audit_write_failed');
    }
  }
}
