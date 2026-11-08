import { Types, type HydratedDocument } from 'mongoose';
import { z } from 'zod';
import type { AuthContext } from '../../common/auth';
import { decryptSecret } from '../../common/crypto';
import { CsvError, parseCsv, toCsv } from '../../common/csv';
import { AppError, Errors } from '../../common/errors';
import type { RequestMeta } from '../../common/request';
import { AcademicYear, Department, Division, Enrollment, SchoolClass } from '../academics/academics.models';
import type { AuditService } from '../audit/audit.service';
import { User } from '../users/user.model';
import {
  ImportJob,
  ImportRow,
  type IImportJob,
  type IImportRow,
  type ImportCounts,
  type ImportStatus,
  type ImportType,
  type RowAction,
  type RowStatus,
} from './import.models';

export const MAX_ROWS = 5000;
export const MAX_BYTES = 2 * 1024 * 1024;
export const CREDENTIAL_TTL_MS = 24 * 60 * 60 * 1000;
export const purgeDate = (days: number, from: Date = new Date()): Date => new Date(from.getTime() + days * 24 * 60 * 60 * 1000);

type RowInput = Omit<IImportRow, 'jobId' | 'collegeId' | 'createdAt' | 'updatedAt' | 'purgeAt'>;

// Privacy minimisation (D-06): ONLY these columns are accepted. Any other column (date of birth,
// phone, address...) rejects the whole file instead of being silently stored.
const HEADERS = ['loginId', 'name', 'rollNo', 'departmentCode', 'classCode', 'divisionName'] as const;
type Header = (typeof HEADERS)[number];
const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
const CANONICAL = new Map(HEADERS.map((h): [string, Header] => [norm(h), h]));

const hasControlChars = (s: string) => [...s].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
const code = z.string().min(1, 'required').max(20, 'too long').regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, - and _ only');
const rowSchema = z.object({
  loginId: z.string().min(3, 'too short (minimum 3)').max(100, 'too long').regex(/^[a-z0-9._@+-]+$/, 'letters, digits and . _ @ + - only'),
  name: z.string().min(2, 'too short (minimum 2)').max(120, 'too long').refine((s) => !hasControlChars(s), 'contains control characters'),
  rollNo: z.string().min(1, 'required').max(30, 'too long'),
  departmentCode: code,
  classCode: code,
  divisionName: z.string().min(1, 'required').max(20, 'too long'),
});

const bad = (path: string, message: string) => Errors.validation([{ path, message }]);
const gone = (code: string, message: string) => new AppError(410, code, message);

type RowDoc = HydratedDocument<IImportRow>;
type JobDoc = HydratedDocument<IImportJob>;

export const toRowDto = (r: RowDoc) => ({
  line: r.line,
  loginId: r.loginId,
  name: r.name,
  rollNo: r.rollNo,
  departmentCode: r.departmentCode,
  classCode: r.classCode,
  divisionName: r.divisionName,
  action: r.action ?? null,
  status: r.status,
  errors: r.errors,
  message: r.message ?? null,
});

export const toJobDto = (j: JobDoc) => ({
  id: j.id as string,
  type: j.type,
  status: j.status,
  academicYearId: j.academicYearId ? j.academicYearId.toString() : null,
  reason: j.reason ?? null,
  selector: j.selector?.kind ? { kind: j.selector.kind, ref: j.selector.ref ?? null } : null,
  purgeAt: j.purgeAt ? j.purgeAt.toISOString() : null,
  fileName: j.fileName ?? null,
  counts: { total: j.counts.total, ready: j.counts.ready, invalid: j.counts.invalid, done: j.counts.done, failed: j.counts.failed },
  attempts: j.attempts,
  createdAt: j.createdAt.toISOString(),
  startedAt: j.startedAt ? j.startedAt.toISOString() : null,
  finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
  credentialsExpiresAt: j.credentialsExpiresAt ? j.credentialsExpiresAt.toISOString() : null,
  credentialsExported: Boolean(j.credentialsExportedAt),
  credentialsPurged: Boolean(j.credentialsPurgedAt),
});

/** Recomputes the per-status counters from the row documents (the single source of truth). */
export async function recountRows(jobId: Types.ObjectId): Promise<ImportCounts> {
  const groups = await ImportRow.aggregate<{ _id: RowStatus; n: number }>([
    { $match: { jobId } },
    { $group: { _id: '$status', n: { $sum: 1 } } },
  ]);
  const counts: ImportCounts = { total: 0, ready: 0, invalid: 0, done: 0, failed: 0 };
  for (const g of groups) {
    counts[g._id] = g.n;
    counts.total += g.n;
  }
  return counts;
}

interface ParsedRow {
  line: number;
  loginId: string;
  name: string;
  rollNo: string;
  departmentCode: string;
  classCode: string;
  divisionName: string;
}

export interface ImportServiceDeps {
  audit: AuditService;
  credentialKey: string;
  retentionDays: number;
}

export class ImportService {
  constructor(private readonly d: ImportServiceDeps) {}

  private log(actor: AuthContext, meta: RequestMeta, action: string, targetId: string, summary?: Record<string, unknown>) {
    return this.d.audit.record({
      collegeId: actor.collegeId,
      actorId: actor.userId,
      action,
      targetType: 'importJob',
      targetId,
      summary,
      requestId: meta.requestId,
      ip: meta.ip,
    });
  }

  template(): string {
    return toCsv([[...HEADERS], ['s2026001', 'Asha Patil', '101', 'CS', 'FYCS', 'A']]);
  }

  // ------------------------------------------------------------------ validate (preview)
  async createStudentJob(actor: AuthContext, csv: string, opts: { academicYearId?: string; fileName?: string }, meta: RequestMeta) {
    let table: string[][];
    try {
      table = parseCsv(csv, { maxRows: MAX_ROWS });
    } catch (err) {
      if (err instanceof CsvError) throw bad('csv', err.message);
      throw err;
    }
    const [headerRow, ...dataRows] = table;
    if (!headerRow) throw bad('csv', 'The file is empty');

    // Header: canonical names, no unknown or duplicate columns, all required present.
    const colIndex = new Map<Header, number>();
    const unknown: string[] = [];
    const duplicated: string[] = [];
    headerRow.forEach((cell, i) => {
      const canonical = CANONICAL.get(norm(cell));
      if (!canonical) unknown.push(cell.trim() || '(blank)');
      else if (colIndex.has(canonical)) duplicated.push(canonical);
      else colIndex.set(canonical, i);
    });
    if (unknown.length) throw bad('csv', `Unknown column(s): ${unknown.join(', ')}. Only these are accepted: ${HEADERS.join(', ')}`);
    if (duplicated.length) throw bad('csv', `Duplicate column(s): ${duplicated.join(', ')}`);
    const missing = HEADERS.filter((h) => !colIndex.has(h));
    if (missing.length) throw bad('csv', `Missing required column(s): ${missing.join(', ')}`);

    // Academic year: explicit, else the current one.
    const year = opts.academicYearId
      ? await AcademicYear.findOne({ _id: opts.academicYearId, collegeId: actor.collegeId, archivedAt: null })
      : await AcademicYear.findOne({ collegeId: actor.collegeId, isCurrent: true, archivedAt: null });
    if (!year) throw bad('academicYearId', opts.academicYearId ? 'unknown or archived academic year' : 'no current academic year is set; pass academicYearId');

    const parsed: ParsedRow[] = [];
    dataRows.forEach((cells, i) => {
      const get = (h: Header) => (cells[colIndex.get(h) ?? -1] ?? '').trim();
      if (cells.every((c) => c.trim() === '')) return; // ignore rows that are entirely empty
      parsed.push({
        line: i + 2,
        loginId: get('loginId').toLowerCase(),
        name: get('name'),
        rollNo: get('rollNo'),
        departmentCode: get('departmentCode').toUpperCase(),
        classCode: get('classCode').toUpperCase(),
        divisionName: get('divisionName'),
      });
    });
    if (parsed.length === 0) throw bad('csv', 'The file has a header but no data rows');

    const rows = await this.evaluate(actor, year._id, parsed);
    return this.persistJob(actor, meta, {
      type: 'students',
      academicYearId: year._id,
      fileName: opts.fileName,
      rows,
      audit: { action: 'import.validated', summary: { fileName: opts.fileName ?? null } },
    });
  }

  /** Stores a validated job and its rows (nothing is applied yet) and returns the preview. */
  private async persistJob(
    actor: AuthContext,
    meta: RequestMeta,
    o: {
      type: ImportType;
      academicYearId?: Types.ObjectId;
      fileName?: string;
      reason?: string;
      selector?: IImportJob['selector'];
      rows: RowInput[];
      audit: { action: string; summary: Record<string, unknown> };
    },
  ) {
    const counts: ImportCounts = {
      total: o.rows.length,
      ready: o.rows.filter((r) => r.status === 'ready').length,
      invalid: o.rows.filter((r) => r.status === 'invalid').length,
      done: 0,
      failed: 0,
    };
    // An abandoned preview is deleted automatically after the retention period.
    const purgeAt = purgeDate(this.d.retentionDays);

    const job = await ImportJob.create({
      collegeId: actor.collegeId,
      type: o.type,
      uploadedBy: new Types.ObjectId(actor.userId),
      ...(o.academicYearId ? { academicYearId: o.academicYearId } : {}),
      fileName: o.fileName,
      reason: o.reason,
      selector: o.selector,
      status: 'validated',
      counts,
      purgeAt,
    });
    try {
      for (let i = 0; i < o.rows.length; i += 500) {
        await ImportRow.insertMany(o.rows.slice(i, i + 500).map((r) => ({ ...r, jobId: job._id, collegeId: actor.collegeId, purgeAt })));
      }
    } catch (err) {
      // Remove the half-written import scaffolding (never academic data) so nothing dangles.
      await ImportRow.deleteMany({ jobId: job._id });
      await ImportJob.deleteOne({ _id: job._id });
      throw err;
    }
    await this.log(actor, meta, o.audit.action, job.id, { ...counts, ...o.audit.summary });

    const stored = await ImportRow.find({ jobId: job._id }).sort({ line: 1 });
    return {
      job: toJobDto(job),
      problems: stored.filter((r) => r.status === 'invalid').slice(0, 50).map(toRowDto),
      sample: stored.slice(0, 10).map(toRowDto),
    };
  }

  // ------------------------------------------------------------------ bulk password reissue
  /**
   * Fresh temporary passwords for a SET of students (a lost credentials file, a whole division...).
   * Same safeguards as an import: preview first, explicit confirm, background worker, one-time download.
   * Applying it signs the students out everywhere and forces a password change at next login.
   */
  async createReissueJob(
    actor: AuthContext,
    input: { importJobId?: string; classId?: string; divisionId?: string; loginIds?: string[]; reason: string },
    meta: RequestMeta,
  ) {
    interface Candidate { userId?: Types.ObjectId; loginId: string; name: string; rollNo: string; departmentCode: string; classCode: string; divisionName: string }
    const collegeId = actor.collegeId;
    let selector: NonNullable<IImportJob['selector']>;
    let candidates: Candidate[];

    if (input.importJobId) {
      const src = await ImportJob.findOne({ _id: input.importJobId, collegeId, type: 'students' });
      if (!src) throw bad('importJobId', 'unknown student import');
      selector = { kind: 'import', ref: src.id as string };
      const srcRows = await ImportRow.find({ jobId: src._id, status: 'done', action: 'create_and_enroll' }).sort({ line: 1 });
      candidates = srcRows.map((r) => ({ userId: r.userId, loginId: r.loginId, name: r.name, rollNo: r.rollNo, departmentCode: r.departmentCode, classCode: r.classCode, divisionName: r.divisionName }));
    } else if (input.divisionId || input.classId) {
      const division = input.divisionId ? await Division.findOne({ _id: input.divisionId, collegeId }) : null;
      if (input.divisionId && !division) throw bad('divisionId', 'unknown division');
      const cls = input.classId ? await SchoolClass.findOne({ _id: input.classId, collegeId }) : null;
      if (input.classId && !cls) throw bad('classId', 'unknown class');
      selector = division ? { kind: 'division', ref: division.id as string } : { kind: 'class', ref: cls?.id as string };
      const enrollments = await Enrollment.find(division ? { collegeId, divisionId: division._id } : { collegeId, classId: cls?._id }).sort({ rollNo: 1 });
      const [classes, divisions, depts, users] = await Promise.all([
        SchoolClass.find({ _id: { $in: enrollments.map((e) => e.classId) } }),
        Division.find({ _id: { $in: enrollments.map((e) => e.divisionId) } }),
        Department.find({ _id: { $in: enrollments.map((e) => e.departmentId) } }),
        User.find({ _id: { $in: enrollments.map((e) => e.studentId) }, collegeId }).select('loginId name'),
      ]);
      const classCode = new Map(classes.map((x): [string, string] => [x.id as string, x.code]));
      const divName = new Map(divisions.map((x): [string, string] => [x.id as string, x.name]));
      const deptCode = new Map(depts.map((x): [string, string] => [x.id as string, x.code]));
      const userById = new Map(users.map((x): [string, typeof x] => [x.id as string, x]));
      candidates = enrollments.flatMap((e) => {
        const u = userById.get(e.studentId.toString());
        return u
          ? [{ userId: u._id, loginId: u.loginId, name: u.name, rollNo: e.rollNo, departmentCode: deptCode.get(e.departmentId.toString()) ?? '', classCode: classCode.get(e.classId.toString()) ?? '', divisionName: divName.get(e.divisionId.toString()) ?? '' }]
          : [];
      });
    } else {
      selector = { kind: 'logins' };
      const wanted = [...new Set((input.loginIds ?? []).map((l) => l.trim().toLowerCase()).filter((l) => l.length > 0))];
      const found = await User.find({ collegeId, loginId: { $in: wanted } }).select('loginId name');
      const byLogin = new Map(found.map((x): [string, typeof x] => [x.loginId, x]));
      candidates = wanted.map((login) => {
        const u = byLogin.get(login);
        return { userId: u?._id, loginId: login, name: u?.name ?? '', rollNo: '', departmentCode: '', classCode: '', divisionName: '' };
      });
    }
    if (candidates.length === 0) throw bad('selector', 'No students matched the selection');
    if (candidates.length > MAX_ROWS) throw bad('selector', `Too many students (maximum ${MAX_ROWS} per request)`);

    const accounts = await User.find({ _id: { $in: candidates.flatMap((c) => (c.userId ? [c.userId] : [])) }, collegeId }).select('role status deletedAt');
    const accountById = new Map(accounts.map((x): [string, typeof x] => [x.id as string, x]));
    const rows: RowInput[] = candidates.map((c, i) => {
      const acct = c.userId ? accountById.get(c.userId.toString()) : undefined;
      const errors: string[] = [];
      if (!acct) errors.push('loginId: no such account in this college');
      else if (acct.deletedAt) errors.push('loginId: the account was removed');
      else if (acct.role !== 'STUDENT') errors.push('loginId: not a student account');
      else if (acct.status !== 'active') errors.push('loginId: the account is not active');
      return {
        line: i + 1,
        loginId: c.loginId,
        name: c.name || c.loginId,
        rollNo: c.rollNo,
        departmentCode: c.departmentCode,
        classCode: c.classCode,
        divisionName: c.divisionName,
        action: errors.length ? undefined : ('reset_password' as const),
        userId: errors.length ? undefined : c.userId,
        status: errors.length ? ('invalid' as const) : ('ready' as const),
        errors,
      };
    });

    return this.persistJob(actor, meta, {
      type: 'credential_reissue',
      reason: input.reason,
      selector,
      rows,
      audit: { action: 'credentials.reissue_validated', summary: { reason: input.reason, selector } },
    });
  }

  /** Pure validation + lookups; touches nothing. Resolves every reference in a handful of queries. */
  private async evaluate(actor: AuthContext, yearId: Types.ObjectId, parsed: ParsedRow[]): Promise<RowInput[]> {
    type Out = RowInput;
    const collegeId = actor.collegeId;

    const schemaErrors = new Map<number, string[]>();
    for (const p of parsed) {
      const r = rowSchema.safeParse(p);
      if (!r.success) schemaErrors.set(p.line, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
    }
    const okRows = parsed.filter((p) => !schemaErrors.has(p.line));

    const [depts, classes] = await Promise.all([
      Department.find({ collegeId, archivedAt: null }),
      SchoolClass.find({ collegeId, academicYearId: yearId, archivedAt: null }),
    ]);
    const deptByCode = new Map(depts.map((x): [string, typeof x] => [x.code, x]));
    const classByKey = new Map(classes.map((x): [string, typeof x] => [`${x.departmentId.toString()}:${x.code}`, x]));
    const divisions = await Division.find({ collegeId, classId: { $in: classes.map((c) => c._id) }, archivedAt: null });
    const divByKey = new Map(divisions.map((x): [string, typeof x] => [`${x.classId.toString()}:${x.name}`, x]));

    const existingUsers = await User.find({ collegeId, loginId: { $in: [...new Set(okRows.map((r) => r.loginId))] } }).select('loginId role status deletedAt');
    const userByLogin = new Map(existingUsers.map((x): [string, typeof x] => [x.loginId, x]));
    const enrolled = await Enrollment.find({ collegeId, academicYearId: yearId, studentId: { $in: existingUsers.map((u) => u._id) } }).select('studentId');
    const enrolledIds = new Set(enrolled.map((e) => e.studentId.toString()));
    const rollTaken = new Set(
      (
        await Enrollment.find({
          collegeId,
          academicYearId: yearId,
          divisionId: { $in: divisions.map((d) => d._id) },
          rollNo: { $in: [...new Set(okRows.map((r) => r.rollNo))] },
        }).select('divisionId rollNo')
      ).map((e) => `${e.divisionId.toString()}:${e.rollNo}`),
    );

    const firstLogin = new Map<string, number>();
    const firstRoll = new Map<string, number>();
    const out: Out[] = [];

    for (const p of parsed) {
      const base = { line: p.line, loginId: p.loginId, name: p.name, rollNo: p.rollNo, departmentCode: p.departmentCode, classCode: p.classCode, divisionName: p.divisionName };
      const errors: string[] = [...(schemaErrors.get(p.line) ?? [])];
      let departmentId: Types.ObjectId | undefined;
      let classId: Types.ObjectId | undefined;
      let divisionId: Types.ObjectId | undefined;
      let action: RowAction | undefined;
      let userId: Types.ObjectId | undefined;

      if (p.loginId) {
        const seen = firstLogin.get(p.loginId);
        if (seen !== undefined) errors.push(`loginId: duplicate of line ${seen} in this file`);
        else firstLogin.set(p.loginId, p.line);
      }

      if (!schemaErrors.has(p.line)) {
        const dept = deptByCode.get(p.departmentCode);
        if (!dept) errors.push(`departmentCode: unknown department "${p.departmentCode}"`);
        const cls = dept ? classByKey.get(`${dept.id}:${p.classCode}`) : undefined;
        if (dept && !cls) errors.push(`classCode: unknown class "${p.classCode}" in ${p.departmentCode} for this academic year`);
        const div = cls ? divByKey.get(`${cls.id}:${p.divisionName}`) : undefined;
        if (cls && !div) errors.push(`divisionName: unknown division "${p.divisionName}" in class ${p.classCode}`);

        if (dept && cls && div) {
          departmentId = dept._id;
          classId = cls._id;
          divisionId = div._id;
          const rollKey = `${div.id}:${p.rollNo}`;
          const seenRoll = firstRoll.get(rollKey);
          if (seenRoll !== undefined) errors.push(`rollNo: duplicate of line ${seenRoll} in the same division`);
          else firstRoll.set(rollKey, p.line);
          if (rollTaken.has(rollKey)) errors.push('rollNo: already used in this division for this academic year');
        }

        const existing = userByLogin.get(p.loginId);
        if (!existing) {
          action = 'create_and_enroll';
        } else if (existing.deletedAt) {
          errors.push('loginId: belongs to a removed account');
        } else if (existing.role !== 'STUDENT') {
          errors.push('loginId: belongs to a non-student account');
        } else if (existing.status !== 'active') {
          errors.push('loginId: account exists but is not active (approve or activate it first)');
        } else if (enrolledIds.has(existing.id as string)) {
          errors.push('loginId: this student is already enrolled for this academic year');
        } else {
          action = 'enroll_existing';
          userId = existing._id;
        }
      }

      out.push({
        ...base,
        departmentId,
        classId,
        divisionId,
        action: errors.length ? undefined : action,
        userId: errors.length ? undefined : userId,
        status: errors.length ? 'invalid' : 'ready',
        errors,
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ read
  private async load(actor: AuthContext, id: string): Promise<JobDoc> {
    const job = await ImportJob.findOne({ _id: id, collegeId: actor.collegeId });
    if (!job) throw Errors.notFound();
    return job;
  }

  async list(actor: AuthContext, q: { page: number; pageSize: number }) {
    const filter = { collegeId: actor.collegeId };
    const [docs, total] = await Promise.all([
      ImportJob.find(filter).sort({ createdAt: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize),
      ImportJob.countDocuments(filter),
    ]);
    return { items: docs.map(toJobDto), page: q.page, pageSize: q.pageSize, total };
  }

  async get(actor: AuthContext, id: string) {
    const job = await this.load(actor, id);
    const credentialsAvailable =
      Boolean(job.credentialsExpiresAt && job.credentialsExpiresAt > new Date()) &&
      (await ImportRow.exists({ jobId: job._id, status: 'done', tempPasswordEnc: { $exists: true } })) !== null;
    return { ...toJobDto(job), credentialsAvailable };
  }

  async rows(actor: AuthContext, id: string, q: { status?: RowStatus; page: number; pageSize: number }) {
    const job = await this.load(actor, id);
    const filter: { jobId: Types.ObjectId; status?: RowStatus } = { jobId: job._id };
    if (q.status) filter.status = q.status;
    const [docs, total] = await Promise.all([
      ImportRow.find(filter).sort({ line: 1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize),
      ImportRow.countDocuments(filter),
    ]);
    return { items: docs.map(toRowDto), page: q.page, pageSize: q.pageSize, total };
  }

  // ------------------------------------------------------------------ lifecycle
  async confirm(actor: AuthContext, id: string, skipInvalid: boolean, meta: RequestMeta) {
    const job = await this.load(actor, id);
    if (job.status !== 'validated') throw Errors.conflict(`Only a validated import can be confirmed (current status: ${job.status})`);
    if (job.counts.ready === 0) throw Errors.conflict('There are no valid rows to import');
    if (job.counts.invalid > 0 && !skipInvalid) {
      throw Errors.conflict(`${job.counts.invalid} row(s) have errors. Fix the file and upload it again, or confirm with skipInvalid=true to import only the valid rows`);
    }
    // While queued/running the data must not expire; the worker sets a new purge date when it finishes.
    const queued = await ImportJob.findOneAndUpdate({ _id: job._id, status: 'validated' }, { $set: { status: 'queued' }, $unset: { purgeAt: '' } }, { new: true });
    if (!queued) throw Errors.conflict('The import changed state; reload and try again');
    await ImportRow.updateMany({ jobId: job._id }, { $unset: { purgeAt: '' } });
    await this.log(actor, meta, 'import.confirmed', job.id, { ready: job.counts.ready, skippedInvalid: job.counts.invalid });
    return toJobDto(queued);
  }

  /** Re-queues rows that failed during processing. Rows already done are never touched again. */
  async retry(actor: AuthContext, id: string, meta: RequestMeta) {
    const job = await this.load(actor, id);
    if (job.status !== 'completed_with_errors' && job.status !== 'failed') throw Errors.conflict(`Nothing to retry (current status: ${job.status})`);
    await ImportRow.updateMany({ jobId: job._id, status: 'failed' }, { $set: { status: 'ready' }, $unset: { message: '' } });
    const counts = await recountRows(job._id);
    if (counts.ready === 0) throw Errors.conflict('There are no failed rows to retry');
    const queued = await ImportJob.findOneAndUpdate(
      { _id: job._id, status: { $in: ['completed_with_errors', 'failed'] } },
      { $set: { status: 'queued', counts, attempts: 0 }, $unset: { finishedAt: '', purgeAt: '' } },
      { new: true },
    );
    if (!queued) throw Errors.conflict('The import changed state; reload and try again');
    await ImportRow.updateMany({ jobId: job._id }, { $unset: { purgeAt: '' } });
    await this.log(actor, meta, 'import.retried', job.id, { rows: counts.ready });
    return toJobDto(queued);
  }

  async cancel(actor: AuthContext, id: string, meta: RequestMeta) {
    const job = await this.load(actor, id);
    const purgeAt = purgeDate(this.d.retentionDays);
    const cancelled = await ImportJob.findOneAndUpdate({ _id: job._id, status: { $in: ['validated', 'queued'] } }, { $set: { status: 'cancelled', purgeAt } }, { new: true });
    if (!cancelled) throw Errors.conflict(`An import in status "${job.status}" cannot be cancelled`);
    await ImportRow.updateMany({ jobId: job._id }, { $set: { purgeAt } });
    await this.log(actor, meta, 'import.cancelled', job.id);
    return toJobDto(cancelled);
  }

  // ------------------------------------------------------------------ credentials (one-time)
  /**
   * Returns a CSV of temporary passwords exactly once, then wipes them. Claimed atomically, so two
   * simultaneous downloads cannot both succeed. A lost file means individual admin password resets.
   */
  async exportCredentials(actor: AuthContext, id: string, meta: RequestMeta): Promise<{ csv: string; fileName: string }> {
    const job = await this.load(actor, id);
    if (job.status !== 'completed' && job.status !== 'completed_with_errors') throw Errors.conflict('The import has not finished yet');

    const now = new Date();
    const claimed = await ImportJob.findOneAndUpdate(
      { _id: job._id, credentialsExpiresAt: { $gt: now } },
      { $set: { credentialsExportedAt: now }, $unset: { credentialsExpiresAt: '' } },
    );
    if (!claimed) {
      if (job.credentialsExportedAt) throw gone('CREDENTIALS_ALREADY_EXPORTED', 'The temporary passwords were already downloaded. Reset individual passwords if one was lost');
      throw gone('CREDENTIALS_UNAVAILABLE', 'No temporary passwords are available (expired or none were created). Reset individual passwords if needed');
    }

    const rows = await ImportRow.find({ jobId: job._id, status: 'done', tempPasswordEnc: { $exists: true } }).select('+tempPasswordEnc').sort({ line: 1 });
    const csv = toCsv([
      ['loginId', 'name', 'rollNo', 'departmentCode', 'classCode', 'divisionName', 'temporaryPassword'],
      ...rows.map((r) => [r.loginId, r.name, r.rollNo, r.departmentCode, r.classCode, r.divisionName, decryptSecret(r.tempPasswordEnc ?? '', this.d.credentialKey)]),
    ]);
    await ImportRow.updateMany({ jobId: job._id, status: 'done' }, { $unset: { tempPasswordEnc: '' } });
    await this.log(actor, meta, 'import.credentials_exported', job.id, { count: rows.length });
    return { csv, fileName: `credentials-${job.id}.csv` };
  }

  /** Wipes passwords nobody downloaded in time. Called by the worker. */
  async purgeExpiredCredentials(): Promise<number> {
    const now = new Date();
    const expired = await ImportJob.find({ credentialsExpiresAt: { $lte: now } }).select('_id collegeId');
    for (const j of expired) {
      await ImportRow.updateMany({ jobId: j._id }, { $unset: { tempPasswordEnc: '' } });
      await ImportJob.updateOne({ _id: j._id }, { $set: { credentialsPurgedAt: now }, $unset: { credentialsExpiresAt: '' } });
      await this.d.audit.record({ collegeId: j.collegeId, action: 'import.credentials_expired', targetType: 'importJob', targetId: j.id as string });
    }
    return expired.length;
  }
}

export type { ImportStatus };
