export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: { field: string; message: string }[];
  };
}

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function envelope(
  requestId: string,
  code: string,
  message: string,
  details?: { field: string; message: string }[],
): ErrorEnvelope {
  return {
    error: { code, message, requestId, ...(details ? { details } : {}) },
  };
}

/**
 * The ONE 404 used for "does not exist" and for "exists but you may not discover it" (06 §2 step 8).
 * Same status, code and message everywhere, so the two cases are indistinguishable to a client.
 */
export const RESOURCE_NOT_FOUND_MESSAGE = 'The requested resource was not found.';
export function resourceNotFound(): AppError {
  return new AppError(404, 'RESOURCE_NOT_FOUND', RESOURCE_NOT_FOUND_MESSAGE);
}
