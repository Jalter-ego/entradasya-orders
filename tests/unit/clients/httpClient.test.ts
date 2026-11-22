import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { callService, type ServiceEndpoint } from '../../../src/clients/httpClient.js';

const endpoint: ServiceEndpoint = { name: 'events', url: 'http://events.test', token: 'token-events-0123456789abcdef', timeoutMs: 1000 };
const schema = z.object({ ok: z.literal(true) });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function namedError(name: string) {
  const error = new Error(name);
  error.name = name;
  return error;
}

describe('callService', () => {
  it('envía método, ruta, token interno, request id y cuerpo JSON', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { ok: true }));
    await callService(endpoint, { method: 'POST', path: '/internal/x', body: { a: 1 }, requestId: 'req-1', schema });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://events.test/internal/x');
    expect(init).toMatchObject({
      method: 'POST',
      body: '{"a":1}',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-internal-token': endpoint.token,
        'x-request-id': 'req-1',
      },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sin cuerpo no envía content-type ni body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await callService(endpoint, { method: 'GET', path: '/x', requestId: 'r', schema, timeoutMs: 50 });
    const init = fetchMock.mock.calls[0]![1];
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty('content-type');
  });

  it('2xx con cuerpo válido → ok', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { ok: true }));
    await expect(callService(endpoint, { method: 'GET', path: '/x', requestId: 'r', schema }))
      .resolves.toEqual({ kind: 'ok', status: 201, data: { ok: true } });
  });

  it('2xx con cuerpo que no cumple el esquema → unavailable INVALID_RESPONSE', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: false }));
    await expect(callService(endpoint, { method: 'GET', path: '/x', requestId: 'r', schema }))
      .resolves.toEqual({ kind: 'unavailable', status: 200, code: 'INVALID_RESPONSE' });
  });

  it('2xx con cuerpo que no es JSON → unavailable INVALID_RESPONSE', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 200 }));
    await expect(callService(endpoint, { method: 'GET', path: '/x', requestId: 'r', schema }))
      .resolves.toEqual({ kind: 'unavailable', status: 200, code: 'INVALID_RESPONSE' });
  });

  it('4xx con error de negocio → rejected con código y mensaje', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: { code: 'SOLD_OUT', message: 'Agotado' } }));
    await expect(callService(endpoint, { method: 'POST', path: '/x', requestId: 'r', schema }))
      .resolves.toEqual({ kind: 'rejected', status: 409, code: 'SOLD_OUT', message: 'Agotado' });
  });

  it('4xx sin cuerpo JSON → rejected HTTP_<status>', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
    await expect(callService(endpoint, { method: 'GET', path: '/x', requestId: 'r', schema }))
      .resolves.toEqual({ kind: 'rejected', status: 404, code: 'HTTP_404', message: '' });
  });

  it('5xx → unavailable con el código del cuerpo', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { error: { code: 'PDF_UNAVAILABLE' } }));
    await expect(callService(endpoint, { method: 'POST', path: '/x', requestId: 'r', schema }))
      .resolves.toEqual({ kind: 'unavailable', status: 503, code: 'PDF_UNAVAILABLE' });
  });

  it('5xx con códigos que no son texto → HTTP_<status>', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: { code: 1, message: 2 } }));
    await expect(callService(endpoint, { method: 'POST', path: '/x', requestId: 'r', schema }))
      .resolves.toEqual({ kind: 'unavailable', status: 500, code: 'HTTP_500' });
  });

  it('timeout antes de la respuesta → unavailable TIMEOUT', async () => {
    fetchMock.mockRejectedValue(namedError('TimeoutError'));
    await expect(callService(endpoint, { method: 'GET', path: '/x', requestId: 'r', schema }))
      .resolves.toEqual({ kind: 'unavailable', status: null, code: 'TIMEOUT' });
  });

  it('error de red → unavailable NETWORK_ERROR', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(callService(endpoint, { method: 'GET', path: '/x', requestId: 'r', schema }))
      .resolves.toEqual({ kind: 'unavailable', status: null, code: 'NETWORK_ERROR' });
  });

  it('timeout mientras se lee el cuerpo → unavailable TIMEOUT', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => Promise.reject(namedError('TimeoutError')) });
    await expect(callService(endpoint, { method: 'GET', path: '/x', requestId: 'r', schema }))
      .resolves.toEqual({ kind: 'unavailable', status: 200, code: 'TIMEOUT' });
  });
});
