import { Types } from 'mongoose';
import type { AttemptLookup } from '../quizzes/quiz.rules';
import { Attempt, COUNTED_STATUSES } from './attempt.model';

/** The real attempt counts the quiz module uses for availability, the student list, and the unpublish guard. */
export function createAttemptLookup(): AttemptLookup {
  return {
    async countsForStudent(studentId, quizIds) {
      if (quizIds.length === 0) return new Map();
      const rows = await Attempt.aggregate<{ _id: Types.ObjectId; n: number }>([
        { $match: { studentId: new Types.ObjectId(studentId), quizId: { $in: quizIds.map((id) => new Types.ObjectId(id)) }, status: { $in: COUNTED_STATUSES } } },
        { $group: { _id: '$quizId', n: { $sum: 1 } } },
      ]);
      return new Map(rows.map((r): [string, number] => [r._id.toString(), r.n]));
    },
    async quizHasAttempts(quizId) {
      return (await Attempt.exists({ quizId })) !== null;
    },
    async activeAttemptIds(studentId, quizIds) {
      if (quizIds.length === 0) return new Map();
      const rows = await Attempt.find({ studentId, quizId: { $in: quizIds }, status: 'in_progress' }).select('quizId');
      return new Map(rows.map((r): [string, string] => [r.quizId.toString(), r.id as string]));
    },
  };
}
