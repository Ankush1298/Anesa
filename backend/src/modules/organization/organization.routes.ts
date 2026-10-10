import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import type { AuditRequestMeta } from '../../shared/audit/index.js';
import { CampusService } from './campus.service.js';
import { DepartmentService } from './department.service.js';
import {
  CampusParamsSchema,
  type CampusParams,
  CreateCampusBodySchema,
  type CreateCampusBody,
  CreateCampusResponseSchema,
  GetCampusResponseSchema,
  UpdateCampusBodySchema,
  type UpdateCampusBody,
  UpdateCampusResponseSchema,
  DepartmentParamsSchema,
  type DepartmentParams,
  CreateDepartmentBodySchema,
  type CreateDepartmentBody,
  CreateDepartmentResponseSchema,
  GetDepartmentResponseSchema,
  UpdateDepartmentBodySchema,
  type UpdateDepartmentBody,
  UpdateDepartmentResponseSchema,
  DeleteDepartmentResponseSchema,
} from './organization.schemas.js';

function extractAuditMeta(req: FastifyRequest): AuditRequestMeta {
  const meta: AuditRequestMeta = {
    ip: req.ip,
    requestId: req.id,
  };
  const ua = req.headers['user-agent'];
  if (typeof ua === 'string') {
    meta.userAgent = ua;
  }
  return meta;
}

export const registerOrganizationRoutes: FastifyPluginAsync<{ db: Database }> = async (
  app,
  opts,
) => {
  await Promise.resolve();
  if (!opts.db) {
    throw new Error('Database dependency is required to register organization routes.');
  }

  // --- Campuses ---

  // POST /campuses
  app.post<{ Body: CreateCampusBody }>(
    '/campuses',
    {
      config: { permission: 'org.campus.manage' },
      schema: {
        body: CreateCampusBodySchema,
        response: {
          201: CreateCampusResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);

      const id = await opts.db.withTenant(ctx, async (tx) => {
        return CampusService.create(tx, ctx, req.body, meta);
      });

      return reply.status(201).send({ success: true, data: { id } });
    },
  );

  // GET /campuses/:id
  app.get<{ Params: CampusParams }>(
    '/campuses/:id',
    {
      config: { permission: 'org.campus.manage' },
      schema: {
        params: CampusParamsSchema,
        response: {
          200: GetCampusResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');

      const record = await opts.db.withTenant(ctx, async (tx) => {
        return CampusService.getById(tx, ctx, req.params.id);
      });

      return reply.status(200).send({ success: true, data: record });
    },
  );

  // PATCH /campuses/:id
  app.patch<{ Params: CampusParams; Body: UpdateCampusBody }>(
    '/campuses/:id',
    {
      config: { permission: 'org.campus.manage' },
      schema: {
        params: CampusParamsSchema,
        body: UpdateCampusBodySchema,
        response: {
          200: UpdateCampusResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);

      await opts.db.withTenant(ctx, async (tx) => {
        await CampusService.update(tx, ctx, req.params.id, req.body, meta);
      });

      return reply.status(200).send({ success: true });
    },
  );

  // --- Departments ---

  // POST /departments
  app.post<{ Body: CreateDepartmentBody }>(
    '/departments',
    {
      config: { permission: 'org.department.manage' },
      schema: {
        body: CreateDepartmentBodySchema,
        response: {
          201: CreateDepartmentResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);

      const id = await opts.db.withTenant(ctx, async (tx) => {
        return DepartmentService.create(tx, ctx, req.body, meta);
      });

      return reply.status(201).send({ success: true, data: { id } });
    },
  );

  // GET /departments/:id
  app.get<{ Params: DepartmentParams }>(
    '/departments/:id',
    {
      config: { permission: 'org.department.manage' },
      schema: {
        params: DepartmentParamsSchema,
        response: {
          200: GetDepartmentResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');

      const record = await opts.db.withTenant(ctx, async (tx) => {
        return DepartmentService.getById(tx, ctx, req.params.id);
      });

      return reply.status(200).send({ success: true, data: record });
    },
  );

  // PATCH /departments/:id
  app.patch<{ Params: DepartmentParams; Body: UpdateDepartmentBody }>(
    '/departments/:id',
    {
      config: { permission: 'org.department.manage' },
      schema: {
        params: DepartmentParamsSchema,
        body: UpdateDepartmentBodySchema,
        response: {
          200: UpdateDepartmentResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);

      await opts.db.withTenant(ctx, async (tx) => {
        await DepartmentService.update(tx, ctx, req.params.id, req.body, meta);
      });

      return reply.status(200).send({ success: true });
    },
  );

  // DELETE /departments/:id
  app.delete<{ Params: DepartmentParams }>(
    '/departments/:id',
    {
      config: { permission: 'org.department.manage' },
      schema: {
        params: DepartmentParamsSchema,
        response: {
          200: DeleteDepartmentResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);

      await opts.db.withTenant(ctx, async (tx) => {
        await DepartmentService.softDelete(tx, ctx, req.params.id, meta);
      });

      return reply.status(200).send({ success: true });
    },
  );
};
