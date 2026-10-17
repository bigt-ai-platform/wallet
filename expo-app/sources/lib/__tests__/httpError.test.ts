import { describe, it, expect } from 'vitest';
import { serverErrorMessage } from '../httpError';

describe('serverErrorMessage', () => {
  it('prefers the Fastify 500 message over the generic error', () => {
    expect(
      serverErrorMessage(
        { statusCode: 500, error: 'Internal Server Error', message: 'insufficient spendable outputs for social tx' },
        500,
      ),
    ).toBe('insufficient spendable outputs for social tx');
  });

  it('uses the engine route error when there is no message', () => {
    expect(serverErrorMessage({ error: 'order is no longer active' }, 409)).toBe('order is no longer active');
  });

  it('falls back to the HTTP status for an empty/unknown body', () => {
    expect(serverErrorMessage({}, 502)).toBe('HTTP 502');
    expect(serverErrorMessage(null, 503)).toBe('HTTP 503');
    expect(serverErrorMessage({ error: '' }, 400)).toBe('HTTP 400');
  });
});
