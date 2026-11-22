import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OrdersController } from '../../../src/controllers/ordersController.js';
import { ReportsController } from '../../../src/controllers/reportsController.js';
import { errorHandler } from '../../../src/middleware/errorHandler.js';
import { requestContext } from '../../../src/middleware/requestContext.js';
import type { OrdersRepository } from '../../../src/repositories/ordersRepository.js';
import type { ReportsRepository } from '../../../src/repositories/reportsRepository.js';
import { ordersRoutes } from '../../../src/routes/ordersRoutes.js';
import type { PurchaseService } from '../../../src/services/purchaseService.js';
import type { AuthUser } from '../../../src/types/auth.js';
import { AppError } from '../../../src/utils/appError.js';
import { IDS, makeOrder, makePaidOrder } from '../helpers/fixtures.js';

/** Tokens de prueba: el verificador falso los traduce a un usuario o falla. */
const USERS: Record<string, AuthUser> = {
  customer: { id: IDS.customer, role: 'customer', email: 'cliente@example.com' },
  organizer: { id: IDS.organizer, role: 'organizer', email: 'org@example.com' },
};
const verifyToken = vi.fn(async (token: string) => {
  const user = USERS[token];
  if (!user) throw new Error('token inválido');
  return user;
});

let repo: { listByCustomer: ReturnType<typeof vi.fn>; findOwned: ReturnType<typeof vi.fn> };
let purchases: { purchase: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> };
let reportsRepo: { belongsToAnotherOrganizer: ReturnType<typeof vi.fn>; salesBySector: ReturnType<typeof vi.fn> };
let app: express.Express;

beforeEach(() => {
  repo = { listByCustomer: vi.fn(), findOwned: vi.fn() };
  purchases = { purchase: vi.fn(), retry: vi.fn() };
  reportsRepo = { belongsToAnotherOrganizer: vi.fn().mockResolvedValue(false), salesBySector: vi.fn().mockResolvedValue([]) };
  const controllers = {
    orders: new OrdersController(repo as unknown as OrdersRepository, purchases as unknown as PurchaseService),
    reports: new ReportsController(reportsRepo as unknown as ReportsRepository),
  };
  app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use('/api/orders', ordersRoutes(controllers, verifyToken));
  app.use(errorHandler);
});

const validBody = { eventId: IDS.event, sectorId: IDS.sector, quantity: 2, payment: { method: 'demo_card', last4: '1111' } };
const asCustomer = { authorization: 'Bearer customer' };

describe('autenticación y roles', () => {
  it('sin token responde 401', async () => {
    const res = await request(app).get('/api/orders/me');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED', message: 'Falta el token de acceso' } });
  });

  it('con un token inválido responde 401', async () => {
    const res = await request(app).get('/api/orders/me').set('authorization', 'Bearer otro');
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Token inválido o vencido');
  });

  it('con otro rol responde 403', async () => {
    const res = await request(app).get('/api/orders/me').set('authorization', 'Bearer organizer');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('todas las respuestas son privadas y sin caché', async () => {
    const res = await request(app).get('/api/orders/me');
    expect(res.headers['cache-control']).toBe('private, no-store');
  });
});

describe('POST /api/orders', () => {
  it('compra nueva → 201 con el mensaje y la orden', async () => {
    purchases.purchase.mockResolvedValue({ created: true, order: makePaidOrder({ ticket_status: 'issued' }) });
    const res = await request(app).post('/api/orders').set(asCustomer).set('idempotency-key', 'k1').send(validBody);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, message: 'Compra realizada', data: { id: IDS.order, status: 'paid' }, meta: null });
    expect(res.body.requestId).toEqual(expect.any(String));
    expect(purchases.purchase).toHaveBeenCalledWith(USERS.customer, 'k1', validBody, res.body.requestId);
  });

  it('compra repetida → 200', async () => {
    purchases.purchase.mockResolvedValue({ created: false, order: makeOrder() });
    const res = await request(app).post('/api/orders').set(asCustomer).set('idempotency-key', 'k1').send(validBody);
    expect(res.status).toBe(200);
  });

  it('sin Idempotency-Key → 400 con el detalle del header', async () => {
    const res = await request(app).post('/api/orders').set(asCustomer).send(validBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'Falta o es inválido el header Idempotency-Key',
      details: [{ field: 'Idempotency-Key', message: 'Falta el header Idempotency-Key' }],
    });
  });

  it('cuerpo inválido → 400 con los campos que fallan', async () => {
    const res = await request(app).post('/api/orders').set(asCustomer).set('idempotency-key', 'k1')
      .send({ ...validBody, quantity: 7, unitPriceMinor: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toEqual(expect.arrayContaining(['quantity', 'body']));
  });

  it('un AppError del servicio se responde tal cual', async () => {
    purchases.purchase.mockRejectedValue(new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Esa clave de compra ya se usó con otros datos'));
    const res = await request(app).post('/api/orders').set(asCustomer).set('idempotency-key', 'k1').send(validBody);
    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({ code: 'IDEMPOTENCY_CONFLICT', message: 'Esa clave de compra ya se usó con otros datos' });
  });
});

describe('GET /api/orders/me', () => {
  it('lista las compras del comprador con paginación', async () => {
    repo.listByCustomer.mockResolvedValue({ rows: [makeOrder()], total: 11 });
    const res = await request(app).get('/api/orders/me?page=2&perPage=5').set(asCustomer);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta).toEqual({ currentPage: 2, perPage: 5, total: 11, lastPage: 3 });
    expect(repo.listByCustomer).toHaveBeenCalledWith(IDS.customer, 2, 5);
  });

  it('query params inválidos → 400', async () => {
    const res = await request(app).get('/api/orders/me?perPage=500').set(asCustomer);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/orders/:id', () => {
  it('devuelve la compra del comprador', async () => {
    repo.findOwned.mockResolvedValue(makeOrder());
    const res = await request(app).get(`/api/orders/${IDS.order.toUpperCase()}`).set(asCustomer);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('La compra está en proceso; consulta su estado o reintenta');
    expect(repo.findOwned).toHaveBeenCalledWith(IDS.order, IDS.customer);
  });

  it('404 si no existe o es de otro comprador', async () => {
    repo.findOwned.mockResolvedValue(null);
    const res = await request(app).get(`/api/orders/${IDS.order}`).set(asCustomer);
    expect(res.status).toBe(404);
  });

  it('404 si el id no es un UUID, sin consultar la base', async () => {
    const res = await request(app).get('/api/orders/abc').set(asCustomer);
    expect(res.status).toBe(404);
    expect(repo.findOwned).not.toHaveBeenCalled();
  });
});

describe('POST /api/orders/:id/retry', () => {
  it('reprocesa la compra', async () => {
    purchases.retry.mockResolvedValue(makePaidOrder({ ticket_status: 'pending' }));
    const res = await request(app).post(`/api/orders/${IDS.order}/retry`).set(asCustomer);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Compra pagada; tus entradas se están emitiendo');
    expect(purchases.retry).toHaveBeenCalledWith(IDS.order, IDS.customer, res.body.requestId);
  });
});

describe('GET /api/orders/reports/events/:eventId', () => {
  const asOrganizer = { authorization: 'Bearer organizer' };

  it('devuelve el reporte de ventas del organizador', async () => {
    reportsRepo.salesBySector.mockResolvedValue([
      { sector_id: IDS.sector, sector_name: 'General', currency: 'BOB', orders_paid: 1, tickets_sold: '2', revenue_minor: '10000' },
    ]);
    const res = await request(app).get(`/api/orders/reports/events/${IDS.event}`).set(asOrganizer);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ eventId: IDS.event, currency: 'BOB', ticketsSold: 2, revenueMinor: 10000 });
    expect(reportsRepo.salesBySector).toHaveBeenCalledWith(IDS.event, IDS.organizer);
  });

  it('403 si el evento es de otro organizador', async () => {
    reportsRepo.belongsToAnotherOrganizer.mockResolvedValue(true);
    const res = await request(app).get(`/api/orders/reports/events/${IDS.event}`).set(asOrganizer);
    expect(res.status).toBe(403);
    expect(reportsRepo.salesBySector).not.toHaveBeenCalled();
  });

  it('400 si el eventId no es un UUID', async () => {
    const res = await request(app).get('/api/orders/reports/events/abc').set(asOrganizer);
    expect(res.status).toBe(400);
  });

  it('un comprador no puede ver reportes', async () => {
    const res = await request(app).get(`/api/orders/reports/events/${IDS.event}`).set(asCustomer);
    expect(res.status).toBe(403);
  });
});
