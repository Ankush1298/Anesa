import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import type { AuditRequestMeta } from '../../shared/audit/index.js';
import { StudentService } from './student.service.js';
import {
  CreateStudentBodySchema,
  type CreateStudentBody,
  CreateStudentResponseSchema,
  GetStudentResponseSchema,
  StudentIdParamSchema,
  type StudentIdParam,
} from './student.schemas.js';

function extractAuditMeta(req: FastifyRequest): AuditRequestMeta {
  const meta: AuditRequestMeta = { ip: req.ip, requestId: req.id };
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') meta.userAgent = ua;
  return meta;
}

/** doc 11 §5.4: POST /students, GET /students/{id}. Mounted at /api/v1/students. List/PATCH/status are later phases. */
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
};
