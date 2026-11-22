# Plan: pipeline CI/CD en GitHub Actions — `entradasya-orders`

## 1. Objetivo

Un pipeline en GitHub Actions que, en cada push a `develop` o `main`:

1. Instale dependencias, valide el código y ejecute **unit tests sin base de datos** (con mocks).
2. Exija **cobertura ≥ 85 %** (si no llega, el pipeline falla).
3. Pase por **SonarQube Cloud** (quality gate).
4. Genere y guarde los **artifacts**.
5. Construya y publique la **imagen Docker** en GHCR (develop y main, con tags distintos).
6. En `main`, cree un **release versionado**.
7. Despliegue: **pendiente**, se define al final (ver §10).

En los pull requests hacia `develop` y `main` se ejecuta solo la parte de validación (pasos 1 a 4). No se publica imagen ni release.

## 2. Situación actual del repo

| Tema | Estado | Qué hacer |
|---|---|---|
| Stack | Node 22, TypeScript, pnpm, Vitest, Express 5, Postgres | – |
| Build | `tsc` → `dist/` | Se mantiene |
| Tests | 4 archivos de **integración** (`http`, `purchase`, `queries`, `recovery`) que necesitan Postgres real (`globalSetup` aplica migraciones) | Moverlos a `tests/integration/` y crear una suite **unit** nueva con mocks |
| Coverage | No está instalado `@vitest/coverage-v8` | Agregarlo, con umbral del 85 % |
| Lint | No hay ESLint | Agregar ESLint + typescript-eslint |
| Docker | No hay `Dockerfile` | Crear un Dockerfile multi-stage y `.dockerignore` |
| Ramas | `master` y `develop` (creada y subida) | **Pendiente:** el dueño del repo debe renombrar `master` → `main` desde la web. Hasta entonces, los pushes a `master` no disparan el pipeline |
| Repo | Público | Se usa **SonarQube Cloud** para replicar el flujo del trabajo (gratis en repos públicos). CodeQL también sería gratis y queda como alternativa |

**Ventaja para los mocks:** el código ya recibe sus dependencias por constructor (`PurchaseService(repo, processor)`, `OrderProcessor(db, repo, clients)`, `OrdersRepository(db)`, `createApp({ db, verifyToken, clients })`). Se pueden pasar mocks sin tocar el código de producción.

## 3. Qué son los artifacts de este proyecto

Un artifact es lo que el pipeline genera, empaqueta y guarda para descargarlo o desplegarlo después. Para este backend en Node:

| Artifact | Contenido | Dónde queda | Ramas |
|---|---|---|---|
| **`orders-<versión>-<sha>.tgz`** (artifact principal) | `dist/`, `package.json`, `pnpm-lock.yaml`, `migrations/` (todo lo necesario para correr con `pnpm install --prod && node dist/server.js`) | GitHub Actions Artifacts (retención de 30 días) | develop y main |
| **Imagen Docker** | Imagen lista para ejecutar | GHCR: `ghcr.io/jalter-ego/entradasya-orders` | develop y main |
| **Reporte de cobertura** | `coverage/` (HTML y `lcov.info`) | GitHub Actions Artifacts (14 días) | todas |
| **Reporte de tests** | `junit.xml` | GitHub Actions Artifacts (14 días) | todas |
| **Release** | Tag `vX.Y.Z` con el `.tgz` adjunto | GitHub Releases (permanente) | solo main |

## 4. Versionado (decisión)

- **La fuente de verdad es `package.json` → `version`** (hoy `0.1.0`). Para publicar una versión nueva se sube la versión en el PR hacia `main` (`pnpm version minor --no-git-tag-version`).
- **Tags de imagen:**
  - `develop` → `dev`, `dev-<sha7>`
  - `main` → `<versión>` (ej. `0.1.0`), `latest`, `sha-<sha7>`
- **Release en main:** si el tag `v<versión>` **no existe**, el pipeline crea el tag y el GitHub Release con el `.tgz` adjunto y notas generadas automáticamente. Si ya existe, se omite el release, pero la imagen igual se publica con `sha-<sha7>`. Así nunca se pisa una versión publicada.

Motivo: es simple, no exige convenciones de commits (como semantic-release o release-please) y la versión queda visible en el código.

## 5. Estrategia de tests

### 5.1 Separación

```
tests/
  unit/          ← NUEVO: mocks, sin red ni Postgres. Lo ejecuta el pipeline.
  integration/   ← los 4 tests actuales + helpers/ + setup/. Se ejecutan en local con Postgres.
```

| Config | Incluye | globalSetup (migraciones) | Script |
|---|---|---|---|
| `vitest.config.ts` (unit) | `tests/unit/**/*.test.ts` | No | `pnpm test` / `pnpm test:coverage` |
| `vitest.integration.config.ts` | `tests/integration/**/*.test.ts` | Sí (el actual) | `pnpm test:integration` |

### 5.2 Cómo se mockea cada capa

| Capa | Archivos | Técnica |
|---|---|---|
| utils, builders, mappers, validators, constants | `utils/*`, `builders/*`, `mappers/*`, `validators/*` | Funciones puras: entradas y salidas, sin mocks |
| JWT | `utils/jwt.ts`, `middleware/auth.ts` | Par de claves RSA generado en el test (como hoy `tests/setup/env.ts`) |
| Clientes HTTP | `clients/httpClient.ts`, `eventsClient`, `paymentsClient`, `ticketsClient`, `notificationsClient` | `vi.stubGlobal('fetch', vi.fn())`: respuestas ok, 4xx, 5xx, timeout (`AbortError`) y JSON inválido |
| Base de datos | `database/database.ts`, `database/orderLock.ts` | Objeto `Db` falso: `{ connect: vi.fn(() => client), query: vi.fn() }`. Se prueban `BEGIN`/`COMMIT`/`ROLLBACK`, lock adquirido, lock con timeout y fallo al desbloquear |
| Repositorios | `ordersRepository.ts`, `reportsRepository.ts` | `db.query` mockeado: se verifican los parámetros enviados y el mapeo de filas, incluidos los errores (violación de unicidad → `AppError`) |
| Servicios | `orderProcessor.ts` (el más grande, 224 líneas), `purchaseService.ts` | `repo` y `clients` como mocks y `vi.mock('../database/orderLock.js')`. Un caso por rama de cada paso: reserva, cobro, liberación, emisión y notificación, con éxito, rechazo, error remoto y reintento |
| Controllers, rutas, middleware | `controllers/*`, `routes/*`, `middleware/*`, `app.ts` | `supertest` sobre `createApp(...)` con `db`, `clients` y `verifyToken` falsos (sin `listen` ni red) |
| Config | `config/config.ts` | `vi.resetModules()` + variables de entorno por caso |

### 5.3 Cobertura

- Proveedor: `@vitest/coverage-v8`. Reportes: `text`, `html`, `lcov` (para Sonar) y `json-summary`.
- **Umbral 85 %** en `lines`, `statements`, `functions` y `branches`. Si alguno no llega, Vitest termina con error y el job falla.
- Exclusiones (solo lo que no tiene lógica o es arranque del proceso): `src/server.ts`, `src/types/**`, `scripts/**`, `**/*.d.ts`. **No** se excluyen los repositorios ni la base de datos para inflar el número.
- Sonar recibe el mismo `lcov.info`.

## 6. Diseño del workflow

Archivo: `.github/workflows/ci.yml`

```yaml
on:
  push:         { branches: [develop, main] }
  pull_request: { branches: [develop, main] }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
permissions: { contents: read }
```

### 6.1 Jobs

```
  ┌──────────┐     ┌──────────┐     ┌──────────────┐     ┌───────────┐     ┌──────────────┐
  │  build   │ ──▶ │  sonar   │ ──▶ │ docker-image │ ──▶ │  release  │ ──▶ │ deploy (TBD) │
  │ (todas)  │     │ (todas)  │     │ (solo push)  │     │ (solo main)│    │              │
  └──────────┘     └──────────┘     └──────────────┘     └───────────┘     └──────────────┘
```

| Job | Cuándo | Pasos | Sale |
|---|---|---|---|
| **build** | siempre | checkout → `pnpm/action-setup` → `setup-node@v4` (Node 22, caché de pnpm) → `pnpm install --frozen-lockfile` → `pnpm lint` → `pnpm typecheck` → `pnpm audit --prod --audit-level high` → `pnpm test:coverage` (umbral 85 %) → `pnpm build` → empaquetar el `.tgz` → `upload-artifact` (paquete, coverage, junit) | artifacts |
| **sonar** | siempre (`needs: build`) | checkout con `fetch-depth: 0` → descargar coverage → `SonarSource/sonarqube-scan-action` → esperar el quality gate (`sonar.qualitygate.wait=true`) | estado del quality gate |
| **docker-image** | `push` a develop/main (`needs: [build, sonar]`) | `docker/login-action` en GHCR con `GITHUB_TOKEN` → `docker/metadata-action` (tags según §4) → `docker/build-push-action` con caché `type=gha`, `provenance` y `sbom` activados | imagen en GHCR |
| **release** | `push` a main (`needs: docker-image`) | leer la versión → si `v<versión>` no existe: descargar el `.tgz` → `gh release create v<versión> --generate-notes <tgz>` | tag + Release |
| **deploy** | por definir | ver §10 | – |

Permisos por job (mínimos): `docker-image` → `packages: write`; `release` → `contents: write`.

### 6.2 Diferencias entre develop y main

| | PR | push develop | push main |
|---|:-:|:-:|:-:|
| Install, lint, typecheck, audit | ✅ | ✅ | ✅ |
| Unit tests y coverage ≥ 85 % | ✅ | ✅ | ✅ |
| SonarQube Cloud | ✅ | ✅ | ✅ |
| Artifact `.tgz` y reportes | ✅ | ✅ | ✅ |
| Imagen Docker | – | `dev`, `dev-<sha>` | `<versión>`, `latest`, `sha-<sha>` |
| Release | – | – | ✅ (si la versión es nueva) |
| Deploy | – | TBD | TBD |

## 7. Dockerfile (multi-stage)

1. **deps**: `node:22-alpine` + corepack/pnpm → `pnpm install --frozen-lockfile`
2. **build**: copia el código → `pnpm build` → `pnpm prune --prod`
3. **runtime**: `node:22-alpine`, `NODE_ENV=production`, usuario no root (`node`), copia `dist/`, `node_modules` de producción, `package.json` y `migrations/`. `EXPOSE 3003`, `HOST=0.0.0.0`, `HEALTHCHECK` contra `/health`, `CMD ["node", "dist/server.js"]`

`.dockerignore`: `node_modules`, `dist`, `coverage`, `tests`, `.git`, `.env*`, `keys/`, `postman/`, `.local/`.

> Nota: el `start` actual usa `--env-file-if-exists=.env`. En el contenedor la configuración llega por variables de entorno, por eso el `CMD` llama a `node` directamente.

## 8. Configuración necesaria (manual, una sola vez)

| Dónde | Qué |
|---|---|
| sonarcloud.io | Entrar con GitHub, importar el repo privado (plan gratuito), desactivar "Automatic Analysis" (se analiza desde CI), anotar la *organization* y la *project key* |
| GitHub → Settings → Secrets | `SONAR_TOKEN` |
| GitHub → Settings → Variables | `SONAR_ORGANIZATION`, `SONAR_PROJECT_KEY` (o directo en `sonar-project.properties`) |
| GitHub → Branches | Renombrar `master` → `main`, crear `develop`, poner `main` como default |
| GitHub → Branch protection (recomendado) | En `main` y `develop`: exigir PR y que `build` y `sonar` estén en verde |
| GitHub → Packages | Tras el primer push, la imagen queda privada y ligada al repo (no hace falta nada más) |

## 9. Cambios en el repositorio

| Archivo | Cambio |
|---|---|
| `package.json` | Scripts `lint`, `test` (unit), `test:coverage`, `test:integration`. devDeps: `@vitest/coverage-v8`, `eslint`, `@eslint/js`, `typescript-eslint` |
| `vitest.config.ts` | Pasa a ser la config unit (sin `globalSetup`, con coverage y umbrales) |
| `vitest.integration.config.ts` | Nuevo: la config actual apuntando a `tests/integration/` |
| `tests/integration/**` | Se mueven los tests, helpers y setup actuales (se ajustan los imports) |
| `tests/unit/**` | Nuevos tests según §5.2 |
| `eslint.config.js` | Nuevo (flat config, typescript-eslint recommended) |
| `Dockerfile`, `.dockerignore` | Nuevos |
| `sonar-project.properties` | `sonar.sources=src`, `sonar.tests=tests`, `sonar.javascript.lcov.reportPaths=coverage/lcov.info`, exclusiones iguales a las de coverage |
| `.github/workflows/ci.yml` | Nuevo |
| `README.md` | Sección "CI/CD": cómo funciona el pipeline, tags y cómo publicar una versión |

## 10. Pendiente: despliegue

Se decide al final. Opciones a evaluar:

- **A. Sin despliegue real:** la imagen publicada en GHCR es el entregable.
- **B. GitHub Environments** (`dev` y `prod`) con aprobación manual en `prod`. Registra qué versión se "desplegó", sin infraestructura.
- **C. Smoke test en kind:** levantar un Kubernetes efímero dentro del job, aplicar los manifiestos (`k8s/`) con la imagen recién publicada y probar `/health`. Valida los manifiestos sin un clúster real.
- **D. Clúster real** (si aparece uno): `kubectl`/Helm con un kubeconfig guardado como secreto.

## 11. Orden de implementación

1. **Ramas:** ✅ `develop` creada y subida. ⏳ Falta que el dueño del repo renombre `master` → `main`.
2. **Tests:** ✅ integración movida a `tests/integration/`, configs separadas, coverage con umbral 85 % y reporte JUnit en `reports/junit.xml`. ⏳ Falta correr `pnpm test:integration` contra una base `orders_test` real (según el README, esa suite nunca se ejecutó).
3. **Unit tests:** ✅ 188 tests en 15 archivos, sin Postgres ni red (≈3,5 s). Cobertura: 100 % en líneas, sentencias y funciones, 98,66 % en ramas. Se comprobó que con un umbral mayor `pnpm test:coverage` falla (exit 1).
4. **ESLint:** agregarlo y corregir lo que reporte.
5. **Docker:** `Dockerfile` + `.dockerignore`; probar `docker build` y `docker run` en local.
6. **Sonar:** configurar SonarQube Cloud y `sonar-project.properties`.
7. **Workflow:** `ci.yml`; probarlo con un PR hacia `develop`, después push a `develop` (imagen `dev`) y después merge a `main` (imagen `0.1.0` + release `v0.1.0`).
8. **Docs:** README.
9. **Despliegue:** decidir según §10.

## 12. Criterios de aceptación

- [ ] Un push a `develop` genera el artifact `.tgz`, los reportes y la imagen `ghcr.io/jalter-ego/entradasya-orders:dev-<sha>`.
- [ ] Un push a `main` genera lo mismo, más la imagen `:<versión>`/`:latest` y el Release `v<versión>` con el `.tgz` adjunto.
- [ ] El pipeline falla si la cobertura baja del 85 %, si falla un test, lint o typecheck, o si el quality gate de Sonar no pasa.
- [ ] Los unit tests corren sin Postgres ni red.
- [ ] Un PR ejecuta la validación pero no publica nada.
