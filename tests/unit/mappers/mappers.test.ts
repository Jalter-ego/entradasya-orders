import { describe, expect, it } from 'vitest';
import { toOrder } from '../../../src/mappers/orderMapper.js';
import { toOrderMessage } from '../../../src/mappers/orderMessage.js';
import { toSalesReport } from '../../../src/mappers/reportMapper.js';
import type { SectorSalesRow } from '../../../src/types/report.js';
import { IDS, makeOrder, makePaidOrder } from '../helpers/fixtures.js';

describe('toOrder', () => {
  it('expone una orden pagada en camelCase con total, evento y progreso', () => {
    expect(toOrder(makePaidOrder())).toEqual({
      id: IDS.order,
      status: 'paid',
      eventId: IDS.event,
      sectorId: IDS.sector,
      quantity: 2,
      unitPriceMinor: 5000,
      totalMinor: 10000,
      currency: 'BOB',
      event: { id: IDS.event, title: 'Noche de Rock', venue: 'Estadio', city: 'La Paz', startsAt: '2026-12-31T22:00:00.000Z' },
      sector: { id: IDS.sector, name: 'General' },
      payment: { method: 'demo_card', last4: '1111', transactionId: IDS.transaction },
      progress: { reservation: 'active', payment: 'approved', tickets: 'not_started', notification: 'not_started' },
      lastError: null,
      paidAt: '2026-01-01T00:05:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('deja en null lo que todavía no se conoce', () => {
    const order = toOrder(makeOrder());
    expect(order).toMatchObject({ unitPriceMinor: null, totalMinor: null, event: null, sector: null, paidAt: null });
  });

  it('incluye el último error, con código vacío si falta', () => {
    expect(toOrder(makeOrder({ last_error_step: 'payment', last_error_code: 'TIMEOUT' })).lastError)
      .toEqual({ step: 'payment', code: 'TIMEOUT' });
    expect(toOrder(makeOrder({ last_error_step: 'payment', last_error_code: null })).lastError)
      .toEqual({ step: 'payment', code: '' });
  });
});

describe('toOrderMessage', () => {
  it.each([
    [makePaidOrder({ ticket_status: 'issued' }), 'Compra realizada'],
    [makePaidOrder({ ticket_status: 'pending' }), 'Compra pagada; tus entradas se están emitiendo'],
    [makeOrder({ status: 'rejected', last_error_code: 'SOLD_OUT' }), 'No quedan cupos suficientes en el sector'],
    [makeOrder({ status: 'rejected', last_error_code: 'PAYMENT_REJECTED' }), 'El pago fue rechazado'],
    [makeOrder({ status: 'rejected', last_error_code: 'OTRO' }), 'La compra no se pudo completar'],
    [makeOrder({ status: 'rejected', last_error_code: null }), 'La compra no se pudo completar'],
    [makeOrder({ status: 'cancelled' }), 'Compra cancelada'],
    [makeOrder(), 'La compra está en proceso; consulta su estado o reintenta'],
  ])('mensaje para %#', (order, message) => {
    expect(toOrderMessage(order)).toBe(message);
  });
});

describe('toSalesReport', () => {
  const row = (overrides: Partial<SectorSalesRow> = {}): SectorSalesRow => ({
    sector_id: IDS.sector, sector_name: 'General', currency: 'BOB', orders_paid: 2, tickets_sold: '3', revenue_minor: '15000',
    ...overrides,
  });

  it('suma los sectores y convierte las sumas de texto a número', () => {
    const report = toSalesReport(IDS.event, [row(), row({ sector_id: 'vip', sector_name: 'VIP', orders_paid: 1, tickets_sold: '1', revenue_minor: '9000' })]);
    expect(report).toEqual({
      eventId: IDS.event,
      currency: 'BOB',
      ordersPaid: 3,
      ticketsSold: 4,
      revenueMinor: 24000,
      sectors: [
        { sectorId: IDS.sector, sectorName: 'General', ordersPaid: 2, ticketsSold: 3, revenueMinor: 15000 },
        { sectorId: 'vip', sectorName: 'VIP', ordersPaid: 1, ticketsSold: 1, revenueMinor: 9000 },
      ],
    });
  });

  it('un evento sin ventas da totales en cero y moneda null', () => {
    expect(toSalesReport(IDS.event, [])).toEqual({
      eventId: IDS.event, currency: null, ordersPaid: 0, ticketsSold: 0, revenueMinor: 0, sectors: [],
    });
  });

  it('rechaza ventas con monedas distintas', () => {
    expect(() => toSalesReport(IDS.event, [row(), row({ currency: 'USD' })])).toThrow('monedas distintas');
  });

  it('rechaza sumas fuera del rango seguro', () => {
    expect(() => toSalesReport(IDS.event, [row({ revenue_minor: '99999999999999999999' })])).toThrow();
  });
});
