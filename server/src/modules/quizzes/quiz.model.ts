import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

// Stored status (guide Section 0). "scheduled", "live" and "ended" are DERIVED display states, never stored.
export const QUIZ_STATUSES = ['draft', 'published', 'paused', 'closed'] as const;
export type QuizStatus = (typeof QUIZ_STATUSES)[number];
export const ACCESS_MODES = ['scheduled', 'code', 'both'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];
export const RESULT_VISIBILITIES = ['hidden', 'score_only', 'score_and_answers'] as const;
export type ResultVisibility = (typeof RESULT_VISIBILITIES)[number];

/** A question reference with the marks it carries IN THIS QUIZ. The content is copied into each attempt at start. */
export interface IQuizItem {
  questionId: Types.ObjectId;
  marks: number;
}
/** Who may sit the quiz: students enrolled (in the quiz's academic year) in this class and division. */
export interface IQuizTarget {
  classId: Types.ObjectId;
  divisionId: Types.ObjectId;
}

export interface IQuiz {
  collegeId: Types.ObjectId;
  departmentId: Types.ObjectId; // derived from the teaching assignments, never from the client
  academicYearId: Types.ObjectId; // derived
  subjectId: Types.ObjectId;
  createdBy: Types.ObjectId;
  title: string;
  instructions?: string;
  items: IQuizItem[];
  totalMarks: number; // computed by the server, always
  targets: IQuizTarget[];
  startAt?: Date; // UTC
  endAt?: Date; // UTC
  durationMinutes?: number;
  maxAttempts: number;
  accessMode: AccessMode;
  /** HMAC of the access code. select:false; the code itself is shown once and never stored. */
  codeHash?: string;
  codeSetAt?: Date;
  resultVisibility: ResultVisibility; // D-01: hidden by default
  resultsPublishedAt?: Date; // null until a teacher publishes results (Step 9)
  status: QuizStatus;
  revision: number;
  publishedAt?: Date;
  pausedAt?: Date;
  closedAt?: Date;
  statusReason?: string; // last pause/close/unpublish reason
  createdAt: Date;
  updatedAt: Date;
}

const ref = () => ({ type: Schema.Types.ObjectId, required: true });

const itemSchema = new Schema<IQuizItem>(
  { questionId: ref(), marks: { type: Number, required: true, min: 0.01, max: 100 } },
  { _id: false },
);
const targetSchema = new Schema<IQuizTarget>({ classId: ref(), divisionId: ref() }, { _id: false });

const quizSchema = new Schema<IQuiz>(
  {
    collegeId: ref(),
    departmentId: ref(),
    academicYearId: ref(),
    subjectId: ref(),
    createdBy: ref(),
    title: { type: String, required: true, trim: true },
    instructions: { type: String },
    items: { type: [itemSchema], default: [], validate: { validator: (v: unknown[]) => v.length <= 200, message: 'at most 200 questions' } },
    totalMarks: { type: Number, required: true, default: 0 },
    targets: { type: [targetSchema], required: true, validate: { validator: (v: unknown[]) => v.length >= 1 && v.length <= 10, message: '1-10 targets' } },
    startAt: Date,
    endAt: Date,
    durationMinutes: Number,
    maxAttempts: { type: Number, required: true, default: 1, min: 1, max: 5 },
    accessMode: { type: String, enum: [...ACCESS_MODES], required: true, default: 'scheduled' },
    codeHash: { type: String, select: false },
    codeSetAt: Date,
    resultVisibility: { type: String, enum: [...RESULT_VISIBILITIES], required: true, default: 'hidden' },
    resultsPublishedAt: Date,
    status: { type: String, enum: [...QUIZ_STATUSES], required: true, default: 'draft' },
    revision: { type: Number, required: true, default: 1 },
    publishedAt: Date,
    pausedAt: Date,
    closedAt: Date,
    statusReason: String,
  },
  { timestamps: true },
);
quizSchema.index({ collegeId: 1, createdBy: 1, status: 1, createdAt: -1 });
quizSchema.index({ collegeId: 1, departmentId: 1, status: 1, createdAt: -1 });
// Student discovery: published/paused quizzes of a year that include a given division.
quizSchema.index({ collegeId: 1, status: 1, academicYearId: 1, 'targets.divisionId': 1, endAt: 1 });

export const Quiz = model<IQuiz>('Quiz', quizSchema);
export type QuizDoc = HydratedDocument<IQuiz>;
export const initQuizIndexes = () => Quiz.init();
