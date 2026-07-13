import { neon } from '@neondatabase/serverless';

let sqlClient;
let schemaPromise;

export function hasAnalyticsDatabase() {
  return Boolean(getDatabaseUrl());
}

export async function loadAnalyticsDatabaseSnapshot() {
  const sql = await getSql();
  if (!sql) return null;

  const [events, metaRows] = await Promise.all([
    sql.query(`
      SELECT id, type, occurred_at, session_id, payload
      FROM chatbot_events
      ORDER BY occurred_at DESC, created_at DESC
    `),
    sql.query(`SELECT key, value FROM chatbot_analytics_meta`)
  ]);

  const meta = Object.fromEntries(metaRows.map((row) => [row.key, row.value]));
  return {
    ...(meta.snapshot || {}),
    eventLog: events.map((row) => ({
      id: row.id,
      type: row.type,
      at: new Date(row.occurred_at).toISOString(),
      sessionId: row.session_id || '',
      payload: row.payload || {}
    }))
  };
}

export async function insertAnalyticsEvents(events = [], snapshotMeta = {}) {
  if (!events.length) return true;
  const sql = await getSql();
  if (!sql) return false;

  const rows = events.map((event) => ({
    id: event.id,
    type: event.type,
    at: event.at,
    sessionId: event.sessionId || null,
    requestId: event.payload?.requestId || null,
    question: event.payload?.question || null,
    payload: event.payload || {}
  }));

  await sql.query(
    `
      INSERT INTO chatbot_events (id, type, occurred_at, session_id, request_id, question, payload)
      SELECT item.id, item.type, item.at::timestamptz, item."sessionId", item."requestId", item.question, item.payload
      FROM jsonb_to_recordset($1::jsonb) AS item(
        id text,
        type text,
        at text,
        "sessionId" text,
        "requestId" text,
        question text,
        payload jsonb
      )
      ON CONFLICT (id) DO NOTHING
    `,
    [JSON.stringify(rows)]
  );

  await sql.query(
    `
      INSERT INTO chatbot_analytics_meta (key, value, updated_at)
      VALUES ('snapshot', $1::jsonb, NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `,
    [JSON.stringify(snapshotMeta)]
  );
  return true;
}

export async function checkAnalyticsDatabase() {
  const sql = await getSql();
  if (!sql) return { configured: false, ok: false };
  await sql.query('SELECT 1 AS ok');
  return { configured: true, ok: true };
}

async function getSql() {
  const url = getDatabaseUrl();
  if (!url) return null;
  if (!sqlClient) sqlClient = neon(url);
  if (!schemaPromise) schemaPromise = ensureSchema(sqlClient);
  await schemaPromise;
  return sqlClient;
}

async function ensureSchema(sql) {
  await sql.query(`
    CREATE TABLE IF NOT EXISTS chatbot_events (
      id text PRIMARY KEY,
      type varchar(80) NOT NULL,
      occurred_at timestamptz NOT NULL,
      session_id varchar(64),
      request_id varchar(100),
      question text,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
  await sql.query(`CREATE INDEX IF NOT EXISTS chatbot_events_type_at_idx ON chatbot_events (type, occurred_at DESC)`);
  await sql.query(`CREATE INDEX IF NOT EXISTS chatbot_events_session_at_idx ON chatbot_events (session_id, occurred_at DESC)`);
  await sql.query(`CREATE INDEX IF NOT EXISTS chatbot_events_request_idx ON chatbot_events (request_id) WHERE request_id IS NOT NULL`);
  await sql.query(`
    CREATE TABLE IF NOT EXISTS chatbot_analytics_meta (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);
}

function getDatabaseUrl() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
}
