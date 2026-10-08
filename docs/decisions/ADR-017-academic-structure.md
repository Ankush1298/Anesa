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
