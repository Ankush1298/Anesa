# ADR-003: Identity: accounts versus student/employee records

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-007, ADR-020

## Context
A student must remain the same person across section, semester, roll number, email and phone changes.

## Decision
`users` = account/person attributes; `students` and `employees` = role records with their own immutable UUIDv7 ids. All academic facts reference `student_id`. Admission number is tenant-unique and format-configurable; roll number lives on term enrollment; registration/other IDs in `student_identifiers`. Merge of duplicates via audited tombstone; anonymisation keeps academic facts.

## Options considered
Single users table with type column; separate persons table; accounts plus role records.

## Consequences
Clean history and flexible login; more joins; merge and anonymisation procedures must be implemented and tested.

## Amendment 1 (X1, migration `0016`): a user holds a student record or an employee record, not both
- **Date:** 2026-10-13
- **Decision:** Within one organization an account (`users` row) may have a `students` row **or** an `employees` row, never both. `actor_kind` is derived from the students mapping, so an account with both would act as a STUDENT and could never use its staff permissions. The rule is enforced in the database by one `SECURITY INVOKER` trigger function (`app.enforce_person_record_exclusive`) on `BEFORE INSERT` of both tables and `BEFORE UPDATE OF user_id` of students. It serialises writers per `(organization_id, user_id)` with a transaction-scoped advisory lock, then checks the other table. Violation: SQLSTATE `23P01`, constraint name `person_record_exclusive`.
- **Why not a constraint:** PostgreSQL cannot express a cross-table exclusion as a declarative constraint; a shared "person role" table would restructure two shipped tables and was out of scope.
- **Limitations:** correct under `READ COMMITTED` only; forward-only (existing rows are not validated); bypassed by a superuser, `session_replication_role = replica` or dropping the trigger; the INVOKER design relies on every permitted writer being a STAFF actor in the tenant (the only context that sees both tables under RLS). Since migration `0017` the runtime role cannot update `students.user_id`, so the `UPDATE OF user_id` path is reachable only by privileged sessions (defence in depth). Details: `docs/architecture/v3/20-employees.md` §3.1.
