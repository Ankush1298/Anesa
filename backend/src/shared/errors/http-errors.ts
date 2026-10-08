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
