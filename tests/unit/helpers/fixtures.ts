import type { ReservationResponse } from '../../../src/clients/eventsClient.js';
import type { PaymentResponse } from '../../../src/clients/paymentsClient.js';
import type { OrderRow } from '../../../src/types/order.js';

export const IDS = {
  order: '11111111-1111-4111-8111-111111111111',
  customer: '22222222-2222-4222-8222-222222222222',
  event: '33333333-3333-4333-8333-333333333333',
  sector: '44444444-4444-4444-8444-444444444444',
  organizer: '55555555-5555-4555-8555-555555555555',
  reservation: '66666666-6666-4666-8666-666666666666',
  transaction: '77777777-7777-4777-8777-777777777777',
  ticket: '88888888-8888-4888-8888-888888888888',
} as const;

export function makeReservation(overrides: Partial<ReservationResponse['reservation']> = {}): ReservationResponse {
  return {
    reservation: {
      id: IDS.reservation,
      orderId: IDS.order,
      eventId: IDS.event,
      sectorId: IDS.sector,
      quantity: 2,
      unitPriceMinor: 5000,
      totalMinor: 10000,
      currency: 'BOB',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      releasedAt: null,
      ...overrides,
    },
    event: {
      id: IDS.event,
      title: 'Noche de Rock',
      venue: 'Estadio',
      city: 'La Paz',
      startsAt: '2026-12-31T22:00:00.000Z',
      organizerId: IDS.organizer,
    },
    sector: { id: IDS.sector, name: 'General' },
  };
}

/** Orden recién creada (pending, sin reserva). */
export function makeOrder(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: IDS.order,
    customer_id: IDS.customer,
    customer_email: 'cliente@example.com',
    idempotency_key: 'k1',
    request_hash: 'hash',
    status: 'pending',
    reservation_status: 'not_started',
    payment_status: 'not_started',
    ticket_status: 'not_started',
    notification_status: 'not_started',
    payment_request: { method: 'demo_card', last4: '1111' },
    payment_transaction_id: null,
    ticket_issue_payload: null,
    last_error_step: null,
    last_error_code: null,
    paid_at: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    event_id: IDS.event,
    sector_id: IDS.sector,
    quantity: 2,
    organizer_id: null,
    unit_price_minor: null,
    currency: null,
    reservation_snapshot: null,
    ...overrides,
  };
}

/** Orden con la reserva confirmada (lista para cobrar). */
export function makeReservedOrder(overrides: Partial<OrderRow> = {}): OrderRow {
  return makeOrder({
    reservation_status: 'active',
    organizer_id: IDS.organizer,
    unit_price_minor: 5000,
    currency: 'BOB',
    reservation_snapshot: makeReservation(),
    ...overrides,
  });
}

/** Orden pagada (lista para emitir entradas). */
export function makePaidOrder(overrides: Partial<OrderRow> = {}): OrderRow {
  return makeReservedOrder({
    status: 'paid',
    payment_status: 'approved',
    payment_transaction_id: IDS.transaction,
    paid_at: new Date('2026-01-01T00:05:00.000Z'),
    ...overrides,
  });
}

export function makePayment(overrides: Partial<PaymentResponse> = {}): PaymentResponse {
  return {
    transactionId: IDS.transaction,
    orderId: IDS.order,
    status: 'approved',
    amountMinor: 10000,
    currency: 'BOB',
    ...overrides,
  };
}
