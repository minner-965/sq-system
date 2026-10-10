import pg from 'pg';

/** Connection settings shared by the server and the command-line scripts. */
export function poolConfig(env = process.env) {
  return {
    host: env.POSTGRES_HOST || 'postgres',
    port: Number(env.POSTGRES_PORT || 5432),
    database: env.POSTGRES_DB || 'leadgen',
    user: env.POSTGRES_USER || 'leadgen',
    password: env.POSTGRES_PASSWORD,
    // "Today", "this week" and "this month" follow local time.
    options: `-c TimeZone=${env.TZ || 'Asia/Shanghai'}`
  };
}

/**
 * Pool for scripts run on the host: reads the repository .env, then connects
 * to the compose database through its loopback port.
 */
export function createHostPool(env = process.env) {
  return new pg.Pool({
    ...poolConfig(env),
    host: env.HZ_DB_HOST || '127.0.0.1',
    port: Number(env.HZ_DB_PORT || env.POSTGRES_HOST_PORT || 5433)
  });
}
