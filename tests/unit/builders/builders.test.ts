import { describe, expect, it } from 'vitest';
import { buildPaginationMeta } from '../../../src/builders/paginationMeta.js';
import { buildPurchaseNotification } from '../../../src/builders/purchaseNotification.js';
import { buildRequestHash } from '../../../src/builders/requestHash.js';
import { buildTicketIssuePayload } from '../../../src/builders/ticketIssuePayload.js';
import type { OrderSelection } from '../../../src/types/order.js';
import { IDS, makeOrder, makeReservedOrder } from '../helpers/fixtures.js';

describe('buildPaginationMeta', () => {
  it('calcula la última página redondeando hacia arriba', () => {
    expect(buildPaginationMeta(2, 10, 25)).toEqual({ currentPage: 2, perPage: 10, total: 25, lastPage: 3 });
  });

  it('la última página es 1 aunque no haya resultados', () => {
    expect(buildPaginationMeta(1, 10, 0).lastPage).toBe(1);
  });
});

describe('buildRequestHash', () => {
  const selection: OrderSelection = {
    eventId: IDS.event, sectorId: IDS.sector, quantity: 2, payment: { method: 'demo_card', last4: '1111' },
  };

  it('es estable e ignora mayúsculas en los UUID', () => {
    const upper = { ...selection, eventId: IDS.event.toUpperCase(), sectorId: IDS.sector.toUpperCase() };
    expect(buildRequestHash(selection)).toMatch(/^[0-9a-f]{64}$/);
    expect(buildRequestHash(upper)).toBe(buildRequestHash(selection));
  });

  it('cambia si cambia la cantidad o el pago', () => {
    expect(buildRequestHash({ ...selection, quantity: 3 })).not.toBe(buildRequestHash(selection));
    expect(buildRequestHash({ ...selection, payment: { method: 'demo_card', last4: '0000' } }))
      .not.toBe(buildRequestHash(selection));
  });
});

describe('buildTicketIssuePayload', () => {
  it('arma el cuerpo de emisión desde la copia de la reserva, sin city', () => {
    const payload = buildTicketIssuePayload(makeReservedOrder());
    expect(payload).toEqual({
      orderId: IDS.order,
      customerId: IDS.customer,
      paymentStatus: 'approved',
      quantity: 2,
      unitPriceMinor: 5000,
      currency: 'BOB',
      event: { id: IDS.event, title: 'Noche de Rock', venue: 'Estadio', startsAt: '2026-12-31T22:00:00.000Z', organizerId: IDS.organizer },
      sector: { id: IDS.sector, name: 'General' },
    });
  });

  it('falla si la reserva no está confirmada', () => {
    expect(() => buildTicketIssuePayload(makeOrder())).toThrow('reserva confirmada');
  });
});

describe('buildPurchaseNotification', () => {
  it('arma el resumen de la compra para el comprador', () => {
    expect(buildPurchaseNotification(makeReservedOrder())).toEqual({
      orderId: IDS.order,
      to: 'cliente@example.com',
      event: { title: 'Noche de Rock', venue: 'Estadio', startsAt: '2026-12-31T22:00:00.000Z' },
      sector: { name: 'General' },
      quantity: 2,
      totalMinor: 10000,
      currency: 'BOB',
    });
  });

  it.each([
    ['sin reserva', makeOrder()],
    ['sin precio', makeReservedOrder({ unit_price_minor: null })],
    ['sin moneda', makeReservedOrder({ currency: null })],
  ])('falla %s', (_name, order) => {
    expect(() => buildPurchaseNotification(order)).toThrow('reserva confirmada');
  });
});
