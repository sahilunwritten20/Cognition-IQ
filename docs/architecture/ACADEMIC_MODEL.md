# Academic model (Step 3a)

College -> Department -> Academic Year -> Class -> Division; Subjects belong to a Department.
Every record carries `collegeId`; classes, divisions, enrollments and assignments also carry
`departmentId` and `academicYearId`, **derived from the parent record, never from the client**.

| Collection | Key rules (enforced by MongoDB unique indexes) |
|---|---|
| departments | unique `(collegeId, code)` |
| academicyears | unique `(collegeId, label)`; at most one `isCurrent` per college (partial unique index) |
| schoolclasses | unique `(collegeId, academicYearId, departmentId, code)` |
| divisions | unique `(classId, name)` |
| subjects | unique `(collegeId, departmentId, code)` |
| enrollments | unique `(studentId, academicYearId)` (D-14); unique `(college, year, class, division, rollNo)` |
| teachingassignments | unique `(teacher, subject, class, division, year)` **while `active`**; revoking keeps history |

## Behaviour
- **Nothing is hard-deleted.** "Archive" hides a record from default lists but keeps history.
  Archiving is blocked while children are active (e.g. a class with active divisions, a subject or
  division with an active teaching assignment, the current academic year).
- **Enrollment history**: an enrollment belongs to one academic year. A new year is a *new* enrollment;
  within a year only the division or roll number can be corrected (audited with before/after).
- **Teaching assignment rules**: teacher must be an active TEACHER whose `departmentId` equals the
  class's department; the subject must belong to the same department; the division must belong to the class.
  Link staff to a department with `PATCH /academics/staff/:id/department` first.
- **HOD scope**: a HOD reads only their own department; a query for another department is ignored (not
  an error and not a leak). A HOD with no department assigned gets 403.
- **Reserved codes**: archived records keep their code reserved (unique index covers archived rows).

## Not yet built
Bulk CSV import and credential export (Step 3b), year rollover (R3), cross-listed/elective subjects (D-14).
