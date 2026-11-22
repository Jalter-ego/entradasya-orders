import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

const VALID_ENV = {
  PORT: '3003',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgres://u:p@localhost:5432/orders',
  JWT_PUBLIC_KEY: 'clave-publica',
  JWT_PUBLIC_KEY_FILE: '',
  JWT_ALG: 'RS256',
  JWT_ISSUER: 'entradasya-auth',
  JWT_AUDIENCE: 'entradasya',
  HTTP_TIMEOUT_MS: '5000',
  TICKETS_TIMEOUT_MS: '20000',
  EVENTS_URL: 'http://events:3001',
  EVENTS_INTERNAL_TOKEN: 'token-events-0123456789abcdef',
  PAYMENTS_URL: 'http://payments:3004',
  PAYMENTS_INTERNAL_TOKEN: 'token-payments-0123456789abcdef',
  TICKETS_URL: 'http://tickets:3005',
  TICKETS_INTERNAL_TOKEN: 'token-tickets-0123456789abcdef',
  NOTIFICATIONS_URL: 'http://notifications:3006',
  NOTIFICATIONS_INTERNAL_TOKEN: 'token-notifications-0123456789abcdef',
};

async function loadConfig(env: Record<string, string | undefined>) {
  process.env = { ...ORIGINAL_ENV, ...VALID_ENV, ...env };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
  vi.resetModules();
  return import('../../../src/config/config.js');
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('config', () => {
  it('lee las variables de entorno y reemplaza \\n en la clave pública', async () => {
    const { config } = await loadConfig({ JWT_PUBLIC_KEY: 'linea1\\nlinea2', DATABASE_SSL: 'true' });
    expect(config.jwt.publicKey).toBe('linea1\nlinea2');
    expect(config.databaseSsl).toBe(true);
    expect(config.services.events).toEqual({ url: 'http://events:3001', token: VALID_ENV.EVENTS_INTERNAL_TOKEN });
  });

  it('usa valores por defecto cuando faltan variables', async () => {
    const { config } = await loadConfig({
      PORT: undefined, HOST: undefined, LOG_LEVEL: undefined, HTTP_TIMEOUT_MS: undefined, TICKETS_TIMEOUT_MS: undefined,
      DATABASE_URL: undefined, JWT_ALG: undefined, EVENTS_URL: undefined,
    });
    expect(config).toMatchObject({ port: 3003, host: '127.0.0.1', logLevel: 'info', databaseUrl: '', databaseSsl: false });
    expect(config.http).toEqual({ timeoutMs: 5000, ticketsTimeoutMs: 20000 });
    expect(config.jwt.algorithm).toBe('RS256');
    expect(config.services.events.url).toBe('');
  });
});

describe('validateConfig', () => {
  it('no falla con una configuración completa', async () => {
    const { validateConfig } = await loadConfig({});
    expect(() => validateConfig()).not.toThrow();
  });

  it('acepta la clave pública por archivo', async () => {
    const { validateConfig } = await loadConfig({ JWT_PUBLIC_KEY: '', JWT_PUBLIC_KEY_FILE: 'keys/public.pem' });
    expect(() => validateConfig()).not.toThrow();
  });

  it.each([
    [{ PORT: '0' }, 'PORT inválido'],
    [{ PORT: 'abc' }, 'PORT inválido'],
    [{ LOG_LEVEL: 'verbose' }, 'LOG_LEVEL debe ser'],
    [{ DATABASE_URL: '' }, 'Falta DATABASE_URL'],
    [{ JWT_PUBLIC_KEY: '', JWT_PUBLIC_KEY_FILE: '' }, 'Falta JWT_PUBLIC_KEY_FILE o JWT_PUBLIC_KEY'],
    [{ JWT_ALG: 'HS256' }, 'JWT_ALG debe ser RS256'],
    [{ JWT_ISSUER: '' }, 'Falta JWT_ISSUER'],
    [{ JWT_AUDIENCE: '' }, 'Falta JWT_AUDIENCE'],
    [{ HTTP_TIMEOUT_MS: '50' }, 'HTTP_TIMEOUT_MS debe estar entre'],
    [{ TICKETS_TIMEOUT_MS: '200000' }, 'TICKETS_TIMEOUT_MS debe estar entre'],
    [{ EVENTS_URL: 'no es url' }, 'EVENTS_URL inválida'],
    [{ PAYMENTS_INTERNAL_TOKEN: 'corto' }, 'PAYMENTS_INTERNAL_TOKEN debe tener al menos 24'],
    [{ TICKETS_INTERNAL_TOKEN: VALID_ENV.EVENTS_INTERNAL_TOKEN }, 'Cada servicio interno debe usar un token distinto'],
  ])('rechaza %j', async (env, message) => {
    const { validateConfig } = await loadConfig(env);
    expect(() => validateConfig()).toThrow(message);
  });

  it('junta todos los problemas en un solo error', async () => {
    const { validateConfig } = await loadConfig({ DATABASE_URL: '', JWT_ISSUER: '' });
    expect(() => validateConfig()).toThrow(/Falta DATABASE_URL; Falta JWT_ISSUER\. Revisa \.env\.example/);
  });
});
