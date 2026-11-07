import { Types, type FilterQuery, type HydratedDocument } from 'mongoose';
import type { AuthContext } from '../../common/auth';
import { Errors } from '../../common/errors';
import { duplicateKey } from '../../common/mongo';
import type { RequestMeta } from '../../common/request';
import type { AuditService } from '../audit/audit.service';
import { toPublicUser, type PublicUser } from '../users/user.dto';
import { User } from '../users/user.model';
import {
  toAssignmentDto,
  toClassDto,
  toDepartmentDto,
  toDivisionDto,
  toEnrollmentDto,
  toSubjectDto,
  toYearDto,
  type PersonRef,
} from './academics.dto';
import {
  AcademicYear,
  Department,
  Division,
  Enrollment,
  SchoolClass,
  Subject,
  TeachingAssignment,
  type IAcademicYear,
  type IDepartment,
  type IDivision,
  type IEnrollment,
  type ISchoolClass,
  type ISubject,
  type ITeachingAssignment,
} from './academics.models';
import type { z } from 'zod';
import type * as S from './academics.schemas';

export type ArchiveKind = 'department' | 'year' | 'class' | 'division' | 'subject';
type Q<T extends z.ZodTypeAny> = z.output<T>;

const pageOf = <T>(items: T[], q: { page: number; pageSize: number }, total: number) => ({
  items,
  page: q.page,
  pageSize: q.pageSize,
  total,
});
const skip = (q: { page: number; pageSize: number }) => (q.page - 1) * q.pageSize;
const bad = (path: string, message: string) => Errors.validation([{ path, message }]);

/**
 * Structure and enrollment rules. SUPER_ADMIN writes; HOD reads only inside their own department.
 * Parent/child consistency is checked here and denormalized ids (department, year) are always derived
 * from the parent record, never taken from the client.
 */
export class AcademicsService {
  constructor(private readonly audit: AuditService) {}

  // ------------------------------------------------------------------ scope helpers
  /** undefined = no restriction (SUPER_ADMIN). A HOD is restricted to their own department. */
  private hodDepartment(actor: AuthContext): Types.ObjectId | undefined {
    if (actor.role === 'SUPER_ADMIN') return undefined;
    if (actor.role === 'HOD' && actor.departmentId) return new Types.ObjectId(actor.departmentId);
    throw Errors.forbidden(); // HOD with no department assigned, or any other role
  }

  private log(actor: AuthContext, meta: RequestMeta, action: string, targetType: string, targetId: string, summary?: Record<string, unknown>) {
    return this.audit.record({
      collegeId: actor.collegeId,
      actorId: actor.userId,
      action,
      targetType,
      targetId,
      summary,
      requestId: meta.requestId,
      ip: meta.ip,
    });
  }

  private async activeDept(actor: AuthContext, id: string, path = 'departmentId') {
    const d = await Department.findOne({ _id: id, collegeId: actor.collegeId, archivedAt: null });
    if (!d) throw bad(path, 'unknown or archived department');
    return d;
  }
  private async activeYear(actor: AuthContext, id: string) {
    const y = await AcademicYear.findOne({ _id: id, collegeId: actor.collegeId, archivedAt: null });
    if (!y) throw bad('academicYearId', 'unknown or archived academic year');
    return y;
  }
  private async activeClass(actor: AuthContext, id: string) {
    const c = await SchoolClass.findOne({ _id: id, collegeId: actor.collegeId, archivedAt: null });
    if (!c) throw bad('classId', 'unknown or archived class');
    return c;
  }
  private async activeDivision(actor: AuthContext, id: string, cls: { _id: Types.ObjectId }) {
    const d = await Division.findOne({ _id: id, collegeId: actor.collegeId, archivedAt: null });
    if (!d) throw bad('divisionId', 'unknown or archived division');
    if (!d.classId.equals(cls._id)) throw bad('divisionId', 'does not belong to the given class');
    return d;
  }

  // ------------------------------------------------------------------ departments
  async listDepartments(actor: AuthContext, q: Q<typeof S.departmentList>) {
    const hod = this.hodDepartment(actor);
    const filter: FilterQuery<IDepartment> = { collegeId: actor.collegeId };
    if (hod) filter._id = hod;
    if (!q.includeArchived) filter.archivedAt = null;
    const [docs, total] = await Promise.all([
      Department.find(filter).sort({ code: 1 }).skip(skip(q)).limit(q.pageSize),
      Department.countDocuments(filter),
    ]);
    return pageOf(docs.map(toDepartmentDto), q, total);
  }

  async createDepartment(actor: AuthContext, input: Q<typeof S.createDepartmentBody>, meta: RequestMeta) {
    try {
      const doc = await Department.create({ collegeId: actor.collegeId, ...input });
      await this.log(actor, meta, 'academics.department_created', 'department', doc.id, { code: doc.code });
      return toDepartmentDto(doc);
    } catch (err) {
      if (duplicateKey(err)) throw Errors.conflict('A department with this code already exists');
      throw err;
    }
  }

  async renameDepartment(actor: AuthContext, id: string, input: Q<typeof S.updateNameBody>, meta: RequestMeta) {
    const doc = await Department.findOneAndUpdate(
      { _id: id, collegeId: actor.collegeId, archivedAt: null },
      { $set: { name: input.name } },
      { new: true },
    );
    if (!doc) throw Errors.notFound();
    await this.log(actor, meta, 'academics.department_updated', 'department', doc.id, { name: input.name });
    return toDepartmentDto(doc);
  }

  // ------------------------------------------------------------------ academic years
  async listYears(actor: AuthContext, q: Q<typeof S.yearList>) {
    this.hodDepartment(actor); // read access check only: years are college-wide
    const filter: FilterQuery<IAcademicYear> = { collegeId: actor.collegeId };
    if (!q.includeArchived) filter.archivedAt = null;
    const [docs, total] = await Promise.all([
      AcademicYear.find(filter).sort({ startDate: -1 }).skip(skip(q)).limit(q.pageSize),
      AcademicYear.countDocuments(filter),
    ]);
    return pageOf(docs.map(toYearDto), q, total);
  }

  async createYear(actor: AuthContext, input: Q<typeof S.createYearBody>, meta: RequestMeta) {
    try {
      const doc = await AcademicYear.create({ collegeId: actor.collegeId, ...input });
      await this.log(actor, meta, 'academics.year_created', 'academicYear', doc.id, { label: doc.label });
      return toYearDto(doc);
    } catch (err) {
      if (duplicateKey(err)) throw Errors.conflict('An academic year with this label already exists');
      throw err;
    }
  }

  async updateYear(actor: AuthContext, id: string, input: Q<typeof S.updateYearBody>, meta: RequestMeta) {
    const doc = await AcademicYear.findOneAndUpdate(
      { _id: id, collegeId: actor.collegeId, archivedAt: null },
      { $set: { startDate: input.startDate, endDate: input.endDate } },
      { new: true },
    );
    if (!doc) throw Errors.notFound();
    await this.log(actor, meta, 'academics.year_updated', 'academicYear', doc.id);
    return toYearDto(doc);
  }

  async setCurrentYear(actor: AuthContext, id: string, meta: RequestMeta) {
    const target = await AcademicYear.findOne({ _id: id, collegeId: actor.collegeId, archivedAt: null });
    if (!target) throw Errors.notFound();
    try {
      await AcademicYear.updateMany(
        { collegeId: actor.collegeId, isCurrent: true, _id: { $ne: target._id } },
        { $set: { isCurrent: false } },
      );
      const doc = await AcademicYear.findOneAndUpdate({ _id: target._id }, { $set: { isCurrent: true } }, { new: true });
      if (!doc) throw Errors.notFound();
      await this.log(actor, meta, 'academics.year_set_current', 'academicYear', doc.id, { label: doc.label });
      return toYearDto(doc);
    } catch (err) {
      if (duplicateKey(err)) throw Errors.conflict('The current year was changed by another request; retry');
      throw err;
    }
  }

  // ------------------------------------------------------------------ classes
  async listClasses(actor: AuthContext, q: Q<typeof S.classList>) {
    const hod = this.hodDepartment(actor);
    const filter: FilterQuery<ISchoolClass> = { collegeId: actor.collegeId };
    const dept = hod ?? q.departmentId; // a HOD's own department always wins over any query value
    if (dept) filter.departmentId = dept;
    if (q.academicYearId) filter.academicYearId = q.academicYearId;
    if (!q.includeArchived) filter.archivedAt = null;
    const [docs, total] = await Promise.all([
      SchoolClass.find(filter).sort({ code: 1 }).skip(skip(q)).limit(q.pageSize),
      SchoolClass.countDocuments(filter),
    ]);
    return pageOf(docs.map(toClassDto), q, total);
  }

  async createClass(actor: AuthContext, input: Q<typeof S.createClassBody>, meta: RequestMeta) {
    const dept = await this.activeDept(actor, input.departmentId);
    const year = await this.activeYear(actor, input.academicYearId);
    try {
      const doc = await SchoolClass.create({
        collegeId: actor.collegeId,
        departmentId: dept._id,
        academicYearId: year._id,
        name: input.name,
        code: input.code,
      });
      await this.log(actor, meta, 'academics.class_created', 'class', doc.id, { code: doc.code });
      return toClassDto(doc);
    } catch (err) {
      if (duplicateKey(err)) throw Errors.conflict('A class with this code already exists in this department and year');
      throw err;
    }
  }

  async renameClass(actor: AuthContext, id: string, input: Q<typeof S.updateNameBody>, meta: RequestMeta) {
    const doc = await SchoolClass.findOneAndUpdate(
      { _id: id, collegeId: actor.collegeId, archivedAt: null },
      { $set: { name: input.name } },
      { new: true },
    );
    if (!doc) throw Errors.notFound();
    await this.log(actor, meta, 'academics.class_updated', 'class', doc.id, { name: input.name });
    return toClassDto(doc);
  }

  // ------------------------------------------------------------------ divisions
  async listDivisions(actor: AuthContext, q: Q<typeof S.divisionList>) {
    const hod = this.hodDepartment(actor);
    const filter: FilterQuery<IDivision> = { collegeId: actor.collegeId };
    if (hod) filter.departmentId = hod;
    if (q.classId) filter.classId = q.classId;
    if (!q.includeArchived) filter.archivedAt = null;
    const [docs, total] = await Promise.all([
      Division.find(filter).sort({ name: 1 }).skip(skip(q)).limit(q.pageSize),
      Division.countDocuments(filter),
    ]);
    return pageOf(docs.map(toDivisionDto), q, total);
  }

  async createDivision(actor: AuthContext, input: Q<typeof S.createDivisionBody>, meta: RequestMeta) {
    const cls = await this.activeClass(actor, input.classId);
    try {
      const doc = await Division.create({
        collegeId: actor.collegeId,
        classId: cls._id,
        departmentId: cls.departmentId,
        academicYearId: cls.academicYearId,
        name: input.name,
      });
      await this.log(actor, meta, 'academics.division_created', 'division', doc.id, { name: doc.name });
      return toDivisionDto(doc);
    } catch (err) {
      if (duplicateKey(err)) throw Errors.conflict('This class already has a division with this name');
      throw err;
    }
  }

  async renameDivision(actor: AuthContext, id: string, name: string, meta: RequestMeta) {
    try {
      const doc = await Division.findOneAndUpdate(
        { _id: id, collegeId: actor.collegeId, archivedAt: null },
        { $set: { name } },
        { new: true },
      );
      if (!doc) throw Errors.notFound();
      await this.log(actor, meta, 'academics.division_updated', 'division', doc.id, { name });
      return toDivisionDto(doc);
    } catch (err) {
      if (duplicateKey(err)) throw Errors.conflict('This class already has a division with this name');
      throw err;
    }
  }

  // ------------------------------------------------------------------ subjects
  async listSubjects(actor: AuthContext, q: Q<typeof S.subjectList>) {
    const hod = this.hodDepartment(actor);
    const filter: FilterQuery<ISubject> = { collegeId: actor.collegeId };
    const dept = hod ?? q.departmentId;
    if (dept) filter.departmentId = dept;
    if (!q.includeArchived) filter.archivedAt = null;
    const [docs, total] = await Promise.all([
      Subject.find(filter).sort({ code: 1 }).skip(skip(q)).limit(q.pageSize),
      Subject.countDocuments(filter),
    ]);
    return pageOf(docs.map(toSubjectDto), q, total);
  }

  async createSubject(actor: AuthContext, input: Q<typeof S.createSubjectBody>, meta: RequestMeta) {
    const dept = await this.activeDept(actor, input.departmentId);
    try {
      const doc = await Subject.create({ collegeId: actor.collegeId, departmentId: dept._id, name: input.name, code: input.code });
      await this.log(actor, meta, 'academics.subject_created', 'subject', doc.id, { code: doc.code });
      return toSubjectDto(doc);
    } catch (err) {
      if (duplicateKey(err)) throw Errors.conflict('A subject with this code already exists in this department');
      throw err;
    }
  }

  async renameSubject(actor: AuthContext, id: string, input: Q<typeof S.updateNameBody>, meta: RequestMeta) {
    const doc = await Subject.findOneAndUpdate(
      { _id: id, collegeId: actor.collegeId, archivedAt: null },
      { $set: { name: input.name } },
      { new: true },
    );
    if (!doc) throw Errors.notFound();
    await this.log(actor, meta, 'academics.subject_updated', 'subject', doc.id, { name: input.name });
    return toSubjectDto(doc);
  }

  // ------------------------------------------------------------------ archive (never delete)
  private async blockIf(count: PromiseLike<number>, what: string): Promise<void> {
    if ((await count) > 0) throw Errors.conflict(`Cannot archive: it still has ${what}`);
  }

  async archive(actor: AuthContext, kind: ArchiveKind, id: string, meta: RequestMeta) {
    const base = { _id: id, collegeId: actor.collegeId, archivedAt: null };
    const live = { collegeId: actor.collegeId, archivedAt: null };
    const set = { $set: { archivedAt: new Date() } };
    let doc: { id: string } | null = null;

    switch (kind) {
      case 'department':
        await this.blockIf(SchoolClass.countDocuments({ ...live, departmentId: id }), 'active classes');
        await this.blockIf(Subject.countDocuments({ ...live, departmentId: id }), 'active subjects');
        doc = await Department.findOneAndUpdate(base, set, { new: true });
        break;
      case 'year':
        await this.blockIf(
          AcademicYear.countDocuments({ _id: id, collegeId: actor.collegeId, isCurrent: true }),
          'the current-year flag (set another year as current first)',
        );
        await this.blockIf(SchoolClass.countDocuments({ ...live, academicYearId: id }), 'active classes');
        doc = await AcademicYear.findOneAndUpdate(base, set, { new: true });
        break;
      case 'class':
        await this.blockIf(Division.countDocuments({ ...live, classId: id }), 'active divisions');
        doc = await SchoolClass.findOneAndUpdate(base, set, { new: true });
        break;
      case 'division':
        await this.blockIf(
          TeachingAssignment.countDocuments({ collegeId: actor.collegeId, divisionId: id, active: true }),
          'active teaching assignments',
        );
        doc = await Division.findOneAndUpdate(base, set, { new: true });
        break;
      case 'subject':
        await this.blockIf(
          TeachingAssignment.countDocuments({ collegeId: actor.collegeId, subjectId: id, active: true }),
          'active teaching assignments',
        );
        doc = await Subject.findOneAndUpdate(base, set, { new: true });
        break;
    }
    if (!doc) throw Errors.notFound();
    await this.log(actor, meta, `academics.${kind}_archived`, kind, doc.id);
    return { id: doc.id, archived: true };
  }

  // ------------------------------------------------------------------ enrollments
  private async studentRefs(ids: Types.ObjectId[]): Promise<Map<string, PersonRef>> {
    const users = await User.find({ _id: { $in: ids } }).select('name loginId');
    return new Map(users.map((u): [string, PersonRef] => [u.id as string, { id: u.id as string, name: u.name, loginId: u.loginId }]));
  }

  async listEnrollments(actor: AuthContext, q: Q<typeof S.enrollmentList>) {
    const hod = this.hodDepartment(actor);
    const filter: FilterQuery<IEnrollment> = { collegeId: actor.collegeId };
    if (hod) filter.departmentId = hod;
    if (q.academicYearId) filter.academicYearId = q.academicYearId;
    if (q.classId) filter.classId = q.classId;
    if (q.divisionId) filter.divisionId = q.divisionId;
    if (q.studentId) filter.studentId = q.studentId;
    const [docs, total] = await Promise.all([
      Enrollment.find(filter).sort({ classId: 1, divisionId: 1, rollNo: 1 }).skip(skip(q)).limit(q.pageSize),
      Enrollment.countDocuments(filter),
    ]);
    const people = await this.studentRefs(docs.map((d) => d.studentId));
    return pageOf(docs.map((d) => toEnrollmentDto(d, people.get(d.studentId.toString()) ?? null)), q, total);
  }

  async createEnrollment(actor: AuthContext, input: Q<typeof S.createEnrollmentBody>, meta: RequestMeta) {
    const student = await User.findOne({
      _id: input.studentId,
      collegeId: actor.collegeId,
      role: 'STUDENT',
      status: 'active',
      deletedAt: null,
    });
    if (!student) throw bad('studentId', 'must be an active student in this college');
    const cls = await this.activeClass(actor, input.classId);
    const div = await this.activeDivision(actor, input.divisionId, cls);

    try {
      const doc = await Enrollment.create({
        collegeId: actor.collegeId,
        studentId: student._id,
        academicYearId: cls.academicYearId, // derived, never client-supplied
        departmentId: cls.departmentId,
        classId: cls._id,
        divisionId: div._id,
        rollNo: input.rollNo,
      });
      await this.log(actor, meta, 'academics.enrollment_created', 'enrollment', doc.id, {
        studentId: student.id,
        classId: cls.id,
        divisionId: div.id,
        rollNo: doc.rollNo,
      });
      return toEnrollmentDto(doc, { id: student.id, name: student.name, loginId: student.loginId });
    } catch (err) {
      throw this.enrollmentConflict(err);
    }
  }

  /** Corrections inside the same year/class only; moving to a new year is a NEW enrollment (history kept). */
  async updateEnrollment(actor: AuthContext, id: string, input: Q<typeof S.updateEnrollmentBody>, meta: RequestMeta) {
    const before = await Enrollment.findOne({ _id: id, collegeId: actor.collegeId });
    if (!before) throw Errors.notFound();

    const set: { divisionId?: Types.ObjectId; rollNo?: string } = {};
    if (input.divisionId) {
      const cls = await this.activeClass(actor, before.classId.toString());
      set.divisionId = (await this.activeDivision(actor, input.divisionId, cls))._id;
    }
    if (input.rollNo !== undefined) set.rollNo = input.rollNo;

    try {
      const doc = await Enrollment.findOneAndUpdate({ _id: before._id }, { $set: set }, { new: true });
      if (!doc) throw Errors.notFound();
      await this.log(actor, meta, 'academics.enrollment_updated', 'enrollment', doc.id, {
        before: { divisionId: before.divisionId.toString(), rollNo: before.rollNo },
        after: { divisionId: doc.divisionId.toString(), rollNo: doc.rollNo },
      });
      const people = await this.studentRefs([doc.studentId]);
      return toEnrollmentDto(doc, people.get(doc.studentId.toString()) ?? null);
    } catch (err) {
      throw this.enrollmentConflict(err);
    }
  }

  private enrollmentConflict(err: unknown): unknown {
    const dup = duplicateKey(err);
    if (!dup) return err;
    return 'studentId' in dup.keyPattern
      ? Errors.conflict('This student already has an enrollment for that academic year')
      : Errors.conflict('This roll number is already used in that division');
  }

  // ------------------------------------------------------------------ teaching assignments
  private async describe(docs: Array<HydratedDocument<ITeachingAssignment>>) {
    const uniq = (pick: (d: (typeof docs)[number]) => Types.ObjectId) => [...new Set(docs.map((d) => pick(d).toString()))];
    const [teachers, subjects, classes, divisions] = await Promise.all([
      User.find({ _id: { $in: uniq((d) => d.teacherId) } }).select('name loginId'),
      Subject.find({ _id: { $in: uniq((d) => d.subjectId) } }),
      SchoolClass.find({ _id: { $in: uniq((d) => d.classId) } }),
      Division.find({ _id: { $in: uniq((d) => d.divisionId) } }),
    ]);
    const tMap = new Map(teachers.map((t): [string, PersonRef] => [t.id as string, { id: t.id as string, name: t.name, loginId: t.loginId }]));
    const sMap = new Map(subjects.map((x): [string, { id: string; code: string; name: string }] => [x.id as string, { id: x.id as string, code: x.code, name: x.name }]));
    const cMap = new Map(classes.map((c): [string, { id: string; code: string; name: string }] => [c.id as string, { id: c.id as string, code: c.code, name: c.name }]));
    const dMap = new Map(divisions.map((d): [string, { id: string; name: string }] => [d.id as string, { id: d.id as string, name: d.name }]));
    return docs.map((d) =>
      toAssignmentDto(d, {
        teacher: tMap.get(d.teacherId.toString()) ?? null,
        subject: sMap.get(d.subjectId.toString()) ?? null,
        class: cMap.get(d.classId.toString()) ?? null,
        division: dMap.get(d.divisionId.toString()) ?? null,
      }),
    );
  }

  async listAssignments(actor: AuthContext, q: Q<typeof S.assignmentList>) {
    const hod = this.hodDepartment(actor);
    const filter: FilterQuery<ITeachingAssignment> = { collegeId: actor.collegeId };
    if (hod) filter.departmentId = hod;
    if (!q.includeInactive) filter.active = true;
    if (q.teacherId) filter.teacherId = q.teacherId;
    if (q.subjectId) filter.subjectId = q.subjectId;
    if (q.classId) filter.classId = q.classId;
    if (q.divisionId) filter.divisionId = q.divisionId;
    if (q.academicYearId) filter.academicYearId = q.academicYearId;
    const [docs, total] = await Promise.all([
      TeachingAssignment.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip(q)).limit(q.pageSize),
      TeachingAssignment.countDocuments(filter),
    ]);
    return pageOf(await this.describe(docs), q, total);
  }

  /** A teacher's own active assignments: the basis of their dashboard scope (Step 5+). */
  async myAssignments(actor: AuthContext) {
    const docs = await TeachingAssignment.find({ collegeId: actor.collegeId, teacherId: actor.userId, active: true })
      .sort({ createdAt: -1 })
      .limit(200);
    return { items: await this.describe(docs) };
  }

  async createAssignment(actor: AuthContext, input: Q<typeof S.createAssignmentBody>, meta: RequestMeta) {
    const teacher = await User.findOne({
      _id: input.teacherId,
      collegeId: actor.collegeId,
      role: 'TEACHER',
      status: 'active',
      deletedAt: null,
    });
    if (!teacher) throw bad('teacherId', 'must be an active teacher in this college');
    const cls = await this.activeClass(actor, input.classId);
    const div = await this.activeDivision(actor, input.divisionId, cls);
    const subject = await Subject.findOne({ _id: input.subjectId, collegeId: actor.collegeId, archivedAt: null });
    if (!subject) throw bad('subjectId', 'unknown or archived subject');
    if (!subject.departmentId.equals(cls.departmentId)) throw bad('subjectId', 'belongs to a different department than the class');
    if (!teacher.departmentId || !teacher.departmentId.equals(cls.departmentId)) {
      throw bad('teacherId', "is not assigned to the class's department (set the teacher's department first)");
    }

    try {
      const doc = await TeachingAssignment.create({
        collegeId: actor.collegeId,
        teacherId: teacher._id,
        subjectId: subject._id,
        departmentId: cls.departmentId,
        academicYearId: cls.academicYearId,
        classId: cls._id,
        divisionId: div._id,
        active: true,
      });
      await this.log(actor, meta, 'academics.assignment_created', 'teachingAssignment', doc.id, {
        teacherId: teacher.id,
        subjectId: subject.id,
        classId: cls.id,
        divisionId: div.id,
      });
      return (await this.describe([doc]))[0];
    } catch (err) {
      if (duplicateKey(err)) throw Errors.conflict('This teaching assignment already exists');
      throw err;
    }
  }

  async revokeAssignment(actor: AuthContext, id: string, meta: RequestMeta) {
    const doc = await TeachingAssignment.findOneAndUpdate(
      { _id: id, collegeId: actor.collegeId, active: true },
      { $set: { active: false, endedAt: new Date() } },
      { new: true },
    );
    if (!doc) throw Errors.notFound();
    await this.log(actor, meta, 'academics.assignment_revoked', 'teachingAssignment', doc.id);
    return (await this.describe([doc]))[0];
  }

  // ------------------------------------------------------------------ staff department
  /** Links a HOD or teacher to a department (the basis of HOD read scope and teacher eligibility). */
  async setStaffDepartment(actor: AuthContext, userId: string, departmentId: string | null, meta: RequestMeta): Promise<PublicUser> {
    const user = await User.findOne({
      _id: userId,
      collegeId: actor.collegeId,
      role: { $in: ['HOD', 'TEACHER'] },
      deletedAt: null,
    });
    if (!user) throw Errors.notFound();
    let updated;
    if (departmentId) {
      const dept = await this.activeDept(actor, departmentId);
      updated = await User.findOneAndUpdate({ _id: user._id }, { $set: { departmentId: dept._id } }, { new: true });
    } else {
      updated = await User.findOneAndUpdate({ _id: user._id }, { $unset: { departmentId: '' } }, { new: true });
    }
    if (!updated) throw Errors.notFound();
    await this.log(actor, meta, 'academics.staff_department_set', 'user', updated.id, {
      before: user.departmentId ? user.departmentId.toString() : null,
      after: departmentId,
    });
    return toPublicUser(updated);
  }
}
