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
