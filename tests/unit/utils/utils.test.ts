import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../src/utils/appError.js';
import { sha256Hex } from '../../../src/utils/hash.js';
import { toSafeInteger } from '../../../src/utils/safeInteger.js';

describe('sha256Hex', () => {
  it('devuelve el SHA-256 en hexadecimal de 64 caracteres', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('toSafeInteger', () => {
  it('acepta números y texto numérico', () => {
    expect(toSafeInteger(42)).toBe(42);
    expect(toSafeInteger('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rechaza valores fuera del rango entero seguro o no enteros', () => {
    expect(() => toSafeInteger('9007199254740992')).toThrow('rango entero seguro');
    expect(() => toSafeInteger(1.5)).toThrow();
    expect(() => toSafeInteger('abc')).toThrow();
  });
});

describe('AppError', () => {
  it('guarda status, código, mensaje y detalles', () => {
    const error = new AppError(400, 'VALIDATION_ERROR', 'Mal', [{ field: 'x', message: 'y' }]);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ status: 400, code: 'VALIDATION_ERROR', message: 'Mal', details: [{ field: 'x', message: 'y' }] });
  });

  it('usa una lista de detalles vacía por defecto', () => {
    expect(new AppError(404, 'NOT_FOUND', 'No').details).toEqual([]);
  });
});

describe('log', () => {
  afterEach(() => {
    process.env.LOG_LEVEL = 'silent';
    vi.resetModules();
  });

  async function loadLogger(level: string) {
    process.env.LOG_LEVEL = level;
    vi.resetModules();
    return import('../../../src/utils/logger.js');
  }

  it('escribe JSON con timestamp, nivel, servicio y campos extra', async () => {
    const { log } = await loadLogger('debug');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    log('info', 'hola', { orderId: 'o1' });
    const line = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(line).toMatchObject({ level: 'info', service: 'orders', message: 'hola', orderId: 'o1' });
    expect(line.timestamp).toEqual(expect.any(String));
  });

  it('descarta los mensajes por debajo del nivel configurado', async () => {
    const { log } = await loadLogger('warn');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    log('info', 'ignorado');
    log('error', 'visible');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('usa info si el nivel configurado no existe', async () => {
    const { log } = await loadLogger('ruidoso');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    log('debug', 'ignorado');
    log('info', 'visible');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
