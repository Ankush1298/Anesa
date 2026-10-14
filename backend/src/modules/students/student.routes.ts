import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import type { AuditRequestMeta } from '../../shared/audit/index.js';
import { parseIfMatch } from '../../shared/settings/index.js';
import { StudentService } from './student.service.js';
import { StudentProgramService } from './student-program.service.js';
import { StudentDirectoryService } from './student-directory.service.js';
import {
  CreateStudentBodySchema,
  type CreateStudentBody,
  CreateStudentResponseSchema,
  GetStudentResponseSchema,
  StudentIdParamSchema,
  type StudentIdParam,
  StudentLookupQuerySchema,
  type StudentLookupQuery,
  StudentLookupResponseSchema,
  OpenStudentProgramBodySchema,
  type OpenStudentProgramBody,
  OpenStudentProgramResponseSchema,
  StudentProgramParamsSchema,
  type StudentProgramParams,
  CloseStudentProgramBodySchema,
  type CloseStudentProgramBody,
  CloseStudentProgramResponseSchema,
} from './student.schemas.js';

function extractAuditMeta(req: FastifyRequest): AuditRequestMeta {
  const meta: AuditRequestMeta = { ip: req.ip, requestId: req.id };
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') meta.userAgent = ua;
  return meta;
}

/**
 * doc 11 §5.4: POST /students, GET /students/{id}, POST /students/{id}/programs, POST /students/{id}/programs/{pid}/close.
 * Mounted at /api/v1/students. List/PATCH/status are later phases.
 */
export const registerStudentRoutes: FastifyPluginAsync<{ db: Database }> = async (app, opts) => {
  await Promise.resolve();
  if (!opts.db) throw new Error('Database dependency is required to register student routes.');

  app.post<{ Body: CreateStudentBody }>(
    '/',
    {
      config: { permission: 'student.record.create' },
      schema: { body: CreateStudentBodySchema, response: { 201: CreateStudentResponseSchema } },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await opts.db.withTenant(ctx, (tx) =>
        StudentService.create(tx, ctx, req.body, { idempotencyKey, meta }),
      );
      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.status(result.status).send(result.body);
    },
  );

  // Exact admission-number lookup, at most one student (no listing, no name search, no pagination: docs 21 §0b).
  // 404 for an unknown number AND for a placed student outside the caller's scope: indistinguishable.
  app.get<{ Querystring: StudentLookupQuery }>(
    '/',
    {
      config: { permission: 'student.directory.search' },
      schema: {
        querystring: StudentLookupQuerySchema,
        response: { 200: StudentLookupResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) =>
        StudentDirectoryService.findByAdmissionNumber(tx, ctx, req.query.admissionNumber),
      );
      return reply.status(200).send({ success: true, data });
    },
  );

  app.get<{ Params: StudentIdParam }>(
    '/:id',
    {
      config: { permission: 'student.profile.read' },
      schema: { params: StudentIdParamSchema, response: { 200: GetStudentResponseSchema } },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) =>
        StudentService.getById(tx, ctx, req.params.id),
      );
      reply.header('ETag', `"${data.version}"`);
      return reply.status(200).send({ success: true, data });
    },
  );

  // Opens a REGULAR program enrolment. Idempotency-Key is passed RAW: the service owns 428 (missing) / 400 (malformed).
  app.post<{ Params: StudentIdParam; Body: OpenStudentProgramBody }>(
    '/:id/programs',
    {
      config: { permission: 'student.program.assign' },
      schema: {
        params: StudentIdParamSchema,
        body: OpenStudentProgramBodySchema,
        response: { 201: OpenStudentProgramResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);
      const idempotencyKey = req.headers['idempotency-key'];
      const result = await opts.db.withTenant(ctx, (tx) =>
        StudentProgramService.open(tx, ctx, req.params.id, req.body, { idempotencyKey, meta }),
      );
      if (result.replayed) reply.header('Idempotent-Replayed', 'true');
      return reply.status(result.status).send(result.body);
    },
  );

  // Closes an ACTIVE enrolment. If-Match is mandatory (428 missing, 400 malformed/weak) and parsed ONLY by parseIfMatch,
  // which can only produce a concrete expectation or an error. The path's student id must own the enrolment (else 404, enforced by the service).
  app.post<{ Params: StudentProgramParams; Body: CloseStudentProgramBody }>(
    '/:id/programs/:pid/close',
    {
      config: { permission: 'student.program.assign' },
      schema: {
        params: StudentProgramParamsSchema,
        body: CloseStudentProgramBodySchema,
        response: { 200: CloseStudentProgramResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const header = req.headers['if-match'];
      const expected = parseIfMatch(typeof header === 'string' ? header : undefined);
      const { id: owner, pid } = req.params;
      const options = { expected, studentId: owner, meta: extractAuditMeta(req) };
      const data = await opts.db.withTenant(ctx, (tx) =>
        StudentProgramService.close(tx, ctx, pid, req.body, options),
      );
      reply.header('ETag', `"${data.version}"`);
      return reply.status(200).send({ success: true, data });
    },
  );
};
