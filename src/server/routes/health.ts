import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '../../shared/contracts';

export interface HealthRouteOptions {
  version: string;
}

/**
 * `GET /api/health` — used by the guest reachability check and by deployments
 * to verify the DB schema is present. Never exposes room or guest data.
 */
export async function healthRoutes(
  app: FastifyInstance,
  options: HealthRouteOptions,
): Promise<void> {
  app.get('/api/health', async (_request, reply) => {
    let schemaVersion: number | null = null;
    let dbOk = false;

    try {
      const row = app.db
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
      schemaVersion = row ? Number(row.value) : null;
      dbOk = Number.isFinite(schemaVersion);
    } catch {
      // The DB may be locked or the schema may be missing; report unhealthy.
      dbOk = false;
    }

    const body: HealthResponse = {
      ok: dbOk,
      name: 'welcome2myhome',
      version: options.version,
      uptimeSec: Math.round(process.uptime()),
      db: { ok: dbOk, schemaVersion },
      time: new Date().toISOString(),
    };

    return reply.code(dbOk ? 200 : 503).send(body);
  });
}
