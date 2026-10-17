/**
 * Human-readable message from a failed JSON response.
 *
 * The p2p engine is Fastify, whose default error body is
 * `{ statusCode, error: "Internal Server Error", message: <real reason> }` —
 * so preferring `error` (as the client used to) hides the cause behind a
 * generic string. The engine's own routes answer `{ error }` only, so fall
 * back to that, then to the HTTP status.
 */
export function serverErrorMessage(
  data: unknown,
  status: number,
  fallback: string = `HTTP ${status}`,
): string {
  const body = (data ?? {}) as { error?: unknown; message?: unknown };
  if (typeof body.message === 'string' && body.message) return body.message;
  if (typeof body.error === 'string' && body.error) return body.error;
  return fallback;
}
