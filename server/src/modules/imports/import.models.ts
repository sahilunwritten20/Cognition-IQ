import { Schema, model, type Types } from 'mongoose';

export const IMPORT_STATUSES = ['validated', 'queued', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];
export const ROW_STATUSES = ['ready', 'invalid', 'done', 'failed'] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];
export type RowAction = 'create_and_enroll' | 'enroll_existing' | 'reset_password';
export type ImportType = 'students' | 'credential_reissue';
export interface ImportSelector {
  kind: 'import' | 'class' | 'division' | 'logins';
  ref?: string;
}

export interface ImportCounts {
  total: number;
  ready: number;
  invalid: number;
  done: number;
  failed: number;
}

export interface IImportJob {
  collegeId: Types.ObjectId;
  type: ImportType;
  uploadedBy: Types.ObjectId;
  academicYearId?: Types.ObjectId; // students import only
  fileName?: string;
  /** credential_reissue only: why, and which students were selected. */
  reason?: string;
  selector?: ImportSelector;
  /** MongoDB deletes the document at this time (TTL). Unset while the job is queued or running. */
  purgeAt?: Date;
  status: ImportStatus;
  counts: ImportCounts;
  attempts: number;
  leaseUntil?: Date;
  startedAt?: Date;
  finishedAt?: Date;
  /** Temporary passwords are downloadable until this moment, then purged. */
  credentialsExpiresAt?: Date;
  credentialsExportedAt?: Date;
  credentialsPurgedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IImportRow {
  jobId: Types.ObjectId;
  collegeId: Types.ObjectId;
  line: number; // line number in the uploaded file (header = 1)
  loginId: string;
  name: string;
  rollNo: string;
  departmentCode: string;
  classCode: string;
  divisionName: string;
  departmentId?: Types.ObjectId;
  classId?: Types.ObjectId;
  divisionId?: Types.ObjectId;
  action?: RowAction;
  status: RowStatus;
  errors: string[];
  message?: string; // processing failure reason (safe text)
  userId?: Types.ObjectId; // pre-allocated before creation so retries are idempotent
  tempPasswordEnc?: string; // AES-GCM encrypted; wiped on export or expiry
  purgeAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const oid = () => ({ type: Schema.Types.ObjectId, required: true });

const jobSchema = new Schema<IImportJob>(
  {
    collegeId: oid(),
    type: { type: String, enum: ['students', 'credential_reissue'], required: true },
    uploadedBy: oid(),
    academicYearId: Schema.Types.ObjectId,
    fileName: String,
    reason: String,
    selector: { kind: { type: String, enum: ['import', 'class', 'division', 'logins'] }, ref: String },
    purgeAt: Date,
    status: { type: String, enum: [...IMPORT_STATUSES], required: true },
    counts: {
      total: { type: Number, default: 0 },
      ready: { type: Number, default: 0 },
      invalid: { type: Number, default: 0 },
      done: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
    },
    attempts: { type: Number, default: 0 },
    leaseUntil: Date,
    startedAt: Date,
    finishedAt: Date,
    credentialsExpiresAt: Date,
    credentialsExportedAt: Date,
    credentialsPurgedAt: Date,
  },
  { timestamps: true },
);
jobSchema.index({ collegeId: 1, createdAt: -1 });
jobSchema.index({ status: 1, leaseUntil: 1 });
jobSchema.index({ credentialsExpiresAt: 1 }, { sparse: true });
jobSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 }); // retention: the database deletes expired jobs

const rowSchema = new Schema<IImportRow>(
  {
    jobId: oid(),
    collegeId: oid(),
    line: { type: Number, required: true },
    loginId: { type: String, required: true },
    name: { type: String, required: true },
    rollNo: { type: String, default: '' },
    departmentCode: { type: String, default: '' },
    classCode: { type: String, default: '' },
    divisionName: { type: String, default: '' },
    departmentId: Schema.Types.ObjectId,
    classId: Schema.Types.ObjectId,
    divisionId: Schema.Types.ObjectId,
    action: { type: String, enum: ['create_and_enroll', 'enroll_existing', 'reset_password'] },
    status: { type: String, enum: [...ROW_STATUSES], required: true },
    errors: { type: [String], default: [] },
    message: String,
    userId: Schema.Types.ObjectId,
    tempPasswordEnc: { type: String, select: false },
    purgeAt: Date,
  },
  { timestamps: true },
);
rowSchema.index({ jobId: 1, line: 1 }, { unique: true });
rowSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
rowSchema.index({ jobId: 1, status: 1, line: 1 });

export const ImportJob = model<IImportJob>('ImportJob', jobSchema);
export const ImportRow = model<IImportRow>('ImportRow', rowSchema);

export const initImportIndexes = () => Promise.all([ImportJob.init(), ImportRow.init()]);
