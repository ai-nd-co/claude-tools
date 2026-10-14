// Text to speech for outgoing bot messages.
//
// Synthesis is delegated to the `agent-tools ttsify` CLI rather than
// reimplemented: it already picks Kokoro for English and Silero for Russian, and
// it is the tool this owner maintains for exactly this. This module's job is to
// find it, run it without the LLM rewrite step, and hand Telegram something it
// will play as a voice note rather than show as a file.

import { execFile, execFileSync } from 'child_process';
import { accessSync, constants, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

/**
 * Kokoro loads its model on every invocation, and the transform adds an LLM call
 * on top, so a short line can still take a while.
 */
const SYNTHESIS_TIMEOUT_MS = 10 * 60 * 1000;

/** Telegram truncates nothing, but minutes of audio from a long message is not useful. */
export const MAX_TTS_CHARACTERS = 4000;

/**
 * ttsify defaults to Codex with `gpt-5.4-mini`, which a ChatGPT account cannot
 * use ("model is not supported when using Codex with a ChatGPT account"), so the
 * transform would fail on this machine out of the box. The local Claude CLI is
 * available and fast enough for a rewrite this small.
 */
const DEFAULT_TRANSFORM_ARGS = ['--provider', 'claude-code', '--claude-model', 'haiku'];

export interface TtsResult {
  /** Ogg/Opus, which is what Telegram plays as a voice note. */
  oggPath: string;
  /** Caller must remove this when finished. */
  workDir: string;
}

/**
 * Locate the `agent-tools` CLI.
 *
 * The repo venv is checked before PATH: this machine has the checkout but no
 * global install, and a stale global would be the wrong build.
 */
function isRunnable(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    // Windows has no execute bit; presence of the file is the best signal there.
    if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findAgentTools(explicit?: string): string | null {
  const candidates = [
    explicit,
    process.env.AGENT_TOOLS_BIN,
    join(homedir(), 'projects/otherorg/repos/agent-tools/.venv/bin/agent-tools'),
    join(homedir(), 'projects/otherorg/repos/agent-tools/.venv/Scripts/agent-tools.exe'),
  ].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    // Existence is not enough: a directory or a non-executable file would offer
    // a button that cannot work, and would shadow a usable PATH install.
    if (isRunnable(candidate)) return candidate;
  }

  // Nothing at a known path: fall back to PATH, but resolve it now rather than
  // assuming, so availability checks cannot report a tool that is not there.
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['agent-tools'], {
      stdio: 'ignore',
      timeout: 10_000,
    });
    return 'agent-tools';
  } catch {
    return null;
  }
}

/**
 * Whether this machine can produce speech at all.
 *
 * Speech is an optional extra: it needs a Python ML stack (Kokoro/Silero) and
 * ffmpeg, and plenty of machines have neither. Callers check this instead of
 * offering a button that fails when pressed — a Listen button that errors is
 * worse than no button.
 */
export function isTtsAvailable(bin?: string): boolean {
  if (!findAgentTools(bin)) return false;

  // ffmpeg turns the wav into the Ogg/Opus Telegram plays as a voice note.
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Why speech is unavailable, for a message that explains rather than just fails. */
export function ttsUnavailableReason(bin?: string): string | null {
  if (!findAgentTools(bin)) {
    return 'agent-tools is not installed (set AGENT_TOOLS_BIN to its path if it is elsewhere)';
  }
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 10_000 });
  } catch {
    return 'ffmpeg is not installed';
  }
  return null;
}

/**
 * Speak `text`, returning an Ogg/Opus file.
 *
 * `ttsify`'s LLM transform is on by default. It is what makes a commit hash or a
 * table listenable rather than spelled out character by character, which plain
 * synthesis does badly. `transform: false` skips it for a verbatim reading.
 */
export async function synthesize(
  text: string,
  opts: {
    bin?: string;
    device?: 'auto' | 'cpu' | 'cuda';
    voice?: string;
    transform?: boolean;
    /** Extra ttsify arguments selecting the transform provider. */
    transformArgs?: string[];
  } = {}
): Promise<TtsResult> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Nothing to speak: the text is empty.');
  if (trimmed.length > MAX_TTS_CHARACTERS) {
    throw new Error(`Text is ${trimmed.length} characters; the limit for speech is ${MAX_TTS_CHARACTERS}.`);
  }

  const bin = findAgentTools(opts.bin) ?? 'agent-tools';
  const workDir = mkdtempSync(join(tmpdir(), 'claude-tools-tts-'));
  const wav = join(workDir, 'speech.wav');
  const ogg = join(workDir, 'speech.ogg');
  const source = join(workDir, 'speech.txt');

  try {
    // A file rather than stdin: the text can contain anything, and --input-file
    // sidesteps shell and encoding questions entirely.
    writeFileSync(source, trimmed, 'utf-8');

    const base = ['ttsify', '--input-file', source, '--output-file', wav, '--device', opts.device ?? 'cpu'];
    if (opts.voice) base.push('--voice', opts.voice);

    // Default is the rewrite: it is what makes a commit hash or a table
    // listenable instead of spelled out. An explicit false reads verbatim.
    const wantsTransform = opts.transform !== false;
    const args = wantsTransform
      ? [...base, ...(opts.transformArgs ?? DEFAULT_TRANSFORM_ARGS)]
      : [...base, '--no-transform'];

    const invoke = async (argv: string[]) => {
      try {
        await run(bin, argv, { timeout: SYNTHESIS_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          throw new Error(
            'agent-tools was not found. Install it, or set AGENT_TOOLS_BIN to its path ' +
            '(e.g. repos/agent-tools/.venv/bin/agent-tools).'
          );
        }
        // The CLI puts the useful part on stderr; a bare exit code explains nothing.
        throw new Error(String(err?.stderr || err?.message).trim().split('\n').slice(-3).join(' '));
      }
    };

    try {
      await invoke(args);
    } catch (err) {
      // The rewrite needs a working LLM provider. Losing it should cost polish,
      // not the whole voice note, so fall back to reading the text as written.
      if (!wantsTransform) throw new Error(`Speech synthesis failed: ${(err as Error).message}`);

      process.stderr.write(`[tts] transform unavailable, reading verbatim: ${(err as Error).message}\n`);
      try {
        await invoke([...base, '--no-transform']);
      } catch (fallbackErr) {
        throw new Error(`Speech synthesis failed: ${(fallbackErr as Error).message}`);
      }
    }

    if (!existsSync(wav)) throw new Error('Speech synthesis produced no audio.');

    // Telegram plays Ogg/Opus as a voice note; a wav arrives as a file to
    // download, which defeats the point.
    try {
      await run('ffmpeg', ['-y', '-i', wav, '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', ogg], {
        timeout: 60_000,
      });
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        throw new Error('ffmpeg is required to convert speech to a voice note, and was not found.');
      }
      throw new Error(`Converting speech to Opus failed: ${String(err?.stderr || err?.message).trim().slice(-300)}`);
    }

    return { oggPath: ogg, workDir };
  } catch (err) {
    rmSync(workDir, { recursive: true, force: true });
    throw err;
  }
}
