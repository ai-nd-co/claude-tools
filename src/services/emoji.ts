// Whether a message is "only emoji": a 👍, a 🔥, a row of 🎉 — the reactions people post as messages.
// A watcher drops these by default (Davron #1470), because each one wakes an agent for nothing to do.
//
// Deliberately narrow, so nothing with words in it is ever dropped:
//  - at least one pictograph or flag must be present;
//  - every other character must be whitespace or emoji glue (ZWJ, variation selector, skin tone, keycap);
//  - digits, `#` and `*` do not count as emoji, so "5", "#3" or a keycap like 1️⃣ always gets through: those
//    are answers, not reactions.

const EMOJI_ONLY = /^(?:\s|‍|️|⃣|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator})+$/u;
const HAS_PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

export function isEmojiOnly(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && EMOJI_ONLY.test(trimmed) && HAS_PICTOGRAPH.test(trimmed);
}
