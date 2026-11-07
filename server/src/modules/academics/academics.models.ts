import { Schema, model, type Types } from 'mongoose';

// Hierarchy (guide Section 2): College -> Department -> Academic Year -> Class -> Division -> Subjects.
// Every record carries collegeId (and departmentId / academicYearId where relevant) so every query
// can be scoped explicitly. Nothing here is ever hard-deleted: "archive" keeps history.

interface Base {
  collegeId: Types.ObjectId;
  archivedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IDepartment extends Base {
  name: string;
  code: string;
}
export interface IAcademicYear extends Base {
  label: string;
  startDate: Date;
  endDate: Date;
  isCurrent: boolean;
}
export interface ISchoolClass extends Base {
  departmentId: Types.ObjectId;
  academicYearId: Types.ObjectId;
  name: string;
  code: string;
}
export interface IDivision extends Base {
  classId: Types.ObjectId;
  departmentId: Types.ObjectId;
  academicYearId: Types.ObjectId;
  name: string;
}
export interface ISubject extends Base {
  departmentId: Types.ObjectId;
  name: string;
  code: string;
}
/** A student account is permanent; an enrollment is one academic year. History is never overwritten. */
export interface IEnrollment {
  collegeId: Types.ObjectId;
  studentId: Types.ObjectId;
  academicYearId: Types.ObjectId;
  departmentId: Types.ObjectId;
  classId: Types.ObjectId;
  divisionId: Types.ObjectId;
  rollNo: string;
  createdAt: Date;
  updatedAt: Date;
}
export interface ITeachingAssignment {
  collegeId: Types.ObjectId;
  teacherId: Types.ObjectId;
  subjectId: Types.ObjectId;
  departmentId: Types.ObjectId;
  academicYearId: Types.ObjectId;
  classId: Types.ObjectId;
  divisionId: Types.ObjectId;
  active: boolean;
  endedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ref = () => ({ type: Schema.Types.ObjectId, required: true });
const timestamps = { timestamps: true };

const departmentSchema = new Schema<IDepartment>(
  { collegeId: ref(), name: { type: String, required: true, trim: true }, code: { type: String, required: true, trim: true, uppercase: true }, archivedAt: Date },
  timestamps,
);
departmentSchema.index({ collegeId: 1, code: 1 }, { unique: true });

const yearSchema = new Schema<IAcademicYear>(
  {
    collegeId: ref(),
    label: { type: String, required: true, trim: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    isCurrent: { type: Boolean, default: false },
    archivedAt: Date,
  },
  timestamps,
);
yearSchema.index({ collegeId: 1, label: 1 }, { unique: true });
// At most one current year per college, enforced by MongoDB.
yearSchema.index({ collegeId: 1 }, { unique: true, partialFilterExpression: { isCurrent: true } });

const classSchema = new Schema<ISchoolClass>(
  {
    collegeId: ref(),
    departmentId: ref(),
    academicYearId: ref(),
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    archivedAt: Date,
  },
  timestamps,
);
classSchema.index({ collegeId: 1, academicYearId: 1, departmentId: 1, code: 1 }, { unique: true });

const divisionSchema = new Schema<IDivision>(
  {
    collegeId: ref(),
    classId: ref(),
    departmentId: ref(),
    academicYearId: ref(),
    name: { type: String, required: true, trim: true },
    archivedAt: Date,
  },
  timestamps,
);
divisionSchema.index({ classId: 1, name: 1 }, { unique: true });

const subjectSchema = new Schema<ISubject>(
  {
    collegeId: ref(),
    departmentId: ref(),
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    archivedAt: Date,
  },
  timestamps,
);
subjectSchema.index({ collegeId: 1, departmentId: 1, code: 1 }, { unique: true });

const enrollmentSchema = new Schema<IEnrollment>(
  {
    collegeId: ref(),
    studentId: ref(),
    academicYearId: ref(),
    departmentId: ref(),
    classId: ref(),
    divisionId: ref(),
    rollNo: { type: String, required: true, trim: true },
  },
  timestamps,
);
// D-14: one enrollment per student per academic year; roll numbers unique within a division.
enrollmentSchema.index({ studentId: 1, academicYearId: 1 }, { unique: true });
enrollmentSchema.index({ collegeId: 1, academicYearId: 1, classId: 1, divisionId: 1, rollNo: 1 }, { unique: true });
enrollmentSchema.index({ collegeId: 1, divisionId: 1 });

const assignmentSchema = new Schema<ITeachingAssignment>(
  {
    collegeId: ref(),
    teacherId: ref(),
    subjectId: ref(),
    departmentId: ref(),
    academicYearId: ref(),
    classId: ref(),
    divisionId: ref(),
    active: { type: Boolean, default: true },
    endedAt: Date,
  },
  timestamps,
);
// Unique only while active, so a revoked assignment can be created again later (history is kept).
assignmentSchema.index(
  { teacherId: 1, subjectId: 1, classId: 1, divisionId: 1, academicYearId: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);
assignmentSchema.index({ teacherId: 1, active: 1 });
assignmentSchema.index({ collegeId: 1, departmentId: 1, active: 1 });

export const Department = model<IDepartment>('Department', departmentSchema);
export const AcademicYear = model<IAcademicYear>('AcademicYear', yearSchema);
export const SchoolClass = model<ISchoolClass>('SchoolClass', classSchema);
export const Division = model<IDivision>('Division', divisionSchema);
export const Subject = model<ISubject>('Subject', subjectSchema);
export const Enrollment = model<IEnrollment>('Enrollment', enrollmentSchema);
export const TeachingAssignment = model<ITeachingAssignment>('TeachingAssignment', assignmentSchema);

/** Build indexes now (tests and migrations); in normal runs Mongoose builds them at startup. */
export const initAcademicIndexes = () =>
  Promise.all([
    Department.init(),
    AcademicYear.init(),
    SchoolClass.init(),
    Division.init(),
    Subject.init(),
    Enrollment.init(),
    TeachingAssignment.init(),
  ]);
