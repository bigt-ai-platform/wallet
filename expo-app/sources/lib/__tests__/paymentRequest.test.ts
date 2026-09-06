import { describe, expect, it } from 'vitest';
import {
  buildPaymentRequestJson,
  buildPaymentRequestQuery,
} from '../paymentRequest';

const fields = {
  address: 'n3MotdMXgRKwrSwDLwAdr3gPaXQsFXdNDs',
  amount: '0.5',
  tokenid: 'bc',
  memo: 'coffee',
};

describe('buildPaymentRequestJson', () => {
  it('produces the Java-wallet payment QR payload', () => {
    const json = JSON.parse(buildPaymentRequestJson(fields));
    expect(json.address).toBe(fields.address);
    expect(json.quantity).toBe('0.5');
    expect(json.tokenid).toBe('bc');
    expect(json.memo).toBe('coffee');
  });

  it('omits empty optional fields', () => {
    const json = buildPaymentRequestJson({ address: fields.address });
    expect(json).toBe(JSON.stringify({ address: fields.address }));
  });
});

describe('buildPaymentRequestQuery', () => {
  it('encodes fields as url query params', () => {
    const q = buildPaymentRequestQuery(fields);
    expect(q).toContain('address=' + encodeURIComponent(fields.address));
    expect(q).toContain('amount=0.5');
    expect(q).toContain('tokenid=bc');
    expect(q).toContain('memo=coffee');
  });

  it('round-trips through decodeURIComponent', () => {
    const q = buildPaymentRequestQuery(fields);
    const pairs = Object.fromEntries(
      q.split('&').map((part) => {
        const [k, v] = part.split('=');
        return [decodeURIComponent(k), decodeURIComponent(v)];
      }),
    );
    expect(pairs).toMatchObject({
      address: fields.address,
      amount: '0.5',
      tokenid: 'bc',
      memo: 'coffee',
    });
  });
});
