import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSchema, createPool, transaction } from '../../../src/database/database.js';
import { withOrderLock } from '../../../src/database/orderLock.js';
import { createFakeDb, sqlOf } from '../helpers/fakeDb.js';

describe('createPool', () => {
  it('crea un pg.Pool sin conectarse todavía', async () => {
    const pool = createPool();
    expect(pool).toBeInstanceOf(pg.Pool);
    expect(pool.totalCount).toBe(0);
    await pool.end();
  });
});

describe('checkSchema', () => {
  it('consulta las tablas orders y order_items', async () => {
    const { db, pool } = createFakeDb();
    await checkSchema(db);
    expect(sqlOf(pool.query)[0]).toContain('FROM orders o LEFT JOIN order_items');
  });
});

describe('transaction', () => {
  it('hace BEGIN, ejecuta y COMMIT; libera el cliente', async () => {
    const { db, client } = createFakeDb();
    const result = await transaction(db, async (tx) => {
      await tx.query('SELECT 1');
      return 'listo';
    });
    expect(result).toBe('listo');
    expect(sqlOf(client.query)).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('hace ROLLBACK y relanza el error', async () => {
    const { db, client } = createFakeDb();
    await expect(transaction(db, async () => { throw new Error('falla'); })).rejects.toThrow('falla');
    expect(sqlOf(client.query)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('si el ROLLBACK también falla, se relanza el error original', async () => {
    const { db, client } = createFakeDb();
    client.query.mockImplementation(async (sql: unknown) => {
      if (sql === 'ROLLBACK') throw new Error('conexión perdida');
      return { rows: [] };
    });
    await expect(transaction(db, async () => { throw new Error('original'); })).rejects.toThrow('original');
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe('withOrderLock', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function lockResults(...results: boolean[]) {
    const fake = createFakeDb();
    fake.client.query.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('pg_try_advisory_lock')) return { rows: [{ ok: results.shift() ?? true }] };
      return { rows: [] };
    });
    return fake;
  }

  it('toma el lock, ejecuta la función, lo suelta y libera el cliente', async () => {
    const { db, client } = lockResults(true);
    const outcome = await withOrderLock(db, 'o1', async () => 'resultado');
    expect(outcome).toEqual({ acquired: true, result: 'resultado' });
    expect(sqlOf(client.query)).toEqual([
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok',
      'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
    ]);
    expect(client.query.mock.calls[0]![1]).toEqual(['o1']);
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('reintenta mientras el lock está ocupado', async () => {
    const { db, client } = lockResults(false, true);
    const outcome = await withOrderLock(db, 'o1', async () => 1);
    expect(outcome).toEqual({ acquired: true, result: 1 });
    expect(sqlOf(client.query).filter((sql) => sql.includes('try_advisory'))).toHaveLength(2);
  });

  it('se rinde al vencer el plazo sin ejecutar la función', async () => {
    const { db, client } = lockResults(false);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValueOnce(now).mockReturnValue(now + 60_000);
    const fn = vi.fn();
    await expect(withOrderLock(db, 'o1', fn)).resolves.toEqual({ acquired: false });
    expect(fn).not.toHaveBeenCalled();
    expect(sqlOf(client.query).some((sql) => sql.includes('unlock'))).toBe(false);
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('suelta el lock aunque la función falle', async () => {
    const { db, client } = lockResults(true);
    await expect(withOrderLock(db, 'o1', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(sqlOf(client.query).at(-1)).toContain('pg_advisory_unlock');
  });

  it('si no puede soltar el lock, descarta la conexión', async () => {
    const { db, client } = createFakeDb();
    client.query.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes('unlock')) throw new Error('conexión perdida');
      return { rows: [{ ok: true }] };
    });
    await expect(withOrderLock(db, 'o1', async () => 'ok')).resolves.toEqual({ acquired: true, result: 'ok' });
    expect(client.release).toHaveBeenCalledWith(true);
  });
});
