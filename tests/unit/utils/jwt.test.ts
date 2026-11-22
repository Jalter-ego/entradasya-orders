import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importPKCS8, SignJWT, type JWTPayload } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { IDS } from '../helpers/fixtures.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let tempDir: string;
beforeAll(() => { tempDir = mkdtempSync(join(tmpdir(), 'orders-jwt-')); });
afterAll(() => { rmSync(tempDir, { recursive: true, force: true }); });
afterEach(() => {
  delete process.env.JWT_PUBLIC_KEY;
  delete process.env.JWT_PUBLIC_KEY_FILE;
  vi.resetModules();
});

async function loadVerifier(env: { JWT_PUBLIC_KEY?: string; JWT_PUBLIC_KEY_FILE?: string }) {
  Object.assign(process.env, { JWT_PUBLIC_KEY: '', JWT_PUBLIC_KEY_FILE: '', ...env });
  vi.resetModules();
  const { createJwtVerifier } = await import('../../../src/utils/jwt.js');
  return createJwtVerifier();
}

async function sign(payload: JWTPayload, options: { issuer?: string; audience?: string; expiresIn?: string } = {}) {
  const key = await importPKCS8(privatePem, 'RS256');
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(options.issuer ?? 'entradasya-auth')
    .setAudience(options.audience ?? 'entradasya')
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
    .sign(key);
}

const claims = { sub: IDS.customer, role: 'customer', email: '  Cliente@Example.com ' };

describe('createJwtVerifier', () => {
  it('verifica un token válido y normaliza el email', async () => {
    const verify = await loadVerifier({ JWT_PUBLIC_KEY: publicPem });
    await expect(verify(await sign(claims))).resolves.toEqual({
      id: IDS.customer, role: 'customer', email: 'cliente@example.com',
    });
  });

  it('lee la clave pública desde archivo si JWT_PUBLIC_KEY_FILE está definido', async () => {
    const file = join(tempDir, 'public.pem');
    writeFileSync(file, publicPem);
    const verify = await loadVerifier({ JWT_PUBLIC_KEY_FILE: file });
    await expect(verify(await sign(claims))).resolves.toMatchObject({ id: IDS.customer });
  });

  it('rechaza otro emisor, otra audiencia o un token vencido', async () => {
    const verify = await loadVerifier({ JWT_PUBLIC_KEY: publicPem });
    await expect(verify(await sign(claims, { issuer: 'otro' }))).rejects.toThrow();
    await expect(verify(await sign(claims, { audience: 'otra' }))).rejects.toThrow();
    await expect(verify(await sign(claims, { expiresIn: '-1m' }))).rejects.toThrow();
  });

  it('rechaza claims inválidos o faltantes', async () => {
    const verify = await loadVerifier({ JWT_PUBLIC_KEY: publicPem });
    await expect(verify(await sign({ ...claims, role: 'admin' }))).rejects.toThrow();
    await expect(verify(await sign({ ...claims, sub: 'no-uuid' }))).rejects.toThrow();
    await expect(verify(await sign({ sub: IDS.customer, role: 'customer' }))).rejects.toThrow();
  });
});
