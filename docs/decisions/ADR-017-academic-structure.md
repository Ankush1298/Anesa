# ADR-017: Configurable academic structure

- **Status:** Accepted (freeze candidate, v3.1)
- **Date:** 2026-10-08
- **Related:** ADR-007

## Context
Colleges differ in semesters, trimesters, annual systems, program lengths, electives, labs, projects and internships.

## Decision
Period types are data (labels), terms are calendar windows with free codes per campus, programs define duration in periods, cohorts map to terms through cohort_periods, curriculum_courses prescribe by regulation, elective_groups define choice rules, course offerings are separate from enrollment, and course registrations are separate from term enrollment so students may hold different course sets. Terminology is display configuration.

## Options considered
Hard-coded semester model; fully generic hierarchy; configurable period/term/cohort model.

## Consequences
Supports semester/trimester/annual/year systems and electives without schema change; some joint-degree cases deferred.

## Amendment (2026-10-10): F2.1 foundation (campuses, departments, typed role scopes)
Migrations 0008 (expand) and 0009 (contract) add `app.campuses`, `app.departments` and typed
`role_assignments.campus_id` / `department_id` that must agree with `scope_id`. A campus carries a **required** IANA
timezone that is fixed after creation; it is validated on the server against the tz database (never defaulted to UTC).
Schema, privileges, locking order, timezone policy and rollout: `docs/architecture/v3/18-academic-structure-f21.md`.
