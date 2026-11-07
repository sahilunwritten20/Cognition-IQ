import { z } from 'zod';
import { objectIdSchema as id } from '../../common/validate';

// .strict() everywhere: scope fields such as collegeId/departmentId are derived on the server,
// so a client that sends them gets a 400 instead of being silently trusted.
const code = z
  .string()
  .trim()
  .min(2)
  .max(20)
  .regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, - and _ only')
  .transform((s) => s.toUpperCase());
const name = z.string().trim().min(2).max(120);

const listShape = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25), // bounded: never "return everything"
  includeArchived: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
};
const list = <S extends z.ZodRawShape>(extra: S) => z.object({ ...listShape, ...extra }).strict();

export const departmentList = list({});
export const yearList = list({});
export const classList = list({ departmentId: id.optional(), academicYearId: id.optional() });
export const divisionList = list({ classId: id.optional() });
export const subjectList = list({ departmentId: id.optional() });
export const enrollmentList = list({
  academicYearId: id.optional(),
  classId: id.optional(),
  divisionId: id.optional(),
  studentId: id.optional(),
});
export const assignmentList = z
  .object({
    page: listShape.page,
    pageSize: listShape.pageSize,
    includeInactive: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    teacherId: id.optional(),
    subjectId: id.optional(),
    classId: id.optional(),
    divisionId: id.optional(),
    academicYearId: id.optional(),
  })
  .strict();

export const createDepartmentBody = z.object({ name, code }).strict();
export const updateNameBody = z.object({ name }).strict();

const dates = { startDate: z.coerce.date(), endDate: z.coerce.date() };
const orderedDates = (v: { startDate: Date; endDate: Date }) => v.endDate > v.startDate;
export const createYearBody = z
  .object({ label: z.string().trim().min(4).max(20), ...dates })
  .strict()
  .refine(orderedDates, { message: 'endDate must be after startDate', path: ['endDate'] });
export const updateYearBody = z
  .object(dates)
  .strict()
  .refine(orderedDates, { message: 'endDate must be after startDate', path: ['endDate'] });

export const createClassBody = z.object({ departmentId: id, academicYearId: id, name, code }).strict();
export const createDivisionBody = z
  .object({ classId: id, name: z.string().trim().min(1).max(20) })
  .strict();
export const updateDivisionBody = z.object({ name: z.string().trim().min(1).max(20) }).strict();
export const createSubjectBody = z.object({ departmentId: id, name, code }).strict();

const rollNo = z.string().trim().min(1).max(30);
export const createEnrollmentBody = z
  .object({ studentId: id, classId: id, divisionId: id, rollNo })
  .strict();
export const updateEnrollmentBody = z
  .object({ divisionId: id.optional(), rollNo: rollNo.optional() })
  .strict()
  .refine((v) => v.divisionId !== undefined || v.rollNo !== undefined, { message: 'nothing to update' });

export const createAssignmentBody = z
  .object({ teacherId: id, subjectId: id, classId: id, divisionId: id })
  .strict();

export const staffDepartmentBody = z.object({ departmentId: id.nullable() }).strict();

export type ListQuery = { page: number; pageSize: number; includeArchived: boolean };
