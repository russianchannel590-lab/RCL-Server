import pg from 'pg';

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: {
        rejectUnauthorized: false
      }
    })
  : null;

let initialized = false;
let initializationPromise = null;

export async function initDatabase() {
  if (!pool) {
    return false;
  }

  if (initialized) {
    return true;
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS verified_users (
          hwid TEXT PRIMARY KEY,
          roblox_id BIGINT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

      initialized = true;
      console.log('Database initialized');

      return true;
    } catch (error) {
      console.error('Database initialization failed:', error);
      return false;
    } finally {
      initializationPromise = null;
    }
  })();

  return initializationPromise;
}

export async function getRobloxIdByHwid(hwid) {
  if (!pool || !hwid) {
    return null;
  }

  try {
    const result = await pool.query(
      'SELECT roblox_id FROM verified_users WHERE hwid = $1',
      [hwid]
    );

    return result.rowCount > 0
      ? result.rows[0].roblox_id
      : null;
  } catch (error) {
    console.error('HWID lookup failed:', error);
    return null;
  }
}
