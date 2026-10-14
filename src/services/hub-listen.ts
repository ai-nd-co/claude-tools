/**
 * The Listen presses a `hub watch` has taken and not yet finished with.
 *
 * THE RULE THIS FILE EXISTS FOR: a pressed button must never end up gone with no way to press it again.
 *
 * A press arrives as a hub message, and the watcher's cursor moves past it as soon as the batch is printed. Its
 * button is removed the moment the press is taken. So from then on this ledger is the only record that the press
 * exists, and an entry may leave it in exactly four ways:
 *
 *   1. the press ended `spoken`, or `permanent` (nothing here can ever read it, so a button would only repeat that);
 *   2. its button was put back: by this ledger after a `retryable` failure, or already by `accept` (`restored`, a
 *      press refused by a full speech queue);
 *   3. putting the button back failed MAX_BUTTON_RESTORES times; the agent is told to send the message again;
 *   4. `release()` at exit, which puts the button back when the hub may be called, and names the press either way.
 *
 * Every exit path of the watcher goes through `release()`, and every outcome through `settle()`. Code that drops
 * an entry any other way breaks the rule; `topic-listen.test.ts` drives each path and checks the button.
 *
 * WHEN THE RULE AND "ONE VOICE NOTE, NOT TWO" CONFLICT, THE RULE WINS. A voice upload may take up to two minutes and
 * an exit has one to three seconds, so at exit an upload's outcome is not always known. `release()` gives it
 * UPLOAD_DECISION_MS: delivered keeps the button off; failed or still undecided puts it back. The cost is a possible
 * second voice note on a later press, never a press that can no longer be made. While the hub may not be called
 * (quarantine) nothing can be restored or sent at all, and the press is named to the agent instead.
 */
import type { HubListenPress } from './hub-telegram.js';

/**
 * How a press ended. `spoken`: the voice note went out. `permanent`: nothing here can ever read it, and the presser
 * was told so. `retryable`: another press could work (synthesis, upload, an undelivered reply, the quarantine guard),
 * so the button must come back. `restored`: its button is already back.
 */
export type ListenOutcome = 'spoken' | 'retryable' | 'permanent' | 'restored';

/** A failed button restore is retried after later successful polls, this many times in all. */
export const MAX_BUTTON_RESTORES = 5;

/** How long `release()` waits for an upload already under way before putting the button back anyway. */
export const UPLOAD_DECISION_MS = 500;

export interface ListenLedgerDeps {
  /**
   * Take the press: answer it, remove its button, queue the speech; `onSettled` once, with how it ended. Replies it
   * sends without awaiting go to `track`, so an exit can bound them too.
   */
  accept(press: HubListenPress, onSettled: (outcome: ListenOutcome) => void, track: (request: Promise<unknown>) => void): Promise<void>;
  /** Stop a repeat press's spinner; nothing else happens for it. */
  answerRepeat(press: HubListenPress): Promise<void>;
  /** Put the press's Listen button back on its message. */
  restoreButton(press: HubListenPress): Promise<void>;
  /** Whether the hub may be called now (false while something else answers /api). */
  canReachHub(): boolean;
  /** One line for the agent; a returned promise is tracked, so an exit waits for the line to be written. */
  report(line: string): Promise<unknown> | void;
}

type State = 'working' | 'due' | 'restoring';

interface Entry {
  press: HubListenPress;
  /** The press's own answer-and-remove; a restore waits for it, so a late removal cannot undo the restore. */
  setup: Promise<unknown>;
  state: State;
  restoreAttempts: number;
  /** A voice upload already under way for this press; release waits for its outcome before deciding to restore. */
  upload?: Promise<boolean>;
}

const where = (press: HubListenPress): string =>
  `msg ${press.messageId} (chat ${press.chatId}${press.threadId !== undefined ? `, topic ${press.threadId}` : ''})`;

export class ListenLedger {
  private readonly entries = new Map<string, Entry>();
  /** Requests sent without being awaited (a callback answer, an explanation); they hold no button, only the process. */
  private readonly inFlight = new Set<Promise<unknown>>();
  /** Set by the first `release()`: the watcher is leaving, so nothing new is taken and no voice note goes out. */
  private isClosed = false;

  constructor(private readonly deps: ListenLedgerDeps) {}

  get size(): number {
    return this.entries.size;
  }

  /**
   * True once released. A voice note must not go out after this: its button has been put back, so the next watcher
   * would read the message again on the next press (Codex review). The caller's voice transport refuses it.
   */
  get closed(): boolean {
    return this.isClosed;
  }

  /** Whether anything Listen started is still outstanding: a press, or a request sent without being awaited. */
  get busy(): boolean {
    return this.entries.size > 0 || this.inFlight.size > 0;
  }

  /**
   * A voice upload for the press on `bot`/`chatId`/`messageId` has started. Uploads begun before a release cannot be
   * recalled, so `release()` waits for this one: delivered means the button stays off (one voice note, not two);
   * failed means it goes back (Codex review).
   */
  uploading(bot: string, chatId: string, messageId: number, upload: Promise<unknown>): void {
    const entry = this.entries.get(`${bot}:${chatId}:${messageId}`);
    if (entry !== undefined) entry.upload = upload.then(() => true, () => false);
  }

  /**
   * Settles once no request sent without being awaited is left, including any added while it waits (a press still
   * being set up can add one). An exit races it against its deadline.
   */
  async drained(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  /** A press the hub delivered. One entry and at most one job per message; a repeat only has its spinner stopped. */
  take(press: HubListenPress): void {
    // Leaving: the press is not touched at all, so its button stays and the next press reaches whoever watches next.
    // Taking it now would remove the button with no exit left to put it back (Codex review).
    if (this.isClosed) return;
    const key = `${press.bot}:${press.chatId}:${press.messageId}`;
    if (this.entries.has(key)) {
      this.track(this.deps.answerRepeat(press));
      return;
    }
    const entry: Entry = { press, setup: Promise.resolve(), state: 'working', restoreAttempts: 0 };
    this.entries.set(key, entry);
    entry.setup = this.deps.accept(press, (outcome) => this.settle(key, entry, outcome), (request) => this.track(request)).catch((error: Error) => {
      this.say(`Listen on ${where(press)} failed: ${error.message.slice(0, 200)}`);
      this.settle(key, entry, 'retryable');
    });
  }

  /** The hub answered as itself: put back every button that is due, retrying earlier failed restores. */
  hubVerified(): void {
    // Never while the hub may not be called: a restore the guard refuses would be counted as a failed attempt and
    // could exhaust MAX_BUTTON_RESTORES without one real try (Codex review).
    if (!this.deps.canReachHub()) return;
    for (const [key, entry] of this.entries) {
      if (entry.state !== 'due') continue;
      // Stays in the ledger while restoring, so an exit in the meantime still restores it (idempotently).
      entry.state = 'restoring';
      entry.restoreAttempts += 1;
      // Tracked as a whole, so a release that starts meanwhile waits for it and for any report it ends with; and a
      // press the release has already taken over is not reported a second time (Codex review).
      this.track(entry.setup
        .then(() => this.deps.restoreButton(entry.press))
        .then(
          () => {
            if (this.entries.get(key) !== entry) return;
            this.forget(key, entry);
            this.say(`Listen on ${where(entry.press)} was not read aloud; its button is back for another press.`);
          },
          (error: Error) => {
            if (this.entries.get(key) !== entry) return;
            if (entry.restoreAttempts < MAX_BUTTON_RESTORES) {
              entry.state = 'due';
              return;
            }
            this.forget(key, entry);
            this.say(
              `Listen on ${where(entry.press)} was not read aloud, and its button could not be put back `
              + `(${error.message.slice(0, 200)}); send the message again.`,
            );
          },
        ));
    }
  }

  /**
   * The watcher is leaving (signal, handover, update restart, any end of the loop): every press still here is
   * named, and its button put back when the hub may be called. `restored` settles when those calls have AND no
   * reply sent without being awaited is left in flight; the caller bounds the wait by its own exit deadline.
   */
  release(why: string): { lines: string[]; restored: Promise<unknown> } {
    this.isClosed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    const reachable = this.deps.canReachHub();
    // Written before any upload's outcome is known, so it must be true either way (Codex review).
    const outcome = reachable
      ? 'If no voice note arrived, its button is being put back for another press; if the button stays gone, send the message again.'
      : 'If no voice note arrived, its button could not be put back, because the hub was not answering; send the message again.';
    const lines = entries.map((entry) => `Listen on ${where(entry.press)} was interrupted: ${why}. ${outcome}`);
    const restores = reachable
      ? Promise.allSettled(entries.map(async (entry) => {
        await entry.setup;
        if (entry.upload !== undefined) {
          let timer: NodeJS.Timeout | undefined;
          const undecided = new Promise<'undecided'>((resolve) => { timer = setTimeout(() => resolve('undecided'), UPLOAD_DECISION_MS); });
          const delivered = await Promise.race([entry.upload, undecided]);
          clearTimeout(timer);
          if (delivered === true) return; // delivered: the button stays off
          // Failed or undecided: the button goes back (see the header on why the rule outranks a second voice note).
        }
        await this.deps.restoreButton(entry.press);
      }))
      : Promise.resolve();
    // Tracked like any outstanding request, so a later exit path (one release, then the loop's own exit) still waits
    // for these restores instead of seeing an empty ledger and leaving mid-restore (Codex review).
    this.track(restores);
    // What every exit path waits for: the restores, then every reply still in flight (Codex review).
    return { lines, restored: restores.then(() => this.drained()) };
  }

  private settle(key: string, entry: Entry, outcome: ListenOutcome): void {
    if (this.entries.get(key) !== entry) return;
    if (outcome !== 'retryable') {
      this.forget(key, entry);
      return;
    }
    entry.state = 'due';
    if (this.deps.canReachHub()) this.hubVerified();
  }

  /** A report to the agent, tracked like a request: the "send the message again" line must survive an exit. */
  private say(line: string): void {
    this.track(Promise.resolve(this.deps.report(line)));
  }

  private track(request: Promise<unknown>): void {
    const settled = request.catch(() => undefined).finally(() => this.inFlight.delete(settled));
    this.inFlight.add(settled);
  }

  private forget(key: string, entry: Entry): void {
    if (this.entries.get(key) === entry) this.entries.delete(key);
  }
}
