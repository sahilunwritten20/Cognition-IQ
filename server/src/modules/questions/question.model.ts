import { Schema, model, type HydratedDocument, type Types } from 'mongoose';

export const QUESTION_TYPES = ['mcq', 'true_false'] as const; // R1 scope only
export type QuestionType = (typeof QUESTION_TYPES)[number];
export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
export const QUESTION_STATUSES = ['active', 'archived'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

/** optionId is assigned by the server and is stable across edits (needed for regrading and snapshots). */
export interface IQuestionOption {
  optionId: string;
  text: string;
}

export interface IQuestion {
  collegeId: Types.ObjectId;
  departmentId: Types.ObjectId; // derived from the subject, never from the client
  subjectId: Types.ObjectId;
  topic?: string;
  type: QuestionType;
  text: string; // plain text only: clients must render it as text, never as HTML
  options: IQuestionOption[];
  /** THE ANSWER KEY. select:false => absent from every default query; only authoring/grading code asks for it. */
  correctOptionId: string;
  marks: number;
  difficulty: Difficulty;
  status: QuestionStatus;
  createdBy: Types.ObjectId;
  /** Incremented on every content change; used for optimistic concurrency and audit. */
  revision: number;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ref = () => ({ type: Schema.Types.ObjectId, required: true });

const optionSchema = new Schema<IQuestionOption>(
  { optionId: { type: String, required: true }, text: { type: String, required: true } },
  { _id: false },
);

const questionSchema = new Schema<IQuestion>(
  {
    collegeId: ref(),
    departmentId: ref(),
    subjectId: ref(),
    topic: { type: String, trim: true },
    type: { type: String, enum: [...QUESTION_TYPES], required: true },
    text: { type: String, required: true },
    options: {
      type: [optionSchema],
      required: true,
      validate: { validator: (v: unknown[]) => v.length >= 2 && v.length <= 6, message: 'options must have 2-6 entries' },
    },
    correctOptionId: { type: String, required: true, select: false },
    marks: { type: Number, required: true, min: 0.01, max: 100 },
    difficulty: { type: String, enum: [...DIFFICULTIES], required: true, default: 'medium' },
    status: { type: String, enum: [...QUESTION_STATUSES], required: true, default: 'active' },
    createdBy: ref(),
    revision: { type: Number, required: true, default: 1 },
    archivedAt: Date,
  },
  { timestamps: true },
);
questionSchema.index({ collegeId: 1, subjectId: 1, status: 1, createdAt: -1 });
questionSchema.index({ collegeId: 1, createdBy: 1, createdAt: -1 });

export const Question = model<IQuestion>('Question', questionSchema);
export type QuestionDoc = HydratedDocument<IQuestion>;
export const initQuestionIndexes = () => Question.init();
