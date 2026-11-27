import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import mongoose, { Types } from 'mongoose';
import { z } from 'zod';
import { AcademicYear, Department, Division, Enrollment, SchoolClass, Subject, TeachingAssignment } from '../modules/academics/academics.models';
import { Attempt } from '../modules/attempts/attempt.model';
import { PasswordService } from '../modules/auth/password.service';
import { Question } from '../modules/questions/question.model';
import { Quiz } from '../modules/quizzes/quiz.model';
import { User } from '../modules/users/user.model';
import { ANSWER_PATTERN_VERSION } from './load-spec';

/**
 * Creates (or removes) synthetic data for load testing: one teacher, N students sharing one password, an open exam.
 *   npm run load:seed -w server -- --yes            create
 *   npm run load:seed -w server -- --yes --clean    remove everything this script created
 * Safety: refuses NODE_ENV=production and anything without --yes. Everything it creates is recognisable by a fixed prefix
 * (loginId "load.*", codes LOAD*, titles "[LOAD] ...") and --clean touches only that. Students are inserted directly with ONE
 * precomputed password hash (so 1,500 users take seconds), but at the real Argon2 cost, so login load is realistic.
 */
const schema = z.object({
  MONGODB_URI: z.string().min(1),
  COLLEGE_ID: z.string().regex(/^[a-f0-9]{24}$/i),
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(1024).default(19456),
  ARGON2_TIME_COST: z.coerce.number().int().min(2).max(10).default(2),
  LOAD_USERS: z.coerce.number().int().min(1).max(5000).default(1500),
  LOAD_QUESTIONS: z.coerce.number().int().min(1).max(200).default(30),
  LOAD_PASSWORD: z.string().min(12).default('Load-Test-Pass-1234'),
  LOAD_WINDOW_START_MINUTES: z.coerce.number().int().default(-5), // exam window opens this many minutes from now (negative = already open)
  LOAD_WINDOW_MINUTES: z.coerce.number().int().min(10).default(90),
  LOAD_DURATION_MINUTES: z.coerce.number().int().min(5).default(45),
  LOAD_OUT_DIR: z.string().default('../load/data'),
});

const CODE = { dept: 'LOADTEST', cls: 'LOADCLS', subject: 'LOADSUB', year: 'LOAD-AY' };
const TITLE = '[LOAD] Exam';
const QTEXT = '[LOAD] Question';

async function clean(collegeId: Types.ObjectId): Promise<void> {
  const users = await User.find({ collegeId, loginId: /^load\./ }).select('_id');
  const userIds = users.map((u) => u._id);
  const quizzes = await Quiz.find({ collegeId, title: TITLE }).select('_id');
  const quizIds = quizzes.map((q) => q._id);
  const loadClasses = await SchoolClass.find({ collegeId, code: CODE.cls }).select('_id');
  const out = {
    attempts: (await Attempt.deleteMany({ collegeId, quizId: { $in: quizIds } })).deletedCount,
    quizzes: (await Quiz.deleteMany({ collegeId, title: TITLE })).deletedCount,
    questions: (await Question.deleteMany({ collegeId, text: { $regex: `^\\[LOAD\\] Question` } })).deletedCount,
    enrollments: (await Enrollment.deleteMany({ collegeId, studentId: { $in: userIds } })).deletedCount,
    assignments: (await TeachingAssignment.deleteMany({ collegeId, teacherId: { $in: userIds } })).deletedCount,
    users: (await User.deleteMany({ collegeId, loginId: /^load\./ })).deletedCount,
    divisions: (await Division.deleteMany({ collegeId, classId: { $in: loadClasses.map((c) => c._id) } })).deletedCount, // only the load-test class's divisions
    classes: (await SchoolClass.deleteMany({ collegeId, code: CODE.cls })).deletedCount,
    subjects: (await Subject.deleteMany({ collegeId, code: CODE.subject })).deletedCount,
    years: (await AcademicYear.deleteMany({ collegeId, label: CODE.year })).deletedCount,
    departments: (await Department.deleteMany({ collegeId, code: CODE.dept })).deletedCount,
  };
  console.log('Removed load-test data:', JSON.stringify(out));
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run with NODE_ENV=production.');
  if (!process.argv.includes('--yes')) throw new Error('Refusing to run without --yes. This writes synthetic data to the database in MONGODB_URI.');
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) throw new Error(`Invalid variables: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  const env = parsed.data;
  const collegeId = new Types.ObjectId(env.COLLEGE_ID);

  await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
  try {
    await clean(collegeId); // always start from a clean slate
    if (process.argv.includes('--clean')) return;

    const divisionSize = Math.max(100, Math.ceil(env.LOAD_USERS / 10)); // a quiz may target at most 10 class/divisions
    const divisionCount = Math.ceil(env.LOAD_USERS / divisionSize);
    const passwordHash = await new PasswordService({ memoryKib: env.ARGON2_MEMORY_KIB, timeCost: env.ARGON2_TIME_COST }).hash(env.LOAD_PASSWORD);

    const dept = await Department.create({ collegeId, name: 'Load Test Department', code: CODE.dept });
    const year = await AcademicYear.create({ collegeId, label: CODE.year, startDate: new Date('2026-06-01'), endDate: new Date('2027-05-31'), isCurrent: false });
    const cls = await SchoolClass.create({ collegeId, departmentId: dept._id, academicYearId: year._id, name: 'Load Test Class', code: CODE.cls });
    const divisions = await Division.insertMany(Array.from({ length: divisionCount }, (_, i) => ({ collegeId, classId: cls._id, departmentId: dept._id, academicYearId: year._id, name: `LD${i + 1}` })));
    const subject = await Subject.create({ collegeId, departmentId: dept._id, name: 'Load Test Subject', code: CODE.subject });

    const teacher = await User.create({ collegeId, name: 'Load Teacher', loginId: 'load.teacher', passwordHash, role: 'TEACHER', status: 'active', mustChangePassword: false, departmentId: dept._id });
    await TeachingAssignment.insertMany(divisions.map((d) => ({ collegeId, teacherId: teacher._id, subjectId: subject._id, departmentId: dept._id, academicYearId: year._id, classId: cls._id, divisionId: d._id, active: true })));

    for (let from = 1; from <= env.LOAD_USERS; from += 500) {
      const to = Math.min(env.LOAD_USERS, from + 499);
      const indexes = Array.from({ length: to - from + 1 }, (_, k) => from + k);
      const created = await User.insertMany(indexes.map((i) => ({ collegeId, name: `Load Student ${i}`, loginId: `load.${i}`, passwordHash, role: 'STUDENT' as const, status: 'active' as const, mustChangePassword: false, twoFactor: { enabled: false } })));
      await Enrollment.insertMany(
        created.map((u, k) => {
          const i = indexes[k] as number;
          const division = divisions[Math.floor((i - 1) / divisionSize)] ?? divisions[divisions.length - 1];
          return { collegeId, studentId: u._id, academicYearId: year._id, departmentId: dept._id, classId: cls._id, divisionId: division?._id, rollNo: String(i) };
        }),
      );
    }

    const questions = await Question.insertMany(
      Array.from({ length: env.LOAD_QUESTIONS }, (_, k) => ({
        collegeId, departmentId: dept._id, subjectId: subject._id, type: 'mcq' as const, text: `${QTEXT} ${k + 1}`,
        options: ['a', 'b', 'c', 'd'].map((l) => ({ optionId: `lq${k + 1}${l}`, text: `Option ${l.toUpperCase()}` })),
        correctOptionId: `lq${k + 1}a`, marks: 1, difficulty: 'medium' as const, status: 'active' as const, createdBy: teacher._id, revision: 1,
      })),
    );

    const now = Date.now();
    const startAt = new Date(now + env.LOAD_WINDOW_START_MINUTES * 60_000);
    const quiz = await Quiz.create({
      collegeId, departmentId: dept._id, academicYearId: year._id, subjectId: subject._id, createdBy: teacher._id,
      title: TITLE, items: questions.map((q) => ({ questionId: q._id, marks: 1 })), totalMarks: env.LOAD_QUESTIONS,
      targets: divisions.map((d) => ({ classId: cls._id, divisionId: d._id })),
      startAt, endAt: new Date(startAt.getTime() + env.LOAD_WINDOW_MINUTES * 60_000), durationMinutes: env.LOAD_DURATION_MINUTES,
      maxAttempts: 1, accessMode: 'scheduled', resultVisibility: 'score_only', status: 'published', publishedAt: new Date(now), revision: 1,
    });

    const outDir = path.resolve(process.cwd(), env.LOAD_OUT_DIR);
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'users.json'), JSON.stringify(Array.from({ length: env.LOAD_USERS }, (_, i) => `load.${i + 1}`)));
    await writeFile(
      path.join(outDir, 'meta.json'),
      JSON.stringify({ password: env.LOAD_PASSWORD, teacherLogin: 'load.teacher', quizId: quiz.id, questionCount: env.LOAD_QUESTIONS, users: env.LOAD_USERS, answerPatternVersion: ANSWER_PATTERN_VERSION, windowStartsAt: startAt.toISOString(), windowMinutes: env.LOAD_WINDOW_MINUTES, durationMinutes: env.LOAD_DURATION_MINUTES }, null, 2),
    );
    console.log(`Created ${env.LOAD_USERS} students in ${divisionCount} divisions, ${env.LOAD_QUESTIONS} questions, quiz ${quiz.id}.`);
    console.log(`Window: ${startAt.toISOString()} for ${env.LOAD_WINDOW_MINUTES} min (duration ${env.LOAD_DURATION_MINUTES} min). Files written to ${outDir}`);
    console.log('The exam window is already running: start the k6 run now, or re-run this script to reset it.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
