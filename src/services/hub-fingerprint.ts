// VENDORED, NOT REWRITTEN.
//
// Same author and copyright holder as this package, reused with permission and published
// here under this repository's MIT licence.
//
// Source: agent-hub `packages/shared/src/fingerprint.ts` at commit
// 86fd524cd995dc6ce942ff4c1708cd3caa0d3d97. The server derives the machine
// identity with that file; this client must derive the identical value from the
// identical machine or nothing authenticates - and worse, one machine can
// acquire two identities and show up twice in the owner's approval queue, where
// it reads as an enrolment problem rather than as a client bug.
//
// So it is copied rather than reimplemented, and copied verbatim: upstream
// formatting (double quotes, the comment wording) is kept so `diff` against the
// source file stays meaningful. Two lines are the only edits, both forced by the
// package boundary - `FINGERPRINT_PATTERN` and `machineLabelOf` come from
// sibling modules there and are inlined here, with the upstream values.
//
// Cross-repo agreement is asserted, not assumed: `src/tests/hub-fingerprint.test.ts`
// pins the whole chain - systemd's app-specific id, the derived fingerprint, its
// sha256 and the 16-character label - to literals produced by the server's own
// compiled module, and `packages/shared/src/fingerprint.test.ts` upstream pins
// the same literals. A silent divergence fails a test on both sides.
//
// If you change anything here, change it upstream in the same breath.

/**
 * Deriving the machine fingerprint — roadmap D14, and the **client** half of ISSUE-13.
 *
 * ```
 * APP_ID = a fixed, PUBLIC 128-bit id, compiled in                       (FINGERPRINT_APP_ID)
 * anchor = app_specific(machine anchor, APP_ID)                          128-bit hex, NOT secret
 * salt   = 32 bytes from a CSPRNG, written once at ~/.config/ai-hub/machine.key, 0600, O_EXCL
 * fp     = base64url(HMAC-SHA256(key = salt, msg = "ai-hub/fingerprint/v1\n" + anchor))
 *        # 32 bytes -> 43 base64url characters on the wire
 * ```
 *
 * **Where the entropy comes from: the salt, not the machine.** `machine-id(5)` is world-readable on
 * the owner's own box, it is reproducible by anyone who has ever held a copy of that filesystem, and
 * inside a VM it may be derived from the hypervisor's `product_uuid` — so an anchor-only fingerprint
 * would be *guessable by the wrong people* on a public endpoint (roadmap D9). Once the secret salt is
 * mixed in, **the fingerprint is an API key that happens to be bound to a machine.** The anchor
 * contributes stability (the same machine re-derives the same value with nothing but the salt stored)
 * and a clone tripwire — not security. Do not describe it to a user as "your machine is the password".
 *
 * `machine-id(5)`, on why the raw id never goes on the wire:
 *
 * > "This ID uniquely identifies the host. It should be considered 'confidential', and must not be
 * > exposed in untrusted environments, in particular on the network. […] the machine ID should be
 * > hashed with a cryptographic, keyed hash function, using a fixed, application-specific key."
 *
 * **This module is node-only and is deliberately NOT re-exported from `index.ts`.** It reads files and
 * spawns processes; `packages/web` compiles against `@agent-hub/shared` and must never pull `node:fs`
 * into a browser bundle. Import it as `@agent-hub/shared/fingerprint`.
 *
 * The server never derives a fingerprint — it only ever hashes the one on the wire. `fingerprintHash`
 * lives here so there is exactly **one** definition of what gets hashed (the ASCII wire value, not the
 * 32 raw bytes) and the two sides cannot drift.
 */
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/**
 * Inlined from the server's `packages/shared/src/identity.js`: 43 base64url characters, the fixed
 * length the server length-checks before hashing. A client that sent anything else would be refused
 * with the same opaque 403 an unapproved machine gets, so the check belongs on this side too.
 */
export const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Inlined from the server's `packages/shared/src/machines.js`. 16 characters, 64 bits. */
export const MACHINE_LABEL_LENGTH = 16;

function machineLabelOf(machineId: string): string {
  return machineId.slice(0, MACHINE_LABEL_LENGTH);
}

/**
 * The application-specific key, generated once with `systemd-id128 new` semantics and frozen.
 *
 * **Public on purpose.** It is compiled into a client the owner may well publish, and the derivation
 * is designed to survive that: `sd_id128_get_app_specific(3)` guarantees that "neither of the two
 * input parameters can be calculated from the output", and the secret is the salt.
 *
 * Changing this value re-derives every fingerprint on every machine, which reads at the hub as a fleet
 * of new pending machines. It is therefore a version number, not a knob.
 */
export const FINGERPRINT_APP_ID = "d52c0138296aa0b9bdca559f7e4b97c8";

/**
 * Domain separation, and the reason it ends in a newline: the salt is a general-purpose HMAC key, and a
 * context string with a terminator means a future `"ai-hub/something-else/v1\n"` cannot be confused
 * with a longer variant of this one.
 */
export const FINGERPRINT_CONTEXT = "ai-hub/fingerprint/v1\n";

/** 256 bits. ISSUE-02 §2 puts the floor at 128; 256 costs 43 characters instead of 22, which is free. */
export const SALT_BYTES = 32;

/** `~/.config/ai-hub/` — or `$XDG_CONFIG_HOME`, or `%APPDATA%` on Windows. */
export const CONFIG_SUBDIR = "ai-hub";
export const SALT_FILENAME = "machine.key";
export const ANCHOR_FILENAME = "machine-anchor";

/**
 * Which rung of the fallback chain produced the anchor. Recorded in the roster so the console can show
 * that a container fell through to a self-written random file rather than `/etc/machine-id` — an anchor
 * that changes appears as a **new pending machine**, and knowing which rung was used is how that stops
 * being a mystery.
 */
export const ANCHOR_RUNGS = [
  "machine-id",
  "dbus-machine-id",
  "windows-machine-guid",
  "macos-platform-uuid",
  "random-file",
] as const;
export type AnchorRung = (typeof ANCHOR_RUNGS)[number];

export interface Anchor {
  /** The app-specific 128-bit value, hex. Never the raw machine id. */
  readonly value: string;
  readonly rung: AnchorRung;
}

export interface MachineFingerprint {
  /** 43 base64url characters. **The credential.** Never log it, never print any part of it. */
  readonly fingerprint: string;
  /**
   * The first 16 characters of `sha256(fingerprint)` — what the listener prints and the approval screen
   * shows, so the owner can match the two. Derived by a hash, never taken from the credential itself.
   */
  readonly label: string;
  /** `sha256(fingerprint)` hex. What the server stores, and all it ever stores. */
  readonly hash: string;
  readonly anchor: Anchor;
}

export const FINGERPRINT_ERROR_CODES = [
  "salt_unreadable",
  "salt_malformed",
  "salt_permissions",
  "config_unwritable",
  "anchor_unavailable",
] as const;
export type FingerprintErrorCode = (typeof FINGERPRINT_ERROR_CODES)[number];

/**
 * Every failure here is **fatal to the listener, by design.** ISSUE-02 §2 names the two things this must
 * never do, and both are enforced by throwing rather than returning:
 *
 *  1. Never fall back to a salt-less fingerprint. That branch would silently downgrade every machine to
 *     the guessable, anchor-only form and nobody would notice.
 *  2. Never regenerate a salt while a usable one exists. A listener that quietly re-enrols on every
 *     permissions glitch trains the owner to click Approve without reading.
 */
export class FingerprintError extends Error {
  readonly code: FingerprintErrorCode;

  constructor(code: FingerprintErrorCode, message: string) {
    super(message);
    this.name = "FingerprintError";
    this.code = code;
  }
}

export interface FingerprintEnvironment {
  /** Overrides the config home. Tests point this at a temp directory; the file work itself is real. */
  readonly configHome?: string;
  readonly platform?: NodeJS.Platform;
  /**
   * Injected so the Windows and macOS rungs are exercised on Linux, and so a test can simulate a box
   * where the anchor is unavailable. Returns `null` when the command does not exist or fails.
   */
  readonly runCommand?: (file: string, args: readonly string[]) => string | null;
  /** Injected for the same reason. Returns `null` for a file that is absent or unreadable. */
  readonly readTextFile?: (path: string) => string | null;
}

/**
 * `$XDG_CONFIG_HOME/ai-hub`, `%APPDATA%/ai-hub` on Windows, else `~/.config/ai-hub`.
 *
 * A **relative** `XDG_CONFIG_HOME` is refused rather than resolved. The XDG spec says such a value "must
 * be ignored", and here the consequence is sharper than untidiness: a relative path makes the salt depend
 * on the process's working directory, so the same machine would derive different fingerprints depending on
 * where its listener was started, and each one would appear as a new pending machine.
 */
export function configDirectory(env: FingerprintEnvironment = {}): string {
  if (env.configHome !== undefined) {
    return join(env.configHome, CONFIG_SUBDIR);
  }
  const platform = env.platform ?? process.platform;
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg !== "") {
    if (!isAbsolute(xdg)) {
      throw new FingerprintError("config_unwritable", `XDG_CONFIG_HOME must be an absolute path, got ${JSON.stringify(xdg)}`);
    }
    return join(xdg, CONFIG_SUBDIR);
  }
  const appData = process.env["APPDATA"];
  if (platform === "win32" && appData !== undefined && appData !== "") {
    return join(appData, CONFIG_SUBDIR);
  }
  return join(homedir(), ".config", CONFIG_SUBDIR);
}

export function saltPath(env: FingerprintEnvironment = {}): string {
  return join(configDirectory(env), SALT_FILENAME);
}

/**
 * `sd_id128_get_app_specific()`, reimplemented in fifteen lines rather than shelled out to
 * `systemd-id128`.
 *
 * > "Internally, this function calculates HMAC-SHA256 of the app_id parameter keyed by the base
 * > parameter, and truncates this result to fit in `sd_id128_t` and turns it into a valid Variant 1
 * > Version 4 UUID, in accordance with RFC 4122."
 * > — `sd_id128_get_machine(3)`
 *
 * **Verified byte-for-byte** against `systemd-id128 machine-id --app-specific=<APP_ID>` on the owner's
 * box (systemd 255) while building ISSUE-13. Doing it here rather than through the binary means the
 * derivation also works in a container with no systemd, and that rung 1 and rung 2 of the fallback
 * chain produce the *same* anchor for the same machine — falling through does not re-enrol the machine.
 */
export function appSpecificId(base: Buffer, appIdHex: string = FINGERPRINT_APP_ID): string {
  const digest = createHmac("sha256", base).update(Buffer.from(appIdHex, "hex")).digest();
  const id = Buffer.from(digest.subarray(0, 16));
  // Variant 1, version 4 — exactly the six bits systemd overwrites, which is also why the anchor is
  // ~122 bits rather than 128. It carries no secret, so that is not a shortfall.
  id[6] = ((id[6] as number) & 0x0f) | 0x40;
  id[8] = ((id[8] as number) & 0x3f) | 0x80;
  return id.toString("hex");
}

/** A 32-hex-character id becomes 16 bytes; anything else is keyed by its own UTF-8 bytes. */
function anchorBase(raw: string): Buffer {
  const hex = raw.trim().replace(/-/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(hex) ? Buffer.from(hex, "hex") : Buffer.from(raw.trim(), "utf8");
}

function defaultReadTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // Absent, unreadable, a directory — all the same answer: this rung cannot supply an anchor.
    return null;
  }
}

function defaultRunCommand(file: string, args: readonly string[]): string | null {
  try {
    return execFileSync(file, [...args], {
      encoding: "utf8",
      // A machine anchor is not worth hanging a listener's startup over.
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * The anchor, and which rung produced it.
 *
 * `uninitialized` is rejected explicitly: on a stateless or read-only root systemd bind-mounts a
 * transient `/etc/machine-id` and the value changes per boot until `systemd-machine-id-commit.service`
 * writes it. Taking it would hand every boot a different fingerprint.
 *
 * The last rung writes its own 16 random bytes next to the salt. That is deliberate and it has a
 * consequence worth stating: **the OS anchor adds nothing to survivability**, because the salt lives in
 * the same directory — wipe it and the fingerprint changes regardless of how stable `/etc/machine-id`
 * was. The anchor's only remaining value is clone and restore detection.
 */
export function resolveAnchor(env: FingerprintEnvironment = {}): Anchor {
  const platform = env.platform ?? process.platform;
  const readTextFile = env.readTextFile ?? defaultReadTextFile;
  const runCommand = env.runCommand ?? defaultRunCommand;

  const fromFile = (path: string, rung: AnchorRung): Anchor | null => {
    const raw = readTextFile(path)?.trim();
    if (raw === undefined || raw === "" || raw === "uninitialized") {
      return null;
    }
    return { value: appSpecificId(anchorBase(raw)), rung };
  };

  if (platform === "win32") {
    // `wmic` is gone from Windows 11 24H2 and later, so the registry read rather than a WMI shell-out.
    // A 32-bit process must read the 64-bit view; `reg query` with /reg:64 is the shell equivalent of
    // KEY_WOW64_64KEY.
    const output = runCommand("reg", [
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
      "/v",
      "MachineGuid",
      "/reg:64",
    ]);
    const guid = output === null ? undefined : /MachineGuid\s+REG_SZ\s+(\S+)/.exec(output)?.[1];
    if (guid !== undefined) {
      return { value: appSpecificId(anchorBase(guid)), rung: "windows-machine-guid" };
    }
  } else if (platform === "darwin") {
    const output = runCommand("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    const uuid = output === null ? undefined : /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(output)?.[1];
    if (uuid !== undefined) {
      return { value: appSpecificId(anchorBase(uuid)), rung: "macos-platform-uuid" };
    }
  } else {
    // `/var/lib/dbus/machine-id` is usually a symlink to the same file; it is a separate rung because on
    // some images it is the only one present.
    return (
      fromFile("/etc/machine-id", "machine-id") ??
      fromFile("/var/lib/dbus/machine-id", "dbus-machine-id") ??
      randomFileAnchor(env)
    );
  }
  return randomFileAnchor(env);
}

function randomFileAnchor(env: FingerprintEnvironment): Anchor {
  const path = join(configDirectory(env), ANCHOR_FILENAME);
  const raw = readOrCreateSecretFile(path, 16, "the machine anchor");
  return { value: appSpecificId(raw), rung: "random-file" };
}

/**
 * Reads a secret file, or creates it once, atomically, with mode 0600.
 *
 * Two properties, and both took a second attempt to get right:
 *
 *  - **Nothing can replace it.** The publish is `open(tmp, "wx")` → write → `link(tmp, path)`, and `link`
 *    fails with `EEXIST` rather than replacing an existing file. So two listeners starting at the same
 *    moment cannot each generate a salt — the loser reads the winner's — and the winner's file is
 *    *complete* before it has a name. A bare `writeFileSync(…, {flag: "wx"})` also refuses to replace, but
 *    it publishes the name first and the content after, so the loser could read an empty or half-written
 *    file and conclude the salt was malformed. A crash in the middle now leaves a stray temp file rather
 *    than a permanently broken credential.
 *  - **The file that is checked is the file that is read.** One descriptor, opened `O_NOFOLLOW` where the
 *    platform has it, `fstat`ed for the mode and read from — never `statSync(path)` and `readFileSync(path)`
 *    as two separate resolutions, which another user with write access to the directory can swap between.
 */
function readOrCreateSecretFile(path: string, bytes: number, what: string): Buffer {
  const directory = dirname(path);
  // Checked on **both** paths, not only when creating. A 0600 key inside a 0777 directory is not
  // protected, and an existing key is exactly the case that matters: it is the one that gets used.
  if (existsSync(directory)) {
    assertDirectoryTrusted(directory);
  }
  const existing = readSecretFile(path, bytes, what);
  if (existing !== null) {
    return existing;
  }
  try {
    // 0700: the salt's directory has no business being readable by anyone else either.
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw new FingerprintError("config_unwritable", `cannot create ${directory}: ${errorText(cause)}`);
  }
  assertDirectoryTrusted(directory);

  const created = randomBytes(bytes);
  // Same directory, so `link` stays on one filesystem; the pid and a random suffix keep two starts apart.
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, created, { flag: "wx", mode: 0o600 });
  } catch (cause) {
    throw new FingerprintError("config_unwritable", `cannot write ${what} near ${path}: ${errorText(cause)}`);
  }
  try {
    linkSync(temp, path);
    return created;
  } catch (cause) {
    if (isErrnoCode(cause, "EEXIST")) {
      // Lost the race. Read the winner's value; never overwrite it.
      const raced = readSecretFile(path, bytes, what);
      if (raced !== null) {
        return raced;
      }
      throw new FingerprintError("salt_unreadable", `${what} at ${path} appeared but cannot be read`);
    }
    throw new FingerprintError("config_unwritable", `cannot publish ${what} at ${path}: ${errorText(cause)}`);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // A leftover temp file is untidy, never dangerous: it is 0600 and nothing reads it by name.
    }
  }
}

function readSecretFile(path: string, bytes: number, what: string): Buffer | null {
  // Belt: on Windows, where `O_NOFOLLOW` does not exist, this is the only symlink check there is, and it
  // is a check-then-open — so it is a real TOCTOU window on that platform and is written down as one.
  // Braces: on POSIX, `O_NOFOLLOW` below refuses the link in the same syscall that opens it, which has no
  // window at all.
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new FingerprintError("salt_permissions", `${what} at ${path} is a symbolic link; it must be a plain file`);
    }
  } catch (cause) {
    if (cause instanceof FingerprintError) {
      throw cause;
    }
    if (!isErrnoCode(cause, "ENOENT")) {
      throw new FingerprintError("salt_unreadable", `cannot inspect ${what} at ${path}: ${errorText(cause)}`);
    }
    return null;
  }
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = openSync(path, flags);
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT")) {
      return null;
    }
    if (isErrnoCode(cause, "ELOOP")) {
      throw new FingerprintError("salt_permissions", `${what} at ${path} is a symbolic link; it must be a plain file`);
    }
    // Present but unreadable: fail loudly and do NOT create a second one (ISSUE-02 §2).
    throw new FingerprintError("salt_unreadable", `${what} at ${path} exists but cannot be read: ${errorText(cause)}`);
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) {
      throw new FingerprintError("salt_malformed", `${what} at ${path} is not a plain file`);
    }
    assertOwnerOnly(path, what, stats.mode);
    if (stats.size !== bytes) {
      // A truncated or hand-edited file is not a reason to re-enrol silently — it is a reason to stop.
      throw new FingerprintError(
        "salt_malformed",
        `${what} at ${path} is ${stats.size} bytes, expected exactly ${bytes}`,
      );
    }
    const contents = Buffer.alloc(bytes);
    const read = readSync(fd, contents, 0, bytes, 0);
    if (read !== bytes) {
      throw new FingerprintError("salt_malformed", `${what} at ${path} returned ${read} of ${bytes} bytes`);
    }
    return contents;
  } finally {
    closeSync(fd);
  }
}

function assertOwnerOnly(path: string, what: string, rawMode: number): void {
  if (process.platform === "win32") {
    // POSIX mode bits are not the access-control mechanism there; asserting on them would fail every
    // Windows machine for no gain.
    return;
  }
  const mode = rawMode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new FingerprintError(
      "salt_permissions",
      `${what} at ${path} is mode ${mode.toString(8).padStart(4, "0")}; it is a bearer credential and must be 0600`,
    );
  }
}

/**
 * The directory has to be as trustworthy as the file.
 *
 * A 0600 salt inside a world-writable directory is not protected: anyone who can write that directory can
 * unlink the file and leave their own in its place, and the next start would derive *their* fingerprint.
 * Only the *writable* bits matter — a readable directory reveals nothing, since the file is 0600 — and the
 * owner matters, because another user's directory is another user's to rearrange.
 *
 * **The limit of this check, stated rather than implied:** it looks at the immediate directory, not at
 * every ancestor. A writable `~` or `/home` is a compromised account already, and walking the whole chain
 * would fail on ordinary systems for no gain here. On Windows it checks nothing: POSIX mode bits are not
 * the access-control mechanism there, and ACL inspection is a bigger dependency than this is worth.
 */
function assertDirectoryTrusted(directory: string): void {
  if (process.platform === "win32") {
    return;
  }
  const stats = statSync(directory);
  const mode = stats.mode & 0o777;
  if ((mode & 0o022) !== 0) {
    throw new FingerprintError(
      "salt_permissions",
      `${directory} is mode ${mode.toString(8).padStart(4, "0")}; anyone who can write it can replace the machine key`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new FingerprintError(
      "salt_permissions",
      `${directory} is owned by uid ${stats.uid}, not ${uid}; its owner can replace the machine key`,
    );
  }
}

/**
 * The salt: 32 CSPRNG bytes, `0600`, created with `O_EXCL`, read back on every later start.
 *
 * **If it is lost** (disk reimaged, `~/.config` wiped, TPM cleared) the fingerprint changes, the hub
 * sees an unknown machine, it lands in the pending queue, and the owner approves once and revokes the
 * stale entry. That is the correct failure mode and needs no recovery path.
 */
export function loadSalt(env: FingerprintEnvironment = {}): Buffer {
  return readOrCreateSecretFile(saltPath(env), SALT_BYTES, "the machine key");
}

/** `base64url(HMAC-SHA256(salt, context + anchor))` — 43 characters, and the whole credential. */
export function deriveFingerprint(salt: Buffer, anchor: string): string {
  if (salt.byteLength !== SALT_BYTES) {
    throw new FingerprintError("salt_malformed", `the salt must be ${SALT_BYTES} bytes, got ${salt.byteLength}`);
  }
  const fingerprint = createHmac("sha256", salt)
    .update(FINGERPRINT_CONTEXT, "utf8")
    .update(anchor, "utf8")
    .digest("base64url");
  if (!FINGERPRINT_PATTERN.test(fingerprint)) {
    // Unreachable unless Node's base64url encoding changes shape; asserting beats shipping a value the
    // server will reject as malformed.
    throw new FingerprintError("salt_malformed", "the derived fingerprint is not 43 base64url characters");
  }
  return fingerprint;
}

/**
 * `sha256(fingerprint)` hex — over the **ASCII wire value**, not the 32 raw bytes it decodes to.
 *
 * One SHA-256 round is correct here, and not bcrypt or argon2, precisely because the fingerprint
 * carries 256 bits of machine-generated entropy: there is no dictionary to run, so a KDF would only buy
 * a per-request cost on the hot path. A Redis dump, an AOF file or a PVC backup then contains no usable
 * credential.
 */
export function fingerprintHash(fingerprint: string): string {
  return createHash("sha256").update(fingerprint, "utf8").digest("hex");
}

/**
 * The 16-character identifier the owner matches: a prefix of `sha256(fingerprint)`, **not** of the
 * fingerprint.
 *
 * Printing a prefix of the credential itself looks harmless and is not: the server accepts any
 * 43-character string, so a caller-chosen prefix lets anyone appear in the approval screen under the same
 * identifier as a real machine, and the owner's whole job there is to tell one row from another. A hash
 * prefix cannot be steered without a 2^64 search. **Never print any part of the fingerprint:** an agent
 * transcript gets pasted into chats.
 */
export function machineLabel(fingerprint: string): string {
  return machineLabelOf(fingerprintHash(fingerprint));
}

/** Everything the client needs, in one call: resolve the anchor, load or create the salt, derive. */
export function machineFingerprint(env: FingerprintEnvironment = {}): MachineFingerprint {
  const anchor = resolveAnchor(env);
  const fingerprint = deriveFingerprint(loadSalt(env), anchor.value);
  return {
    fingerprint,
    label: machineLabel(fingerprint),
    hash: fingerprintHash(fingerprint),
    anchor,
  };
}

function isErrnoCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === code;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
