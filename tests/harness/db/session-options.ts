/**
 * Startup options for a harness connection that sets its options explicitly.
 *
 * node-postgres lets the options of a connection string override both PGOPTIONS and an explicit
 * options setting, so isolated-database.ts moves the options of TEST_DATABASE_URL (with the
 * PGOPTIONS the runner started with) out of the isolated URL into TEST_DATABASE_OPTIONS. A
 * connection with explicit options keeps those settings by putting them first; its own options come
 * after them and win.
 */
export function testSessionOptions(...options: string[]): string {
  return [process.env.TEST_DATABASE_OPTIONS, ...options].filter(Boolean).join(" ");
}
