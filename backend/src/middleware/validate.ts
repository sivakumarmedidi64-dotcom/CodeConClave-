/**
 * CodeConClave - Zod validation middleware.
 * Validates request body against Zod schemas.
 */
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';

export function validate(schema: z.ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));
      throw new Error(JSON.stringify({ code: 'VALIDATION_ERROR', errors }));
    }
    req.body = result.data;
    next();
  };
}

export const validateQuery = (schema: z.ZodSchema) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));
      throw new Error(JSON.stringify({ code: 'VALIDATION_ERROR', errors }));
    }
    req.query = result.data as Record<string, string>;
    next();
  };
}

export const validateParams = (schema: z.ZodSchema) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));
      throw new Error(JSON.stringify({ code: 'VALIDATION_ERROR', errors }));
    }
    req.params = result.data as Record<string, string>;
    next();
  };
}