import { chmodSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { openDatabaseReadOnly } from "./db.js";

const KEEP = 14;

/**
 * Writes a consistent copy of the mirror (VACUUM INTO) to <dir>/<profile>-YYYY-MM-DD.sqlite and keeps the newest
 * 14 such copies. The copy is written under a temporary name, made owner-only, then renamed, so a sync client
 * (e.g. Google Drive) never picks up a half-written file. A second backup on the same day replaces that day's copy.
 * Only files matching the exact backup name pattern are ever deleted.
 */
export function backupMirror(
  dbPath: string,
  backupDir: string,
  profile: string,
  now = new Date(),
): { path: string; removed: string[] } {
  const dir = resolve(backupDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const liveDir = realpathSync(dirname(resolve(dbPath)));
  if (realpathSync(dir) === liveDir) {
    throw new Error("The backup directory must not be the directory that holds the live mirror.");
  }
  const db = openDatabaseReadOnly(dbPath);
  if (!db) throw new Error(`No mirror at ${dbPath} to back up; run sync first.`);
  const name = `${profile}-${now.toISOString().slice(0, 10)}.sqlite`;
  const target = join(dir, name);
  const tmp = join(dir, `.${name}.${process.pid}.tmp`);
  try {
    rmSync(tmp, { force: true });
    db.prepare("VACUUM INTO ?").run(tmp);
  } finally {
    db.close();
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, target);

  const pattern = new RegExp(`^${profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{4}-\\d{2}-\\d{2}\\.sqlite$`);
  const copies = readdirSync(dir)
    .filter((f) => pattern.test(f))
    .sort()
    .reverse();
  const removed = copies.slice(KEEP);
  for (const f of removed) rmSync(join(dir, f), { force: true });
  return { path: target, removed };
}
