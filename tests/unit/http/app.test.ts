import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../src/app.js';
import type { Clients } from '../../../src/clients/clients.js';
import { errorHandler } from '../../../src/middleware/errorHandler.js';
import { notFound } from '../../../src/middleware/notFound.js';
import { requestContext } from '../../../src/middleware/requestContext.js';
import { createFakeDb } from '../helpers/fakeDb.js';

function buildApp() {
  const fake = createFakeDb();
  const app = createApp({ db: fake.db, verifyToken: vi.fn(), clients: {} as Clients });
  return { app, ...fake };
}

describe('createApp', () => {
  it('GET /health responde ok si la base y las migraciones están disponibles', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { status: 'ok', service: 'orders' } });
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('GET /health responde 503 si la base falla', async () => {
    const { app, pool } = buildApp();
    pool.query.mockRejectedValue(new Error('sin conexión'));
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('una ruta desconocida responde 404', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/no-existe');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, data: null, error: { code: 'NOT_FOUND', message: 'Ruta no encontrada' } });
  });

  it('un JSON mal formado responde 400 INVALID_JSON', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/orders').set('content-type', 'application/json').send('{"roto"');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('un cuerpo de más de 32kb responde 413', async () => {
    const { app } = buildApp();
    const res = await request(app).post('/api/orders').set('content-type', 'application/json')
      .send(JSON.stringify({ x: 'a'.repeat(40_000) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('BODY_TOO_LARGE');
  });
});

describe('requestContext', () => {
  it('reutiliza un x-request-id válido', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/health').set('x-request-id', 'abc-123');
    expect(res.headers['x-request-id']).toBe('abc-123');
    expect(res.body.requestId).toBe('abc-123');
  });

  it('genera uno nuevo si el recibido no es válido', async () => {
    const { app } = buildApp();
    const res = await request(app).get('/health').set('x-request-id', 'con espacios!');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('errorHandler', () => {
  function appThatThrows(error: unknown, sendFirst = false) {
    const app = express();
    app.use(requestContext);
    app.get('/boom', (_req, res) => {
      if (sendFirst) res.status(200).write('parcial');
      throw error;
    });
    app.use(notFound);
    app.use(errorHandler);
    return app;
  }

  it('un error inesperado responde 500 sin filtrar detalles', async () => {
    const res = await request(appThatThrows(new Error('secreto interno'))).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'No se pudo completar la operación' });
    expect(JSON.stringify(res.body)).not.toContain('secreto');
  });

  it('también maneja errores que no son objetos Error', async () => {
    const res = await request(appThatThrows(Object.assign(Object.create(null), { name: '' }))).get('/boom');
    expect(res.status).toBe(500);
  });

  it('si la respuesta ya empezó, delega en Express', async () => {
    const handler = vi.fn();
    const app = appThatThrows(new Error('tarde'), true);
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      handler(err);
      res.end();
    });
    await request(app).get('/boom');
    expect(handler).toHaveBeenCalledOnce();
  });
});
