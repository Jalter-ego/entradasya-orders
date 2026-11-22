import { describe, expect, it } from 'vitest';
import { OrdersRepository, type CreateOrderInput } from '../../../src/repositories/ordersRepository.js';
import { AppError } from '../../../src/utils/appError.js';
import { buildTicketIssuePayload } from '../../../src/builders/ticketIssuePayload.js';
import { createFakeDb, sqlOf } from '../helpers/fakeDb.js';
import { IDS, makeOrder, makeReservation, makeReservedOrder } from '../helpers/fixtures.js';

const input: CreateOrderInput = {
  id: IDS.order,
  customerId: IDS.customer,
  customerEmail: 'cliente@example.com',
  idempotencyKey: 'k1',
  requestHash: 'hash',
  selection: { eventId: IDS.event, sectorId: IDS.sector, quantity: 2, payment: { method: 'demo_card', last4: '1111' } },
};

/** db.query devuelve siempre `row` (lecturas); el cliente de transacción, rowCount = insertedRows. */
function setup(row: unknown = makeOrder(), insertedRows = 1) {
  const fake = createFakeDb();
  fake.pool.query.mockResolvedValue({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
  fake.client.query.mockResolvedValue({ rows: [], rowCount: insertedRows });
  return { ...fake, repo: new OrdersRepository(fake.db) };
}

describe('OrdersRepository.createOrGet', () => {
  it('inserta orden e ítem en una transacción y devuelve la orden creada', async () => {
    const { repo, client, pool } = setup();
    await expect(repo.createOrGet(input)).resolves.toEqual({ created: true, order: makeOrder() });

    const sql = sqlOf(client.query);
    expect(sql[0]).toBe('BEGIN');
    expect(sql[1]).toContain('INSERT INTO orders');
    expect(sql[1]).toContain('ON CONFLICT (customer_id, idempotency_key) DO NOTHING');
    expect(client.query.mock.calls[1]![1]).toEqual([IDS.order, IDS.customer, 'cliente@example.com', 'k1', 'hash', '{"method":"demo_card","last4":"1111"}']);
    expect(sql[2]).toContain('INSERT INTO order_items');
    expect(client.query.mock.calls[2]![1]).toEqual([IDS.order, IDS.event, IDS.sector, 2]);
    expect(sql[3]).toBe('COMMIT');
    expect(pool.query.mock.calls[0]![1]).toEqual([IDS.order]);
  });

  it('si la clave ya existe con el mismo hash, devuelve la orden existente', async () => {
    const { repo, client, pool } = setup(makeOrder(), 0);
    await expect(repo.createOrGet(input)).resolves.toEqual({ created: false, order: makeOrder() });
    expect(sqlOf(client.query).some((sql) => sql.includes('order_items'))).toBe(false);
    expect(pool.query.mock.calls[0]![1]).toEqual([IDS.customer, 'k1']);
  });

  it('si la clave ya existe con otros datos, responde 409 IDEMPOTENCY_CONFLICT', async () => {
    const { repo } = setup(makeOrder({ request_hash: 'otro' }), 0);
    const error = await repo.createOrGet(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('falla si hubo conflicto pero la orden no aparece', async () => {
    const { repo } = setup(null, 0);
    await expect(repo.createOrGet(input)).rejects.toThrow('no se encontró tras el conflicto');
  });
});

describe('OrdersRepository lecturas', () => {
  it('findById devuelve la fila o null, y acepta otro cliente', async () => {
    const { repo, pool } = setup();
    await expect(repo.findById(IDS.order)).resolves.toEqual(makeOrder());
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(repo.findById(IDS.order)).resolves.toBeNull();

    const other = createFakeDb();
    other.pool.query.mockResolvedValue({ rows: [makeOrder()] });
    await repo.findById(IDS.order, other.db);
    expect(other.pool.query).toHaveBeenCalledOnce();
  });

  it('findOwned filtra por id y comprador', async () => {
    const { repo, pool } = setup(null);
    await expect(repo.findOwned(IDS.order, IDS.customer)).resolves.toBeNull();
    expect(sqlOf(pool.query)[0]).toContain('WHERE o.id = $1 AND o.customer_id = $2');
    expect(pool.query.mock.calls[0]![1]).toEqual([IDS.order, IDS.customer]);
  });

  it('findByIdempotencyKey devuelve null si no existe', async () => {
    const { repo } = setup(null);
    await expect(repo.findByIdempotencyKey(IDS.customer, 'k1')).resolves.toBeNull();
  });

  it('listByCustomer pagina con LIMIT/OFFSET y devuelve el total', async () => {
    const { repo, pool } = setup();
    pool.query
      .mockResolvedValueOnce({ rows: [makeOrder()], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ total: 21 }], rowCount: 1 });
    await expect(repo.listByCustomer(IDS.customer, 3, 10)).resolves.toEqual({ rows: [makeOrder()], total: 21 });
    expect(pool.query.mock.calls[0]![1]).toEqual([IDS.customer, 10, 20]);
    expect(sqlOf(pool.query)[1]).toContain('count(*)::int AS total');
  });

  it('listByCustomer usa total 0 si el conteo no devuelve filas', async () => {
    const { repo, pool } = setup();
    pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(repo.listByCustomer(IDS.customer, 1, 10)).resolves.toEqual({ rows: [], total: 0 });
  });

  it('mustFind falla si la orden no existe', async () => {
    const { repo } = setup(null);
    await expect(repo.mustFind(IDS.order)).rejects.toThrow('La orden no se encontró');
  });
});

describe('OrdersRepository.update', () => {
  it('actualiza solo las columnas indicadas con parámetros numerados', async () => {
    const { repo, pool } = setup();
    await repo.update(IDS.order, { status: 'paid', payment_status: 'approved' });
    expect(sqlOf(pool.query)[0]).toBe('UPDATE orders SET updated_at = now(), status = $2, payment_status = $3 WHERE id = $1');
    expect(pool.query.mock.calls[0]![1]).toEqual([IDS.order, 'paid', 'approved']);
  });

  it('limpia el último error solo si es del paso indicado', async () => {
    const { repo, pool } = setup();
    await repo.update(IDS.order, { ticket_status: 'issued' }, 'tickets');
    const sql = sqlOf(pool.query)[0]!;
    expect(sql).toContain('last_error_step = CASE WHEN last_error_step = $3 THEN NULL ELSE last_error_step END');
    expect(sql).toContain('last_error_code = CASE WHEN last_error_step = $3 THEN NULL ELSE last_error_code END');
    expect(pool.query.mock.calls[0]![1]).toEqual([IDS.order, 'issued', 'tickets']);
  });

  it('rechaza columnas que no se pueden actualizar', async () => {
    const { repo, pool } = setup();
    await expect(repo.update(IDS.order, { customer_id: 'x' } as never)).rejects.toThrow('Columna no actualizable: customer_id');
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe('OrdersRepository escrituras de pasos', () => {
  it('confirmReservation guarda precio, moneda y copia, y activa la reserva en una transacción', async () => {
    const { repo, client } = setup(makeReservedOrder());
    const reservation = makeReservation();
    await expect(repo.confirmReservation(IDS.order, reservation)).resolves.toEqual(makeReservedOrder());

    const sql = sqlOf(client.query);
    expect(sql[0]).toBe('BEGIN');
    expect(sql[1]).toContain('UPDATE order_items');
    expect(client.query.mock.calls[1]![1]).toEqual([IDS.order, IDS.organizer, 5000, 'BOB', JSON.stringify(reservation)]);
    expect(sql[2]).toContain("reservation_status = 'active'");
    expect(sql[3]).toBe('COMMIT');
  });

  it('saveTicketPayload guarda el cuerpo de emisión sin pisar uno anterior', async () => {
    const { repo, pool } = setup();
    const payload = buildTicketIssuePayload(makeReservedOrder());
    await repo.saveTicketPayload(IDS.order, payload);
    expect(sqlOf(pool.query)[0]).toContain('COALESCE(ticket_issue_payload, $2)');
    expect(pool.query.mock.calls[0]![1]).toEqual([IDS.order, JSON.stringify(payload)]);
  });
});
