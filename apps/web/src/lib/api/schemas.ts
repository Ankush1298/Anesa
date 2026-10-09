import { z } from 'zod';

/** Documented backend contracts (docs/architecture/v3/15 + auth.routes.ts). Unknown keys are dropped. */
export const ActorKindSchema = z.enum(['STUDENT', 'STAFF']);

export const LoginResponseSchema = z.object({
  success: z.literal(true),
  tenant_id: z.string(),
  csrf_token: z.string().min(16),
});

export const MeResponseSchema = z.object({
  tenant_id: z.string(),
  user_id: z.string(),
  actor_kind: ActorKindSchema,
  display_name: z.string(),
  roles: z.array(z.string()),
  capabilities: z.array(z.string()),
  csrf_token: z.string().min(16),
});

export const SuccessSchema = z.object({ success: z.literal(true) });

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    requestId: z.string().optional(),
  }),
});

export type MeResponse = z.infer<typeof MeResponseSchema>;
