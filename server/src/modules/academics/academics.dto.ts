import type { HydratedDocument } from 'mongoose';
import type {
  IAcademicYear,
  IDepartment,
  IDivision,
  IEnrollment,
  ISchoolClass,
  ISubject,
  ITeachingAssignment,
} from './academics.models';

const archived = (d: { archivedAt?: Date }) => ({
  archived: Boolean(d.archivedAt),
  archivedAt: d.archivedAt ? d.archivedAt.toISOString() : null,
});

export const toDepartmentDto = (d: HydratedDocument<IDepartment>) => ({
  id: d.id as string,
  code: d.code,
  name: d.name,
  ...archived(d),
});

export const toYearDto = (d: HydratedDocument<IAcademicYear>) => ({
  id: d.id as string,
  label: d.label,
  startDate: d.startDate.toISOString(),
  endDate: d.endDate.toISOString(),
  isCurrent: d.isCurrent,
  ...archived(d),
});

export const toClassDto = (d: HydratedDocument<ISchoolClass>) => ({
  id: d.id as string,
  code: d.code,
  name: d.name,
  departmentId: d.departmentId.toString(),
  academicYearId: d.academicYearId.toString(),
  ...archived(d),
});

export const toDivisionDto = (d: HydratedDocument<IDivision>) => ({
  id: d.id as string,
  name: d.name,
  classId: d.classId.toString(),
  departmentId: d.departmentId.toString(),
  academicYearId: d.academicYearId.toString(),
  ...archived(d),
});

export const toSubjectDto = (d: HydratedDocument<ISubject>) => ({
  id: d.id as string,
  code: d.code,
  name: d.name,
  departmentId: d.departmentId.toString(),
  ...archived(d),
});

export interface PersonRef {
  id: string;
  name: string;
  loginId: string;
}

export const toEnrollmentDto = (d: HydratedDocument<IEnrollment>, student: PersonRef | null) => ({
  id: d.id as string,
  student,
  rollNo: d.rollNo,
  academicYearId: d.academicYearId.toString(),
  departmentId: d.departmentId.toString(),
  classId: d.classId.toString(),
  divisionId: d.divisionId.toString(),
});

export interface AssignmentRefs {
  teacher: PersonRef | null;
  subject: { id: string; code: string; name: string } | null;
  class: { id: string; code: string; name: string } | null;
  division: { id: string; name: string } | null;
}

export const toAssignmentDto = (d: HydratedDocument<ITeachingAssignment>, refs: AssignmentRefs) => ({
  id: d.id as string,
  ...refs,
  academicYearId: d.academicYearId.toString(),
  departmentId: d.departmentId.toString(),
  active: d.active,
  endedAt: d.endedAt ? d.endedAt.toISOString() : null,
});
