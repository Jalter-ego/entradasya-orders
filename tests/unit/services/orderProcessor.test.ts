import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clients } from '../../../src/clients/clients.js';
import type { RemoteResult } from '../../../src/clients/httpClient.js';
import type { Db } from '../../../src/database/database.js';
import { withOrderLock } from '../../../src/database/orderLock.js';
import type { OrderPatch, OrdersRepository } from '../../../src/repositories/ordersRepository.js';
import { OrderProcessor } from '../../../src/services/orderProcessor.js';
import type { OrderRow } from '../../../src/types/order.js';
import { buildTicketIssuePayload } from '../../../src/builders/ticketIssuePayload.js';
import {
  IDS, makeOrder, makePaidOrder, makePayment, makeReservation, makeReservedOrder,
} from '../helpers/fixtures.js';

vi.mock('../../../src/database/orderLock.js', () => ({
  withOrderLock: vi.fn(async (_db: unknown, _id: string, fn: () => Promise<unknown>) => ({ acquired: true, result: await fn() })),
}));

const ok = <T>(data: T, status = 200): RemoteResult<T> => ({ kind: 'ok', status, data });
const rejected = (code: string, status = 409): RemoteResult<never> => ({ kind: 'rejected', status, code, message: '' });
const unavailable = (code: string, status: number | null = null): RemoteResult<never> => ({ kind: 'unavailable', status, code });
const issued = (count = 2, orderId: string = IDS.order) => ok({
  orderId, items: Array.from({ length: count }, (_, i) => ({ id: IDS.ticket, ticketNumber: i + 1, pdfUrl: `/t/${i + 1}.pdf` })),
}, 201);

/** Repositorio en memoria: guarda la orden y aplica los cambios como lo haría la base. */
function createRepo(initial: OrderRow) {
  let current = structuredClone(initial);
  const snapshot = async () => structuredClone(current);
  return {
    get current() { return current; },
    mustFind: vi.fn(snapshot),
    update: vi.fn(async (_id: string, patch: OrderPatch, clearErrorFor?: string) => {
      current = { ...current, ...patch } as OrderRow;
      if (clearErrorFor && current.last_error_step === clearErrorFor) {
        current = { ...current, last_error_step: null, last_error_code: null };
      }
      return snapshot();
    }),
    confirmReservation: vi.fn(async (_id: string, reservation: ReturnType<typeof makeReservation>) => {
      current = {
        ...current,
        reservation_status: 'active',
        organizer_id: reservation.event.organizerId,
        unit_price_minor: reservation.reservation.unitPriceMinor,
        currency: reservation.reservation.currency,
        reservation_snapshot: reservation,
        ...(current.last_error_step === 'reservation' ? { last_error_step: null, last_error_code: null } : {}),
      };
      return snapshot();
    }),
    saveTicketPayload: vi.fn(async (_id: string, payload: OrderRow['ticket_issue_payload']) => {
      current = { ...current, ticket_issue_payload: current.ticket_issue_payload ?? payload, ticket_status: 'pending' };
      return snapshot();
    }),
  };
}

function createClients() {
  return {
    events: {
      reserve: vi.fn(async () => ok(makeReservation(), 201)),
      release: vi.fn(async () => ok(makeReservation({ status: 'released' }))),
      getReservation: vi.fn(),
    },
    payments: {
      charge: vi.fn(async () => ok(makePayment(), 201)),
      getByOrder: vi.fn(),
    },
    tickets: { issue: vi.fn(async () => issued()) },
    notifications: { sendPurchase: vi.fn(async () => ok({}, 202)) },
  };
}

let clients: ReturnType<typeof createClients>;
beforeEach(() => { clients = createClients(); });

async function run(initial: OrderRow) {
  const repo = createRepo(initial);
  const processor = new OrderProcessor({} as Db, repo as unknown as OrdersRepository, clients as unknown as Clients);
  const result = await processor.process(initial.id, 'req-1');
  return { repo, result };
}

describe('OrderProcessor.process', () => {
  it('compra completa: reserva, cobra, emite y notifica una sola vez', async () => {
    const { result, repo } = await run(makeOrder());

    expect(result).toMatchObject({
      status: 'paid',
      reservation_status: 'active',
      payment_status: 'approved',
      payment_transaction_id: IDS.transaction,
      ticket_status: 'issued',
      notification_status: 'sent',
      last_error_step: null,
    });
    expect(result.paid_at).toBeInstanceOf(Date);
    expect(clients.events.reserve).toHaveBeenCalledWith(
      { orderId: IDS.order, eventId: IDS.event, sectorId: IDS.sector, quantity: 2 }, 'req-1',
    );
    expect(clients.payments.charge).toHaveBeenCalledWith(
      { orderId: IDS.order, amountMinor: 10000, currency: 'BOB', method: 'demo_card', last4: '1111' }, 'req-1',
    );
    expect(clients.events.release).not.toHaveBeenCalled();
    expect(clients.tickets.issue).toHaveBeenCalledWith(buildTicketIssuePayload(makeReservedOrder()), 'req-1');
    expect(clients.notifications.sendPurchase).toHaveBeenCalledOnce();
    expect(repo.saveTicketPayload).toHaveBeenCalledOnce();
  });

  it('si otra petición tiene el lock, devuelve la orden tal como está', async () => {
    vi.mocked(withOrderLock).mockResolvedValueOnce({ acquired: false });
    const { result, repo } = await run(makeOrder());
    expect(result).toEqual(makeOrder());
    expect(repo.mustFind).toHaveBeenCalledOnce();
    expect(clients.events.reserve).not.toHaveBeenCalled();
  });

  it('una orden ya terminada no llama a ningún servicio', async () => {
    await run(makePaidOrder({ ticket_status: 'issued', notification_status: 'sent' }));
    for (const fn of [clients.events.reserve, clients.payments.charge, clients.events.release, clients.tickets.issue, clients.notifications.sendPurchase]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });
});

describe('paso de reserva', () => {
  it.each([
    ['otra cantidad', makeReservation({ quantity: 3 })],
    ['otro orderId', makeReservation({ orderId: IDS.customer })],
    ['reserva liberada', makeReservation({ status: 'released' })],
    ['importe fuera de rango', makeReservation({ unitPriceMinor: Number.MAX_SAFE_INTEGER })],
  ])('una reserva que no coincide (%s) queda como error de reserva', async (_name, reservation) => {
    clients.events.reserve.mockResolvedValueOnce(ok(reservation, 201));
    const { result } = await run(makeOrder());
    expect(result).toMatchObject({
      status: 'pending', reservation_status: 'pending', last_error_step: 'reservation', last_error_code: 'RESERVATION_MISMATCH',
    });
    expect(clients.payments.charge).not.toHaveBeenCalled();
  });

  it.each([
    ['SOLD_OUT', 'SOLD_OUT', 'failed'],
    ['EVENT_NOT_AVAILABLE', 'EVENT_NOT_AVAILABLE', 'failed'],
    ['NOT_FOUND', 'EVENT_NOT_FOUND', 'failed'],
    ['RESERVATION_RELEASED', 'RESERVATION_RELEASED', 'released'],
  ])('rechazo %s de events rechaza la orden sin cobrar', async (remoteCode, code, reservationStatus) => {
    clients.events.reserve.mockResolvedValueOnce(rejected(remoteCode));
    const { result } = await run(makeOrder());
    expect(result).toMatchObject({
      status: 'rejected', reservation_status: reservationStatus, last_error_step: 'reservation', last_error_code: code,
    });
    expect(clients.payments.charge).not.toHaveBeenCalled();
  });

  it('un rechazo desconocido o un timeout deja la reserva pendiente para reintentar', async () => {
    clients.events.reserve.mockResolvedValueOnce(rejected('VALIDATION_ERROR', 400));
    expect((await run(makeOrder())).result).toMatchObject({
      status: 'pending', reservation_status: 'pending', last_error_step: 'reservation', last_error_code: 'VALIDATION_ERROR',
    });

    clients.events.reserve.mockResolvedValueOnce(unavailable('TIMEOUT'));
    expect((await run(makeOrder())).result).toMatchObject({ status: 'pending', last_error_code: 'TIMEOUT' });
  });

  it('un reintento tras un error de reserva lo limpia al confirmar', async () => {
    const { result } = await run(makeOrder({ reservation_status: 'pending', last_error_step: 'reservation', last_error_code: 'TIMEOUT' }));
    expect(result).toMatchObject({ status: 'paid', last_error_step: null, last_error_code: null });
  });
});

describe('paso de cobro', () => {
  it('un importe fuera de rango no llama a payments', async () => {
    const { result } = await run(makeReservedOrder({ unit_price_minor: Number.MAX_SAFE_INTEGER }));
    expect(result).toMatchObject({ last_error_step: 'payment', last_error_code: 'AMOUNT_OUT_OF_RANGE' });
    expect(clients.payments.charge).not.toHaveBeenCalled();
  });

  it('con un pago en estado unknown reintenta el cobro sin volver a marcarlo pending', async () => {
    const { result, repo } = await run(makeReservedOrder({ payment_status: 'unknown', last_error_step: 'payment', last_error_code: 'TIMEOUT' }));
    expect(repo.update.mock.calls.some(([, patch]) => (patch as OrderPatch).payment_status === 'pending')).toBe(false);
    expect(result).toMatchObject({ status: 'paid', payment_status: 'approved', last_error_step: null });
  });

  it.each([
    ['otro orderId', makePayment({ orderId: IDS.customer })],
    ['otro importe', makePayment({ amountMinor: 1 })],
    ['otra moneda', makePayment({ currency: 'USD' })],
  ])('una respuesta de pago que no coincide (%s) deja el pago unknown', async (_name, payment) => {
    clients.payments.charge.mockResolvedValueOnce(ok(payment, 201));
    const { result } = await run(makeReservedOrder());
    expect(result).toMatchObject({
      status: 'pending', payment_status: 'unknown', last_error_step: 'payment', last_error_code: 'PAYMENT_MISMATCH',
    });
    expect(clients.tickets.issue).not.toHaveBeenCalled();
  });

  it('un pago rechazado (2xx) rechaza la orden, guarda la transacción y libera los cupos', async () => {
    clients.payments.charge.mockResolvedValueOnce(ok(makePayment({ status: 'rejected' }), 201));
    const { result } = await run(makeReservedOrder({ payment_request: { method: 'demo_card', last4: '0000' } }));
    expect(result).toMatchObject({
      status: 'rejected',
      payment_status: 'rejected',
      payment_transaction_id: IDS.transaction,
      reservation_status: 'released',
      last_error_step: 'payment',
      last_error_code: 'PAYMENT_REJECTED',
    });
    expect(clients.events.release).toHaveBeenCalledWith(IDS.order, 'req-1');
    expect(clients.tickets.issue).not.toHaveBeenCalled();
  });

  it('un PAYMENT_REJECTED (4xx) rechaza sin transacción; un 404 al liberar cuenta como liberado', async () => {
    clients.payments.charge.mockResolvedValueOnce(rejected('PAYMENT_REJECTED', 402));
    clients.events.release.mockResolvedValueOnce(rejected('NOT_FOUND', 404));
    const { result } = await run(makeReservedOrder());
    expect(result).toMatchObject({
      status: 'rejected', payment_transaction_id: null, reservation_status: 'released', last_error_code: 'PAYMENT_REJECTED',
    });
  });

  it('si events no responde al liberar, la liberación queda pendiente', async () => {
    clients.payments.charge.mockResolvedValueOnce(rejected('PAYMENT_REJECTED', 402));
    clients.events.release.mockResolvedValueOnce(unavailable('TIMEOUT'));
    const { result } = await run(makeReservedOrder());
    expect(result).toMatchObject({ status: 'rejected', reservation_status: 'release_pending' });
  });

  it('un reintento con liberación pendiente solo libera', async () => {
    const { result } = await run(makeReservedOrder({
      status: 'rejected', payment_status: 'rejected', reservation_status: 'release_pending',
      last_error_step: 'payment', last_error_code: 'PAYMENT_REJECTED',
    }));
    expect(result).toMatchObject({ reservation_status: 'released', last_error_code: 'PAYMENT_REJECTED' });
    expect(clients.payments.charge).not.toHaveBeenCalled();
  });

  it('otro rechazo 4xx de payments queda como error del paso de pago', async () => {
    clients.payments.charge.mockResolvedValueOnce(rejected('IDEMPOTENCY_CONFLICT'));
    const { result } = await run(makeReservedOrder());
    expect(result).toMatchObject({
      status: 'pending', payment_status: 'pending', last_error_step: 'payment', last_error_code: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('si payments no responde, el pago queda unknown', async () => {
    clients.payments.charge.mockResolvedValueOnce(unavailable('TIMEOUT'));
    const { result } = await run(makeReservedOrder());
    expect(result).toMatchObject({ payment_status: 'unknown', last_error_step: 'payment', last_error_code: 'TIMEOUT' });
  });
});

describe('paso de emisión', () => {
  it('reutiliza el cuerpo de emisión guardado', async () => {
    const saved = { ...buildTicketIssuePayload(makeReservedOrder()), quantity: 2 };
    const { repo } = await run(makePaidOrder({ ticket_status: 'pending', ticket_issue_payload: saved }));
    expect(repo.saveTicketPayload).not.toHaveBeenCalled();
    expect(clients.tickets.issue).toHaveBeenCalledWith(saved, 'req-1');
  });

  it.each([
    ['otra cantidad de entradas', issued(1)],
    ['otro orderId', issued(2, IDS.customer)],
  ])('una respuesta que no coincide (%s) queda como error de emisión', async (_name, response) => {
    clients.tickets.issue.mockResolvedValueOnce(response);
    const { result } = await run(makePaidOrder());
    expect(result).toMatchObject({ ticket_status: 'pending', last_error_step: 'tickets', last_error_code: 'TICKETS_MISMATCH' });
    expect(clients.notifications.sendPurchase).not.toHaveBeenCalled();
  });

  it('si tickets falla, la emisión queda pendiente y no se notifica', async () => {
    clients.tickets.issue.mockResolvedValueOnce(unavailable('PDF_UNAVAILABLE', 503));
    const { result } = await run(makePaidOrder());
    expect(result).toMatchObject({ status: 'paid', ticket_status: 'pending', last_error_step: 'tickets', last_error_code: 'PDF_UNAVAILABLE' });
    expect(clients.notifications.sendPurchase).not.toHaveBeenCalled();
  });
});

describe('paso de notificación', () => {
  const issuedOrder = () => makePaidOrder({ ticket_status: 'issued' });

  it('un timeout deja la notificación unknown', async () => {
    clients.notifications.sendPurchase.mockResolvedValueOnce(unavailable('TIMEOUT'));
    const { result } = await run(issuedOrder());
    expect(result).toMatchObject({ notification_status: 'unknown', last_error_step: 'notification', last_error_code: 'TIMEOUT' });
  });

  it('otro error deja la notificación failed', async () => {
    clients.notifications.sendPurchase.mockResolvedValueOnce(rejected('INVALID_EMAIL', 400));
    const { result } = await run(issuedOrder());
    expect(result).toMatchObject({ notification_status: 'failed', last_error_code: 'INVALID_EMAIL' });
  });

  it('un reintento tras un fallo vuelve a notificar y limpia el error', async () => {
    const { result } = await run(makePaidOrder({
      ticket_status: 'issued', notification_status: 'failed', last_error_step: 'notification', last_error_code: 'HTTP_500',
    }));
    expect(result).toMatchObject({ notification_status: 'sent', last_error_step: null, last_error_code: null });
  });
});
