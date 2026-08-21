/**
 * CodeConClave — typed application errors.
 * Every service error carries a stable error_code the client can rely on.
 */
export class AppError extends Error {
  readonly status: number;
  readonly errorCode: string;
  readonly details?: unknown;

  constructor(status: number, errorCode: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.errorCode = errorCode;
    this.details = details;
  }

  static badRequest(errorCode: string, message: string, details?: unknown): AppError {
    return new AppError(400, errorCode, message, details);
  }
  static unauthorized(errorCode = 'unauthorized', message = 'Authentication required'): AppError {
    return new AppError(401, errorCode, message);
  }
  static forbidden(errorCode = 'forbidden', message = 'You do not have permission'): AppError {
    return new AppError(403, errorCode, message);
  }
  static notFound(resource = 'resource', errorCode = 'not_found'): AppError {
    return new AppError(404, errorCode, `${resource} not found`);
  }
  static conflict(errorCode: string, message: string, details?: unknown): AppError {
    return new AppError(409, errorCode, message, details);
  }
  static tooMany(errorCode = 'rate_limited', message = 'Too many requests'): AppError {
    return new AppError(429, errorCode, message);
  }
  static paymentRequired(errorCode: string, message: string, details?: unknown): AppError {
    return new AppError(402, errorCode, message, details);
  }
  static unavailable(errorCode: string, message: string, details?: unknown): AppError {
    return new AppError(503, errorCode, message, details);
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function errorCodeOf(e: unknown): string {
  if (isAppError(e)) return e.errorCode;
  return 'internal_error';
}
