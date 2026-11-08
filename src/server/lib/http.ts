import type { ZodType } from 'zod';
import { AppError } from './errors';

/** Parse a JSON body and turn zod failures into a 422 API error. */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : '参数不合法';
    throw new AppError('VALIDATION_FAILED', 422, message);
  }
  return parsed.data;
}

/** Loopback check for `localhost`-only host administration (FR-01/FR-47). */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}
