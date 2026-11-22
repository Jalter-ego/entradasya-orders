/**
 * Antes de cada archivo unit (y antes de que se importe src/config): variables de entorno fijas.
 * No hay base de datos: DATABASE_URL es un valor de relleno que ningún test usa.
 */
Object.assign(process.env, {
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://unit:unit@127.0.0.1:1/unit_no_db',
  DATABASE_SSL: 'false',
  JWT_ALG: 'RS256',
  JWT_ISSUER: 'entradasya-auth',
  JWT_AUDIENCE: 'entradasya',
});
