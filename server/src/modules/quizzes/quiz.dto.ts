import type { QuizDoc } from './quiz.model';
import { displayState, evaluateAvailability, REASON_TEXT } from './quiz.rules';

export interface QuizRefs {
  subjects: Map<string, { id: string; code: string; name: string }>;
  classes: Map<string, { id: string; code: string; name: string }>;
  divisions: Map<string, { id: string; name: string }>;
}

const iso = (d?: Date) => (d ? d.toISOString() : null);

/**
 * Teacher / HOD / SUPER_ADMIN view. Never contains the code hash. `accessCode` appears only in the single response
 * that creates or rotates it (extras), formatted ABCD-EFGH, and is never retrievable afterwards.
 */
export function toQuizDto(q: QuizDoc, refs: QuizRefs, actorId: string, now: Date, extras: { accessCode?: string } = {}) {
  return {
    id: q.id as string,
    title: q.title,
    instructions: q.instructions ?? null,
    subject: refs.subjects.get(q.subjectId.toString()) ?? null,
    academicYearId: q.academicYearId.toString(),
    departmentId: q.departmentId.toString(),
    targets: q.targets.map((t) => ({
      classId: t.classId.toString(),
      class: refs.classes.get(t.classId.toString()) ?? null,
      divisionId: t.divisionId.toString(),
      division: refs.divisions.get(t.divisionId.toString()) ?? null,
    })),
    items: q.items.map((i) => ({ questionId: i.questionId.toString(), marks: i.marks })),
    questionCount: q.items.length,
    totalMarks: q.totalMarks,
    startAt: iso(q.startAt),
    endAt: iso(q.endAt),
    durationMinutes: q.durationMinutes ?? null,
    maxAttempts: q.maxAttempts,
    accessMode: q.accessMode,
    requiresCode: q.accessMode !== 'scheduled',
    hasCode: Boolean(q.codeSetAt),
    ...(extras.accessCode ? { accessCode: extras.accessCode } : {}),
    resultVisibility: q.resultVisibility,
    resultsPublished: Boolean(q.resultsPublishedAt),
    status: q.status,
    state: displayState(q, now), // draft | scheduled | live | ended | paused | closed (derived)
    statusReason: q.statusReason ?? null,
    revision: q.revision,
    createdBy: q.createdBy.toString(),
    mine: q.createdBy.toString() === actorId,
    publishedAt: iso(q.publishedAt),
    closedAt: iso(q.closedAt),
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
  };
}

/**
 * The ONLY quiz shape a student receives. Explicit allow-list: no question ids, no marks per question, no code
 * hash, no teacher or department ids. (The questions themselves arrive only after a start, as StudentQuestionDTOs.)
 */
export function toStudentQuizDto(
  q: QuizDoc,
  subject: { id: string; code: string; name: string } | null,
  attemptsUsed: number,
  now: Date,
  activeAttemptId: string | null = null,
) {
  const a = evaluateAvailability(q, now, attemptsUsed);
  return {
    id: q.id as string,
    title: q.title,
    instructions: q.instructions ?? null,
    subject,
    startAt: iso(q.startAt),
    endAt: iso(q.endAt),
    durationMinutes: q.durationMinutes ?? null,
    maxAttempts: q.maxAttempts,
    attemptsUsed,
    attemptsLeft: Math.max(0, q.maxAttempts - attemptsUsed),
    // A running attempt can be resumed even when `available` is false (paused/closed block NEW starts only).
    activeAttemptId,
    requiresCode: q.accessMode !== 'scheduled',
    totalMarks: q.totalMarks,
    questionCount: q.items.length,
    state: displayState(q, now),
    available: a.available,
    reason: a.available ? null : a.reason,
    reasonText: a.available ? null : REASON_TEXT[a.reason],
  };
}
