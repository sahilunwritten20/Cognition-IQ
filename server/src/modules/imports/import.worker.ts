import { Types, type HydratedDocument } from 'mongoose';
import { decryptSecret, encryptSecret } from '../../common/crypto';
import { duplicateKey } from '../../common/mongo';
import type { Logger } from '../../common/logger';
import { Enrollment } from '../academics/academics.models';
import type { AuditService } from '../audit/audit.service';
import { generateTemporaryPassword, type PasswordService } from '../auth/password.service';
import { revokeAllForUser } from '../auth/session.model';
import { User } from '../users/user.model';
import { ImportJob, ImportRow, type IImportJob, type IImportRow } from './import.models';
import { CREDENTIAL_TTL_MS, type ImportService, purgeDate, recountRows } from './import.service';

type JobDoc = HydratedDocument<IImportJob>;
type RowDoc = HydratedDocument<IImportRow>;

/** A failure whose message is safe to show to the administrator. Anything else is logged, not shown. */
class RowError extends Error {}

export interface ImportWorkerDeps {
  audit: AuditService;
  passwords: PasswordService;
  imports: ImportService;
  credentialKey: string;
  logger: Logger;
  batchSize?: number;
  concurrency?: number; // keep small: Argon2 hashing is CPU-heavy and shares the API process
  leaseMs?: number;
  intervalMs?: number;
  maxAttempts?: number;
  /** Days to keep rows after a job finishes (then MongoDB deletes them). */
  retentionDays: number;
  /**
   * Return true to hold ALL processing, for example while an exam window is open (wired in with the exam
   * engine, Steps 6-7). Queued jobs simply wait; nothing is dropped.
   */
  shouldPause?: () => Promise<boolean>;
}

/**
 * Database-backed job runner (ADR-003). Jobs live in MongoDB, so they survive restarts; a job is claimed
 * atomically with a lease, and an expired lease means the previous runner died and the job is resumed.
 * Every step is idempotent: rows already done are skipped, user ids are allocated BEFORE creation.
 * Run large imports outside exam windows: hashing competes with the API for CPU.
 */
export class ImportWorker {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopping = false;
  private current: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: ImportWorkerDeps) {}

  private get batchSize() { return this.d.batchSize ?? 20; }
  private get concurrency() { return this.d.concurrency ?? 4; }
  private get leaseMs() { return this.d.leaseMs ?? 60_000; }
  private get maxAttempts() { return this.d.maxAttempts ?? 5; }

  start(): void {
    this.stopping = false;
    this.timer = setInterval(() => {
      this.current = this.tick();
    }, this.d.intervalMs ?? 2_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.current; // finish the current batch; an unfinished job is resumed after its lease expires
  }

  /** One scheduling pass. Returns true if a job was processed. */
  async tick(): Promise<boolean> {
    if (this.running || this.stopping) return false;
    this.running = true;
    try {
      await this.d.imports.purgeExpiredCredentials().catch((err) => this.d.logger.error({ err }, 'credential_purge_failed'));
      if (this.d.shouldPause && (await this.d.shouldPause())) {
        this.d.logger.debug('import_worker_paused');
        return false;
      }
      const job = await this.claim();
      if (!job) return false;
      await this.process(job);
      return true;
    } catch (err) {
      this.d.logger.error({ err }, 'import_worker_error');
      return false;
    } finally {
      this.running = false;
    }
  }

  /** Process everything that is queued (used by tests and one-off runs). */
  async drain(): Promise<void> {
    while (await this.tick()) {
      /* keep going until nothing is claimable */
    }
  }

  private async claim(): Promise<JobDoc | null> {
    const now = new Date();
    return ImportJob.findOneAndUpdate(
      { $or: [{ status: 'queued' }, { status: 'running', leaseUntil: { $lt: now } }] },
      { $set: { status: 'running', leaseUntil: new Date(now.getTime() + this.leaseMs), startedAt: now }, $inc: { attempts: 1 } },
      { sort: { createdAt: 1 }, new: true },
    );
  }

  private async process(job: JobDoc): Promise<void> {
    if (job.attempts > this.maxAttempts) {
      const failedAt = new Date();
      await ImportJob.updateOne({ _id: job._id }, { $set: { status: 'failed', finishedAt: failedAt, counts: await recountRows(job._id) } });
      await this.setPurge(job._id, failedAt);
      this.d.logger.error({ jobId: job.id, attempts: job.attempts }, 'import_job_gave_up');
      return;
    }

    for (;;) {
      if (this.stopping) return; // leave it 'running'; the lease expires and it is resumed
      const rows = await ImportRow.find({ jobId: job._id, status: 'ready' }).select('+tempPasswordEnc').sort({ line: 1 }).limit(this.batchSize);
      if (rows.length === 0) break;
      for (let i = 0; i < rows.length; i += this.concurrency) {
        await Promise.all(rows.slice(i, i + this.concurrency).map((r) => this.processRow(job, r)));
      }
      await ImportJob.updateOne({ _id: job._id, status: 'running' }, { $set: { leaseUntil: new Date(Date.now() + this.leaseMs) } });
    }

    const counts = await recountRows(job._id);
    const hasPasswords = (await ImportRow.exists({ jobId: job._id, status: 'done', tempPasswordEnc: { $exists: true } })) !== null;
    const now = new Date();
    const status = counts.failed > 0 ? ('completed_with_errors' as const) : ('completed' as const);
    if (hasPasswords) {
      // New (or newly retried) passwords exist: open a fresh 24 h download window.
      await ImportJob.updateOne(
        { _id: job._id },
        {
          $set: { status, counts, finishedAt: now, credentialsExpiresAt: new Date(now.getTime() + CREDENTIAL_TTL_MS) },
          $unset: { leaseUntil: '', credentialsExportedAt: '', credentialsPurgedAt: '' },
        },
      );
    } else {
      await ImportJob.updateOne({ _id: job._id }, { $set: { status, counts, finishedAt: now }, $unset: { leaseUntil: '' } });
    }
    await this.setPurge(job._id, now);
    await this.d.audit.record({
      collegeId: job.collegeId,
      actorId: job.uploadedBy,
      action: 'import.completed',
      targetType: 'importJob',
      targetId: job.id,
      summary: { ...counts },
    });
  }

  /** Starts the retention clock: MongoDB deletes the job and its rows after `retentionDays`. */
  private async setPurge(jobId: Types.ObjectId, from: Date): Promise<void> {
    const purgeAt = purgeDate(this.d.retentionDays, from);
    await Promise.all([ImportJob.updateOne({ _id: jobId }, { $set: { purgeAt } }), ImportRow.updateMany({ jobId }, { $set: { purgeAt } })]);
  }

  private async processRow(job: JobDoc, row: RowDoc): Promise<void> {
    try {
      if (job.type === 'credential_reissue') {
        await this.reissue(job, row);
        await ImportRow.updateOne({ _id: row._id }, { $set: { status: 'done' }, $unset: { message: '' } });
        return;
      }
      const { classId, divisionId, departmentId } = row;
      const academicYearId = job.academicYearId;
      if (!classId || !divisionId || !departmentId || !academicYearId || !row.action) throw new RowError('row was not validated');

      let userId = row.userId;
      if (row.action === 'create_and_enroll') {
        // Allocate the id and password BEFORE creating the user and persist them, so a crash or a retry
        // can never create a second account or lose the password.
        let enc = row.tempPasswordEnc;
        if (!userId || !enc) {
          userId = new Types.ObjectId();
          enc = encryptSecret(generateTemporaryPassword(), this.d.credentialKey);
          await ImportRow.updateOne({ _id: row._id }, { $set: { userId, tempPasswordEnc: enc } });
        }
        if ((await User.exists({ _id: userId })) === null) {
          const password = decryptSecret(enc, this.d.credentialKey);
          try {
            await User.create({
              _id: userId,
              collegeId: job.collegeId,
              name: row.name,
              loginId: row.loginId,
              passwordHash: await this.d.passwords.hash(password),
              role: 'STUDENT',
              status: 'active',
              mustChangePassword: true,
            });
          } catch (err) {
            if (!duplicateKey(err)) throw err;
            await ImportRow.updateOne({ _id: row._id }, { $unset: { userId: '', tempPasswordEnc: '' } });
            throw new RowError('login ID already exists (it was created after validation)');
          }
        }
      } else {
        const student = userId && (await User.exists({ _id: userId, collegeId: job.collegeId, role: 'STUDENT', status: 'active', deletedAt: null }));
        if (!student) throw new RowError('the existing student account is no longer active');
      }
      if (!userId) throw new RowError('missing user id');

      await this.enroll(job, row, userId, { classId, divisionId, departmentId, academicYearId });
      await ImportRow.updateOne({ _id: row._id }, { $set: { status: 'done' }, $unset: { message: '' } });
    } catch (err) {
      let message = 'unexpected error (see server logs)';
      if (err instanceof RowError) message = err.message;
      else this.d.logger.error({ err, jobId: job.id, line: row.line }, 'import_row_failed');
      await ImportRow.updateOne({ _id: row._id }, { $set: { status: 'failed', message } });
    }
  }

  /**
   * Applies a new temporary password. Idempotent: the password is generated and stored (encrypted) on the row
   * BEFORE it is applied, so a crash and retry applies the very same password, never a different one.
   */
  private async reissue(job: JobDoc, row: RowDoc): Promise<void> {
    if (!row.userId) throw new RowError('row was not validated');
    let enc = row.tempPasswordEnc;
    if (!enc) {
      enc = encryptSecret(generateTemporaryPassword(), this.d.credentialKey);
      await ImportRow.updateOne({ _id: row._id }, { $set: { tempPasswordEnc: enc } });
    }
    const passwordHash = await this.d.passwords.hash(decryptSecret(enc, this.d.credentialKey));
    const res = await User.updateOne(
      { _id: row.userId, collegeId: job.collegeId, role: 'STUDENT', status: 'active', deletedAt: null },
      { $set: { passwordHash, mustChangePassword: true }, $inc: { tokenVersion: 1 } }, // old access tokens die at once
    );
    if (res.matchedCount !== 1) {
      await ImportRow.updateOne({ _id: row._id }, { $unset: { tempPasswordEnc: '' } });
      throw new RowError('the student account is no longer active');
    }
    await revokeAllForUser(row.userId, 'admin'); // sign the student out of every device
  }

  private async enroll(
    job: JobDoc,
    row: RowDoc,
    studentId: Types.ObjectId,
    ids: { classId: Types.ObjectId; divisionId: Types.ObjectId; departmentId: Types.ObjectId; academicYearId: Types.ObjectId },
  ): Promise<void> {
    try {
      await Enrollment.create({
        collegeId: job.collegeId,
        studentId,
        academicYearId: ids.academicYearId,
        departmentId: ids.departmentId,
        classId: ids.classId,
        divisionId: ids.divisionId,
        rollNo: row.rollNo,
      });
    } catch (err) {
      if (!duplicateKey(err)) throw err;
      // Already enrolled by an earlier attempt of this very row? Then this is a successful retry.
      const existing = await Enrollment.findOne({ studentId, academicYearId: ids.academicYearId });
      if (existing && existing.divisionId.equals(ids.divisionId) && existing.rollNo === row.rollNo) return;
      throw new RowError('enrollment conflict: the student is already enrolled for this year, or the roll number is taken');
    }
  }
}
