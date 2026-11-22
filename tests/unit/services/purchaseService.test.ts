import { describe, expect, it, vi } from 'vitest';
import { buildRequestHash } from '../../../src/builders/requestHash.js';
import type { OrdersRepository } from '../../../src/repositories/ordersRepository.js';
import type { OrderProcessor } from '../../../src/services/orderProcessor.js';
import { PurchaseService } from '../../../src/services/purchaseService.js';
import type { OrderSelection } from '../../../src/types/order.js';
import { AppError } from '../../../src/utils/appError.js';
import { IDS, makeOrder, makePaidOrder } from '../helpers/fixtures.js';

function setup() {
  const repo = { createOrGet: vi.fn(), findOwned: vi.fn() };
  const processor = { process: vi.fn().mockResolvedValue(makePaidOrder()) };
  const service = new PurchaseService(repo as unknown as OrdersRepository, processor as unknown as OrderProcessor);
  return { repo, processor, service };
}

const user = { id: IDS.customer, role: 'customer' as const, email: 'cliente@example.com' };
const selection: OrderSelection = {
  eventId: IDS.event, sectorId: IDS.sector, quantity: 2, payment: { method: 'demo_card', last4: '1111' },
};

describe('PurchaseService.purchase', () => {
  it('crea (o recupera) la orden con el hash de la selección y la procesa', async () => {
    const { repo, processor, service } = setup();
    repo.createOrGet.mockResolvedValue({ created: true, order: makeOrder() });

    await expect(service.purchase(user, 'k1', selection, 'req-1')).resolves.toEqual({ created: true, order: makePaidOrder() });

    expect(repo.createOrGet).toHaveBeenCalledWith({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      customerId: IDS.customer,
      customerEmail: 'cliente@example.com',
      idempotencyKey: 'k1',
      requestHash: buildRequestHash(selection),
      selection,
    });
    expect(processor.process).toHaveBeenCalledWith(IDS.order, 'req-1');
  });

  it('propaga created=false en una compra repetida', async () => {
    const { repo, service } = setup();
    repo.createOrGet.mockResolvedValue({ created: false, order: makeOrder() });
    await expect(service.purchase(user, 'k1', selection, 'r')).resolves.toMatchObject({ created: false });
  });
});

describe('PurchaseService.retry', () => {
  it('reprocesa una orden del comprador', async () => {
    const { repo, processor, service } = setup();
    repo.findOwned.mockResolvedValue(makeOrder());
    await expect(service.retry(IDS.order, IDS.customer, 'r')).resolves.toEqual(makePaidOrder());
    expect(repo.findOwned).toHaveBeenCalledWith(IDS.order, IDS.customer);
    expect(processor.process).toHaveBeenCalledWith(IDS.order, 'r');
  });

  it('responde 404 si la orden no es del comprador', async () => {
    const { repo, processor, service } = setup();
    repo.findOwned.mockResolvedValue(null);
    const error = await service.retry(IDS.order, IDS.customer, 'r').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(processor.process).not.toHaveBeenCalled();
  });
});
