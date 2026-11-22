import { vi } from 'vitest';
import type { Db } from '../../../src/database/database.js';

type QueryResult = { rows: unknown[]; rowCount?: number };

/**
 * Doble de pg.Pool: `db.query` para consultas sueltas y `client.query` para lo que pasa por `db.connect()`
 * (transacciones y locks). Por defecto ambos devuelven `{ rows: [], rowCount: 0 }`.
 */
export function createFakeDb() {
  const client = {
    query: vi.fn(async (..._args: unknown[]): Promise<QueryResult> => ({ rows: [], rowCount: 0 })),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async (..._args: unknown[]): Promise<QueryResult> => ({ rows: [], rowCount: 0 })),
    connect: vi.fn(async () => client),
  };
  return { db: pool as unknown as Db, pool, client };
}

/** SQL enviado en cada llamada a un mock de query (primer argumento). */
export function sqlOf(mock: { mock: { calls: unknown[][] } }): string[] {
  return mock.mock.calls.map((call) => String(call[0]).replace(/\s+/g, ' ').trim());
}
