import { describe, expect, it } from 'vitest';
import {
  createOrderSchema, idempotencyKeySchema, listOrdersQuerySchema, orderIdSchema,
} from '../../../src/validators/orderValidators.js';
import { reportParamsSchema } from '../../../src/validators/reportValidators.js';
import { IDS } from '../helpers/fixtures.js';

const validBody = {
  eventId: IDS.event.toUpperCase(),
  sectorId: IDS.sector,
  quantity: 2,
  payment: { method: 'demo_card', last4: '1111' },
};

describe('createOrderSchema', () => {
  it('acepta una compra válida y normaliza los UUID a minúsculas', () => {
    expect(createOrderSchema.parse(validBody).eventId).toBe(IDS.event);
  });

  it.each([
    ['cantidad 0', { ...validBody, quantity: 0 }],
    ['cantidad 7', { ...validBody, quantity: 7 }],
    ['cantidad decimal', { ...validBody, quantity: 1.5 }],
    ['precio enviado por el navegador', { ...validBody, unitPriceMinor: 1 }],
    ['last4 desconocido', { ...validBody, payment: { method: 'demo_card', last4: '1234' } }],
    ['campo extra en payment', { ...validBody, payment: { method: 'demo_card', last4: '1111', cvv: '123' } }],
    ['eventId que no es UUID', { ...validBody, eventId: 'x' }],
  ])('rechaza %s', (_name, body) => {
    expect(createOrderSchema.safeParse(body).success).toBe(false);
  });
});

describe('idempotencyKeySchema', () => {
  it('acepta letras, números y . _ : -', () => {
    expect(idempotencyKeySchema.parse('Compra_1:a.b-c')).toBe('Compra_1:a.b-c');
  });

  it.each([[undefined], [''], ['con espacio'], ['x'.repeat(129)]])('rechaza %j', (value) => {
    expect(idempotencyKeySchema.safeParse(value).success).toBe(false);
  });

  it('explica que falta el header', () => {
    const result = idempotencyKeySchema.safeParse(undefined);
    expect(result.success ? '' : result.error.issues[0]!.message).toBe('Falta el header Idempotency-Key');
  });
});

describe('orderIdSchema y reportParamsSchema', () => {
  it('normalizan el UUID', () => {
    expect(orderIdSchema.parse(IDS.order.toUpperCase())).toBe(IDS.order);
    expect(reportParamsSchema.parse({ eventId: IDS.event.toUpperCase() })).toEqual({ eventId: IDS.event });
  });

  it('rechazan valores que no son UUID', () => {
    expect(orderIdSchema.safeParse('abc').success).toBe(false);
    expect(reportParamsSchema.safeParse({ eventId: 'abc' }).success).toBe(false);
  });
});

describe('listOrdersQuerySchema', () => {
  it('usa página 1 y 10 por página por defecto', () => {
    expect(listOrdersQuerySchema.parse({})).toEqual({ page: 1, perPage: 10 });
  });

  it('convierte los query params de texto', () => {
    expect(listOrdersQuerySchema.parse({ page: '3', perPage: '50' })).toEqual({ page: 3, perPage: 50 });
  });

  it.each([[{ page: '0' }], [{ perPage: '101' }], [{ sort: 'x' }]])('rechaza %j', (query) => {
    expect(listOrdersQuerySchema.safeParse(query).success).toBe(false);
  });
});
