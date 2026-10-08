# Smart Campus OS — Complete Product & Architecture Specification

> **Document Status:** Draft v1.0 — Pending Founder Review  
> **Date:** October 2026  
> **Classification:** Confidential — Internal Architecture

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Product Vision](#2-product-vision)
3. [User Personas](#3-user-personas)
4. [Product Requirements](#4-product-requirements)
5. [MVP Definition](#5-mvp-definition)
6. [Domain Model](#6-domain-model)
7. [System Architecture](#7-system-architecture)
8. [Database Architecture](#8-database-architecture)
9. [Role & Permission Model](#9-role--permission-model)
10. [Application Flows](#10-application-flows)
11. [Service Request Engine](#11-service-request-engine)
12. [Helpdesk Architecture](#12-helpdesk-architecture)
13. [AI Architecture](#13-ai-architecture)
14. [API Strategy](#14-api-strategy)
15. [UI/UX Design System](#15-uiux-design-system)
16. [Security Architecture](#16-security-architecture)
17. [Technology Stack](#17-technology-stack)
18. [Repository Structure](#18-repository-structure)
19. [Development Roadmap](#19-development-roadmap)
20. [Risks](#20-risks)
21. [Recommended First Milestone](#21-recommended-first-milestone)
22. [Questions & Decisions Requiring Approval](#22-questions--decisions-requiring-approval)
23. [What I Should Do Next](#what-i-should-do-next)

---

## 1. Executive Summary

Smart Campus OS is a modular, production-grade digital operating system for colleges and universities. Its foundational premise is simple: **every routine interaction between a student and their institution should be possible without a physical visit to any administrative office.**

The platform is designed as a **modular monolith** that evolves incrementally over ten phases — from core authentication and people management, through academic ERP and digital student services, to an AI assistant that acts as an intelligent interface to the entire system.

**Key architectural bets:**

| Decision | Choice | Rationale |
|---|---|---|
| Backend | Node.js (TypeScript) + Fastify | Speed of development, type safety, large ecosystem |
| Database | PostgreSQL | Relational integrity, JSON support, extensions |
| Frontend | Next.js (React) | SSR/SSG, App Router, full-stack capability |
| Mobile | React Native (Expo) | Code sharing with web, fast iteration |
| Architecture | Modular Monolith | Right size for early stage, extractable later |
| AI | Tool-calling over controlled APIs | Security and auditability |
| Auth | JWT + Refresh Tokens + optional OIDC | Standard, extensible |

**MVP target:** A single college deployment covering authentication, academic structure, attendance, student dashboard, and service requests — in approximately 20 weeks with a team of 3–5 engineers.

---

## 2. Product Vision

### 2.1 Vision Statement

> **"Ask the campus. Get the answer. Complete the task."**

Smart Campus OS transforms the university administration experience from a series of physical, manual, and opaque processes into a unified, digital, intelligent operating system — accessible from any device, at any time, by every member of the institution.

### 2.2 Problem Statement

Today, students in most colleges experience:

- **Information asymmetry** — They don't know where to go, who to ask, or what the status of their request is.
- **Physical bottlenecks** — Routine tasks require in-person visits to multiple departments.
- **Process opacity** — Requests are submitted informally (email, WhatsApp) with no tracking or SLA.
- **Fragmented tools** — Attendance is one app, results are another website, fee payment is a third portal — none of them connected.
- **No accountability** — When something goes wrong (incorrect marks, wrong attendance, delayed certificates), there is no formal mechanism to raise, track, and resolve it.

The same problems affect faculty (manual attendance, no unified class management), HODs (no visibility into department health), and administrators (manual reporting, no audit trail).

### 2.3 Long-Term Opportunity

A complete Campus OS is one of the highest-value SaaS opportunities in the EdTech infrastructure space:

- High switching costs once embedded in institutional workflows
- Network effects across students, faculty, and administration
- Data assets that enable AI-powered analytics and insights
- Applicable globally to thousands of colleges and universities

### 2.4 Strategic Principles

1. **Correctness over features** — A system students trust is worth more than a system with more features.
2. **One product, not a dashboard collection** — Every surface must feel like the same product.
3. **API-first** — Everything the UI does, the API supports. Everything the AI does, the API supports.
4. **Build for the small college first** — If it works for a 500-student college, it will scale to 50,000.
5. **Privacy and security are non-negotiable** — Students' academic records are sensitive data.

---

## 3. User Personas

### Persona 1 — Aanya (Student, 19)

> BSc Computer Science, 2nd year, lives on campus

**Goals:** Check attendance, know exam schedules, get documents (bonafide, ID card), understand fee dues, get answers quickly without visiting offices.

**Frustrations:** Has to visit three departments to get one document. Doesn't know the status of submitted forms. Gets different answers from different staff.

**Device:** Primarily smartphone (Android). Occasionally laptop.

**Tech comfort:** High. Uses apps daily.

---

### Persona 2 — Dr. Ramesh (Faculty, 42)

> Professor of Electronics, teaches 4 subjects across 3 batches

**Goals:** Mark attendance quickly after class, view his class roster, upload assignments, submit marks, handle student requests efficiently.

**Frustrations:** Paper attendance is tedious and error-prone. Getting interrupted for corrections wastes time. No central place to see all his responsibilities.

**Device:** Smartphone and desktop/laptop.

**Tech comfort:** Moderate. Prefers simple, fast interfaces.

---

### Persona 3 — Mrs. Sharma (HOD, 51)

> Head of Department, Electrical Engineering, 30 faculty, 800 students

**Goals:** Department-wide attendance overview, know which students are at risk, see pending requests, monitor faculty workload.

**Frustrations:** Gets data from multiple spreadsheets. Doesn't know about student issues until they escalate. Monthly reports take days to compile manually.

**Device:** Primarily desktop/laptop.

**Tech comfort:** Moderate. Comfortable with web-based tools.

---

### Persona 4 — Vikram (College Admin, 38)

> Registrar's office, manages academic structure, admissions, and reporting

**Goals:** Configure academic years, manage enrollments, generate official reports, manage user access, handle escalated requests.

**Frustrations:** Repetitive data entry. Inconsistent data across systems. Can't easily find which department handled what.

**Device:** Desktop.

**Tech comfort:** Moderate–High. Has used ERPs before.

---

### Persona 5 — Priya (Finance Staff, 35)

> Manages fee collection, dues, receipts, scholarship processing

**Goals:** Track student fee status, issue receipts, process scholarships, generate financial reports.

**Frustrations:** Students don't know their exact dues. Lots of manual reconciliation.

**Device:** Desktop.

**Tech comfort:** Moderate.

---

### Persona 6 — Rohit (Parent, 48)

> Parent of a student, lives in another city

**Goals:** View son's attendance, know exam schedule, receive important notifications, pay fees online.

**Frustrations:** Has no visibility. Gets information only when his son tells him.

**Device:** Smartphone.

**Tech comfort:** Low–moderate.

---

## 4. Product Requirements

### 4.1 Functional Requirements by Module

#### Authentication & Users
- Email/password login with secure password hashing
- Role-based access control
- Permission-based fine-grained authorization
- Multi-organization support (multi-campus)
- Session management with refresh tokens
- Password reset via email
- Optional: SSO via institutional email (OIDC/SAML)
- Optional: MFA for admin roles

#### Academic Structure
- Organization → Campus → Department → Program → Batch → Semester → Section
- Subject catalog with credits, types, and faculty assignment
- Academic year and calendar management
- Enrollment management (linking students to sections/subjects)

#### People Management
- Student profiles with full academic history
- Faculty profiles with department and subject assignments
- Staff profiles with role assignments
- Parent/guardian linkage
- Unified search across people

#### Attendance
- Faculty marks attendance per class session
- Student views their own attendance
- Attendance summary by subject and overall
- At-risk alerts (below threshold)
- Attendance correction request workflow
- HOD/Admin attendance reports
- Export to PDF/Excel

#### Service Requests
- Configurable request types (bonafide, ID card, attendance correction, etc.)
- Multi-step approval workflows
- Status tracking with history
- Email/push notifications at each stage
- SLA tracking
- Documents attached to requests

#### Helpdesk
- Students/faculty raise tickets
- Categories and departments
- Priority levels
- Assignment to staff
- Conversation threads
- Escalation rules
- Feedback after resolution

#### Notifications
- In-app notifications
- Email notifications
- Push notifications (mobile)
- Notification preferences per user

#### AI Assistant (Phase 7)
- Natural language queries about personal data
- Policy and procedure lookup
- Create service requests via conversation
- Check request/ticket status
- AI actions audited and scoped

### 4.2 Non-Functional Requirements

| Requirement | Target |
|---|---|
| API response time (p95) | < 300ms |
| Page load time (LCP) | < 2.5s |
| Availability | 99.5% (single campus, can tolerate maintenance windows) |
| Concurrent users | 5,000 per campus (Phase 1 target) |
| Data isolation | Strict tenant-level isolation |
| Audit trail | All sensitive mutations logged |
| GDPR/data privacy | Soft-delete, export capability |
| Mobile responsiveness | Student app: mobile-first |
| Accessibility | WCAG 2.1 AA |

### 4.3 Non-Goals (Explicitly Out of Scope for v1)

- Building a Learning Management System (LMS) to compete with Moodle/Canvas
- Video conferencing or live lecture streaming
- Alumni management
- Research management
- Accreditation-specific reporting tools (can be added later as reports)
- Public-facing college website / CMS
- Native iOS/Android app in Phase 1 (PWA first, native later)
- AI assistant in Phase 1

### 4.4 Success Metrics

| Metric | Target (First Year) |
|---|---|
| Service requests resolved digitally | > 80% |
| Avg. request resolution time | < 48 hours (vs. current 5–10 days) |
| Student attendance accuracy disputes | < 2% of sessions |
| Daily active users (students) | > 60% of enrolled students |
| Support tickets requiring physical visit | < 10% |
| Admin report generation time | < 5 minutes (vs. hours manually) |
| NPS from students | > 40 |
| NPS from faculty | > 30 |

---

## 5. MVP Definition

### 5.1 What is the MVP?

The MVP is the **minimum system that can realistically replace the physical visit** for the most common student interactions at a single college.

**MVP scope:**

| Module | Included in MVP |
|---|---|
| Authentication | ✅ Email/password, roles, permissions |
| Organization & Campus | ✅ Single campus |
| Departments | ✅ |
| Programs & Batches | ✅ |
| Semesters & Sections | ✅ |
| Subjects | ✅ |
| Student Profiles | ✅ |
| Faculty Profiles | ✅ |
| Enrollment | ✅ |
| Attendance (Faculty) | ✅ Mark attendance per session |
| Attendance (Student) | ✅ View own attendance |
| Timetable | ✅ Basic view |
| Service Requests | ✅ Bonafide, ID Card, Attendance Correction |
| Notifications | ✅ In-app + email |
| Basic Helpdesk | ✅ Ticket creation, assignment, status |
| Student Dashboard | ✅ Attendance, timetable, requests |
| Faculty Dashboard | ✅ Classes, attendance marking |
| Admin Panel | ✅ User management, structure, reports |
| Fees | ❌ Phase 8 |
| Exams & Results | ❌ Phase 4 |
| AI Assistant | ❌ Phase 7 |
| Library/Hostel/Transport | ❌ Phase 9 |
| Mobile App (native) | ❌ PWA first |
| Advanced Analytics | ❌ Phase 10 |
| Multi-campus | ❌ Architecture supports it, UI not exposed |

### 5.2 MVP Definition of Done

A college can:
1. Import or manually create all students, faculty, departments, programs, batches, semesters, sections, and subjects
2. Faculty can log in and mark daily attendance for each class session
3. Students can log in and view their attendance
4. Students can submit bonafide, ID card, and attendance correction requests
5. Admins and department staff can review and process requests
6. Students receive email notifications when their requests are processed
7. HOD can view department attendance summary
8. Admin can export basic attendance reports

### 5.3 What We Are Explicitly Postponing

- Fee management — complex, payment gateway integration, compliance
- Examination & results — needs exam configuration, mark entry, grade calculation
- AI assistant — must be built on top of complete API surface
- Native mobile apps — PWA covers MVP; native adds significant cost
- Advanced analytics and dashboards
- Parent portal (architecture supports it, not exposed in MVP)
- Multi-campus management UI
- SAML/SSO integration (architecture supports it)
- Library, Hostel, Transport modules

---

## 6. Domain Model

### 6.1 Entity Overview

```
Organization
  └── Campus (1..*)
        └── Department (1..*)
              ├── Program (1..*)
              │     └── Batch (1..*)
              │           └── Semester (1..*)
              │                 └── Section (1..*)
              │                       └── Enrollment (students in section)
              ├── Subject (1..*)
              │     └── SubjectOffering (subject in a semester + section + faculty)
              └── Staff / Faculty
```

### 6.2 Entity Definitions

---

#### Organization
> **Purpose:** Top-level entity. Represents the educational institution (university, college trust, group of colleges).

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| name | string | Official name |
| slug | string | URL-safe identifier, unique |
| domain | string | Email domain for SSO |
| logo_url | string | Object storage reference |
| settings | jsonb | Configurable defaults |
| created_at | timestamp | |
| updated_at | timestamp | |

**Relationships:** Has many Campuses, has many Users (via org membership).  
**Lifecycle:** Created once during onboarding. Rarely modified.  
**Permissions:** Only Super Admin can create/modify Organizations.

---

#### Campus
> **Purpose:** A physical or logical campus of the organization.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| organization_id | UUID | FK → Organization |
| name | string | |
| code | string | Short code (e.g., "MAIN", "NORTH") |
| address | jsonb | Street, city, state, pin |
| is_active | boolean | |
| created_at | timestamp | |

**Relationships:** Belongs to Organization. Has many Departments.  
**Lifecycle:** Created during setup. Can be deactivated.  
**Notes:** All data is campus-scoped. Multi-campus isolation is at this level.

---

#### Department
> **Purpose:** Academic or administrative department.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| campus_id | UUID | FK → Campus |
| name | string | "Computer Science", "Electronics" |
| code | string | "CS", "EC" |
| type | enum | ACADEMIC, ADMINISTRATIVE |
| head_user_id | UUID | FK → User (HOD) |
| is_active | boolean | |

**Relationships:** Has many Programs, Subjects, Staff, Faculty.

---

#### Program
> **Purpose:** A degree program offered by a department.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| department_id | UUID | FK → Department |
| name | string | "B.Tech Computer Science" |
| code | string | "BTCS" |
| degree_type | enum | BACHELOR, MASTER, PHD, DIPLOMA |
| duration_years | integer | |
| is_active | boolean | |

---

#### Batch
> **Purpose:** A cohort of students admitted to a program in a specific year.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| program_id | UUID | FK → Program |
| name | string | "2023–2027" |
| admission_year | integer | 2023 |
| graduation_year | integer | 2027 |
| is_active | boolean | |

**Lifecycle:** Created at admission time. Immutable once finalized.

---

#### Semester
> **Purpose:** A specific semester of a batch (Semester 1, 2, ... N).

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| batch_id | UUID | FK → Batch |
| name | string | "Semester 3" |
| number | integer | 1–8 |
| start_date | date | |
| end_date | date | |
| is_current | boolean | Only one per batch at a time |
| is_locked | boolean | Marks/attendance frozen after semester end |

**Lifecycle:** Created before each semester starts. Locked after end.  
**Important:** `is_locked` prevents mutations to attendance/marks from non-admin users.

---

#### Section
> **Purpose:** A subdivision of a batch's semester (e.g., Section A, B, C).

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| semester_id | UUID | FK → Semester |
| name | string | "A", "B" |
| max_strength | integer | |
| created_at | timestamp | |

---

#### Subject
> **Purpose:** A subject definition in the academic catalog.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| department_id | UUID | FK → Department |
| name | string | "Data Structures" |
| code | string | "CS301" |
| credits | decimal | |
| type | enum | THEORY, PRACTICAL, ELECTIVE |
| is_active | boolean | |

**Note:** Subject is a definition. `SubjectOffering` is its instance in a specific semester/section.

---

#### SubjectOffering
> **Purpose:** Links a subject to a specific section/semester/faculty. This is what students attend.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| subject_id | UUID | FK → Subject |
| section_id | UUID | FK → Section |
| faculty_user_id | UUID | FK → User |
| academic_year | string | "2024–25" |
| is_active | boolean | |

**This is the central entity for attendance, assignments, and marks.**

---

#### User
> **Purpose:** Single unified user table. Every person in the system is a User.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| organization_id | UUID | FK → Organization |
| email | string | Unique within org |
| phone | string | Optional |
| password_hash | string | bcrypt |
| first_name | string | |
| last_name | string | |
| avatar_url | string | |
| is_active | boolean | |
| is_email_verified | boolean | |
| last_login_at | timestamp | |
| created_at | timestamp | |

**One User record per person. Their role in the system is determined by UserRole assignments.**

---

#### UserRole
> **Purpose:** Assigns one or more roles to a user, scoped to an organization (and optionally campus/department).

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| user_id | UUID | FK → User |
| role_id | UUID | FK → Role |
| organization_id | UUID | FK → Organization |
| campus_id | UUID | Optional scope |
| department_id | UUID | Optional scope |
| is_active | boolean | |

---

#### StudentProfile
> **Purpose:** Academic profile of a student. Extends User with student-specific data.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| user_id | UUID | FK → User, unique |
| organization_id | UUID | FK → Organization |
| enrollment_number | string | Unique |
| admission_date | date | |
| current_batch_id | UUID | FK → Batch |
| current_section_id | UUID | FK → Section |
| guardian_name | string | |
| guardian_phone | string | |
| blood_group | string | |
| address | jsonb | |
| profile_completed_at | timestamp | |

---

#### FacultyProfile
> **Purpose:** Academic profile of a faculty member.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| user_id | UUID | FK → User, unique |
| organization_id | UUID | FK → Organization |
| employee_id | string | Unique |
| department_id | UUID | FK → Department |
| designation | string | "Assistant Professor" |
| joining_date | date | |
| qualification | string | |
| specialization | string | |

---

#### Enrollment
> **Purpose:** Links a student to a specific Section for a Semester.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| student_user_id | UUID | FK → User |
| section_id | UUID | FK → Section |
| semester_id | UUID | FK → Semester |
| enrolled_at | date | |
| status | enum | ACTIVE, DROPPED, TRANSFERRED |

---

#### ClassSession
> **Purpose:** A specific scheduled class meeting for a SubjectOffering.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| subject_offering_id | UUID | FK → SubjectOffering |
| scheduled_at | timestamp | |
| duration_minutes | integer | |
| topic | string | Optional |
| is_extra | boolean | Extra class? |
| created_by_user_id | UUID | FK → User |

---

#### AttendanceRecord
> **Purpose:** Attendance of a specific student in a specific class session.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| class_session_id | UUID | FK → ClassSession |
| student_user_id | UUID | FK → User |
| subject_offering_id | UUID | Denormalized for fast queries |
| status | enum | PRESENT, ABSENT, LATE, EXCUSED |
| marked_by_user_id | UUID | FK → User (faculty) |
| marked_at | timestamp | |
| is_corrected | boolean | Was this corrected after marking? |
| correction_reason | string | |

**Immutable after semester lock. Corrections go through `AttendanceCorrectionRequest`.**

---

#### Timetable / TimeSlot
> **Purpose:** Scheduled time for a SubjectOffering session.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| subject_offering_id | UUID | FK → SubjectOffering |
| day_of_week | enum | MON..SUN |
| start_time | time | |
| end_time | time | |
| room | string | |
| effective_from | date | |
| effective_to | date | |

---

#### Notification
> **Purpose:** In-app notification record.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| recipient_user_id | UUID | FK → User |
| type | string | "attendance.at_risk", "request.approved" |
| title | string | |
| body | string | |
| data | jsonb | Contextual data |
| is_read | boolean | |
| read_at | timestamp | |
| created_at | timestamp | |

---

#### AuditLog
> **Purpose:** Immutable record of all important system mutations.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| organization_id | UUID | |
| actor_user_id | UUID | Who did it |
| actor_type | enum | USER, SYSTEM, AI |
| action | string | "attendance.mark", "request.approve" |
| entity_type | string | "AttendanceRecord" |
| entity_id | UUID | |
| old_value | jsonb | Before state |
| new_value | jsonb | After state |
| ip_address | inet | |
| user_agent | string | |
| created_at | timestamp | |

---

### 6.3 Service Request Domain

See Section 11 for the complete Service Request domain model.

### 6.4 Helpdesk Domain

See Section 12 for the complete Helpdesk domain model.

---

## 7. System Architecture

### 7.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                     CLIENT LAYER                         │
│  Next.js Web App    │    React Native (Expo) Mobile      │
│  (Admin, Faculty,   │    (Students, Faculty)              │
│   HOD, Student)     │                                     │
└──────────────────────────────┬──────────────────────────┘
                               │ HTTPS / REST API
                               │
┌──────────────────────────────▼──────────────────────────┐
│                      API GATEWAY                         │
│         (Rate limiting, Auth, Routing)                   │
│              [Nginx / Caddy reverse proxy]               │
└──────────────────────────────┬──────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────┐
│                   BACKEND APPLICATION                    │
│              Node.js + TypeScript + Fastify              │
│                                                          │
│  ┌───────────┐  ┌───────────┐  ┌───────────────────┐    │
│  │  Auth     │  │  People   │  │  Academic         │    │
│  │  Module   │  │  Module   │  │  Module           │    │
│  └───────────┘  └───────────┘  └───────────────────┘    │
│  ┌───────────┐  ┌───────────┐  ┌───────────────────┐    │
│  │Attendance │  │ Service   │  │   Helpdesk        │    │
│  │  Module   │  │ Requests  │  │   Module          │    │
│  └───────────┘  └───────────┘  └───────────────────┘    │
│  ┌───────────┐  ┌───────────┐  ┌───────────────────┐    │
│  │Notif.     │  │  Audit    │  │   AI Module       │    │
│  │  Module   │  │  Module   │  │   (Phase 7)       │    │
│  └───────────┘  └───────────┘  └───────────────────┘    │
│                                                          │
│              Shared: DB Layer, Queue, Cache              │
└──────┬───────────────────┬──────────────────────────────┘
       │                   │
┌──────▼──────┐    ┌───────▼─────┐    ┌────────────────┐
│ PostgreSQL  │    │    Redis    │    │  Object Storage│
│  (Primary)  │    │  (Cache +   │    │  (S3 / R2)     │
│             │    │   Queue)    │    │                │
└─────────────┘    └─────────────┘    └────────────────┘
       │
┌──────▼──────────────────────────────────────────────────┐
│                   BACKGROUND WORKERS                    │
│     (BullMQ Workers: Email, Push, Reports, AI jobs)     │
└─────────────────────────────────────────────────────────┘
```

### 7.2 Frontend Architecture

**Framework:** Next.js 14+ with App Router

**Why Next.js:**
- Full-stack capability (API routes for BFF patterns if needed)
- SSR for SEO on public-facing pages
- Static generation for policy/help content
- Strong TypeScript support
- Large ecosystem and community

**App Structure (Next.js):**
```
/app
  /(auth)           — Login, forgot password, reset
  /(student)        — Student-facing experience (mobile-first)
  /(faculty)        — Faculty-facing experience
  /(admin)          — Admin panel
  /(hod)            — HOD dashboard
```

**Design system:** Custom component library using Radix UI primitives + custom CSS. See Section 15.

**State management:**
- Server state: TanStack Query (React Query) — handles caching, loading, errors
- Local UI state: Zustand (lightweight, no boilerplate)
- Form state: React Hook Form + Zod

**Why not Redux:** Overkill for this application's state complexity. TanStack Query covers 80% of state needs (server state), Zustand covers the rest.

### 7.3 Backend Architecture

**Framework:** Fastify + TypeScript

**Why Fastify over Express:**
- 2–3x faster throughput
- First-class TypeScript + schema validation (JSON Schema → Zod)
- Plugin architecture matches our modular design
- Built-in request/response serialization

**Why not NestJS:** NestJS adds significant complexity (decorators, DI containers, module bootstrap) for questionable benefit in early stages. Fastify with a custom module structure gives us the same modularity without the overhead.

**Module structure:**
```
src/
  modules/
    auth/
    people/
    academic/
    attendance/
    service-requests/
    helpdesk/
    notifications/
    audit/
    ai/           (Phase 7)
  shared/
    database/
    queue/
    cache/
    storage/
    errors/
    middleware/
```

**Each module contains:**
```
module-name/
  routes.ts       — Fastify route registration
  service.ts      — Business logic
  repository.ts   — Database queries
  schema.ts       — Request/response validation schemas
  types.ts        — TypeScript interfaces
  errors.ts       — Module-specific errors
```

### 7.4 Database Architecture

**Primary:** PostgreSQL 15+

**Why PostgreSQL:**
- ACID compliance — critical for academic records
- Rich data types (JSONB, arrays, ranges)
- Row-Level Security for multi-tenancy
- Full-text search (avoids Elasticsearch in early stages)
- Excellent TypeScript ORMs (Drizzle, Prisma)
- Extensions: `uuid-ossp`, `pgcrypto`, `pg_trgm` (fuzzy search)

**ORM:** Drizzle ORM

**Why Drizzle over Prisma:**
- Drizzle generates pure SQL — no magic, predictable queries
- Better performance (no N+1 footguns from abstraction)
- TypeScript-native schema definition
- Easier raw SQL escapes when needed
- Migration files are readable SQL

**Why not a query builder only (Knex):** Type safety at the schema level is essential for a team building a complex domain model.

### 7.5 Authentication

**Strategy:** JWT (Access Token) + Refresh Token stored in HttpOnly cookie

**Flow:**
1. User submits credentials
2. Backend verifies, issues short-lived JWT (15 min) + long-lived refresh token (7 days)
3. JWT stored in memory (Zustand/React state), refresh token in HttpOnly cookie
4. Every API call includes JWT in `Authorization: Bearer` header
5. On JWT expiry, client transparently calls `/auth/refresh`
6. Refresh token rotation on each use

**Why not sessions:** JWTs work well for mobile apps and are stateless — easier to scale. We mitigate JWT weaknesses (can't revoke) by using short expiry + refresh token rotation.

**Future:** Support SAML 2.0 and OIDC for institutional SSO (Google Workspace, Microsoft 365). Architecture uses an `auth_provider` table to support multiple providers.

### 7.6 Authorization

**Strategy:** Role-Based Access Control (RBAC) + Attribute-Based Access Control (ABAC) hybrid.

Roles define groups of permissions. Permissions are fine-grained strings.

**Authorization middleware checks:**
1. Is the JWT valid? (authentication)
2. Does the user have the required permission? (authorization)
3. Does the resource belong to this user's organization/campus? (data isolation)
4. For student data: does this student belong to the faculty member's section? (contextual authorization)

**Implementation:** Custom `authorize` middleware attached to each route.

```typescript
// Example route definition
fastify.get('/attendance/my', {
  preHandler: [authenticate, authorize('attendance.read.own')]
}, getMyAttendanceHandler)

fastify.post('/attendance/session/:id/mark', {
  preHandler: [authenticate, authorize('attendance.mark')]
}, markAttendanceHandler)
```

### 7.7 File Storage

**Strategy:** Object storage (S3-compatible)

**For cloud deployments:** AWS S3 or Cloudflare R2 (cheaper egress)  
**For on-premise deployments:** MinIO (self-hosted S3-compatible)

**Why object storage over filesystem:**
- Scales independently of compute
- Durable and redundant
- Can generate pre-signed URLs for secure direct access
- Works across multiple server instances

**File categories:**
- Profile photos
- Service request attachments
- Helpdesk ticket attachments
- Assignment submissions (Phase 4)
- Generated PDFs (bonafide certificates, report cards)

**Security:** Files are never publicly accessible by default. Pre-signed URLs with expiry (15 min) are generated per request after authorization check.

### 7.8 Notifications

**Multi-channel notification system:**

| Channel | Use case |
|---|---|
| In-app | All notifications (primary) |
| Email | Request updates, important alerts, account events |
| Push (web/mobile) | Real-time alerts (Phase 2+) |
| SMS | Critical alerts only (optional, expensive) |

**Architecture:**
- Notification events published to BullMQ queue
- Notification worker processes queue
- Dispatches to appropriate channel(s) based on user preferences
- All notifications stored in `notifications` table for in-app display

### 7.9 Background Jobs

**System:** BullMQ (Redis-backed queue)

**Job types:**
- Email sending (Resend / SMTP)
- Push notification sending (FCM / APNs via Expo)
- PDF generation (for certificates, reports)
- Attendance summary calculation
- SLA breach checking (helpdesk)
- Audit log flush

**Why BullMQ over cron jobs:** Retries, dead-letter queues, priority, delayed execution, monitoring (Bull Board).

### 7.10 Search

**Phase 1–2:** PostgreSQL full-text search using `pg_trgm` extension. Covers: People search, subject search, request search.

**Phase 5+:** Evaluate Typesense or Meilisearch if search volume/complexity grows. These are lightweight, self-hostable, and free.

**Why not Elasticsearch:** Massive operational overhead for early-stage product. PostgreSQL FTS is sufficient until 100K+ records.

### 7.11 Logging & Monitoring

**Application logging:** Pino (structured JSON logging, built into Fastify)

**Error tracking:** Sentry

**Metrics:** OpenTelemetry → Grafana + Prometheus (for self-hosted) or Grafana Cloud

**Log aggregation:** Loki (self-hosted) or CloudWatch/Datadog (cloud)

**Uptime monitoring:** Better Uptime or UptimeRobot

**Why not just console.log:** Structured logs are essential for production debugging. Pino has near-zero performance overhead.

### 7.12 Audit System

Every module that performs a sensitive mutation calls the audit service:

```typescript
await auditService.log({
  actorUserId: req.user.id,
  actorType: 'USER',
  action: 'attendance.correct',
  entityType: 'AttendanceRecord',
  entityId: record.id,
  oldValue: oldRecord,
  newValue: updatedRecord,
  organizationId: req.user.organizationId
})
```

Audit logs are **append-only** in the database. No UPDATE or DELETE on the audit table. A separate partition/archive strategy moves old logs to cold storage.

### 7.13 AI Architecture

See Section 13 for complete AI architecture.

### 7.14 Integration Architecture

**Inbound integrations (future):**
- Payment gateways (Razorpay, Stripe) for fees
- SMS gateways (Twilio, MSG91)
- Push notification services (Firebase FCM, Apple APNs via Expo)
- Institutional SSO (Google, Microsoft via OIDC/SAML)

**Outbound integrations (future):**
- NSDL/DigiLocker for document verification
- National Academic Depository (NAD) for degree verification
- Biometric attendance devices (hardware integration)

**Integration patterns:**
- Webhook receivers for payment callbacks
- Polling for batch imports
- Event-driven for notification triggers

---

## 8. Database Architecture

### 8.1 Design Principles

1. **UUID primary keys** — No sequential IDs exposed externally. Prevents enumeration attacks and works across distributed systems.
2. **created_at / updated_at on every table** — No exceptions.
3. **Soft-delete on people records** — `deleted_at` timestamp. Enrollment history, audit logs, foreign keys must remain intact.
4. **Hard-delete on temporary data** — Notification reads, sessions, temp tokens.
5. **Immutable historical records** — Attendance records, audit logs, exam marks (after lock) are never deleted.
6. **Organization-scoped data** — Every table with campus/user data includes `organization_id` for multi-tenancy.
7. **Indexes on foreign keys and common filter columns** — No exceptions.
8. **JSONB for flexible, infrequently queried data** — Settings, addresses, metadata.

### 8.2 Multi-Tenancy Strategy

**Approach: Shared database, shared schema, with `organization_id` column everywhere**

**Why not separate databases per tenant:**
- Expensive to operate (connection limits, maintenance overhead)
- Harder to query across tenants for analytics

**Why not separate schemas:**
- Schema migrations become complex with many tenants

**Isolation enforcement:**
- Every query is filtered by `organization_id`
- PostgreSQL Row Level Security (RLS) policies as a defense-in-depth layer
- Application-level middleware injects `organization_id` from JWT claims into all queries

### 8.3 Core Tables

```sql
-- organizations
CREATE TABLE organizations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255) NOT NULL,
  slug          VARCHAR(100) NOT NULL UNIQUE,
  domain        VARCHAR(255),
  logo_url      TEXT,
  settings      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- campuses
CREATE TABLE campuses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            VARCHAR(255) NOT NULL,
  code            VARCHAR(20) NOT NULL,
  address         JSONB NOT NULL DEFAULT '{}',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, code)
);

-- departments
CREATE TABLE departments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campus_id       UUID NOT NULL REFERENCES campuses(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            VARCHAR(255) NOT NULL,
  code            VARCHAR(20) NOT NULL,
  type            VARCHAR(30) NOT NULL DEFAULT 'ACADEMIC',
  head_user_id    UUID REFERENCES users(id),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(campus_id, code)
);

-- programs
CREATE TABLE programs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id   UUID NOT NULL REFERENCES departments(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            VARCHAR(255) NOT NULL,
  code            VARCHAR(20) NOT NULL,
  degree_type     VARCHAR(30) NOT NULL,
  duration_years  SMALLINT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(department_id, code)
);

-- batches
CREATE TABLE batches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program_id      UUID NOT NULL REFERENCES programs(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            VARCHAR(100) NOT NULL,
  admission_year  SMALLINT NOT NULL,
  graduation_year SMALLINT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(program_id, admission_year)
);

-- semesters
CREATE TABLE semesters (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        UUID NOT NULL REFERENCES batches(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            VARCHAR(100) NOT NULL,
  number          SMALLINT NOT NULL,
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL,
  is_current      BOOLEAN NOT NULL DEFAULT FALSE,
  is_locked       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(batch_id, number)
);

-- sections
CREATE TABLE sections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  semester_id     UUID NOT NULL REFERENCES semesters(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            VARCHAR(50) NOT NULL,
  max_strength    SMALLINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(semester_id, name)
);

-- subjects
CREATE TABLE subjects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id   UUID NOT NULL REFERENCES departments(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            VARCHAR(255) NOT NULL,
  code            VARCHAR(30) NOT NULL,
  credits         DECIMAL(3,1),
  type            VARCHAR(30) NOT NULL DEFAULT 'THEORY',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, code)
);

-- subject_offerings
CREATE TABLE subject_offerings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id      UUID NOT NULL REFERENCES subjects(id),
  section_id      UUID NOT NULL REFERENCES sections(id),
  faculty_user_id UUID NOT NULL REFERENCES users(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  academic_year   VARCHAR(10) NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(subject_id, section_id, academic_year)
);

-- users
CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL REFERENCES organizations(id),
  email               VARCHAR(255) NOT NULL,
  phone               VARCHAR(20),
  password_hash       VARCHAR(255),
  first_name          VARCHAR(100) NOT NULL,
  last_name           VARCHAR(100) NOT NULL,
  avatar_url          TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  is_email_verified   BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at       TIMESTAMPTZ,
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, email)
);

-- roles
CREATE TABLE roles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id),  -- NULL = system role
  name            VARCHAR(100) NOT NULL,
  description     TEXT,
  is_system       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- permissions
CREATE TABLE permissions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL UNIQUE,  -- e.g., "attendance.mark"
  description TEXT,
  module      VARCHAR(50) NOT NULL
);

-- role_permissions
CREATE TABLE role_permissions (
  role_id       UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

-- user_roles
CREATE TABLE user_roles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id         UUID NOT NULL REFERENCES roles(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  campus_id       UUID REFERENCES campuses(id),
  department_id   UUID REFERENCES departments(id),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  granted_by      UUID REFERENCES users(id),
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ,
  UNIQUE(user_id, role_id, organization_id)
);

-- student_profiles
CREATE TABLE student_profiles (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL UNIQUE REFERENCES users(id),
  organization_id     UUID NOT NULL REFERENCES organizations(id),
  enrollment_number   VARCHAR(50) NOT NULL,
  admission_date      DATE NOT NULL,
  current_batch_id    UUID REFERENCES batches(id),
  current_section_id  UUID REFERENCES sections(id),
  guardian_name       VARCHAR(255),
  guardian_phone      VARCHAR(20),
  blood_group         VARCHAR(10),
  address             JSONB NOT NULL DEFAULT '{}',
  profile_completed_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, enrollment_number)
);

-- faculty_profiles
CREATE TABLE faculty_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL UNIQUE REFERENCES users(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  employee_id     VARCHAR(50) NOT NULL,
  department_id   UUID NOT NULL REFERENCES departments(id),
  designation     VARCHAR(100),
  joining_date    DATE,
  qualification   TEXT,
  specialization  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, employee_id)
);

-- enrollments
CREATE TABLE enrollments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_user_id UUID NOT NULL REFERENCES users(id),
  section_id      UUID NOT NULL REFERENCES sections(id),
  semester_id     UUID NOT NULL REFERENCES semesters(id),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  enrolled_at     DATE NOT NULL DEFAULT CURRENT_DATE,
  status          VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(student_user_id, semester_id)
);

-- class_sessions
CREATE TABLE class_sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_offering_id   UUID NOT NULL REFERENCES subject_offerings(id),
  organization_id       UUID NOT NULL REFERENCES organizations(id),
  scheduled_at          TIMESTAMPTZ NOT NULL,
  duration_minutes      SMALLINT NOT NULL DEFAULT 60,
  topic                 TEXT,
  is_extra              BOOLEAN NOT NULL DEFAULT FALSE,
  attendance_status     VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  created_by_user_id    UUID NOT NULL REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- attendance_records
CREATE TABLE attendance_records (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  class_session_id      UUID NOT NULL REFERENCES class_sessions(id),
  student_user_id       UUID NOT NULL REFERENCES users(id),
  subject_offering_id   UUID NOT NULL REFERENCES subject_offerings(id),
  organization_id       UUID NOT NULL REFERENCES organizations(id),
  status                VARCHAR(20) NOT NULL,  -- PRESENT, ABSENT, LATE, EXCUSED
  marked_by_user_id     UUID NOT NULL REFERENCES users(id),
  marked_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_corrected          BOOLEAN NOT NULL DEFAULT FALSE,
  correction_reason     TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(class_session_id, student_user_id)
);

-- time_slots (timetable)
CREATE TABLE time_slots (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_offering_id   UUID NOT NULL REFERENCES subject_offerings(id),
  organization_id       UUID NOT NULL REFERENCES organizations(id),
  day_of_week           SMALLINT NOT NULL,  -- 0=Sunday, 1=Monday, etc.
  start_time            TIME NOT NULL,
  end_time              TIME NOT NULL,
  room                  VARCHAR(50),
  effective_from        DATE NOT NULL,
  effective_to          DATE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- refresh_tokens
CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(255) NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- password_reset_tokens
CREATE TABLE password_reset_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  VARCHAR(255) NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- notifications
CREATE TABLE notifications (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id),
  recipient_user_id UUID NOT NULL REFERENCES users(id),
  type              VARCHAR(100) NOT NULL,
  title             VARCHAR(255) NOT NULL,
  body              TEXT NOT NULL,
  data              JSONB DEFAULT '{}',
  is_read           BOOLEAN NOT NULL DEFAULT FALSE,
  read_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- audit_logs
CREATE TABLE audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  actor_user_id   UUID REFERENCES users(id),
  actor_type      VARCHAR(20) NOT NULL DEFAULT 'USER',
  action          VARCHAR(100) NOT NULL,
  entity_type     VARCHAR(100),
  entity_id       UUID,
  old_value       JSONB,
  new_value       JSONB,
  ip_address      INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 8.4 Indexes

```sql
-- Performance-critical indexes
CREATE INDEX idx_users_org ON users(organization_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_email ON users(organization_id, email);
CREATE INDEX idx_student_profiles_org ON student_profiles(organization_id);
CREATE INDEX idx_student_profiles_enrollment ON student_profiles(organization_id, enrollment_number);
CREATE INDEX idx_faculty_profiles_department ON faculty_profiles(department_id);
CREATE INDEX idx_enrollments_student ON enrollments(student_user_id);
CREATE INDEX idx_enrollments_section ON enrollments(section_id);
CREATE INDEX idx_class_sessions_offering ON class_sessions(subject_offering_id, scheduled_at);
CREATE INDEX idx_attendance_session ON attendance_records(class_session_id);
CREATE INDEX idx_attendance_student ON attendance_records(student_user_id, subject_offering_id);
CREATE INDEX idx_notifications_recipient ON notifications(recipient_user_id, is_read, created_at DESC);
CREATE INDEX idx_audit_logs_org ON audit_logs(organization_id, created_at DESC);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_subject_offerings_faculty ON subject_offerings(faculty_user_id);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

-- Full-text search (pg_trgm)
CREATE INDEX idx_users_name_trgm ON users USING GIN (
  (first_name || ' ' || last_name) gin_trgm_ops
);
CREATE INDEX idx_student_enrollment_trgm ON student_profiles USING GIN (
  enrollment_number gin_trgm_ops
);
```

### 8.5 Service Request Tables

```sql
-- service_types (configurable)
CREATE TABLE service_types (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id),
  name              VARCHAR(255) NOT NULL,
  code              VARCHAR(50) NOT NULL,
  description       TEXT,
  category          VARCHAR(100),
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  sla_hours         INTEGER,
  workflow_config   JSONB NOT NULL DEFAULT '{}',
  form_schema       JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, code)
);

-- service_requests
CREATE TABLE service_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id),
  service_type_id   UUID NOT NULL REFERENCES service_types(id),
  requester_user_id UUID NOT NULL REFERENCES users(id),
  reference_number  VARCHAR(50) NOT NULL UNIQUE,
  title             VARCHAR(255) NOT NULL,
  description       TEXT,
  form_data         JSONB NOT NULL DEFAULT '{}',
  status            VARCHAR(30) NOT NULL DEFAULT 'SUBMITTED',
  priority          VARCHAR(20) NOT NULL DEFAULT 'NORMAL',
  current_step      INTEGER NOT NULL DEFAULT 1,
  assigned_to_user_id UUID REFERENCES users(id),
  assigned_to_dept_id UUID REFERENCES departments(id),
  due_date          TIMESTAMPTZ,
  resolved_at       TIMESTAMPTZ,
  resolution_note   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- service_request_steps
CREATE TABLE service_request_steps (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_request_id UUID NOT NULL REFERENCES service_requests(id),
  step_number       INTEGER NOT NULL,
  step_name         VARCHAR(100) NOT NULL,
  action            VARCHAR(30) NOT NULL,  -- APPROVE, REVIEW, PROCESS, NOTIFY
  actor_user_id     UUID REFERENCES users(id),
  actor_role        VARCHAR(100),
  status            VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  notes             TEXT,
  acted_at          TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- service_request_attachments
CREATE TABLE service_request_attachments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_request_id  UUID NOT NULL REFERENCES service_requests(id),
  uploaded_by_user_id UUID NOT NULL REFERENCES users(id),
  filename            VARCHAR(255) NOT NULL,
  storage_key         TEXT NOT NULL,
  file_size           INTEGER,
  mime_type           VARCHAR(100),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- service_request_comments
CREATE TABLE service_request_comments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_request_id  UUID NOT NULL REFERENCES service_requests(id),
  author_user_id      UUID NOT NULL REFERENCES users(id),
  body                TEXT NOT NULL,
  is_internal         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 8.6 Helpdesk Tables

```sql
-- ticket_categories
CREATE TABLE ticket_categories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name            VARCHAR(100) NOT NULL,
  department_id   UUID REFERENCES departments(id),
  sla_hours       INTEGER,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- tickets
CREATE TABLE tickets (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   UUID NOT NULL REFERENCES organizations(id),
  ticket_number     VARCHAR(30) NOT NULL UNIQUE,
  category_id       UUID NOT NULL REFERENCES ticket_categories(id),
  reporter_user_id  UUID NOT NULL REFERENCES users(id),
  assigned_to_user_id UUID REFERENCES users(id),
  title             VARCHAR(255) NOT NULL,
  description       TEXT NOT NULL,
  status            VARCHAR(30) NOT NULL DEFAULT 'OPEN',
  priority          VARCHAR(20) NOT NULL DEFAULT 'MEDIUM',
  due_at            TIMESTAMPTZ,
  resolved_at       TIMESTAMPTZ,
  closed_at         TIMESTAMPTZ,
  sla_breached      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ticket_messages
CREATE TABLE ticket_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       UUID NOT NULL REFERENCES tickets(id),
  author_user_id  UUID NOT NULL REFERENCES users(id),
  body            TEXT NOT NULL,
  is_internal     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ticket_attachments
CREATE TABLE ticket_attachments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id           UUID NOT NULL REFERENCES tickets(id),
  message_id          UUID REFERENCES ticket_messages(id),
  uploaded_by_user_id UUID NOT NULL REFERENCES users(id),
  filename            VARCHAR(255) NOT NULL,
  storage_key         TEXT NOT NULL,
  file_size           INTEGER,
  mime_type           VARCHAR(100),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ticket_status_history
CREATE TABLE ticket_status_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       UUID NOT NULL REFERENCES tickets(id),
  from_status     VARCHAR(30),
  to_status       VARCHAR(30) NOT NULL,
  changed_by_user_id UUID NOT NULL REFERENCES users(id),
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ticket_feedback
CREATE TABLE ticket_feedback (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       UUID NOT NULL UNIQUE REFERENCES tickets(id),
  user_id         UUID NOT NULL REFERENCES users(id),
  rating          SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 8.7 Immutable & Historically Tracked Entities

| Entity | Strategy |
|---|---|
| AttendanceRecord | No DELETE. Corrections via CorrectionRequest + audit log |
| AuditLog | Append-only. No UPDATE/DELETE. Partition by month |
| ExamMarks (Phase 4) | Locked after semester lock. Admin override with audit |
| ServiceRequestStep | Append-only history |
| TicketStatusHistory | Append-only |
| RefreshToken | Soft-revoke (`revoked_at`), never deleted |

### 8.8 Soft-Delete Strategy

| Entity | Soft-Delete |
|---|---|
| User | `deleted_at TIMESTAMPTZ` |
| Department | `is_active BOOLEAN` |
| Program/Batch | `is_active BOOLEAN` |
| Subject | `is_active BOOLEAN` |
| SubjectOffering | `is_active BOOLEAN` |
| Enrollment | `status = 'DROPPED'` |

---

## 9. Role & Permission Model

### 9.1 System Roles

| Role | Description | Scope |
|---|---|---|
| SUPER_ADMIN | Platform operator (not a college user) | Platform-level |
| COLLEGE_ADMIN | Top-level admin for the organization | Organization |
| CAMPUS_ADMIN | Admin for a specific campus | Campus |
| DEPARTMENT_ADMIN | Admin for a specific department | Department |
| HOD | Head of Department | Department |
| FACULTY | Teaching faculty | SubjectOffering |
| STAFF | Administrative staff | Department |
| STUDENT | Enrolled student | Own data |
| PARENT | Guardian linked to a student | Student's visible data |
| FINANCE_STAFF | Fee and payment management | Finance module |
| EXAM_STAFF | Examination management | Exam module |
| SUPPORT_STAFF | Helpdesk agent | Helpdesk |
| LIBRARIAN | Library module | Library |

### 9.2 Permission Matrix

```
FORMAT: module.action[.scope]

Scope qualifiers:
  .own    — only their own data
  .dept   — within their department
  .all    — entire organization
```

#### Authentication & Profile
| Permission | Student | Faculty | Staff | HOD | Dept Admin | College Admin |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| profile.read.own | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| profile.update.own | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| profile.read.all | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |

#### Student Management
| Permission | Student | Faculty | HOD | Dept Admin | College Admin |
|---|:---:|:---:|:---:|:---:|:---:|
| student.read.own | ✅ | ❌ | ❌ | ❌ | ❌ |
| student.read.section | ❌ | ✅ | ✅ | ✅ | ✅ |
| student.read.dept | ❌ | ❌ | ✅ | ✅ | ✅ |
| student.read.all | ❌ | ❌ | ❌ | ❌ | ✅ |
| student.create | ❌ | ❌ | ❌ | ✅ | ✅ |
| student.update | ❌ | ❌ | ❌ | ✅ | ✅ |
| student.deactivate | ❌ | ❌ | ❌ | ❌ | ✅ |

#### Attendance
| Permission | Student | Faculty | HOD | Dept Admin | College Admin |
|---|:---:|:---:|:---:|:---:|:---:|
| attendance.read.own | ✅ | ❌ | ❌ | ❌ | ❌ |
| attendance.read.section | ❌ | ✅ | ✅ | ✅ | ✅ |
| attendance.read.dept | ❌ | ❌ | ✅ | ✅ | ✅ |
| attendance.read.all | ❌ | ❌ | ❌ | ❌ | ✅ |
| attendance.mark | ❌ | ✅ | ❌ | ❌ | ❌ |
| attendance.correct | ❌ | ✅ | ✅ | ✅ | ✅ |
| attendance.correct.admin | ❌ | ❌ | ❌ | ❌ | ✅ |
| attendance.session.create | ❌ | ✅ | ❌ | ❌ | ❌ |

#### Service Requests
| Permission | Student | Faculty | Staff | HOD | Dept Admin | College Admin |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| service_request.create | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| service_request.read.own | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| service_request.read.dept | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| service_request.read.all | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| service_request.process | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| service_request.approve | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| service_request.reject | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |

#### Helpdesk
| Permission | Student | Faculty | Support Staff | HOD | College Admin |
|---|:---:|:---:|:---:|:---:|:---:|
| ticket.create | ✅ | ✅ | ✅ | ✅ | ✅ |
| ticket.read.own | ✅ | ✅ | ✅ | ✅ | ✅ |
| ticket.read.dept | ❌ | ❌ | ✅ | ✅ | ✅ |
| ticket.read.all | ❌ | ❌ | ❌ | ❌ | ✅ |
| ticket.assign | ❌ | ❌ | ✅ | ✅ | ✅ |
| ticket.resolve | ❌ | ❌ | ✅ | ✅ | ✅ |
| ticket.close | ❌ | ❌ | ❌ | ✅ | ✅ |

#### Academic Structure
| Permission | Faculty | HOD | Dept Admin | College Admin |
|---|:---:|:---:|:---:|:---:|
| academic.read | ✅ | ✅ | ✅ | ✅ |
| academic.manage.dept | ❌ | ✅ | ✅ | ✅ |
| academic.manage.all | ❌ | ❌ | ❌ | ✅ |
| semester.lock | ❌ | ❌ | ❌ | ✅ |

#### Reports
| Permission | Student | Faculty | HOD | Dept Admin | College Admin |
|---|:---:|:---:|:---:|:---:|:---:|
| report.attendance.own | ✅ | ❌ | ❌ | ❌ | ❌ |
| report.attendance.section | ❌ | ✅ | ✅ | ✅ | ✅ |
| report.attendance.dept | ❌ | ❌ | ✅ | ✅ | ✅ |
| report.attendance.all | ❌ | ❌ | ❌ | ❌ | ✅ |
| report.export | ❌ | ✅ | ✅ | ✅ | ✅ |

### 9.3 Permission Evaluation Logic

```
Authorization check for a request:
1. Extract JWT → userId, organizationId, roles[]
2. Load user's effective permissions (from cache)
3. Check: does user have required permission?
4. If permission has scope (dept/section): does the resource belong to that scope?
5. If all checks pass → allow
6. Else → 403 Forbidden

Effective permissions = union of all permissions from all active user roles.
Cached per user in Redis with TTL = 5 min.
Invalidated on role change.
```

---

## 10. Application Flows

### 10.1 Student Flows

#### Login Flow
```
Student opens app
→ Enter email/password
→ POST /auth/login
→ JWT + refresh token issued
→ Redirected to Student Dashboard
→ If first login: prompt to complete profile
```

#### Student Dashboard
```
Components (mobile-first):
┌─────────────────────────┐
│   👋 Good morning, Aanya │
│   B.Tech CS — Sem 3 — A │
├─────────────────────────┤
│  📊 Attendance           │
│  Overall: 78% ⚠️         │
│  [View Details]          │
├─────────────────────────┤
│  📅 Today's Classes      │
│  9:00 – DBMS (Dr. Patel) │
│  11:00 – OS (Dr. Kumar)  │
├─────────────────────────┤
│  🔔 Notifications (3)    │
│  Your bonafide is ready  │
├─────────────────────────┤
│  ⚡ Quick Actions         │
│  [New Request] [Ticket]  │
└─────────────────────────┘
```

#### Attendance Flow (Student)
```
Student → Attendance tab
→ GET /attendance/my/summary
→ Show: Subject-wise list with %
→ Color coding: Green (≥75%), Yellow (65-75%), Red (<65%)
→ Tap subject → GET /attendance/my/subject/:id
→ Show: Session-by-session history
→ If absent count > threshold: show correction request CTA
```

#### Service Request Flow (Student)
```
Student → Requests → New Request
→ Select request type (Bonafide, ID Card, etc.)
→ Dynamic form (from form_schema)
→ Upload attachments (optional)
→ Submit → POST /service-requests
→ Confirmation + reference number
→ Track progress on "My Requests" screen
→ Receive notifications at each step change
→ On completion: download generated document (if applicable)
```

#### Timetable Flow
```
Student → Timetable
→ GET /timetable/my
→ Show weekly schedule
→ Toggle: Week View / Day View
→ Tap class → Subject details, faculty, room
```

### 10.2 Faculty Flows

#### Faculty Dashboard
```
┌─────────────────────────────┐
│  Today's Classes (3)        │
│  09:00 DBMS — Sec A (34 st) │
│  11:00 DBMS — Sec B (32 st) │
│  14:00 Lab — Sec A (34 st)  │
├─────────────────────────────┤
│  Pending Requests (2)       │
│  Attendance Correction x2   │
├─────────────────────────────┤
│  Low Attendance Alerts      │
│  5 students below 75%       │
└─────────────────────────────┘
```

#### Attendance Marking Flow
```
Faculty → Today's Classes
→ Select class session (or create new)
→ GET /class-sessions/:id/students
→ Student roster displayed
→ Default: all PRESENT
→ Faculty marks absent/late students
→ POST /class-sessions/:id/attendance
  { student_id: "...", status: "ABSENT" }
→ Attendance saved
→ Students notified of absence (optional)
→ Session status: MARKED
```

#### Attendance Correction Request (Faculty processes)
```
Faculty receives notification: "Attendance correction requested"
→ Reviews request details
→ Sees: Student, session, claimed status, reason
→ Approve/Reject with note
→ PATCH /service-requests/:id/step
→ On approve: attendance record updated + audit log
→ Student notified
```

### 10.3 HOD Flows

#### HOD Department Dashboard
```
┌─────────────────────────────────────┐
│  Department: Computer Science        │
│  Semester: 2024–25 Sem 3            │
├─────────────────────────────────────┤
│  Students: 240 enrolled             │
│  Faculty: 18 active                 │
├─────────────────────────────────────┤
│  Attendance Overview                │
│  Avg: 82%  | At-risk students: 12   │
│  [View At-Risk] [Full Report]       │
├─────────────────────────────────────┤
│  Pending Requests (8)               │
│  Bonafide: 3 | Correction: 5        │
├─────────────────────────────────────┤
│  Faculty Workload                   │
│  [View Timetable]                   │
└─────────────────────────────────────┘
```

#### Request Review Flow (HOD)
```
HOD → Requests → Pending
→ Filter by type/status
→ Select request
→ View details, attachments, history
→ Approve / Reject / Reassign
→ Add internal note
→ PATCH /service-requests/:id/step
→ System routes to next step or closes
→ Student notified
```

### 10.4 Admin Flows

#### Admin Dashboard
```
┌─────────────────────────────────────┐
│  Smart Campus OS — Admin            │
├─────────────────────────────────────┤
│  Quick Stats                        │
│  Students: 2,847  Faculty: 148      │
│  Active Semester: 2024–25 Sem 3     │
│  Open Requests: 34  Tickets: 12     │
├─────────────────────────────────────┤
│  Navigation                         │
│  Organization | Students | Faculty  │
│  Academic | Attendance | Requests   │
│  Helpdesk | Reports | Settings      │
└─────────────────────────────────────┘
```

#### User Management Flow
```
Admin → Students → Import / Add
→ Bulk import via CSV (with validation preview)
→ Or individual student creation
→ System creates User + StudentProfile + sends invite email
→ Student sets password on first login
```

#### Academic Setup Flow
```
Admin → Academic → New Semester Setup
1. Create/verify Programs and Batches
2. Create Semester (start/end dates)
3. Create Sections
4. Assign subjects to sections + faculty
5. Publish timetable
6. Set enrollment (import or auto-assign)
→ Checklist UI to guide admin through setup
```

---

## 11. Service Request Engine

### 11.1 Design Philosophy

The service request engine is a **generic, workflow-driven system**.

We do NOT create separate database tables or separate backend services for:
- Bonafide certificate requests
- ID card requests
- Attendance correction requests
- Scholarship requests

Instead, we create:
1. **ServiceType** — configuration of a request type
2. **WorkflowConfig** — JSON definition of approval steps
3. **FormSchema** — JSON Schema definition of the form
4. **ServiceRequest** — the actual request instance
5. **ServiceRequestStep** — step-by-step audit history

This allows admins to configure new request types without code changes.

### 11.2 Service Type Configuration

Each `ServiceType` has a `workflow_config` (JSONB) that defines the flow:

```json
{
  "steps": [
    {
      "step": 1,
      "name": "Faculty Verification",
      "action": "APPROVE",
      "assignTo": { "role": "FACULTY", "scope": "subject_faculty" },
      "sla_hours": 24,
      "on_approve": { "next_step": 2 },
      "on_reject": { "status": "REJECTED", "notify": ["requester"] }
    },
    {
      "step": 2,
      "name": "Department Admin Processing",
      "action": "PROCESS",
      "assignTo": { "role": "DEPARTMENT_ADMIN", "scope": "student_department" },
      "sla_hours": 48,
      "on_approve": { "status": "COMPLETED", "generate_document": true }
    }
  ],
  "notifications": {
    "on_submit": ["requester"],
    "on_approve": ["requester"],
    "on_reject": ["requester"],
    "on_complete": ["requester", "guardian"]
  }
}
```

And a `form_schema` (JSON Schema) that drives the dynamic form:

```json
{
  "title": "Bonafide Certificate Request",
  "fields": [
    {
      "name": "purpose",
      "label": "Purpose of Certificate",
      "type": "select",
      "options": ["Bank Account", "Scholarship", "Passport", "Employment"],
      "required": true
    },
    {
      "name": "additional_details",
      "label": "Additional Details",
      "type": "textarea",
      "required": false
    }
  ]
}
```

### 11.3 Built-in Service Types (MVP)

| Code | Name | Workflow Steps |
|---|---|---|
| `BONAFIDE` | Bonafide Certificate | Submit → Admin review → Generate PDF |
| `ID_CARD` | ID Card Request | Submit → Admin review → Issue |
| `ATTENDANCE_CORRECTION` | Attendance Correction | Submit → Faculty review → Auto-correct |
| `GENERAL_REQUEST` | General Administrative Request | Submit → Dept staff → HOD (if needed) |

### 11.4 Reference Number Generation

```
Format: SR-{YEAR}-{SEQUENCE}
Example: SR-2024-001234

Sequence: Auto-incrementing per organization per year
Generated at submission time, stored in service_requests.reference_number
```

### 11.5 Status Lifecycle

```
SUBMITTED → UNDER_REVIEW → IN_PROGRESS → COMPLETED
                         ↘ REJECTED
                         ↘ CANCELLED (by requester, within 1 hour)
                         ↘ ESCALATED → (back to normal flow)
```

### 11.6 SLA Tracking

```
Each step has an SLA (hours).
A BullMQ delayed job is scheduled at step assignment time.
If not acted upon before SLA expiry:
  1. SLA breached flag set
  2. Escalation notification sent to HOD/Admin
  3. Audit log entry created
```

### 11.7 Document Generation

For requests that produce documents (bonafide, certificates):
1. On `COMPLETED` status: trigger a background job
2. Job uses a PDF template (Handlebars/Puppeteer)
3. Template is configured per `ServiceType`
4. Generated PDF stored in object storage
5. Student receives download link (pre-signed URL, 7 days)
6. Document record stored in `service_request_attachments` (type: GENERATED)

---

## 12. Helpdesk Architecture

### 12.1 Ticket Lifecycle

```
OPEN → ASSIGNED → IN_PROGRESS → RESOLVED → CLOSED
     ↘ (auto-assign on category)
                              ↘ REOPENED → IN_PROGRESS
     ↘ ON_HOLD (waiting for response)
```

### 12.2 Auto-Assignment Rules

When a ticket is created with a specific `category_id`, the system:
1. Looks up the `TicketCategory.department_id`
2. Finds the department's `SUPPORT_STAFF` members
3. Assigns using round-robin or least-load strategy
4. If no staff: assigns to department HOD

### 12.3 SLA Policy

| Priority | Response SLA | Resolution SLA |
|---|---|---|
| URGENT | 1 hour | 4 hours |
| HIGH | 4 hours | 24 hours |
| MEDIUM | 8 hours | 48 hours |
| LOW | 24 hours | 5 days |

SLA breach triggers:
1. Supervisor notification
2. Priority auto-escalation after 2x breach
3. Audit log

### 12.4 Conversation Thread

Tickets have a message thread (`ticket_messages`) supporting:
- Public replies (visible to reporter)
- Internal notes (staff-only, shown with different styling)
- Attachments on any message

### 12.5 Escalation Rules

```
Configurable per category:
- If UNRESOLVED after N hours → escalate to HOD
- If UNRESOLVED after 2N hours → escalate to College Admin
- If reporter reopens 3+ times → flag for manager review
```

### 12.6 Feedback

After ticket `CLOSED`:
1. Reporter receives feedback request (email + in-app)
2. Simple 1–5 star rating + optional comment
3. Feedback stored, averaged per category/agent for reporting

---

## 13. AI Architecture

### 13.1 Architecture Overview

```
Student types: "What is my attendance in DBMS?"
                        │
                        ▼
              ┌─────────────────┐
              │   AI Module     │
              │ (Conversation   │
              │   Manager)      │
              └────────┬────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
   ┌──────────┐ ┌──────────┐ ┌──────────────┐
   │   LLM    │ │   RAG    │ │ Tool Calling │
   │ (Gemini) │ │ (Policy  │ │ (ERP APIs)   │
   │          │ │  Docs)   │ │              │
   └──────────┘ └──────────┘ └──────────────┘
```

### 13.2 LLM Layer

**Provider:** Google Gemini (Gemini 1.5 Flash for general conversations, Gemini 1.5 Pro for complex reasoning)

**Why Gemini:**
- Strong tool-calling capability
- Long context window (useful for policy documents)
- Competitive pricing
- Google ecosystem integration

**Fallback:** OpenAI GPT-4o

**Hosting:** API-based (not self-hosted). LLMs are not deployed on-premise.

### 13.3 RAG / Knowledge Base

**Use cases:**
- College policies and procedures
- Academic regulations
- FAQ documents
- Form instructions

**Architecture:**
1. Admin uploads documents (PDF, DOCX)
2. Documents chunked and embedded (using Google `text-embedding-004`)
3. Embeddings stored in PostgreSQL with `pgvector` extension
4. On user query: retrieve top-K relevant chunks
5. Inject into LLM context as additional knowledge

**Why pgvector over dedicated vector DB (Pinecone/Qdrant):**
- Fewer moving parts
- Sufficient for early-stage scale (<100K chunks)
- Co-located with application data
- Evaluate dedicated vector DB at 1M+ chunks

### 13.4 Tool Calling (AI ↔ ERP Integration)

The AI interacts with the ERP exclusively through explicitly defined tools.

**Critical security rule: AI tools call the SAME API endpoints that the frontend uses. The AI session has its own JWT scoped to the student's identity and permissions.**

#### Initial AI Tool Definitions

```typescript
// Tools available to the student-facing AI

const AI_TOOLS = [
  {
    name: "get_my_attendance_summary",
    description: "Get the student's attendance summary across all subjects",
    parameters: {},
    // Calls: GET /attendance/my/summary
    // Auth: student's own token
  },
  {
    name: "get_my_attendance_by_subject",
    description: "Get detailed attendance for a specific subject",
    parameters: {
      subject_name: { type: "string", description: "Name of the subject" }
    },
    // Calls: GET /attendance/my/subject?name=:name
  },
  {
    name: "get_my_timetable",
    description: "Get the student's timetable for today or this week",
    parameters: {
      timeframe: { type: "string", enum: ["today", "week"] }
    }
  },
  {
    name: "create_service_request",
    description: "Create a new service request on behalf of the student",
    parameters: {
      service_type_code: { type: "string" },
      form_data: { type: "object" },
      description: { type: "string" }
    },
    // REQUIRES explicit confirmation from student before execution
  },
  {
    name: "get_my_requests",
    description: "Get the student's service requests and their status",
    parameters: {
      status: { type: "string", optional: true }
    }
  },
  {
    name: "get_my_tickets",
    description: "Get the student's helpdesk tickets",
    parameters: {}
  },
  {
    name: "search_policies",
    description: "Search college policies and procedures",
    parameters: {
      query: { type: "string" }
    }
    // Uses RAG, no ERP data access
  },
  {
    name: "escalate_to_human",
    description: "Create a helpdesk ticket for human support",
    parameters: {
      title: { type: "string" },
      description: { type: "string" },
      category: { type: "string" }
    }
  }
]
```

### 13.5 Authorization in AI

```
Every AI tool call:
1. Uses the student's own JWT (not a super-token)
2. Goes through the same API middleware
3. Subject to the same permission checks
4. Returns only data the student is authorized to see

The AI CANNOT:
- Access another student's data
- Create requests on behalf of someone else without their consent
- Execute privileged operations
- Access raw database
- Read internal notes or staff-only data
```

### 13.6 Conversation Memory

**Short-term:** Conversation stored in Redis per session (TTL: 30 minutes idle)

**Long-term:** Conversation summaries stored in database per user (last 10 conversations, for context)

**Memory structure:**
```json
{
  "conversation_id": "conv_xxx",
  "user_id": "user_xxx",
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." },
    { "role": "tool", "name": "get_my_attendance", "result": {...} }
  ],
  "context": {
    "student_name": "Aanya",
    "current_semester": "Sem 3",
    "last_topic": "attendance"
  }
}
```

### 13.7 Confirmation Gate

For any tool that mutates data (create request, submit ticket):
1. AI presents a summary to the student: *"I'll create an attendance correction request for DBMS on Oct 5th. Shall I proceed?"*
2. Student confirms
3. Only then does the tool execute
4. This confirmation exchange is stored in the audit log

### 13.8 Safety & Guardrails

- System prompt strictly defines the AI's role, scope, and limitations
- AI cannot discuss topics unrelated to campus services
- Profanity/harassment filters on both input and output
- Rate limiting: 20 AI requests per student per hour
- Jailbreak attempt detection (prompt injection patterns)
- All AI conversations stored for audit and review

### 13.9 AI Audit Logging

Every AI action is logged:
```
actor_type: "AI"
action: "ai.tool_call.create_service_request"
entity_type: "ServiceRequest"
entity_id: <created_request_id>
old_value: null
new_value: { conversation_id, student_id, tool_params }
```

---

## 14. API Strategy

### 14.1 REST vs GraphQL Decision

**Decision: REST**

**Why not GraphQL:**
- Adds complexity (schema, resolvers, DataLoader) without clear benefit for this product
- REST is simpler for mobile clients
- REST is easier to cache, rate-limit, and audit
- GraphQL is better for products with complex, nested, variable queries — not our primary use case

**Exception:** Consider GraphQL for the analytics/reporting layer in Phase 10 where flexible querying is genuinely needed.

### 14.2 URL Conventions

```
Base URL: /api/v1/

Prefix: /api
Version: /v1
Resource: plural nouns

GET    /api/v1/students                    — list students
GET    /api/v1/students/:id               — get student
POST   /api/v1/students                    — create student
PATCH  /api/v1/students/:id               — partial update
DELETE /api/v1/students/:id               — soft-delete

Nested resources (when context matters):
GET    /api/v1/class-sessions/:id/attendance
POST   /api/v1/class-sessions/:id/attendance

Self-referential (student's own data):
GET    /api/v1/attendance/my/summary
GET    /api/v1/timetable/my
GET    /api/v1/requests/my
```

### 14.3 API Versioning

**Strategy: URL-path versioning (/api/v1/, /api/v2/)**

Breaking changes require a new version. Minor additions are non-breaking and added to the current version.

**Deprecation policy:** Old version supported for 6 months after new version release.

### 14.4 Authentication

All API requests (except `/auth/*` and `/health`) require:

```
Authorization: Bearer <jwt_access_token>
```

JWT payload:
```json
{
  "sub": "user_uuid",
  "org": "organization_uuid",
  "campus": "campus_uuid",
  "roles": ["FACULTY"],
  "permissions": ["attendance.mark", "attendance.read.section"],
  "iat": 1234567890,
  "exp": 1234568790
}
```

Permissions are embedded in the JWT (cached) to avoid a DB lookup on every request.

### 14.5 Error Format

All errors use a consistent JSON structure:

```json
{
  "error": {
    "code": "ATTENDANCE_SESSION_NOT_FOUND",
    "message": "The class session with ID 'abc' was not found.",
    "field": null,
    "details": null,
    "requestId": "req_xxxxxxxxxxxx"
  }
}
```

HTTP status codes:
| Status | Meaning |
|---|---|
| 200 | Success |
| 201 | Created |
| 204 | No content (delete) |
| 400 | Bad request / validation error |
| 401 | Unauthenticated |
| 403 | Unauthorized (authenticated but not permitted) |
| 404 | Not found |
| 409 | Conflict (duplicate, already exists) |
| 422 | Unprocessable entity (business rule violation) |
| 429 | Rate limited |
| 500 | Server error |

### 14.6 Pagination

All list endpoints use cursor-based pagination:

```
Request:
GET /api/v1/students?cursor=<opaque_cursor>&limit=25

Response:
{
  "data": [...],
  "pagination": {
    "total": 2847,
    "limit": 25,
    "nextCursor": "eyJpZCI6InV1aWQifQ==",
    "prevCursor": null,
    "hasMore": true
  }
}
```

**Why cursor over offset:** Offset pagination breaks with inserts during pagination. Cursor-based is consistent.

### 14.7 Filtering & Sorting

```
GET /api/v1/students?
  department_id=uuid&
  batch_id=uuid&
  search=aanya&
  sort_by=last_name&
  sort_order=asc

GET /api/v1/service-requests?
  status=SUBMITTED,UNDER_REVIEW&
  created_after=2024-01-01&
  service_type=BONAFIDE
```

### 14.8 Validation

- All request bodies validated against Zod schemas
- Validation errors return 400 with field-level error details:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      { "field": "email", "message": "Invalid email address" },
      { "field": "phone", "message": "Phone number is required" }
    ]
  }
}
```

### 14.9 Rate Limiting

| Endpoint category | Limit |
|---|---|
| Auth (login) | 5 requests / minute / IP |
| Auth (password reset) | 3 requests / hour / email |
| General API | 100 requests / minute / user |
| File upload | 10 requests / minute / user |
| AI assistant | 20 requests / hour / user |
| Report generation | 5 requests / minute / user |

Implementation: Redis-backed sliding window in Fastify rate limit plugin.

### 14.10 Idempotency

Mutating requests (POST) that should be idempotent (attendance marking, service request creation) support an `Idempotency-Key` header:

```
POST /api/v1/service-requests
Idempotency-Key: client-generated-uuid

If the same key is sent twice within 24 hours:
- If first request succeeded: return cached response (200)
- If first request failed: allow retry
```

### 14.11 File Upload Strategy

**Direct upload flow (for large files):**
1. Client requests a pre-signed upload URL: `POST /api/v1/uploads/presign`
2. Backend generates S3 pre-signed PUT URL with metadata
3. Client uploads directly to S3 (bypasses backend)
4. Client confirms upload: `POST /api/v1/uploads/confirm` with storage key
5. Backend validates file exists in storage, creates DB record

**Direct upload flow (for small files, <5MB):**
- Multipart form upload through the backend API
- Backend validates, uploads to S3, returns storage key

---

## 15. UI/UX Design System

### 15.1 Design Principles

1. **Clarity over cleverness** — The interface should be immediately understandable.
2. **Mobile-first student experience** — Design for a 375px screen first, scale up.
3. **Consistent information hierarchy** — Every page has one primary action.
4. **Accessible by default** — WCAG 2.1 AA minimum.
5. **Fast and responsive** — Skeleton loading states everywhere. No spinners with no content.
6. **Trust through feedback** — Every action has a confirmation and a result.

### 15.2 Design Tokens

```css
/* Typography */
--font-sans: 'Inter', system-ui, sans-serif;
--font-mono: 'JetBrains Mono', monospace;

/* Type scale */
--text-xs: 0.75rem;    /* 12px */
--text-sm: 0.875rem;   /* 14px */
--text-base: 1rem;     /* 16px */
--text-lg: 1.125rem;   /* 18px */
--text-xl: 1.25rem;    /* 20px */
--text-2xl: 1.5rem;    /* 24px */
--text-3xl: 1.875rem;  /* 30px */

/* Spacing scale (4px base) */
--space-1: 0.25rem;    /* 4px */
--space-2: 0.5rem;     /* 8px */
--space-3: 0.75rem;    /* 12px */
--space-4: 1rem;       /* 16px */
--space-6: 1.5rem;     /* 24px */
--space-8: 2rem;       /* 32px */
--space-12: 3rem;      /* 48px */
--space-16: 4rem;      /* 64px */

/* Color palette */
/* Primary — Indigo */
--color-primary-50: #eef2ff;
--color-primary-500: #6366f1;
--color-primary-600: #4f46e5;
--color-primary-700: #4338ca;

/* Semantic */
--color-success: #10b981;
--color-warning: #f59e0b;
--color-danger: #ef4444;
--color-info: #3b82f6;

/* Neutrals */
--color-gray-50: #f9fafb;
--color-gray-100: #f3f4f6;
--color-gray-200: #e5e7eb;
--color-gray-500: #6b7280;
--color-gray-700: #374151;
--color-gray-900: #111827;

/* Radius */
--radius-sm: 0.375rem;   /* 6px */
--radius-md: 0.5rem;     /* 8px */
--radius-lg: 0.75rem;    /* 12px */
--radius-xl: 1rem;       /* 16px */
--radius-full: 9999px;
```

### 15.3 Navigation

**Student Mobile Navigation (bottom tab bar):**
```
[ Home ] [ Attendance ] [ Requests ] [ Tickets ] [ Profile ]
```

**Faculty Navigation (sidebar on desktop, bottom bar on mobile):**
```
[ Dashboard ] [ My Classes ] [ Attendance ] [ Students ] [ Requests ] [ Profile ]
```

**Admin Navigation (sidebar, desktop-primary):**
```
Dashboard
├── Organization
├── Students
├── Faculty & Staff
├── Academic
│   ├── Programs
│   ├── Batches & Semesters
│   ├── Sections
│   └── Subjects
├── Attendance
├── Service Requests
├── Helpdesk
├── Reports
└── Settings
    ├── Roles & Permissions
    ├── Notifications
    ├── Service Types
    └── System
```

### 15.4 Core Components

#### Cards
```
┌────────────────────────┐
│ 📊 Attendance           │  ← Icon + Title
│                        │
│  78%  Overall          │  ← Primary metric
│  ████████░░            │  ← Progress bar
│                        │
│ DBMS  65% ⚠️           │  ← Sub-metrics
│ OS    82% ✅           │
└────────────────────────┘
```

#### Status Badges
```
● SUBMITTED   (gray)
● UNDER_REVIEW (blue)
● APPROVED    (green)
● REJECTED    (red)
● COMPLETED   (green, filled)
```

#### Forms
- Label above input (not placeholder-as-label)
- Inline validation (on blur)
- Error messages below field in red
- Required fields marked with `*`
- Single-column on mobile, two-column optional on desktop

#### Tables (Admin / HOD views)
- Sticky header on scroll
- Sortable columns with sort indicator
- Row hover highlight
- Bulk selection checkboxes
- Pagination control at bottom
- Export button (PDF/Excel)

#### Empty States
```
┌────────────────────────┐
│   📭  No requests yet  │
│                        │
│  When you submit a     │
│  request, it appears   │
│  here.                 │
│                        │
│  [Submit a Request]    │
└────────────────────────┘
```

#### Loading States
- Skeleton screens (not spinners) for page-level loading
- Inline spinners for button actions
- No empty flash before content loads

### 15.5 Attendance Visualization

**Student attendance card:**
- Color-coded percentage (green/yellow/red)
- Progress bar per subject
- Session calendar heatmap (tap to see details)

**HOD department view:**
- Sortable table with student risk indicators
- Filter by subject/section
- Export button

### 15.6 Accessibility

- All interactive elements keyboard accessible
- ARIA labels on icon-only buttons
- Color not used as the sole indicator (always paired with text/icon)
- Focus indicators visible
- Font size minimum 16px on mobile
- Contrast ratio: 4.5:1 minimum for body text
- Screen reader tested with NVDA (Windows) and VoiceOver (iOS/macOS)

---

## 16. Security Architecture

### 16.1 Authentication Security

- Passwords hashed with **bcrypt** (cost factor 12)
- JWT signed with **RS256** (asymmetric — private key signs, public key verifies)
- Access token TTL: **15 minutes**
- Refresh token TTL: **7 days**, rotated on each use
- Refresh tokens stored as **hashed** values in DB
- Failed login attempts: locked after **5 failures** in 15 minutes (per IP + per account)
- Password reset tokens: **32 bytes** random, hashed, single-use, expire in **1 hour**
- Email verification: required before full access
- Session invalidation on password change

### 16.2 Authorization Security

- Every protected API route has explicit `preHandler` authorization middleware
- Authorization is **never** based on client-supplied data
- Permission checks are enforced server-side, always
- Resource ownership verified in service layer (not just route level)
- Students can **never** access another student's data
- Faculty can **only** access sections they are assigned to
- Organization isolation enforced via `organization_id` on every query
- PostgreSQL RLS as secondary defense layer

### 16.3 Session Management

- Refresh tokens stored in **HttpOnly**, **SameSite=Strict**, **Secure** cookies
- Access tokens stored in **memory only** (not localStorage, not cookies)
- Logout invalidates refresh token in DB
- Global logout: invalidates all refresh tokens for the user

### 16.4 Password / Security Policies

- Minimum 8 characters
- Must include at least one number and one letter
- Common password blocklist (top 10,000)
- Password change requires current password
- Password history: last 5 passwords cannot be reused
- **MFA (Phase 2):** TOTP (Google Authenticator) for admin roles

### 16.5 Data Isolation

- `organization_id` on every tenant-scoped table
- All database queries include `WHERE organization_id = ?`
- ORM/query builder layer enforces this via a base repository pattern
- PostgreSQL RLS policies as belt-and-suspenders

```sql
-- Example RLS policy
CREATE POLICY students_org_isolation ON student_profiles
  USING (organization_id = current_setting('app.organization_id')::UUID);
```

### 16.6 Encryption

- **At rest:** Database encrypted at storage level (cloud provider managed)
- **In transit:** TLS 1.3 minimum. HSTS enforced.
- **Object storage:** Server-side encryption (AES-256)
- **Secrets:** Environment variables in a secret manager (AWS Secrets Manager / Doppler / Vault)
- **Sensitive fields:** Email addresses of non-active users anonymized after soft-delete

### 16.7 File Security

- Uploaded files stored in private S3 buckets (no public access)
- Access via **pre-signed URLs** with expiry (15 minutes)
- Pre-signed URL generation requires authentication + authorization check
- File type validation: server-side MIME type detection (not filename extension)
- Antivirus scan on upload (ClamAV or cloud provider scanning)
- Maximum file size: 10MB per file, 50MB per request

### 16.8 API Security

- CORS configured to allow only known origins
- Content-Security-Policy headers
- Rate limiting (see Section 14.9)
- Request size limits (body parser)
- SQL injection: prevented by parameterized queries (ORM enforces)
- XSS: React escapes by default; no `dangerouslySetInnerHTML`
- CSRF: mitigated by JWT-in-header (not cookie-based auth for API)
- Helmet.js for security headers

### 16.9 Audit Logging

- **Who:** Actor user ID + type (USER/SYSTEM/AI)
- **What:** Action, entity type, entity ID
- **Before/After:** old_value, new_value (JSONB)
- **Context:** IP address, user agent, timestamp
- **Storage:** Append-only table. No UPDATE/DELETE.
- **Retention:** 7 years (academic records regulatory requirement)
- **Archive:** Older than 1 year → cold storage (S3 Glacier)

### 16.10 Rate Limiting & Abuse Prevention

- IP-based rate limiting on login endpoint
- Account-based lockout after failed attempts
- AI tool call rate limiting per user
- Abuse pattern detection (same error repeated, unusual access patterns)
- Alert on: >1000 requests/minute from single user, >10 failed logins/minute

### 16.11 AI Security

- AI has no direct database access
- AI uses student's own JWT (scoped permissions)
- AI tool calls logged in audit table
- AI cannot perform actions without student confirmation
- System prompt injected on every conversation (cannot be overridden by user)
- Input sanitation to prevent prompt injection
- Output moderation for inappropriate content

### 16.12 Privacy

- Soft-delete for user accounts (data retained for audit/legal)
- Data export capability (GDPR Article 20 equivalent)
- No student data shared across organizations
- Guardian access limited to their linked student's allowed-visible data
- Data retention policy configurable per organization

### 16.13 Infrastructure Security

- No SSH port open publicly (use SSM Session Manager or bastion)
- Database not publicly accessible (VPC private subnet)
- Environment secrets never in code or version control
- Container images scanned for vulnerabilities (Trivy/Snyk)
- Dependency updates: automated PR via Renovate

---

## 17. Technology Stack

### 17.1 Complete Stack Recommendation

#### Frontend Web

| Technology | Choice | Why |
|---|---|---|
| Framework | **Next.js 14+** (App Router) | SSR, full-stack capability, strong ecosystem |
| Language | **TypeScript** | Type safety, IDE support, fewer runtime errors |
| Styling | **Tailwind CSS** | Fast iteration, consistent design tokens |
| UI Primitives | **Radix UI** | Accessible, unstyled, composable |
| State (server) | **TanStack Query** | Caching, loading, error states for API data |
| State (local) | **Zustand** | Lightweight, no boilerplate |
| Forms | **React Hook Form + Zod** | Performance, validation co-located with types |
| Charts | **Recharts** | React-native, composable |
| Tables | **TanStack Table** | Headless, fully custom |

**Alternatives considered:**
- **Vite + React:** No SSR out of box. Next.js is a superset.
- **SvelteKit:** Smaller ecosystem, less hiring pool.
- **Remix:** Good, but Next.js has broader community and more investment.

---

#### Mobile

| Technology | Choice | Why |
|---|---|---|
| Framework | **React Native (Expo)** | Code sharing with web types/utils, fast iteration |
| Phase | **Phase 2 (after web MVP)** | Web first, then native |
| Push | **Expo Notifications** | Unified FCM/APNs abstraction |
| Navigation | **Expo Router** | File-based routing (consistent with Next.js mental model) |

**MVP Alternative:** Progressive Web App (PWA) — Next.js supports this well, covers 80% of mobile use cases without native app overhead. Recommended for MVP to reduce scope.

---

#### Backend

| Technology | Choice | Why |
|---|---|---|
| Runtime | **Node.js 20 LTS** | Mature, large ecosystem, team familiarity |
| Language | **TypeScript** | Type safety end-to-end |
| Framework | **Fastify** | Performance, plugin architecture, TypeScript-native |
| Validation | **Zod** | Shared with frontend, composable |
| ORM | **Drizzle ORM** | SQL-first, type-safe, readable queries |
| Queue | **BullMQ** | Redis-backed, reliable, monitoring dashboard |
| PDF Gen | **Puppeteer / Handlebars** | Template-based document generation |

---

#### Database

| Technology | Choice | Why |
|---|---|---|
| Primary DB | **PostgreSQL 15+** | Relational integrity, JSONB, extensions |
| Cache | **Redis 7** | Sessions, rate limiting, queues, real-time |
| Migrations | **Drizzle Kit** | Co-located with ORM schema |
| Backups | **Automated daily snapshots** | Point-in-time recovery |

---

#### Infrastructure & DevOps

| Technology | Choice | Why |
|---|---|---|
| Containerization | **Docker + Docker Compose** | Consistent environments |
| Orchestration | **Railway / Render (early)** → **ECS / GKE (later)** | Start simple, scale when needed |
| Object Storage | **Cloudflare R2** (cloud) / **MinIO** (self-hosted) | R2: zero egress fees; MinIO: on-premise option |
| CDN | **Cloudflare** | Free tier, global, DDoS protection |
| DNS | **Cloudflare** | DNS + CDN unified |
| Reverse Proxy | **Caddy** (auto TLS) / **Nginx** | Simple TLS, reverse proxy |
| Secrets | **Doppler** / **AWS Secrets Manager** | Never in code |

---

#### Observability

| Technology | Choice | Why |
|---|---|---|
| Error tracking | **Sentry** | Excellent developer experience, alerts |
| Logging | **Pino** (structured JSON) | Built into Fastify, near-zero overhead |
| Log aggregation | **Loki + Grafana** | Self-hosted, integrates with metrics |
| Metrics | **Prometheus + Grafana** | Industry standard |
| Uptime | **Better Uptime** | Simple, reliable |
| APM | **OpenTelemetry** | Vendor-neutral, traces |

---

#### Email

| Technology | Choice | Why |
|---|---|---|
| Email service | **Resend** | Developer-first, generous free tier, React Email templates |
| Templates | **React Email** | Code-first email templates |

---

#### AI (Phase 7)

| Technology | Choice | Why |
|---|---|---|
| LLM | **Google Gemini 1.5 Flash** | Tool calling, long context, pricing |
| Embeddings | **Google text-embedding-004** | Consistent with LLM provider |
| Vector search | **pgvector (PostgreSQL)** | No extra service to manage early on |
| Orchestration | **Vercel AI SDK** or custom | Streaming, tool calling abstractions |

---

#### CI/CD

| Technology | Choice | Why |
|---|---|---|
| Version control | **GitHub** | Standard |
| CI/CD | **GitHub Actions** | Integrated, generous free tier |
| Container registry | **GitHub Container Registry (GHCR)** | Free with GitHub |
| Deployment | Push-to-deploy via CI | Simple, auditable |

---

### 17.2 Stack Tradeoffs Summary

| Decision | Tradeoff |
|---|---|
| Node.js over Go/Rust | Slower raw performance, but much faster development for a small team |
| Fastify over NestJS | Less structure upfront, but avoids over-engineering |
| Drizzle over Prisma | Less magic = more control; requires more explicit query writing |
| PostgreSQL over MongoDB | Relational model is the right fit; JSONB covers flexible data |
| Monolith over microservices | Operationally simpler; can be extracted later |
| R2 over S3 | Zero egress costs; S3-compatible API means no lock-in |

### 17.3 Scale Expectations

| Metric | Phase 1 (MVP) | Phase 5 | Phase 10 |
|---|---|---|---|
| Concurrent users | 200 | 2,000 | 20,000+ |
| DB records | 100K | 5M | 100M+ |
| API requests/day | 50K | 500K | 10M+ |
| Infrastructure | Single server | 3–5 nodes | K8s cluster |

Current stack handles Phase 1–5 without significant changes. Phase 10 may require read replicas, connection pooling (PgBouncer), and service extraction for AI/reporting.

---

## 18. Repository Structure

```
smart-campus-os/
│
├── apps/
│   ├── web/                          # Next.js web application
│   │   ├── app/                      # App Router pages & layouts
│   │   │   ├── (auth)/               # Login, register, reset
│   │   │   ├── (student)/            # Student portal
│   │   │   ├── (faculty)/            # Faculty portal
│   │   │   ├── (hod)/                # HOD portal
│   │   │   └── (admin)/              # Admin panel
│   │   ├── components/               # App-specific components
│   │   ├── hooks/                    # Custom React hooks
│   │   ├── lib/                      # Utilities, API client
│   │   └── public/                   # Static assets
│   │
│   └── mobile/                       # React Native (Expo) — Phase 2
│       ├── app/                      # Expo Router screens
│       ├── components/               # Mobile-specific components
│       └── lib/                      # Utilities
│
├── packages/
│   ├── ui/                           # Shared design system components
│   │   ├── components/               # Button, Input, Card, Badge, etc.
│   │   ├── tokens/                   # Design tokens (colors, spacing, typography)
│   │   └── index.ts
│   │
│   ├── types/                        # Shared TypeScript types and interfaces
│   │   ├── api/                      # API request/response types
│   │   ├── domain/                   # Domain entity types
│   │   └── index.ts
│   │
│   ├── schemas/                      # Shared Zod validation schemas
│   │   ├── auth.ts
│   │   ├── student.ts
│   │   ├── attendance.ts
│   │   └── index.ts
│   │
│   └── utils/                        # Pure utility functions (shared)
│       ├── dates.ts
│       ├── formatting.ts
│       └── index.ts
│
├── backend/                          # Fastify backend application
│   ├── src/
│   │   ├── app.ts                    # Fastify app initialization
│   │   ├── server.ts                 # Server entry point
│   │   ├── config/                   # Configuration, env validation
│   │   │   ├── env.ts                # Zod env schema
│   │   │   └── index.ts
│   │   ├── modules/
│   │   │   ├── auth/
│   │   │   │   ├── auth.routes.ts
│   │   │   │   ├── auth.service.ts
│   │   │   │   ├── auth.repository.ts
│   │   │   │   ├── auth.schema.ts
│   │   │   │   └── auth.types.ts
│   │   │   ├── people/
│   │   │   │   ├── students/
│   │   │   │   ├── faculty/
│   │   │   │   └── staff/
│   │   │   ├── academic/
│   │   │   │   ├── departments/
│   │   │   │   ├── programs/
│   │   │   │   ├── batches/
│   │   │   │   ├── semesters/
│   │   │   │   ├── sections/
│   │   │   │   └── subjects/
│   │   │   ├── attendance/
│   │   │   │   ├── attendance.routes.ts
│   │   │   │   ├── attendance.service.ts
│   │   │   │   ├── attendance.repository.ts
│   │   │   │   └── ...
│   │   │   ├── timetable/
│   │   │   ├── service-requests/
│   │   │   │   ├── engine/           # Core workflow engine
│   │   │   │   ├── types/            # Service type definitions
│   │   │   │   └── ...
│   │   │   ├── helpdesk/
│   │   │   ├── notifications/
│   │   │   │   ├── channels/         # email, push, in-app
│   │   │   │   └── ...
│   │   │   ├── audit/
│   │   │   └── ai/                   # Phase 7
│   │   │       ├── tools/            # AI tool definitions
│   │   │       ├── rag/              # Document chunking, search
│   │   │       └── conversation/
│   │   ├── shared/
│   │   │   ├── database/
│   │   │   │   ├── client.ts         # Drizzle client
│   │   │   │   ├── schema/           # Drizzle schema definitions
│   │   │   │   └── migrations/
│   │   │   ├── cache/                # Redis client, helpers
│   │   │   ├── queue/                # BullMQ setup, job definitions
│   │   │   ├── storage/              # S3/R2 client
│   │   │   ├── errors/               # Error classes
│   │   │   ├── middleware/
│   │   │   │   ├── authenticate.ts
│   │   │   │   ├── authorize.ts
│   │   │   │   └── audit.ts
│   │   │   └── utils/
│   │   └── workers/                  # BullMQ worker processes
│   │       ├── email.worker.ts
│   │       ├── push.worker.ts
│   │       ├── pdf.worker.ts
│   │       └── sla.worker.ts
│   ├── tests/
│   │   ├── unit/
│   │   ├── integration/
│   │   └── fixtures/
│   └── package.json
│
├── database/
│   ├── migrations/                   # SQL migration files (Drizzle Kit)
│   ├── seeds/                        # Seed data for development
│   │   ├── dev-seed.ts               # Full dev environment seed
│   │   └── demo-seed.ts              # Demo college seed
│   └── schema/                       # Canonical schema reference
│
├── infrastructure/
│   ├── docker/
│   │   ├── docker-compose.yml        # Local development
│   │   ├── docker-compose.prod.yml   # Production reference
│   │   ├── Dockerfile.backend
│   │   └── Dockerfile.web
│   ├── caddy/
│   │   └── Caddyfile                 # Reverse proxy config
│   ├── scripts/
│   │   ├── setup-dev.sh              # One-command dev setup
│   │   └── backup-db.sh              # Database backup script
│   └── terraform/                    # Future: IaC for cloud
│
├── docs/
│   ├── architecture/                 # This document and derivatives
│   ├── api/                          # API documentation (auto-generated)
│   ├── runbooks/                     # Operational runbooks
│   ├── decisions/                    # Architecture Decision Records (ADR)
│   └── onboarding/                   # Developer onboarding guide
│
├── .github/
│   └── workflows/
│       ├── ci.yml                    # Tests, lint, type-check
│       ├── deploy-staging.yml        # Deploy on push to `main`
│       └── deploy-production.yml     # Deploy on release tag
│
├── turbo.json                        # Turborepo build orchestration
├── package.json                      # Root workspace package.json
├── pnpm-workspace.yaml               # pnpm workspaces
└── README.md
```

**Monorepo tool:** Turborepo (build caching, pipeline orchestration)  
**Package manager:** pnpm (fast, strict, disk-efficient)

---

## 19. Development Roadmap

### Milestone 0 — Foundation (Weeks 1–2)

**Goal:** Every developer can run the full stack locally in one command.

**Tasks:**
- [ ] Initialize monorepo (Turborepo + pnpm)
- [ ] Set up Next.js web app
- [ ] Set up Fastify backend
- [ ] Configure TypeScript across all packages
- [ ] Set up PostgreSQL + Redis via Docker Compose
- [ ] Configure Drizzle ORM with initial schema
- [ ] Set up Zod environment validation
- [ ] Configure ESLint + Prettier
- [ ] Set up GitHub Actions (CI: type-check, lint, test)
- [ ] Create dev seed script
- [ ] Initialize shared `packages/types`, `packages/schemas`, `packages/ui`
- [ ] Set up Sentry (error tracking)

**Definition of Done:** `pnpm dev` starts all services. `pnpm test` passes. CI is green.

---

### Milestone 1 — Authentication (Weeks 3–4)

**Goal:** Users can register, log in, and receive scoped tokens.

**Tasks:**
- [ ] User table + password_hash
- [ ] POST /auth/login — JWT + refresh token
- [ ] POST /auth/refresh — token rotation
- [ ] POST /auth/logout
- [ ] POST /auth/forgot-password
- [ ] POST /auth/reset-password
- [ ] Role + Permission tables
- [ ] `authenticate` middleware
- [ ] `authorize` middleware
- [ ] Redis-cached permission lookup
- [ ] Login page (Next.js)
- [ ] Basic JWT storage + refresh logic in web app
- [ ] Email sending (Resend integration)
- [ ] Account lockout after failed attempts
- [ ] Audit log for auth events

**Definition of Done:** Admin can log in. Student can log in. Invalid tokens are rejected. Roles are enforced.

---

### Milestone 2 — Academic Structure (Weeks 5–7)

**Goal:** Full academic hierarchy is configurable.

**Tasks:**
- [ ] Organization, Campus, Department entities + CRUD APIs
- [ ] Program, Batch, Semester entities + CRUD APIs
- [ ] Section, Subject, SubjectOffering entities + CRUD APIs
- [ ] Student profile creation + bulk import (CSV)
- [ ] Faculty profile creation
- [ ] Enrollment (link student to section/semester)
- [ ] Admin UI: Organization setup wizard
- [ ] Admin UI: Department, Program management
- [ ] Admin UI: Semester setup flow
- [ ] Admin UI: Student bulk import with validation

**Definition of Done:** Admin can configure a complete college structure and import 100 test students.

---

### Milestone 3 — Attendance (Weeks 8–11)

**Goal:** Faculty can mark attendance; students can view their own.

**Tasks:**
- [ ] ClassSession CRUD
- [ ] POST /class-sessions/:id/attendance (bulk mark)
- [ ] GET /attendance/my/summary
- [ ] GET /attendance/my/subject/:id
- [ ] Faculty Dashboard (today's classes, quick mark)
- [ ] Attendance marking UI (roster with present/absent toggle)
- [ ] Student Dashboard (attendance cards, subject-wise)
- [ ] Attendance reports for HOD
- [ ] At-risk student notifications
- [ ] Timetable (basic CRUD + student view)

**Definition of Done:** Faculty can mark a class. Student can see updated attendance. HOD can see department summary.

---

### Milestone 4 — Service Requests (Weeks 12–15)

**Goal:** Students can submit requests; staff can process them.

**Tasks:**
- [ ] ServiceType configuration (admin)
- [ ] Workflow engine (step-based, configurable)
- [ ] POST /service-requests (submit)
- [ ] GET /service-requests/my
- [ ] PATCH /service-requests/:id/step (process)
- [ ] Built-in service types: BONAFIDE, ID_CARD, ATTENDANCE_CORRECTION
- [ ] Dynamic form renderer (form_schema)
- [ ] File attachment support
- [ ] Reference number generation
- [ ] Notification integration (submit, update, complete)
- [ ] SLA tracking + alerts
- [ ] Student requests screen
- [ ] Staff/admin requests processing screen
- [ ] Basic PDF generation for bonafide certificate

**Definition of Done:** Student submits bonafide request. HOD approves it. Student receives email and can download PDF.

---

### Milestone 5 — Helpdesk (Weeks 16–18)

**Goal:** Students can raise tickets; support staff can manage them.

**Tasks:**
- [ ] Ticket CRUD
- [ ] Category and department configuration
- [ ] Priority and SLA
- [ ] Ticket conversation (public + internal notes)
- [ ] File attachments
- [ ] Auto-assignment rules
- [ ] SLA breach alerts
- [ ] Escalation rules
- [ ] Feedback after resolution
- [ ] Status history
- [ ] Student ticket creation UI
- [ ] Support staff ticket queue UI

**Definition of Done:** Student raises ticket, support staff responds and resolves it, student receives feedback prompt.

---

### Milestone 6 — Notifications & Polish (Weeks 19–20)

**Goal:** The system feels complete and production-ready for first deployment.

**Tasks:**
- [ ] In-app notification center (bell icon, mark-as-read)
- [ ] Email notification templates (React Email)
- [ ] Push notification foundation (web push)
- [ ] Notification preferences (user settings)
- [ ] Empty states and loading states audit
- [ ] Error handling and error pages (404, 500)
- [ ] Accessibility audit
- [ ] Performance audit (Lighthouse)
- [ ] Security review (OWASP checklist)
- [ ] End-to-end test coverage for critical paths
- [ ] Staging deployment
- [ ] Documentation: admin onboarding guide, user guide
- [ ] Production deployment checklist

**Definition of Done:** System deployed to staging, tested by the team, ready for pilot college deployment.

---

## 20. Risks

### 20.1 Technical Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| PostgreSQL performance at scale | Medium | High | Connection pooling (PgBouncer), read replicas, query optimization, indexes from day 1 |
| Monolith becomes unmaintainable | Low | High | Strict module boundaries, no cross-module direct DB access |
| ORM generating bad queries | Medium | Medium | Drizzle produces SQL you can inspect; add explain analyze on slow queries |
| File storage costs spike | Low | Medium | R2 has zero egress. Enforce file size limits. |
| Real-time attendance conflicts (concurrent marking) | Medium | High | Database-level unique constraint on (session_id, student_id); use transactions |

### 20.2 Security Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Student accesses another student's data | Low | Critical | RLS + application-level org isolation + tests |
| JWT stolen from memory (XSS) | Low | High | Strict CSP, no innerHTML, React escaping, Helmet |
| Brute-force login | Medium | High | Rate limiting, account lockout, CAPTCHA |
| Credential stuffing | Medium | Medium | Account lockout per email, anomaly detection |
| Insecure file upload | Medium | High | Server-side type validation, antivirus scanning, private buckets |
| AI prompt injection | Medium | Medium | Input sanitization, system prompt anchoring, output moderation |
| Privilege escalation via role manipulation | Low | Critical | Server-side role verification, never trust client roles |

### 20.3 Product Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Low adoption by faculty | High | Critical | Simple, fast attendance marking; onboarding training; admin mandate |
| Incorrect attendance data leads to distrust | Medium | Critical | Clear correction workflows, audit trail, faculty ownership |
| College admin unable to set up system | Medium | High | Setup wizard, good documentation, onboarding support |
| Feature scope creep before MVP | High | High | Ruthless MVP definition, written-down non-goals |
| Colleges need features that require core changes | Medium | Medium | Modular design, early pilot feedback |

### 20.4 Data Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Database backup failure | Low | Critical | Automated daily backups + restore testing monthly |
| Data loss during migration | Medium | High | Blue-green deployment, full backup before migration |
| Corrupt import data | High | Medium | CSV validation with preview before import |
| GDPR-equivalent data requests | Low | Medium | Soft-delete, data export capability |

### 20.5 AI Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| AI provides incorrect information | Medium | High | Grounding in structured data tools, not free-form generation for data |
| AI creates unauthorized actions | Low | Critical | Actions require explicit confirmation, AI uses student's own JWT |
| LLM API provider outage | Medium | Medium | Graceful degradation (disable AI, not whole app) |
| LLM cost overrun | Medium | Medium | Per-user rate limiting, monitoring, caching common queries |
| Student over-reliance on AI | Low | Low | AI clearly presents itself as an assistant, not a definitive authority |

### 20.6 Operational Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Team too small for scope | High | High | Phased delivery, MVP discipline |
| Key developer leaves | Medium | High | Documentation, code reviews, no hero code |
| Third-party service outage (Resend, R2) | Low | Medium | Graceful degradation, retry queues |
| On-premise deployment required by college | Medium | Medium | Docker Compose self-hosted option designed from the start |

---

## 21. Recommended First Milestone

**Build Milestone 0 + Milestone 1 together as "Week 1–4 Sprint".**

This gives us:
1. A working codebase that the entire team can run locally
2. Authentication that real users can use
3. The authorization foundation that all future modules depend on
4. CI/CD pipeline that catches regressions

**The exact first day of coding should be:**

1. Initialize the monorepo with Turborepo + pnpm
2. Create the `backend` Fastify app with TypeScript
3. Create the `apps/web` Next.js app
4. Configure Docker Compose (PostgreSQL + Redis)
5. Write the Drizzle schema for `users`, `organizations`, `roles`, `permissions`
6. Write the first migration
7. Implement `/auth/login` and `/auth/refresh`
8. Write the `authenticate` middleware
9. Make the CI pipeline green

**Nothing else matters before this works.**

---

## 22. Questions & Decisions Requiring Your Approval

Before proceeding to implementation, I need your decision on the following:

### A. Deployment Strategy (Critical)

> Should the system be **cloud-only** (AWS/GCP), **self-hosted only** (Docker on college server), or **hybrid** (cloud-first with self-hosted option)?

**Recommendation:** Design for self-hosted (Docker Compose) first. Most Indian colleges will want data on their own servers or will not have reliable cloud budgets. Cloud-hosted SaaS can be offered as a premium option.

---

### B. Multi-tenancy Launch Strategy

> Should the first version support **one college** only, or **multiple colleges from day one**?

**Recommendation:** Build multi-tenancy into the data model from day one (it's in the schema above), but expose only single-college management in the UI. This avoids painful retrofitting later.

---

### C. PWA vs Native Mobile App

> Should we build a **PWA** first (simpler, faster, no app store) or go straight to **React Native**?

**Recommendation:** PWA for MVP. React Native in Phase 2. PWA covers 80% of student use cases. This saves 8–12 weeks in MVP.

---

### D. Biometric Attendance Integration

> Is **biometric/RFID attendance device integration** a requirement for MVP or Phase 1, or is manual faculty marking sufficient?

**Recommendation:** Manual faculty marking for MVP. Biometric integration is a hardware integration problem — defer to Phase 3+. Design the `attendance_records` schema to support `source: 'MANUAL' | 'BIOMETRIC' | 'QR_CODE'` from the start.

---

### E. On-Premise vs Cloud Storage

> For colleges that want data on-premise, should the MVP support **MinIO** (self-hosted S3-compatible) or is cloud storage (R2/S3) acceptable?

**Recommendation:** Support both via an abstracted storage interface. The code uses the same S3 SDK for both. Configuration determines which endpoint is used.

---

### F. Communication Language

> Should the student-facing UI support **multiple languages** (English + regional languages like Hindi, Tamil, etc.) or English-only for MVP?

**Recommendation:** English-only for MVP. Build with i18n support in the codebase (next-intl) so localization can be added without refactoring. Add Hindi as the first localization in Phase 2.

---

### G. Parent/Guardian Portal

> Should the **parent portal** be included in MVP or Phase 2+?

**Recommendation:** Exclude from MVP. Parents see limited data (attendance alerts only). Build in Phase 2 as a read-only view. Architecture already supports `parent_student_links` table addition.

---

### H. Examination & Results

> Is **exam management and results** required before first college deployment, or can the college use their existing system for exams temporarily?

**Recommendation:** Defer exams to Phase 4. Focus MVP on attendance + service requests. This is the biggest scope risk if included in MVP.

---

## What I Should Do Next

Here are your exact next steps, in order:

---

### Step 1 — Review and Approve This Document (Today)

Read through each section. For each section in [Section 22 — Questions & Decisions](#22-questions--decisions-requiring-approval), give me a decision.

Mark any section where you disagree with my recommendation or want a different approach.

---

### Step 2 — Answer the 8 Decisions in Section 22

These decisions affect:
- Technology choices (storage, mobile)
- Development timeline (scope)
- Architecture (multi-tenancy)

You cannot start coding without these answers.

---

### Step 3 — Pilot College Identification

Identify the **one specific college** where you will do the first deployment.

I need:
- Approximate number of students
- Approximate number of faculty
- Number of departments
- Current tools they use (spreadsheets? existing ERP?)
- Technical contact at the college

This will inform how we seed data and what the onboarding flow should look like.

---

### Step 4 — Team Definition

Tell me:
- How many engineers are on the team?
- What are their current skill levels (Node.js? React? PostgreSQL?)
- Are there any existing tools/codebases we must integrate with or avoid?

---

### Step 5 — After Approvals: Initialize the Repository

Once you've answered the above, come back and say:

> "Start coding Milestone 0."

I will then:
1. Create the monorepo structure
2. Set up Docker Compose
3. Initialize Fastify backend + Next.js frontend
4. Create the Drizzle schema
5. Write the first migration
6. Implement authentication
7. Set up CI/CD

We will have a running, authenticated system within the first week.

---

*Smart Campus OS Architecture Specification v1.0 — End of Document*
