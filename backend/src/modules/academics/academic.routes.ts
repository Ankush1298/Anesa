import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import type { AuditRequestMeta } from '../../shared/audit/index.js';
import { PeriodTypeService, ProgramService, CohortService } from './academic.service.js';
import {
  CreatePeriodTypeBodySchema,
  type CreatePeriodTypeBody,
  CreatePeriodTypeResponseSchema,
  ListPeriodTypesResponseSchema,
  CreateProgramBodySchema,
  type CreateProgramBody,
  CreateProgramResponseSchema,
  ListProgramsQuerySchema,
  type ListProgramsQuery,
  ListProgramsResponseSchema,
  UpdateProgramBodySchema,
  type UpdateProgramBody,
  UpdateProgramResponseSchema,
  CreateCohortBodySchema,
  type CreateCohortBody,
  CreateCohortResponseSchema,
  ListCohortsQuerySchema,
  type ListCohortsQuery,
  ListCohortsResponseSchema,
  UpdateCohortBodySchema,
  type UpdateCohortBody,
  UpdateCohortResponseSchema,
  IdParamSchema,
  type IdParam,
} from './academic.schemas.js';

function extractAuditMeta(req: FastifyRequest): AuditRequestMeta {
  const meta: AuditRequestMeta = { ip: req.ip, requestId: req.id };
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') meta.userAgent = ua;
  return meta;
}

export const registerAcademicsRoutes: FastifyPluginAsync<{ db: Database }> = async (app, opts) => {
  await Promise.resolve();
  if (!opts.db) throw new Error('Database dependency is required to register academics routes.');

  // --- Period types (doc 11 §5.4: GET/POST /period-types) ---

  app.get(
    '/period-types',
    {
      config: { permission: 'academic.program.read' },
      schema: { response: { 200: ListPeriodTypesResponseSchema } },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) => PeriodTypeService.list(tx, ctx));
      return reply.status(200).send({ success: true, data });
    },
  );

  app.post<{ Body: CreatePeriodTypeBody }>(
    '/period-types',
    {
      config: { permission: 'academic.program.manage' },
      schema: {
        body: CreatePeriodTypeBodySchema,
        response: { 201: CreatePeriodTypeResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);
      const id = await opts.db.withTenant(ctx, (tx) =>
        PeriodTypeService.create(tx, ctx, req.body, meta),
      );
      return reply.status(201).send({ success: true, data: { id } });
    },
  );

  // --- Programs (doc 11 §5.4: GET/POST/PATCH /programs) ---

  app.get<{ Querystring: ListProgramsQuery }>(
    '/programs',
    {
      config: { permission: 'academic.program.read' },
      schema: {
        querystring: ListProgramsQuerySchema,
        response: { 200: ListProgramsResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) => ProgramService.list(tx, ctx, req.query));
      return reply.status(200).send({ success: true, data });
    },
  );

  app.post<{ Body: CreateProgramBody }>(
    '/programs',
    {
      config: { permission: 'academic.program.manage' },
      schema: { body: CreateProgramBodySchema, response: { 201: CreateProgramResponseSchema } },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);
      const id = await opts.db.withTenant(ctx, (tx) =>
        ProgramService.create(tx, ctx, req.body, meta),
      );
      return reply.status(201).send({ success: true, data: { id } });
    },
  );

  app.patch<{ Params: IdParam; Body: UpdateProgramBody }>(
    '/programs/:id',
    {
      config: { permission: 'academic.program.manage' },
      schema: {
        params: IdParamSchema,
        body: UpdateProgramBodySchema,
        response: { 200: UpdateProgramResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);
      await opts.db.withTenant(ctx, (tx) =>
        ProgramService.update(tx, ctx, req.params.id, req.body, meta),
      );
      return reply.status(200).send({ success: true });
    },
  );

  // --- Cohorts (doc 11 §5.4: GET/POST/PATCH /cohorts) ---

  app.get<{ Querystring: ListCohortsQuery }>(
    '/cohorts',
    {
      config: { permission: 'academic.program.read' },
      schema: { querystring: ListCohortsQuerySchema, response: { 200: ListCohortsResponseSchema } },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const data = await opts.db.withTenant(ctx, (tx) => CohortService.list(tx, ctx, req.query));
      return reply.status(200).send({ success: true, data });
    },
  );

  app.post<{ Body: CreateCohortBody }>(
    '/cohorts',
    {
      config: { permission: 'academic.cohort.manage' },
      schema: { body: CreateCohortBodySchema, response: { 201: CreateCohortResponseSchema } },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);
      const id = await opts.db.withTenant(ctx, (tx) =>
        CohortService.create(tx, ctx, req.body, meta),
      );
      return reply.status(201).send({ success: true, data: { id } });
    },
  );

  app.patch<{ Params: IdParam; Body: UpdateCohortBody }>(
    '/cohorts/:id',
    {
      config: { permission: 'academic.cohort.manage' },
      schema: {
        params: IdParamSchema,
        body: UpdateCohortBodySchema,
        response: { 200: UpdateCohortResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);
      await opts.db.withTenant(ctx, (tx) =>
        CohortService.update(tx, ctx, req.params.id, req.body, meta),
      );
      return reply.status(200).send({ success: true });
    },
  );
};
