import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import type { IQuestionOption, QuestionType } from '../questions/question.model';

// Stored lifecycle (guide Section 0). Grading is tracked SEPARATELY in `grading.status`.
export const ATTEMPT_STATUSES = ['in_progress', 'submitted', 'auto_submitted', 'invalidated'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
export const GRADING_STATUSES = ['pending', 'done', 'failed', 'manual_pending'] as const; // manual_pending arrives in R2
export type GradingStatus = (typeof GRADING_STATUSES)[number];
/** Attempts that use up one of the student's allowed attempts. Invalidated (voided) attempts do not. */
export const COUNTED_STATUSES: AttemptStatus[] = ['submitted', 'auto_submitted'];

/** What the student saw: copied from the question at start. Contains NO answer key. */
export interface IAttemptQuestion {
  questionId: Types.ObjectId;
  type: QuestionType;
  text: string;
  options: IQuestionOption[];
  marks: number; // marks in THIS quiz
  sequence: number; // 1-based position shown to the student
}

export interface IAttemptAnswer {
  selectedOptionId: string | null;
  savedAt: Date; // server time of the acknowledged save; client timestamps are never used
}

export interface IAttemptExtension {
  at: Date;
  by: Types.ObjectId;
  minutes: number;
  reason: string;
  beforeEndsAt: Date;
  afterEndsAt: Date;
}

export interface IGradedItem {
  questionId: Types.ObjectId;
  awarded: number;
  answered: boolean;
  correct: boolean;
}

export interface IAttempt {
  collegeId: Types.ObjectId;
  quizId: Types.ObjectId;
  studentId: Types.ObjectId;
  attemptNo: number;
  status: AttemptStatus;
  /** Immutable copy of the quiz as this student saw it (ADR-001). Later edits never change it. */
  snapshot: {
    quizRevision: number;
    title: string;
    instructions?: string;
    totalMarks: number;
    questions: IAttemptQuestion[];
  };
  /** questionId -> correct optionId. select:false: no default query returns it; only grading asks for it. */
  answerKey?: Record<string, string>;
  /** questionId -> latest server-acknowledged answer. */
  answers: Record<string, IAttemptAnswer>;
  lastSeq: number; // highest accepted autosave sequence number
  startedAt: Date;
  endsAt: Date; // authoritative deadline (server clock)
  submittedAt?: Date;
  extensions: IAttemptExtension[];
  grading: {
    status: GradingStatus;
    score?: number;
    totalMarks?: number;
    revision: number;
    gradedAt?: Date;
    items?: IGradedItem[];
  };
  createdAt: Date;
  updatedAt: Date;
}

const optionSchema = new Schema<IQuestionOption>({ optionId: { type: String, required: true }, text: { type: String, required: true } }, { _id: false });
const questionSchema = new Schema<IAttemptQuestion>(
  {
    questionId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, required: true },
    text: { type: String, required: true },
    options: { type: [optionSchema], required: true },
    marks: { type: Number, required: true },
    sequence: { type: Number, required: true },
  },
  { _id: false },
);
const extensionSchema = new Schema<IAttemptExtension>(
  {
    at: { type: Date, required: true },
    by: { type: Schema.Types.ObjectId, required: true },
    minutes: { type: Number, required: true },
    reason: { type: String, required: true },
    beforeEndsAt: { type: Date, required: true },
    afterEndsAt: { type: Date, required: true },
  },
  { _id: false },
);
const gradedItemSchema = new Schema<IGradedItem>(
  { questionId: { type: Schema.Types.ObjectId, required: true }, awarded: Number, answered: Boolean, correct: Boolean },
  { _id: false },
);

const attemptSchema = new Schema<IAttempt>(
  {
    collegeId: { type: Schema.Types.ObjectId, required: true },
    quizId: { type: Schema.Types.ObjectId, required: true },
    studentId: { type: Schema.Types.ObjectId, required: true },
    attemptNo: { type: Number, required: true, min: 1 },
    status: { type: String, enum: [...ATTEMPT_STATUSES], required: true, default: 'in_progress' },
    snapshot: {
      quizRevision: { type: Number, required: true },
      title: { type: String, required: true },
      instructions: String,
      totalMarks: { type: Number, required: true },
      questions: { type: [questionSchema], required: true },
    },
    answerKey: { type: Schema.Types.Mixed, select: false },
    answers: { type: Schema.Types.Mixed, default: () => ({}) },
    lastSeq: { type: Number, required: true, default: 0 },
    startedAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    submittedAt: Date,
    extensions: { type: [extensionSchema], default: [] },
    grading: {
      status: { type: String, enum: [...GRADING_STATUSES], required: true, default: 'pending' },
      score: Number,
      totalMarks: Number,
      revision: { type: Number, required: true, default: 0 },
      gradedAt: Date,
      items: { type: [gradedItemSchema], default: undefined },
    },
  },
  { timestamps: true, minimize: false }, // minimize:false keeps an empty `answers` object
);

// Race-proof integrity lives in MongoDB, not in application checks (T-06):
// 1. at most ONE in-progress attempt per student per quiz (double start, two tabs, two devices)
attemptSchema.index({ quizId: 1, studentId: 1 }, { unique: true, partialFilterExpression: { status: 'in_progress' } });
// 2. attempt numbers are unique per student per quiz
attemptSchema.index({ quizId: 1, studentId: 1, attemptNo: 1 }, { unique: true });
attemptSchema.index({ status: 1, endsAt: 1 }); // the deadline sweeper
attemptSchema.index({ quizId: 1, status: 1 }); // the live monitor
attemptSchema.index({ status: 1, 'grading.status': 1 }); // attempts waiting to be graded
attemptSchema.index({ studentId: 1, createdAt: -1 });

export const Attempt = model<IAttempt>('Attempt', attemptSchema);
export type AttemptDoc = HydratedDocument<IAttempt>;
export const initAttemptIndexes = () => Attempt.init();
