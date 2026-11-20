import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

const UPLOAD_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
};

const EXTENSION_FOR_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/heic": ".heic",
  "application/pdf": ".pdf",
  "text/csv": ".csv",
};

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function expand(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * Reads a local file for upload to Starling. Only receipt-like files
 * (images and PDFs) are allowed, so the tool cannot be used to send
 * arbitrary local files (keys, configs) off the machine.
 */
export async function readUploadFile(
  path: string,
  allowPdf = true,
): Promise<{ data: Buffer; contentType: string; name: string }> {
  const full = resolve(expand(path));
  const contentType = UPLOAD_TYPES[extname(full).toLowerCase()];
  if (!contentType || (!allowPdf && contentType === "application/pdf")) {
    const allowed = Object.keys(UPLOAD_TYPES).filter((e) => allowPdf || e !== ".pdf");
    throw new Error(`Only ${allowed.join(", ")} files can be uploaded`);
  }
  const st = await stat(full);
  if (!st.isFile()) throw new Error(`${full} is not a regular file`);
  if (st.size > MAX_UPLOAD_BYTES) throw new Error(`${full} is larger than 10 MB`);
  return { data: await readFile(full), contentType, name: basename(full) };
}

export function extensionFor(contentType: string): string {
  return EXTENSION_FOR_TYPE[contentType] ?? ".bin";
}

const MAX_NAME_BYTES = 255;

/** Thrown when a requested file name or path is not allowed. */
export class UnsafePathError extends Error {}

/**
 * Returns the name unchanged if it is a single, plain file name:
 * no directory separators, no "." / "..", no control characters, not hidden.
 */
export function plainFileName(name: string): string | undefined {
  if (!name || name === "." || name === "..") return undefined;
  if (name.includes("/") || name.includes("\\")) return undefined;
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  if (name.startsWith(".") || name.startsWith("~")) return undefined;
  if (name.trim() !== name || Buffer.byteLength(name) > MAX_NAME_BYTES) return undefined;
  return name;
}

/**
 * Picks the file name for something the Starling API sent us. Names supplied
 * by the server (e.g. Content-Disposition) are only used if they are a plain
 * file name; anything else falls back to the given safe name.
 */
export function serverFileName(suggested: string | undefined, fallback: string): string {
  return (suggested !== undefined && plainFileName(suggested)) || fallback;
}

/**
 * Resolves where a requested name may be written, or throws. Only plain
 * file names, or absolute / ~ paths whose directory IS the download
 * directory, are accepted: no subdirectories, no "..", no other locations.
 */
async function targetIn(realDir: string, requested: string): Promise<string> {
  const expanded = expand(requested);
  if (isAbsolute(expanded)) {
    const name = plainFileName(basename(expanded));
    let parent: string | undefined;
    try {
      parent = await realpath(dirname(expanded));
    } catch {
      parent = undefined;
    }
    if (!name || parent !== realDir) {
      throw new UnsafePathError(
        `Refusing to write to ${requested}: files can only be saved directly in the download directory (${realDir}).`,
      );
    }
    return join(realDir, name);
  }
  const name = plainFileName(requested);
  if (!name) {
    throw new UnsafePathError(
      `Refusing file name "${requested}": use a plain file name (no "/", "\\", ".." or leading "."). ` +
        `It is saved in ${realDir}.`,
    );
  }
  return join(realDir, name);
}

/**
 * Writes downloaded bank data into the download directory only, with
 * owner-only permissions, never overwriting or following a symlink at the
 * target (O_CREAT | O_EXCL | O_NOFOLLOW). If the name is taken, " (1)",
 * " (2)", ... is added.
 */
export async function saveDownload(
  downloadDir: string | undefined,
  fileName: string,
  data: Buffer | string,
): Promise<string> {
  if (!downloadDir) {
    throw new UnsafePathError(
      "Saving files is disabled (STARLING_DOWNLOAD_DIR=off). Set STARLING_DOWNLOAD_DIR to a directory to enable it.",
    );
  }
  await mkdir(downloadDir, { recursive: true, mode: 0o700 });
  const realDir = await realpath(downloadDir);
  const target = await targetIn(realDir, fileName);

  const ext = extname(target);
  const stem = target.slice(0, target.length - ext.length);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? target : `${stem} (${n})${ext}`;
    try {
      const handle = await open(candidate, flags, 0o600);
      try {
        await handle.writeFile(data);
      } finally {
        await handle.close();
      }
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`Could not find a free file name for ${target}`);
}
