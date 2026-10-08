# Smart Campus OS — Architecture Specification v2.0

> **Document Status:** Approved — Decisions Locked  
> **Date:** October 2026  
> **Version:** 2.0 (decisions incorporated)  
> **Classification:** Confidential — Internal Architecture

---

## Decision Log (All Locked)

| # | Decision | Answer | Impact |
|---|---|---|---|
| A | Deployment | **Hybrid** (Cloud SaaS + Self-hosted Docker) | Docker-first design, cloud-compatible |
| B | Multi-tenant UI | **Single-college MVP** (multi-tenant data model underneath) | Simpler admin UI for MVP |
| C | Mobile | **PWA first** → React Native Phase 2 | Saves 8–12 weeks in MVP |
| D | Attendance | **Smart Face Attendance** (AI-powered, not biometric hardware) | Major new module — see Section 8 |
| E | Storage | **Both R2 + MinIO** via storage abstraction layer | Flexible per deployment |
| F | Languages | **English-only MVP**, i18n-ready codebase | next-intl wired, no translations yet |
| G | Parent Portal | **No MVP** — deferred to Phase 2 | Architecture supports it |
| H | Exams & Results | **No MVP** — deferred to Phase 4 | Saves 6–8 weeks |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Updated Architecture Decisions](#2-updated-architecture-decisions)
3. [Smart Face Attendance Architecture](#3-smart-face-attendance-architecture)
4. [Hybrid Deployment Architecture](#4-hybrid-deployment-architecture)
5. [Storage Abstraction Layer](#5-storage-abstraction-layer)
6. [PWA Architecture](#6-pwa-architecture)
7. [Domain Model (Updated)](#7-domain-model-updated)
8. [Database Architecture (Updated)](#8-database-architecture-updated)
9. [Security Architecture (Updated)](#9-security-architecture-updated)
10. [Technology Stack (Updated)](#10-technology-stack-updated)
11. [Repository Structure (Updated)](#11-repository-structure-updated)
12. [Development Roadmap (Updated)](#12-development-roadmap-updated)
13. [Risks (Updated)](#13-risks-updated)
14. [What I Should Do Next](#what-i-should-do-next)

---

## 1. Executive Summary

This document updates the v1.0 architecture specification with all founder decisions incorporated. The most architecturally significant new decision is **Smart Face Attendance** — replacing hardware biometric with an AI-powered face recognition system where students' faces are enrolled digitally and attendance is marked via camera during class.

The second significant addition is **Hybrid Deployment** — the system must run identically on cloud (for SaaS customers) and on-premise via Docker Compose (for colleges that want data on their own servers).

All other decisions (PWA, storage abstraction, single-college MVP, i18n-ready, no parent portal, no exams) are incorporated throughout.

---

## 2. Updated Architecture Decisions

### 2.1 Hybrid Deployment

The system is packaged as Docker containers from day one. This single design decision affects:

- **No cloud-only dependencies** — No services that don't have a self-hosted equivalent
- **Environment-agnostic configuration** — All secrets via environment variables
- **Storage abstraction** — Code doesn't know if it's talking to R2 or MinIO
- **Email abstraction** — Code doesn't know if it's using Resend or a local SMTP server
- **Two Docker Compose files:**
  - `docker-compose.dev.yml` — local development
  - `docker-compose.prod.yml` — self-hosted production (all services, no cloud)

### 2.2 Single-College MVP UI

The **data model** is multi-tenant (organization_id everywhere). The **admin UI** for v1 exposes only single-college management. The benefit: when we add multi-college management in Phase 2, it's a UI addition, not a data model change.

### 2.3 Smart Face Attendance

See Section 3 for the full architecture. Summary:
- Students enroll their face once (during onboarding)
- Faculty starts a class session and activates face attendance
- Students' faces captured via camera → recognized → attendance marked automatically
- Liveness detection to prevent photo spoofing
- Manual fallback always available
- Strict privacy controls and consent

---

## 3. Smart Face Attendance Architecture

### 3.1 System Overview

```
┌─────────────────────────────────────────────────────────┐
│              SMART FACE ATTENDANCE SYSTEM               │
│                                                         │
│  ┌──────────────┐      ┌──────────────────────────┐    │
│  │  Enrollment  │      │   Live Attendance         │    │
│  │  (One-time)  │      │   (Every Class)           │    │
│  └──────┬───────┘      └──────────┬────────────────┘   │
│         │                         │                     │
│         ▼                         ▼                     │
│  ┌──────────────┐      ┌──────────────────────────┐    │
│  │ Face Capture │      │ Camera Feed / Selfie      │    │
│  │ (Student     │      │ (Faculty device or        │    │
│  │  Selfie x5)  │      │  Student selfie check-in) │    │
│  └──────┬───────┘      └──────────┬────────────────┘   │
│         │                         │                     │
│         ▼                         ▼                     │
│  ┌──────────────────────────────────────────────────┐  │
│  │           Face Recognition Service               │  │
│  │   (Self-hosted: InsightFace / DeepFace)          │  │
│  │   (Cloud: AWS Rekognition / Azure Face)          │  │
│  │                                                  │  │
│  │  Enrollment: Extract & store face embedding      │  │
│  │  Recognition: Match embedding → student_id       │  │
│  │  Liveness: Detect real face vs. photo            │  │
│  └──────────────────────┬───────────────────────────┘  │
│                         │                               │
│                         ▼                               │
│  ┌──────────────────────────────────────────────────┐  │
│  │           Attendance Backend Module              │  │
│  │   - Validate recognition result                  │  │
│  │   - Check student is enrolled in section         │  │
│  │   - Mark attendance record                       │  │
│  │   - Store audit log                              │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Two Modes of Face Attendance

#### Mode A: Faculty Camera Scan (Classroom Mode)
- Faculty opens class session on tablet/laptop
- Camera captures the class (group photo or scan)
- Face recognition service identifies all visible students
- Results presented to faculty for review
- Faculty confirms or adjusts
- Attendance saved

#### Mode B: Student Selfie Check-in (Individual Mode)
- Faculty starts a class session (generates a time-limited session token)
- Students open their mobile app within the session window (e.g., 10 minutes)
- Student taps "Check In" → front camera activates
- Student captures a selfie
- Liveness check runs first (blink/smile detection OR depth analysis)
- Selfie sent to face recognition service
- If matched with enrollment face: marked PRESENT
- Confirmation shown to student
- Faculty sees real-time attendance fill in

**Recommended default: Mode B (Student Selfie)** — does not require a room camera, scales to any device, is less invasive, and is easier to deploy at any college.

### 3.3 Face Enrollment Flow

```
Student logs in for the first time
→ Prompted: "Set up Face Attendance"
→ Explanation of what data is collected and why
→ Explicit consent checkbox (mandatory)
→ Front camera activates
→ Student captures 5 selfies (different angles: straight, left, right, up, down)
→ Liveness check during capture (detect real person)
→ Face embeddings extracted (NOT raw images stored in production)
→ Embeddings stored in face_embeddings table
→ Student can re-enroll or revoke consent at any time
```

### 3.4 Face Recognition Engine

#### Option A: Self-Hosted (Recommended for on-premise colleges)

**Technology: InsightFace (Python microservice)**

```
insightface-service/
  ├── main.py           # FastAPI or Flask server
  ├── recognition.py    # Embedding extraction + matching
  ├── liveness.py       # Anti-spoofing checks
  └── Dockerfile
```

**API exposed to backend:**
```
POST /enroll
  Body: { student_id, images: [base64, ...] }
  Returns: { embedding_id, quality_score }

POST /recognize
  Body: { image: base64, session_context: { section_id, semester_id } }
  Returns: { matches: [{ student_id, confidence }], is_live: bool }

DELETE /embeddings/:student_id
  Body: {}
  Returns: { success: true }
```

**Why InsightFace:**
- State-of-the-art accuracy (ArcFace model)
- Open source, no per-call cost
- Can run on CPU (adequate for MVP), GPU (for faster processing)
- Self-hostable in Docker

#### Option B: Cloud (Recommended for cloud-hosted SaaS)

**Technology: AWS Rekognition or Azure Face API**

- No infrastructure to manage
- Pay per API call (~$0.001 per face detection)
- Higher accuracy for diverse populations
- Built-in liveness detection (AWS Rekognition Face Liveness)
- Less control over data

**Architecture abstraction:**

```typescript
// packages/face-recognition/src/index.ts
interface FaceRecognitionProvider {
  enroll(studentId: string, images: Buffer[]): Promise<EnrollmentResult>
  recognize(image: Buffer, context: ClassContext): Promise<RecognitionResult[]>
  deleteEnrollment(studentId: string): Promise<void>
  livenessCheck(sessionId: string): Promise<LivenessResult>
}

// Implementations:
class InsightFaceProvider implements FaceRecognitionProvider { ... }
class AWSRekognitionProvider implements FaceRecognitionProvider { ... }
class AzureFaceProvider implements FaceRecognitionProvider { ... }

// Selected via environment variable:
// FACE_RECOGNITION_PROVIDER=insightface|aws|azure
```

### 3.5 Liveness Detection

Preventing photo spoofing is critical for attendance integrity.

**Liveness strategy:**

| Method | Works With | Accuracy |
|---|---|---|
| Active liveness (blink/gesture) | Mode B (selfie) | High |
| Passive liveness (depth/texture analysis) | Both modes | Very High |
| Challenge-response (random gesture) | Mode B (selfie) | Highest |

**MVP approach:**
- **InsightFace**: Use built-in passive anti-spoofing (FaceAntiSpoofing model)
- **AWS Rekognition**: Use Face Liveness API (challenge-response)
- Confidence threshold: >85% for liveness acceptance
- On liveness failure: prompt student to retry; after 3 failures, escalate to manual

### 3.6 Data Model for Face Attendance

```sql
-- face_enrollments: links a student to their enrollment status
CREATE TABLE face_enrollments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_user_id   UUID NOT NULL UNIQUE REFERENCES users(id),
  organization_id   UUID NOT NULL REFERENCES organizations(id),
  status            VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  -- PENDING, ENROLLED, FAILED, REVOKED
  enrolled_at       TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  quality_score     DECIMAL(4,3),  -- 0.0 to 1.0
  provider          VARCHAR(30) NOT NULL DEFAULT 'insightface',
  -- External reference in the face recognition service
  external_ref      TEXT,
  consent_given_at  TIMESTAMPTZ,  -- MANDATORY consent timestamp
  consent_ip        INET,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- face_recognition_logs: immutable audit of every recognition attempt
CREATE TABLE face_recognition_logs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations(id),
  class_session_id      UUID NOT NULL REFERENCES class_sessions(id),
  student_user_id       UUID REFERENCES users(id),  -- NULL if unrecognized
  recognition_mode      VARCHAR(20) NOT NULL,  -- SELFIE, CLASSROOM_SCAN
  confidence_score      DECIMAL(4,3),
  liveness_score        DECIMAL(4,3),
  liveness_passed       BOOLEAN NOT NULL,
  result                VARCHAR(30) NOT NULL,  -- MATCHED, NO_MATCH, LIVENESS_FAILED
  attendance_record_id  UUID REFERENCES attendance_records(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add face_attendance_session to class_sessions
ALTER TABLE class_sessions ADD COLUMN face_attendance_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE class_sessions ADD COLUMN face_session_token VARCHAR(64);  -- time-limited
ALTER TABLE class_sessions ADD COLUMN face_session_expires_at TIMESTAMPTZ;
ALTER TABLE class_sessions ADD COLUMN face_session_window_minutes SMALLINT DEFAULT 10;

-- Attendance source tracking
ALTER TABLE attendance_records ADD COLUMN source VARCHAR(30) NOT NULL DEFAULT 'MANUAL';
-- MANUAL, FACE_SELFIE, FACE_CLASSROOM, BIOMETRIC_DEVICE (future)
ALTER TABLE attendance_records ADD COLUMN face_recognition_log_id UUID REFERENCES face_recognition_logs(id);
ALTER TABLE attendance_records ADD COLUMN face_confidence DECIMAL(4,3);
```

### 3.7 Face Attendance API Endpoints

```
POST /api/v1/class-sessions/:id/face/start
  — Faculty starts face attendance session
  — Returns: { session_token, expires_at, qr_code_url }
  — Permission: attendance.mark

GET /api/v1/class-sessions/:id/face/status
  — Real-time attendance progress (poll or SSE)
  — Returns: { total_enrolled, marked_present, not_yet_marked, processing }
  — Permission: attendance.mark

POST /api/v1/attendance/face/check-in
  — Student submits selfie for face check-in
  — Body: { session_token, image_base64 }
  — Returns: { status: PRESENT | LIVENESS_FAILED | SESSION_EXPIRED | NOT_ENROLLED }
  — Permission: attendance.checkin.own

GET /api/v1/attendance/face/enrollment/status
  — Student checks their own enrollment status
  — Permission: profile.read.own

POST /api/v1/attendance/face/enroll
  — Student submits enrollment selfies
  — Body: { images: [base64 x 5], consent: true }
  — Permission: profile.update.own

DELETE /api/v1/attendance/face/enroll
  — Student revokes face enrollment (GDPR right to erasure)
  — Permission: profile.update.own
  — Action: Calls face provider to delete embedding + marks revoked

POST /api/v1/attendance/face/classroom-scan
  — Faculty submits a group photo for classroom scanning (Mode A)
  — Body: { class_session_id, image_base64 }
  — Returns: { recognized: [{student_id, name, confidence}], unrecognized_count }
  — Permission: attendance.mark
```

### 3.8 Student Check-in Flow (Mobile)

```
Faculty taps "Start Face Attendance" on class session
→ System generates session_token + QR code (valid 10 min)
→ Faculty displays QR code on screen/projector

Student opens Smart Campus OS app
→ Dashboard shows: "📸 Face attendance active — DBMS — Check in by 9:10 AM"
→ Student taps "Check In"
→ App activates front camera
→ Liveness prompt: "Blink twice" (or passive analysis)
→ Student captures selfie
→ POST /attendance/face/check-in
→ Face recognition runs (~1–3 seconds)
→ Result shown immediately:
   ✅ "Attendance marked — PRESENT" (green)
   ❌ "Could not verify your face. Try again or ask faculty to mark manually."
→ Faculty dashboard updates in real-time

After session window closes:
→ Students not checked in: faculty reviews and marks manually or marks ABSENT
→ Session closed, attendance finalized
```

### 3.9 Privacy & Consent Architecture

Face data is biometric data. This must be treated with the highest level of care.

**Consent requirements:**
- Explicit opt-in consent before any face data is collected
- Consent timestamp and IP address recorded in DB
- Students can withdraw consent at any time
- On consent withdrawal: face embedding deleted from recognition service + DB record marked REVOKED
- Students who withdraw still receive manual attendance

**Data minimization:**
- Raw images NOT stored after embedding extraction (configurable per deployment)
- Only mathematical face embeddings stored
- Embeddings are not reversible to original image (they're feature vectors)
- For cloud providers: processed transiently, not stored by provider (verify per provider ToS)

**Data residency:**
- For self-hosted deployments: all face data stays on college servers
- For cloud SaaS: offer a choice of cloud region

**Transparency:**
- Admin portal shows: "X students enrolled, Y pending, Z revoked"
- Students can view their enrollment status and consent timestamp
- Admins can run a report: "Students without face enrollment" → offer manual attendance

### 3.10 Fallback to Manual Attendance

Face attendance never completely replaces manual. The system always allows:

1. **Manual override by faculty:** Faculty can always manually mark any student PRESENT/ABSENT regardless of face result
2. **Student escalation:** If 3+ liveness failures, student gets an in-app option to request manual marking
3. **Faculty-controlled mode:** Faculty can disable face attendance for a session and use manual marking
4. **Enrollment pending:** Students not enrolled in face system are always marked manually

This means **face attendance is an accelerator, not a gate**.

### 3.11 Face Attendance Accuracy & Audit

| Metric | Target |
|---|---|
| Recognition accuracy | >95% for enrolled students |
| Liveness detection accuracy | >99% (reject photos) |
| False positive rate | <0.5% (wrong student matched) |
| Processing time per selfie | <3 seconds |

Every recognition attempt is logged in `face_recognition_logs` with:
- Confidence score
- Liveness score
- Result (matched/no-match/liveness-failed)
- Link to resulting attendance record

This allows disputes to be investigated: "My face attendance was marked ABSENT — but I was there."

---

## 4. Hybrid Deployment Architecture

### 4.1 Deployment Topology

```
┌─────────────────────────────────────────────────────────────┐
│             DEPLOYMENT MODE A: CLOUD SAAS                   │
│                                                             │
│  Cloudflare CDN → Cloud Load Balancer → App Containers      │
│  ↓                                                          │
│  Managed PostgreSQL (Neon / RDS / Supabase)                 │
│  Managed Redis (Upstash / ElastiCache)                      │
│  Cloudflare R2 (object storage)                             │
│  Resend (email)                                             │
│  InsightFace service (containerized, cloud)                 │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│        DEPLOYMENT MODE B: SELF-HOSTED (COLLEGE SERVER)      │
│                                                             │
│  Caddy (reverse proxy + auto TLS) → Docker containers       │
│  ↓                                                          │
│  PostgreSQL container (college server)                      │
│  Redis container                                            │
│  MinIO container (S3-compatible object storage)             │
│  SMTP relay / local mail server                             │
│  InsightFace service container (CPU-based)                  │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Self-Hosted Docker Compose (Production)

```yaml
# docker-compose.prod.yml
version: '3.9'
services:

  web:
    image: ghcr.io/smart-campus-os/web:latest
    restart: unless-stopped
    env_file: .env
    ports:
      - "3000:3000"
    depends_on:
      - api

  api:
    image: ghcr.io/smart-campus-os/api:latest
    restart: unless-stopped
    env_file: .env
    depends_on:
      - postgres
      - redis
    ports:
      - "4000:4000"

  worker:
    image: ghcr.io/smart-campus-os/api:latest
    restart: unless-stopped
    env_file: .env
    command: ["node", "dist/workers/index.js"]
    depends_on:
      - postgres
      - redis

  face-service:
    image: ghcr.io/smart-campus-os/face-service:latest
    restart: unless-stopped
    env_file: .env
    ports:
      - "5000:5000"
    volumes:
      - face_models:/app/models  # persist downloaded models

  postgres:
    image: postgres:15-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: smartcampus
      POSTGRES_USER: ${DB_USER}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      - "127.0.0.1:5432:5432"  # local only

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: redis-server --requirepass ${REDIS_PASSWORD} --appendonly yes
    volumes:
      - redis_data:/data
    ports:
      - "127.0.0.1:6379:6379"  # local only

  minio:
    image: minio/minio:latest
    restart: unless-stopped
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
    volumes:
      - minio_data:/data
    ports:
      - "127.0.0.1:9000:9000"
      - "127.0.0.1:9001:9001"

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./infrastructure/caddy/Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - web
      - api

volumes:
  postgres_data:
  redis_data:
  minio_data:
  face_models:
  caddy_data:
  caddy_config:
```

### 4.3 Environment Configuration

The same codebase runs in both modes. The difference is only environment variables:

```bash
# .env.example (shared across both deployment modes)

# App
NODE_ENV=production
APP_URL=https://campus.yourdomain.com
APP_SECRET=<32-byte-random>

# Database
DATABASE_URL=postgresql://user:pass@postgres:5432/smartcampus

# Redis
REDIS_URL=redis://:password@redis:6379

# Storage (choose one mode)
STORAGE_PROVIDER=r2   # or: minio, s3
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=

# MinIO (self-hosted)
MINIO_ENDPOINT=http://minio:9000
MINIO_ACCESS_KEY=
MINIO_SECRET_KEY=
MINIO_BUCKET=smartcampus

# Email (choose one mode)
EMAIL_PROVIDER=resend   # or: smtp
RESEND_API_KEY=
# SMTP fallback:
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=
EMAIL_FROM=no-reply@yourdomain.com

# Face Recognition
FACE_RECOGNITION_PROVIDER=insightface   # or: aws, azure
INSIGHTFACE_SERVICE_URL=http://face-service:5000
AWS_REKOGNITION_REGION=
AWS_REKOGNITION_COLLECTION_ID=

# JWT
JWT_PRIVATE_KEY_PATH=/run/secrets/jwt_private_key
JWT_PUBLIC_KEY_PATH=/run/secrets/jwt_public_key

# Monitoring
SENTRY_DSN=
```

### 4.4 Minimum Hardware Requirements (Self-Hosted)

| Config | Users | Specs | Est. Cost (India) |
|---|---|---|---|
| Small College | <500 students | 4 vCPU, 8GB RAM, 100GB SSD | ₹3,000–5,000/month (VPS) |
| Medium College | 500–3000 students | 8 vCPU, 16GB RAM, 500GB SSD | ₹8,000–15,000/month |
| Large College | 3000+ students | 16 vCPU, 32GB RAM, 1TB SSD | ₹20,000–40,000/month |

> **Note:** Face recognition with InsightFace on CPU: ~1–3 seconds per selfie. Adequate for asynchronous individual check-in. For classroom scanning (group photos), GPU recommended for faster batch processing.

---

## 5. Storage Abstraction Layer

### 5.1 Interface Definition

```typescript
// packages/storage/src/types.ts
export interface StorageProvider {
  upload(key: string, buffer: Buffer, options: UploadOptions): Promise<string>
  getPresignedDownloadUrl(key: string, expiresInSeconds: number): Promise<string>
  getPresignedUploadUrl(key: string, options: PresignOptions): Promise<PresignedUpload>
  delete(key: string): Promise<void>
  exists(key: string): Promise<boolean>
}

export interface UploadOptions {
  contentType: string
  contentLength?: number
  metadata?: Record<string, string>
}

export interface PresignedUpload {
  url: string
  fields?: Record<string, string>  // for S3 form upload
  key: string
  expiresAt: Date
}
```

### 5.2 Provider Implementations

```typescript
// packages/storage/src/providers/r2.ts
export class R2StorageProvider implements StorageProvider {
  private client: S3Client  // AWS SDK v3 (R2 is S3-compatible)
  // ...
}

// packages/storage/src/providers/minio.ts
export class MinIOStorageProvider implements StorageProvider {
  private client: S3Client  // Same AWS SDK v3 — MinIO uses S3 API
  // ...
}

// packages/storage/src/providers/s3.ts
export class S3StorageProvider implements StorageProvider {
  private client: S3Client
  // ...
}

// packages/storage/src/index.ts
export function createStorageProvider(config: Config): StorageProvider {
  switch (config.STORAGE_PROVIDER) {
    case 'r2': return new R2StorageProvider(config)
    case 'minio': return new MinIOStorageProvider(config)
    case 's3': return new S3StorageProvider(config)
    default: throw new Error(`Unknown storage provider: ${config.STORAGE_PROVIDER}`)
  }
}
```

> **Key insight:** All three providers use the same AWS SDK v3 `S3Client`. The difference is only the endpoint URL. This makes the abstraction extremely thin — no significant code difference between providers.

### 5.3 File Key Conventions

```
{organization_id}/profiles/{user_id}/avatar.jpg
{organization_id}/requests/{request_id}/{filename}
{organization_id}/tickets/{ticket_id}/{filename}
{organization_id}/documents/generated/{request_id}/bonafide.pdf
{organization_id}/face-enrollments/{student_user_id}/  ← sensitive bucket/prefix
```

Face enrollment images (if stored) go into a separate bucket with stricter access policies.

---

## 6. PWA Architecture

### 6.1 Why PWA First

| Factor | PWA | React Native |
|---|---|---|
| Dev time (MVP) | ~4 weeks | ~12–16 weeks |
| App Store needed | No | Yes |
| Installable on phone | Yes (Add to Home Screen) | Yes |
| Offline capability | Partial (Service Worker) | Full |
| Push notifications | Web Push (limited on iOS 16.4+) | Full (FCM/APNs) |
| Camera access (selfie) | ✅ (getUserMedia API) | ✅ |
| Face capture quality | Good | Better |
| Performance (attendance marking) | Adequate | Better |

**For MVP: PWA is sufficient.** The face check-in selfie works fine in a mobile browser using `getUserMedia`. Push notifications work on Android Chrome; iOS support improved from iOS 16.4+ (still limited, but functional).

### 6.2 PWA Configuration

```javascript
// apps/web/public/manifest.json
{
  "name": "Smart Campus OS",
  "short_name": "CampusOS",
  "description": "Your college, in your pocket.",
  "start_url": "/student",
  "display": "standalone",
  "background_color": "#1a1a2e",
  "theme_color": "#6366f1",
  "orientation": "portrait",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "categories": ["education"],
  "shortcuts": [
    { "name": "My Attendance", "url": "/student/attendance", "icons": [...] },
    { "name": "New Request", "url": "/student/requests/new", "icons": [...] }
  ]
}
```

```typescript
// apps/web/app/layout.tsx — viewport meta for mobile
export const metadata = {
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    title: 'Campus OS',
    statusBarStyle: 'black-translucent',
  },
  viewport: {
    width: 'device-width',
    initialScale: 1,
    maximumScale: 1,  // Prevent zoom on input focus
    userScalable: false,
  },
}
```

### 6.3 Camera Access (PWA)

For face attendance selfie in PWA:

```typescript
// apps/web/components/face/FaceCapture.tsx
async function captureWithLiveness() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: 'user',  // front camera
      width: { ideal: 640 },
      height: { ideal: 480 }
    }
  })
  // Render to <video> element
  // Capture frame to <canvas>
  // Convert to base64
  // POST to /api/v1/attendance/face/check-in
}
```

**HTTPS required:** Camera access via `getUserMedia` requires a secure context (HTTPS or localhost). This is handled by Caddy's automatic TLS.

### 6.4 Offline Capability (Service Worker)

MVP offline support:
- Cache student timetable for offline viewing
- Cache attendance summary (read-only)
- Show "offline" banner when network unavailable
- Queue failed requests (attendance check-in) and retry when reconnected

```typescript
// apps/web/public/sw.js (Next.js uses next-pwa for this)
// Cache-first strategy for: timetable, attendance summary
// Network-first strategy for: all API calls
// Queue with retry for: face check-in, manual attendance
```

---

## 7. Domain Model (Updated)

The core domain model from v1.0 remains. The following entities are added/modified.

### 7.1 New Entities

#### FaceEnrollment
> **Purpose:** Records a student's face enrollment status and consent.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| student_user_id | UUID | FK → User, UNIQUE |
| organization_id | UUID | FK → Organization |
| status | enum | PENDING, ENROLLED, FAILED, REVOKED |
| enrolled_at | timestamp | When successfully enrolled |
| revoked_at | timestamp | When consent withdrawn |
| quality_score | decimal(4,3) | Face quality 0.0–1.0 |
| provider | string | insightface, aws, azure |
| external_ref | string | ID in the face recognition service |
| consent_given_at | timestamp | MANDATORY. Null = not consented |
| consent_ip | inet | IP at time of consent |

**Ownership:** Belongs to student. Student controls it.  
**Lifecycle:** Created at first enrollment prompt. Revoked on student request or when student leaves.  
**Privacy:** `external_ref` points to embedding in recognition service. Deleting embedding = `revoked_at` set + `external_ref` cleared.

---

#### FaceRecognitionLog
> **Purpose:** Immutable audit record of every face recognition attempt.

| Field | Type | Notes |
|---|---|---|
| id | UUID | PK |
| organization_id | UUID | |
| class_session_id | UUID | FK → ClassSession |
| student_user_id | UUID | FK → User (nullable if unrecognized) |
| recognition_mode | enum | SELFIE, CLASSROOM_SCAN |
| confidence_score | decimal(4,3) | Recognition confidence |
| liveness_score | decimal(4,3) | Anti-spoofing confidence |
| liveness_passed | boolean | |
| result | enum | MATCHED, NO_MATCH, LIVENESS_FAILED, LOW_QUALITY |
| attendance_record_id | UUID | FK → AttendanceRecord (if successful) |
| created_at | timestamp | |

**Immutable.** No UPDATE or DELETE.

---

### 7.2 Modified Entities

#### ClassSession (additions)

| Field | Type | Notes |
|---|---|---|
| face_attendance_enabled | boolean | Default FALSE |
| face_session_token | string | Time-limited token for student check-in |
| face_session_expires_at | timestamp | Window for check-in |
| face_session_window_minutes | integer | Default 10 min |

#### AttendanceRecord (additions)

| Field | Type | Notes |
|---|---|---|
| source | enum | MANUAL, FACE_SELFIE, FACE_CLASSROOM, BIOMETRIC_DEVICE |
| face_recognition_log_id | UUID | FK → FaceRecognitionLog (nullable) |
| face_confidence | decimal(4,3) | Confidence at time of marking |

---

## 8. Database Architecture (Updated)

All tables from v1.0 remain. The following additions apply.

### 8.1 New Tables

```sql
-- face_enrollments
CREATE TABLE face_enrollments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_user_id   UUID NOT NULL UNIQUE REFERENCES users(id),
  organization_id   UUID NOT NULL REFERENCES organizations(id),
  status            VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  enrolled_at       TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  quality_score     DECIMAL(4,3),
  provider          VARCHAR(30) NOT NULL DEFAULT 'insightface',
  external_ref      TEXT,
  consent_given_at  TIMESTAMPTZ,
  consent_ip        INET,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- face_recognition_logs (append-only)
CREATE TABLE face_recognition_logs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       UUID NOT NULL REFERENCES organizations(id),
  class_session_id      UUID NOT NULL REFERENCES class_sessions(id),
  student_user_id       UUID REFERENCES users(id),
  recognition_mode      VARCHAR(20) NOT NULL,
  confidence_score      DECIMAL(4,3),
  liveness_score        DECIMAL(4,3),
  liveness_passed       BOOLEAN NOT NULL DEFAULT FALSE,
  result                VARCHAR(30) NOT NULL,
  attendance_record_id  UUID REFERENCES attendance_records(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Alterations to existing tables
ALTER TABLE class_sessions
  ADD COLUMN face_attendance_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN face_session_token VARCHAR(64),
  ADD COLUMN face_session_expires_at TIMESTAMPTZ,
  ADD COLUMN face_session_window_minutes SMALLINT DEFAULT 10;

ALTER TABLE attendance_records
  ADD COLUMN source VARCHAR(30) NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN face_recognition_log_id UUID REFERENCES face_recognition_logs(id),
  ADD COLUMN face_confidence DECIMAL(4,3);
```

### 8.2 New Indexes

```sql
CREATE INDEX idx_face_enrollments_org ON face_enrollments(organization_id, status);
CREATE INDEX idx_face_recognition_logs_session ON face_recognition_logs(class_session_id);
CREATE INDEX idx_face_recognition_logs_student ON face_recognition_logs(student_user_id, created_at DESC);
CREATE INDEX idx_class_sessions_face_token ON class_sessions(face_session_token)
  WHERE face_session_token IS NOT NULL;
CREATE INDEX idx_attendance_records_source ON attendance_records(source);
```

### 8.3 i18n-Ready Schema

No schema changes needed. All user-visible strings are in frontend code only. The `organization.settings` JSONB can store default locale:

```json
{
  "locale": "en",
  "timezone": "Asia/Kolkata",
  "date_format": "DD/MM/YYYY",
  "academic_year_start_month": 7
}
```

---

## 9. Security Architecture (Updated)

### 9.1 Face Data Security

Face embeddings are **biometric data**. They require the highest protection.

**Storage:**
- Embeddings stored in the face recognition service (InsightFace internal store or cloud service)
- Only the `external_ref` (an opaque ID) is stored in our database
- Raw images: **NOT stored by default** after embedding extraction
  - Configurable: organizations can opt to store images for dispute resolution (stored encrypted)
  - If stored: in a separate, restricted bucket. Access requires audit log.

**Encryption:**
- Face service communication: internal network only (not exposed to internet)
- For cloud providers: TLS in transit, provider-level encryption at rest

**Access control:**
- Face embeddings can ONLY be accessed by the face recognition service
- No API endpoint returns face embeddings to any client
- Face recognition results (confidence scores, logs) are accessible only to authorized staff and the student themselves
- Students can query: "Do I have a face enrollment?" → yes/no, enrolled date, consent date

**Right to erasure:**
```
Student or Admin triggers: DELETE /api/v1/attendance/face/enroll
→ Backend calls face service: DELETE /embeddings/:external_ref
→ face_enrollments.status = REVOKED, external_ref = NULL, revoked_at = NOW()
→ face_recognition_logs retained (no embedding stored there, just metadata)
→ attendance_records retained (the fact of attendance is a legitimate academic record)
→ Audit log: actor, timestamp, reason
```

### 9.2 Session Token Security (Face Check-in)

The `face_session_token` is used by students to join a face attendance session.

**Security properties:**
- 64 bytes, cryptographically random (`crypto.randomBytes(64)`)
- Stored hashed in DB (SHA-256)
- Time-limited (default 10 minutes, configurable by faculty)
- Single-use per student (student can retry if liveness fails, but each attempt logged)
- Tied to a specific `class_session_id` → cannot be used for a different session
- QR code displayed by faculty → encodes the raw token

**Anti-abuse:**
- A student cannot use the token after the session window closes
- A student cannot use a token for a session they are not enrolled in
- Rate limit: max 5 check-in attempts per student per session (prevents brute-force)

### 9.3 Hybrid Deployment Security Additions

**Self-hosted specific:**
- Database port NOT exposed to external network
- MinIO console port NOT exposed to external network
- Face service port NOT exposed to external network
- Caddy handles all inbound TLS termination
- All inter-service communication is on internal Docker network

**Cloud SaaS specific:**
- Firewall: only ports 80, 443 open publicly
- Database in private VPC subnet
- Redis in private VPC subnet
- Face service in private VPC subnet
- VPC security groups enforce internal-only access

---

## 10. Technology Stack (Updated)

### 10.1 Complete Stack

#### Core (unchanged from v1.0)

| Layer | Technology |
|---|---|
| Frontend | Next.js 14+ (App Router) + TypeScript |
| Backend | Fastify + TypeScript |
| Database | PostgreSQL 15+ |
| ORM | Drizzle ORM |
| Cache / Queue | Redis 7 + BullMQ |
| Email (cloud) | Resend |
| Email (self-hosted) | SMTP relay (Postfix / any SMTP) |
| Monorepo | Turborepo + pnpm |
| CI/CD | GitHub Actions |

#### New / Updated

| Layer | Technology | Notes |
|---|---|---|
| Mobile | **PWA** (Next.js + next-pwa) → Expo Phase 2 | Decided |
| Storage (cloud) | **Cloudflare R2** | Zero egress costs |
| Storage (self-hosted) | **MinIO** | S3-compatible |
| Storage abstraction | AWS SDK v3 S3Client | Same SDK for both |
| Face Recognition (self-hosted) | **InsightFace** (Python + FastAPI) | Open source, Docker |
| Face Recognition (cloud) | **AWS Rekognition** | Managed, per-call billing |
| Face service abstraction | Custom TypeScript interface | Swap providers via env |
| Reverse proxy | **Caddy** | Auto TLS for self-hosted |
| i18n | **next-intl** (wired, no translations yet) | i18n-ready |

#### Face Service Technology Detail

**InsightFace Service (self-hosted):**

```
Language: Python 3.11
Framework: FastAPI
Models:
  - buffalo_l (recognition model, high accuracy)
  - antelopev2 (alternative, more accurate)
  - FaceAntiSpoofing (liveness detection)
Runtime: CPU (MVP) / GPU (optional for faster processing)
Docker image: custom, based on python:3.11-slim
Model download: On first startup (cached to volume)
```

**Performance on CPU (4 vCPU):**
- Single selfie processing: ~1.5–3 seconds
- This is acceptable for asynchronous student check-in
- Group photo (30 faces): ~15–30 seconds (background job)

### 10.2 Dependency Map

```
                    ┌─────────────────┐
                    │   Next.js PWA   │
                    │ (web + mobile)  │
                    └────────┬────────┘
                             │ REST API
                    ┌────────▼────────┐
                    │    Fastify API  │
                    └──┬──────────┬──┘
              ┌────────┘          └────────┐
     ┌────────▼─────┐            ┌─────────▼──────┐
     │  PostgreSQL  │            │     Redis       │
     └──────────────┘            └─────────────────┘
                             ┌───────────────────────┐
                             │   Face Service         │
                             │  (InsightFace/AWS)     │
                             └───────────────────────┘
                             ┌───────────────────────┐
                             │   Object Storage       │
                             │   (R2 or MinIO)        │
                             └───────────────────────┘
```

---

## 11. Repository Structure (Updated)

```
smart-campus-os/
│
├── apps/
│   ├── web/                           # Next.js PWA
│   │   ├── app/
│   │   │   ├── (auth)/
│   │   │   ├── (student)/
│   │   │   │   ├── dashboard/
│   │   │   │   ├── attendance/
│   │   │   │   │   └── face-checkin/  # Face check-in UI
│   │   │   │   ├── timetable/
│   │   │   │   ├── requests/
│   │   │   │   ├── tickets/
│   │   │   │   └── profile/
│   │   │   │       └── face-enrollment/  # Face enrollment UI
│   │   │   ├── (faculty)/
│   │   │   │   ├── dashboard/
│   │   │   │   ├── classes/
│   │   │   │   │   └── [id]/
│   │   │   │   │       ├── attendance/
│   │   │   │   │       └── face/     # Face attendance management
│   │   │   │   └── requests/
│   │   │   ├── (hod)/
│   │   │   └── (admin)/
│   │   ├── components/
│   │   │   └── face/                  # Face capture components
│   │   │       ├── FaceCapture.tsx
│   │   │       ├── LivenessGuide.tsx
│   │   │       └── EnrollmentWizard.tsx
│   │   ├── public/
│   │   │   ├── manifest.json          # PWA manifest
│   │   │   ├── sw.js                  # Service worker (via next-pwa)
│   │   │   └── icons/                 # PWA icons
│   │   └── messages/                  # i18n message files (next-intl)
│   │       └── en.json                # English (MVP only language)
│
├── packages/
│   ├── ui/                            # Shared design system
│   ├── types/                         # Shared TypeScript types
│   ├── schemas/                       # Shared Zod schemas
│   ├── utils/                         # Shared utilities
│   └── storage/                       # ← NEW: Storage abstraction
│       ├── src/
│       │   ├── types.ts               # StorageProvider interface
│       │   ├── providers/
│       │   │   ├── r2.ts
│       │   │   ├── minio.ts
│       │   │   └── s3.ts
│       │   └── index.ts               # createStorageProvider factory
│       └── package.json
│
├── backend/
│   ├── src/
│   │   ├── modules/
│   │   │   ├── auth/
│   │   │   ├── people/
│   │   │   ├── academic/
│   │   │   ├── attendance/
│   │   │   │   ├── attendance.routes.ts
│   │   │   │   ├── attendance.service.ts
│   │   │   │   ├── attendance.repository.ts
│   │   │   │   └── face/              # ← NEW: Face attendance
│   │   │   │       ├── face.routes.ts
│   │   │   │       ├── face.service.ts
│   │   │   │       ├── face.repository.ts
│   │   │   │       └── providers/     # Face recognition provider clients
│   │   │   │           ├── insightface.client.ts
│   │   │   │           ├── aws-rekognition.client.ts
│   │   │   │           └── index.ts
│   │   │   ├── timetable/
│   │   │   ├── service-requests/
│   │   │   ├── helpdesk/
│   │   │   ├── notifications/
│   │   │   ├── audit/
│   │   │   └── ai/                    # Phase 7
│   │   └── shared/
│   │       ├── database/
│   │       ├── cache/
│   │       ├── queue/
│   │       ├── storage/               # Uses packages/storage
│   │       ├── email/                 # ← NEW: Email abstraction
│   │       │   ├── providers/
│   │       │   │   ├── resend.ts
│   │       │   │   └── smtp.ts
│   │       │   └── index.ts
│   │       ├── errors/
│   │       └── middleware/
│   └── tests/
│
├── services/
│   └── face-service/                  # ← NEW: InsightFace Python service
│       ├── main.py                    # FastAPI app
│       ├── recognition.py             # Face embedding + matching
│       ├── liveness.py                # Anti-spoofing
│       ├── models.py                  # Pydantic request/response models
│       ├── requirements.txt
│       └── Dockerfile
│
├── database/
│   ├── migrations/
│   ├── seeds/
│   └── schema/
│
├── infrastructure/
│   ├── docker/
│   │   ├── docker-compose.yml         # Local development
│   │   ├── docker-compose.prod.yml    # Self-hosted production
│   │   ├── Dockerfile.backend
│   │   ├── Dockerfile.web
│   │   └── Dockerfile.face-service   # ← NEW
│   ├── caddy/
│   │   └── Caddyfile
│   └── scripts/
│       ├── setup-dev.sh
│       ├── backup-db.sh
│       └── install.sh                 # ← NEW: One-command college server setup
│
├── docs/
│   ├── architecture/
│   ├── api/
│   ├── deployment/
│   │   ├── cloud-saas.md              # ← NEW
│   │   └── self-hosted.md             # ← NEW: Step-by-step college install guide
│   ├── runbooks/
│   └── decisions/
│       └── ADR-001-face-attendance.md # Architecture Decision Record
│
├── .github/
│   └── workflows/
│
├── turbo.json
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

---

## 12. Development Roadmap (Updated)

### Phase Map

```
Milestone 0 — Foundation          (Weeks 1–2)
Milestone 1 — Authentication      (Weeks 3–4)
Milestone 2 — Academic Structure  (Weeks 5–7)
Milestone 3 — Attendance + Face   (Weeks 8–12)  ← Extended for face
Milestone 4 — Service Requests    (Weeks 13–16)
Milestone 5 — Helpdesk            (Weeks 17–18)
Milestone 6 — Polish + Deploy     (Weeks 19–20)
```

### Milestone 0 — Foundation (Weeks 1–2)

**Goal:** Full local dev environment in one command. All services running.

- [ ] Monorepo: Turborepo + pnpm
- [ ] `apps/web` — Next.js + TypeScript + Tailwind + next-intl (en.json)
- [ ] `backend` — Fastify + TypeScript + Drizzle
- [ ] `services/face-service` — FastAPI skeleton (health endpoint only)
- [ ] `packages/storage` — R2 + MinIO abstraction
- [ ] `backend/src/shared/email` — Resend + SMTP abstraction
- [ ] `docker-compose.yml` — PostgreSQL, Redis, MinIO, face-service
- [ ] Drizzle schema + first migration
- [ ] Zod env validation (fail-fast on missing vars)
- [ ] ESLint + Prettier + TypeScript strict mode
- [ ] GitHub Actions CI (type-check, lint)
- [ ] `infrastructure/scripts/setup-dev.sh`
- [ ] PWA: manifest.json, icons, next-pwa config

**Definition of Done:** `pnpm dev` → all services up. `pnpm test` passes. CI green.

---

### Milestone 1 — Authentication (Weeks 3–4)

**Goal:** Login, sessions, roles, permissions working.

- [ ] `users`, `roles`, `permissions`, `role_permissions`, `user_roles` tables
- [ ] `refresh_tokens`, `password_reset_tokens` tables
- [ ] POST /auth/login — RS256 JWT + refresh token in HttpOnly cookie
- [ ] POST /auth/refresh — rotation
- [ ] POST /auth/logout
- [ ] POST /auth/forgot-password → email
- [ ] POST /auth/reset-password
- [ ] `authenticate` middleware
- [ ] `authorize(permission)` middleware
- [ ] Permission caching in Redis (5-min TTL)
- [ ] Login page (Next.js, mobile-first)
- [ ] Forgot/reset password pages
- [ ] JWT memory storage + refresh in API client (Axios/fetch interceptor)
- [ ] Account lockout (5 failures/15 min)
- [ ] Email templates: welcome, password reset
- [ ] Audit log: auth events

**Definition of Done:** Admin logs in. Token expires, refresh works silently. Wrong password locks account. Tokens rejected server-side.

---

### Milestone 2 — Academic Structure (Weeks 5–7)

**Goal:** Admin can configure full college structure, import students and faculty.

- [ ] All academic tables: org, campus, dept, program, batch, semester, section, subject, subject_offering
- [ ] CRUD APIs for all
- [ ] Student profile creation + bulk CSV import (with validation preview)
- [ ] Faculty profile creation
- [ ] Enrollment (student → section/semester)
- [ ] Admin UI: Setup wizard (guided flow)
- [ ] Admin UI: Department management
- [ ] Admin UI: Semester creation with checklist
- [ ] Admin UI: Student bulk import (CSV upload → preview → confirm)
- [ ] Admin UI: Faculty assignment to subjects/sections
- [ ] Student invite email (set-password link)

**Definition of Done:** Admin imports 50 test students. Faculty assigned to subjects. Students can log in.

---

### Milestone 3 — Attendance + Face Attendance (Weeks 8–12)

**Extended by 1 week for face attendance.**

#### Week 8–9: Manual Attendance

- [ ] ClassSession CRUD
- [ ] POST /class-sessions/:id/attendance (bulk mark by faculty)
- [ ] GET /attendance/my/summary (student)
- [ ] GET /attendance/my/subject/:id (student)
- [ ] Timetable: time_slots table + CRUD
- [ ] Faculty dashboard: today's classes list
- [ ] Faculty attendance marking UI (roster, present/absent toggle)
- [ ] Student dashboard: attendance cards + progress bars
- [ ] Student attendance detail: session-by-session list
- [ ] HOD attendance report (section summary, at-risk list)
- [ ] Attendance notifications (absent notification to student)

#### Week 10–12: Face Attendance

- [ ] `face_enrollments`, `face_recognition_logs` tables + migrations
- [ ] Add face columns to `class_sessions`, `attendance_records`
- [ ] InsightFace Python service (FastAPI):
  - [ ] POST /enroll (5 images → embeddings)
  - [ ] POST /recognize (selfie → matched student_id)
  - [ ] DELETE /embeddings/:id
  - [ ] Passive liveness detection
- [ ] Face provider abstraction (TypeScript)
- [ ] POST /api/v1/attendance/face/enroll (student)
- [ ] DELETE /api/v1/attendance/face/enroll (revoke)
- [ ] POST /api/v1/class-sessions/:id/face/start (faculty)
- [ ] POST /api/v1/attendance/face/check-in (student selfie)
- [ ] GET /api/v1/class-sessions/:id/face/status (real-time progress)
- [ ] Student: Face enrollment wizard (consent → 5 selfies → confirm)
- [ ] Student: Face check-in screen (camera → blink prompt → result)
- [ ] Faculty: Enable face attendance toggle on class session
- [ ] Faculty: QR code display for face session token
- [ ] Faculty: Real-time check-in progress dashboard
- [ ] Face recognition audit logs
- [ ] Fallback: manual marking always available

**Definition of Done:** Student enrolls face. Faculty starts face session. Student scans QR, selfie taken, attendance marked. Faculty sees real-time list. All logged in audit table.

---

### Milestone 4 — Service Requests (Weeks 13–16)

*(unchanged from v1.0)*

- [ ] ServiceType configuration engine
- [ ] Workflow engine (configurable steps)
- [ ] Service request CRUD
- [ ] Built-in types: BONAFIDE, ID_CARD, ATTENDANCE_CORRECTION
- [ ] Dynamic form renderer
- [ ] File attachment support (uses storage abstraction)
- [ ] SLA tracking + BullMQ delayed jobs
- [ ] PDF generation (bonafide certificate)
- [ ] Student requests UI
- [ ] Staff processing UI

**Definition of Done:** Student submits bonafide, HOD approves, student downloads PDF certificate.

---

### Milestone 5 — Helpdesk (Weeks 17–18)

*(unchanged)*

- [ ] Ticket CRUD, categories, priorities
- [ ] Conversation threads (public + internal)
- [ ] Auto-assignment rules
- [ ] SLA breach BullMQ jobs
- [ ] Escalation rules
- [ ] Feedback after resolution
- [ ] Student + staff UIs

---

### Milestone 6 — Polish + Hybrid Deploy (Weeks 19–20)

- [ ] In-app notification center
- [ ] Email notification templates
- [ ] PWA: offline timetable caching, install prompt
- [ ] PWA: "Add to Home Screen" nudge for students
- [ ] Admin: System settings page
- [ ] Admin: Face attendance configuration (provider, confidence threshold)
- [ ] Empty states, skeleton loaders, error pages
- [ ] Accessibility audit (WCAG 2.1 AA)
- [ ] Performance audit (Lighthouse)
- [ ] `docker-compose.prod.yml` finalized
- [ ] `infrastructure/scripts/install.sh` — one-command college server setup
- [ ] `docs/deployment/self-hosted.md` — step-by-step guide
- [ ] End-to-end test suite for all critical paths
- [ ] Security review (OWASP Top 10 checklist)
- [ ] Staging deployment + team review
- [ ] Production deployment

**Definition of Done:** System installed on a college server via install script. Admin, faculty, and students successfully complete all MVP flows.

---

## 13. Risks (Updated)

### 13.1 Face Attendance Specific Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Low face recognition accuracy for dark skin tones | Medium | High | Test InsightFace on diverse dataset; use buffalo_l model (better diversity); always offer manual fallback |
| Students refuse consent | High (some) | Medium | Consent is always optional; manual attendance always available; never penalize non-enrollment |
| Proxy attendance (one student checks in for another) | Low | High | Liveness detection prevents photo spoofing; challenge-response for high-stakes classes |
| Face service crashes during class | Medium | High | Manual fallback is always available; faculty can switch to manual in one tap |
| Poor camera quality on cheap devices | Medium | Medium | Image quality check before submission; guide student to retry in better lighting |
| Privacy concerns / regulatory issues | Medium | High | Explicit consent, right to delete, no raw image storage, clear data policy |
| InsightFace model accuracy degrades over time (student appearance change) | Low | Medium | Allow re-enrollment anytime; periodic re-enrollment prompt (each semester) |
| Face spoofing via printed photo | Low | High | Passive anti-spoofing model; depth cues from monocular image |

### 13.2 Hybrid Deployment Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| College server has insufficient RAM/CPU | Medium | High | Clear minimum specs; InstightFace on CPU is resource-heavy (4GB RAM minimum) |
| College IT department blocks Docker | Medium | High | Provide bare-metal install instructions as fallback |
| Self-hosted SSL/TLS misconfiguration | Medium | Medium | Caddy auto-handles TLS; install script validates HTTPS before completing |
| College server internet outage | High | Medium | PWA offline caching for read-only access; attendance can be queued and synced |
| Divergence between self-hosted and cloud versions | Medium | Medium | Single Docker image for both; same CI/CD pipeline; only env vars differ |

### 13.3 PWA Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| iOS Safari camera limitations | Medium | Medium | Test on iOS Safari; `getUserMedia` works in iOS 14.3+ |
| Push notifications blocked on iOS (PWA) | High | Medium | Fall back to in-app badge + email for iOS; native app in Phase 2 |
| PWA not installable on some older Android devices | Low | Low | Always works as a website even without installation |
| Students don't install the PWA | High | Low | Functions without installation; install prompt shown once |

---

## What I Should Do Next

All architecture decisions are locked. Here is your exact sequence:

---

### Step 1 — Tell Me About the Pilot College (Today)

Before we write a single line of application code, share:

1. **College name** (or "College A" if you prefer private)
2. **Approximate student count** (e.g., 500, 2000, 5000)
3. **Approximate faculty count**
4. **Number of departments**
5. **Server situation:** Do they have an existing server? Windows or Linux? Cloud or on-premise?
6. **Key contact** at the college (tech person or principal)

This determines: seed data structure, deployment mode (Mode A or B), and what our install script needs to handle.

---

### Step 2 — Say: "Start coding Milestone 0"

Once you've answered Step 1, say **"Start coding Milestone 0"** and I will:

1. Create the monorepo directory structure at `/Users/ankush/.gemini/antigravity-ide/scratch/smart-campus-os/`
2. Initialize Turborepo + pnpm workspaces
3. Set up Next.js (`apps/web`) with TypeScript, Tailwind, next-intl, next-pwa
4. Set up Fastify backend with TypeScript and Drizzle
5. Create the InsightFace Python service skeleton (`services/face-service`)
6. Create the storage abstraction package (`packages/storage`)
7. Write `docker-compose.yml` with all services
8. Write the first complete Drizzle schema (all MVP tables including face tables)
9. Write the first migration
10. Set up GitHub Actions CI
11. Write `setup-dev.sh`
12. Set up Sentry

**Everything will be production-quality from day one.**

---

### Step 3 — After Milestone 0: First Demo

The first demo milestone target is **Week 4 end**:

- Admin can log in
- Create a department, program, batch, semester, section
- Add 5 test students (manual)
- Students can log in
- Students see their (empty) dashboard

This is the "can we actually deploy this?" proof point before investing in the larger modules.

---

*Smart Campus OS Architecture Specification v2.0 — All Decisions Locked*  
*Ready for implementation on your approval.*
