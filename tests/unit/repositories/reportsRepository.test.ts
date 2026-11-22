import { describe, expect, it } from 'vitest';
import { ReportsRepository } from '../../../src/repositories/reportsRepository.js';
import { createFakeDb, sqlOf } from '../helpers/fakeDb.js';
import { IDS } from '../helpers/fixtures.js';

describe('ReportsRepository', () => {
  it('belongsToAnotherOrganizer devuelve el resultado de EXISTS', async () => {
    const { db, pool } = createFakeDb();
    pool.query.mockResolvedValue({ rows: [{ other: true }] });
    await expect(new ReportsRepository(db).belongsToAnotherOrganizer(IDS.event, IDS.organizer)).resolves.toBe(true);
    expect(sqlOf(pool.query)[0]).toContain('organizer_id <> $2');
    expect(pool.query.mock.calls[0]![1]).toEqual([IDS.event, IDS.organizer]);
  });

  it('belongsToAnotherOrganizer es false si no hay filas', async () => {
    const { db } = createFakeDb();
    await expect(new ReportsRepository(db).belongsToAnotherOrganizer(IDS.event, IDS.organizer)).resolves.toBe(false);
  });

  it('salesBySector consulta solo órdenes pagadas del organizador', async () => {
    const { db, pool } = createFakeDb();
    const rows = [{ sector_id: IDS.sector, sector_name: 'General', currency: 'BOB', orders_paid: 1, tickets_sold: '2', revenue_minor: '10000' }];
    pool.query.mockResolvedValue({ rows });
    await expect(new ReportsRepository(db).salesBySector(IDS.event, IDS.organizer)).resolves.toEqual(rows);
    expect(sqlOf(pool.query)[0]).toContain("o.status = 'paid'");
    expect(pool.query.mock.calls[0]![1]).toEqual([IDS.event, IDS.organizer]);
  });
});
