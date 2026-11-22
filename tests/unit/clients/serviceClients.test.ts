import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClients } from '../../../src/clients/clients.js';
import { EventsClient } from '../../../src/clients/eventsClient.js';
import type { ServiceEndpoint } from '../../../src/clients/httpClient.js';
import { NotificationsClient } from '../../../src/clients/notificationsClient.js';
import { PaymentsClient } from '../../../src/clients/paymentsClient.js';
import { TicketsClient } from '../../../src/clients/ticketsClient.js';
import { buildPurchaseNotification } from '../../../src/builders/purchaseNotification.js';
import { buildTicketIssuePayload } from '../../../src/builders/ticketIssuePayload.js';
import { IDS, makePayment, makeReservation, makeReservedOrder } from '../helpers/fixtures.js';

const endpoint: ServiceEndpoint = { name: 'svc', url: 'http://svc.test', token: 'token-0123456789abcdef-xyz', timeoutMs: 1000 };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1)!;
  return { url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : undefined };
}

describe('EventsClient', () => {
  const events = new EventsClient(endpoint);

  it('reserve hace POST /internal/reservations y valida la reserva', async () => {
    respond(201, makeReservation());
    const input = { orderId: IDS.order, eventId: IDS.event, sectorId: IDS.sector, quantity: 2 };
    const result = await events.reserve(input, 'r');
    expect(result).toMatchObject({ kind: 'ok', status: 201, data: { reservation: { id: IDS.reservation } } });
    expect(lastCall()).toEqual({ url: 'http://svc.test/internal/reservations', method: 'POST', body: input });
  });

  it('getReservation hace GET /internal/reservations/:orderId', async () => {
    respond(200, makeReservation());
    await events.getReservation(IDS.order, 'r');
    expect(lastCall()).toMatchObject({ url: `http://svc.test/internal/reservations/${IDS.order}`, method: 'GET' });
  });

  it('release hace POST /internal/reservations/:orderId/release', async () => {
    respond(200, makeReservation({ status: 'released', releasedAt: '2026-01-01T00:10:00.000Z' }));
    const result = await events.release(IDS.order, 'r');
    expect(result.kind).toBe('ok');
    expect(lastCall()).toMatchObject({ url: `http://svc.test/internal/reservations/${IDS.order}/release`, method: 'POST' });
  });
});

describe('PaymentsClient', () => {
  const payments = new PaymentsClient(endpoint);

  it('charge hace POST /internal/payments', async () => {
    respond(201, makePayment());
    const input = { orderId: IDS.order, amountMinor: 10000, currency: 'BOB', method: 'demo_card' as const, last4: '1111' };
    await expect(payments.charge(input, 'r')).resolves.toMatchObject({ kind: 'ok', data: { status: 'approved' } });
    expect(lastCall()).toEqual({ url: 'http://svc.test/internal/payments', method: 'POST', body: input });
  });

  it('getByOrder hace GET /internal/payments/orders/:orderId', async () => {
    respond(200, makePayment());
    await payments.getByOrder(IDS.order, 'r');
    expect(lastCall()).toMatchObject({ url: `http://svc.test/internal/payments/orders/${IDS.order}`, method: 'GET' });
  });
});

describe('TicketsClient', () => {
  it('issue hace POST /internal/tickets/issue con el cuerpo de emisión', async () => {
    respond(201, { orderId: IDS.order, items: [{ id: IDS.ticket, ticketNumber: 1, pdfUrl: '/t/1.pdf' }] });
    const payload = buildTicketIssuePayload(makeReservedOrder());
    const result = await new TicketsClient(endpoint).issue(payload, 'r');
    expect(result).toMatchObject({ kind: 'ok', data: { items: [{ ticketNumber: 1 }] } });
    expect(lastCall()).toEqual({ url: 'http://svc.test/internal/tickets/issue', method: 'POST', body: payload });
  });
});

describe('NotificationsClient', () => {
  it('sendPurchase hace POST /internal/notifications/purchase', async () => {
    respond(202, { queued: true });
    const notification = buildPurchaseNotification(makeReservedOrder());
    await expect(new NotificationsClient(endpoint).sendPurchase(notification, 'r')).resolves.toMatchObject({ kind: 'ok' });
    expect(lastCall()).toEqual({ url: 'http://svc.test/internal/notifications/purchase', method: 'POST', body: notification });
  });
});

describe('createClients', () => {
  it('crea un cliente por servicio interno', () => {
    const clients = createClients();
    expect(clients.events).toBeInstanceOf(EventsClient);
    expect(clients.payments).toBeInstanceOf(PaymentsClient);
    expect(clients.tickets).toBeInstanceOf(TicketsClient);
    expect(clients.notifications).toBeInstanceOf(NotificationsClient);
  });
});
