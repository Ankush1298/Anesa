import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Database } from '../../shared/database/index.js';
import { AppError } from '../../shared/errors/http-errors.js';
import type { AuditRequestMeta } from '../../shared/audit/index.js';
import { CampusService } from './campus.service.js';
import { DepartmentService } from './department.service.js';
import { DesignationService } from './designation.service.js';
import { SettingsService } from './settings.service.js';
import { computeCollectionETag, parseIfMatch } from '../../shared/settings/index.js';
import {
  CampusParamsSchema,
  type CampusParams,
  CreateCampusBodySchema,
  type CreateCampusBody,
  CreateCampusResponseSchema,
  GetCampusResponseSchema,
  ListCampusesQuerySchema,
  type ListCampusesQuery,
  ListCampusesResponseSchema,
  UpdateCampusBodySchema,
  type UpdateCampusBody,
  UpdateCampusResponseSchema,
  DepartmentParamsSchema,
  type DepartmentParams,
  CreateDepartmentBodySchema,
  type CreateDepartmentBody,
  CreateDepartmentResponseSchema,
  GetDepartmentResponseSchema,
  ListDepartmentsQuerySchema,
  type ListDepartmentsQuery,
  ListDepartmentsResponseSchema,
  UpdateDepartmentBodySchema,
  type UpdateDepartmentBody,
  UpdateDepartmentResponseSchema,
  DeleteDepartmentResponseSchema,
  CreateDesignationBodySchema,
  type CreateDesignationBody,
  CreateDesignationResponseSchema,
  ListDesignationsQuerySchema,
  type ListDesignationsQuery,
  ListDesignationsResponseSchema,
  SettingParamsSchema,
  type SettingParams,
  SetSettingBodySchema,
  type SetSettingBody,
  ListSettingsResponseSchema,
  SetSettingResponseSchema,
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

  // GET /campuses
  app.get<{ Querystring: ListCampusesQuery }>(
    '/campuses',
    {
      config: { permission: ['org.structure.read', 'org.campus.manage'] },
      schema: {
        querystring: ListCampusesQuerySchema,
        response: {
          200: ListCampusesResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');

      const records = await opts.db.withTenant(ctx, async (tx) => {
        return CampusService.list(tx, ctx, req.query);
      });

      return reply.status(200).send({ success: true, data: records });
    },
  );

  // GET /campuses/:id
  app.get<{ Params: CampusParams }>(
    '/campuses/:id',
    {
      config: { permission: ['org.structure.read', 'org.campus.manage'] },
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

  // GET /departments
  app.get<{ Querystring: ListDepartmentsQuery }>(
    '/departments',
    {
      config: { permission: ['org.structure.read', 'org.department.manage'] },
      schema: {
        querystring: ListDepartmentsQuerySchema,
        response: {
          200: ListDepartmentsResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');

      const records = await opts.db.withTenant(ctx, async (tx) => {
        return DepartmentService.list(tx, ctx, req.query);
      });

      return reply.status(200).send({ success: true, data: records });
    },
  );

  // GET /departments/:id
  app.get<{ Params: DepartmentParams }>(
    '/departments/:id',
    {
      config: { permission: ['org.structure.read', 'org.department.manage'] },
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

  // --- Designations ---

  // GET /designations
  app.get<{ Querystring: ListDesignationsQuery }>(
    '/designations',
    {
      config: {
        permission: ['org.structure.read', 'org.campus.manage', 'org.department.manage'],
      },
      schema: {
        querystring: ListDesignationsQuerySchema,
        response: {
          200: ListDesignationsResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');

      const data = await opts.db.withTenant(ctx, async (tx) => {
        return DesignationService.list(tx, ctx, req.query ?? {});
      });

      return reply.status(200).send({ success: true, data });
    },
  );

  // POST /designations
  app.post<{ Body: CreateDesignationBody }>(
    '/designations',
    {
      config: { permission: ['org.campus.manage', 'org.department.manage'] },
      schema: {
        body: CreateDesignationBodySchema,
        response: {
          201: CreateDesignationResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const meta = extractAuditMeta(req);

      const id = await opts.db.withTenant(ctx, async (tx) => {
        return DesignationService.create(tx, ctx, req.body, meta);
      });

      return reply.status(201).send({ success: true, data: { id } });
    },
  );

  // --- Settings (docs/architecture/v3/11 §5.4: GET /settings, PUT /settings/{key}) ---

  // GET /settings
  app.get(
    '/settings',
    {
      config: { permission: 'org.settings.read' },
      schema: { response: { 200: ListSettingsResponseSchema } },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');

      const data = await opts.db.withTenant(ctx, async (tx) => {
        return SettingsService.list(tx, ctx);
      });

      reply.header('ETag', computeCollectionETag(data));
      return reply.status(200).send({ success: true, data });
    },
  );

  // PUT /settings/:key  (CRITICAL: org.settings.manage, reason required, audited atomically, optimistic concurrency)
  app.put<{ Params: SettingParams; Body: SetSettingBody }>(
    '/settings/:key',
    {
      config: { permission: 'org.settings.manage' },
      schema: {
        params: SettingParamsSchema,
        body: SetSettingBodySchema,
        response: { 200: SetSettingResponseSchema },
      },
    },
    async (req, reply) => {
      const ctx = req.tenantContext;
      if (!ctx) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      const ifMatchHeader = req.headers['if-match'];
      const expectedVersion = parseIfMatch(
        typeof ifMatchHeader === 'string' ? ifMatchHeader : undefined,
      );
      const meta = extractAuditMeta(req);

      const data = await opts.db.withTenant(ctx, async (tx) => {
        return SettingsService.set(tx, ctx, req.params.key, req.body, { expectedVersion, meta });
      });

      if (data.version !== null) {
        reply.header('ETag', `"${data.version}"`);
      }
      return reply.status(200).send({ success: true, data });
    },
  );
};
