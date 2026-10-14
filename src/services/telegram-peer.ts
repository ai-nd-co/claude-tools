import './telegram-schema.js'; // must precede the telegram package
import { bindCacheAccount, rememberPeer, getKnownPeers } from '../db/index.js';
import { Api } from 'telegram';

export interface PeerChoice { id: string; title: string }
export interface PeerReference { id: string | number; title: string; inputEntity: any; entity?: any }

/** Marked IDs retain the user / basic-group / channel namespace. */
export function peerId(entity: any): string {
  const kind = entity?.className || entity?.constructor?.name || '';
  if (entity?.channelId !== undefined || kind.startsWith('Channel')) return (-1000000000000n - BigInt(entity.channelId ?? entity.id)).toString();
  if (entity?.chatId !== undefined || kind.startsWith('Chat')) return (-BigInt(entity.chatId ?? entity.id)).toString();
  if (entity?.userId !== undefined || kind.startsWith('User')) return BigInt(entity.userId ?? entity.id).toString();
  throw new Error('Cannot determine Telegram peer type');

}

export function rawPeerId(id: string): string {
  const n = BigInt(id);
  return (n <= -1000000000000n ? -n - 1000000000000n : n < 0n ? -n : n).toString();
}

export function selectPeer<T extends PeerChoice>(identifier: string, peers: T[]): T | null {
  const input = identifier.trim();
  if (!input) throw new Error('Chat must not be empty');
  let matches: T[];
  if (/^-?\d+$/.test(input)) {
    const normalized = BigInt(input).toString();
    // Positive legacy raw IDs are accepted only when no peer namespace collides.
    matches = peers.filter(p => normalized.startsWith('-') ? p.id === normalized : rawPeerId(p.id) === normalized);
  } else {
    const name = input.toLowerCase();
    matches = peers.filter(p => p.title.toLowerCase() === name);
    if (!matches.length) matches = peers.filter(p => p.title.toLowerCase().includes(name));
  }
  matches = [...new Map(matches.map(p => [p.id, p])).values()];
  if (matches.length > 1) throw new Error(`Ambiguous chat "${input}". Use a marked chat ID or @username:\n${matches.map(p => `  ${p.id} ${p.title}`).join('\n')}`);
  return matches[0] || null;
}

/** The session string each live client was built from, so its getMe() can vouch for that session only. */
const clientSessions = new WeakMap<object, string>();
export function rememberClientSession(client: object, sessionString: string): void { clientSessions.set(client, sessionString); }

/**
 * Prove which account this live client is, and bind the cache to it. A relogin to the same account is accepted
 * here and nowhere else, so any command that opens the cache before resolving a chat must call this first.
 */
export async function verifyCacheAccount(client: any): Promise<any> {
  const self = await client.getMe();
  bindCacheAccount(peerId(self), clientSessions.get(client));
  return self;
}

export async function resolvePeer(client: any, identifier: string | number | PeerReference): Promise<any> {
  const self = await verifyCacheAccount(client);
  if (typeof identifier === 'object') {
    const actual = identifier.inputEntity?.className === 'InputPeerSelf' ? peerId(self) : peerId(identifier.inputEntity);
    if(actual !== String(identifier.id)) throw new Error('Resolved chat identity does not match its input peer');
    return {...identifier, id:String(identifier.id), entity:identifier.entity || identifier.inputEntity};
  }
  const input = String(identifier).trim();
  if (!input) throw new Error('Chat must not be empty');
  let entity: any;
  let title: string | undefined;
  if (input.startsWith('@') || input.toLowerCase() === 'me') {
    entity = await client.getEntity(input.toLowerCase() === 'me' ? 'me' : input);
  } else {
    const dialogs = await client.getDialogs({});
    const candidates = dialogs.filter((d: any) => d.entity).map((d: any) => ({
      id: peerId(d.entity), title: d.title || d.entity.title || d.entity.firstName || d.entity.username || '', entity: d.entity,
    }));
    for (const peer of candidates) rememberPeer(peer.id,peer.title,peer.entity.username);
    if (/^\d+$/.test(input)) selectPeer(input,[...candidates,...getKnownPeers()]);
    const selected = selectPeer(input, candidates) as any;
    if (selected) { entity = selected.entity; title = selected.title; }
    else if (/^-\d+$/.test(input)) {
      // Only marked IDs convey enough information for a direct lookup.
      const numeric = BigInt(input);
      entity = await client.getEntity(numeric <= -1000000000000n ? new Api.PeerChannel({channelId:(-numeric-1000000000000n) as any}) : new Api.PeerChat({chatId:(-numeric) as any}));
      if (peerId(entity) !== BigInt(input).toString()) throw new Error('Telegram returned a different chat');
    } else throw new Error(`Chat not found: "${input}". Use telegram chats or an @username.`);
  }
  const id = peerId(entity);
  rememberPeer(id,title || entity.title || entity.firstName || entity.username || input,entity.username);
  const type = entity.className?.startsWith('Channel') ? (entity.megagroup ? 'supergroup' : 'channel') : entity.className?.startsWith('Chat') ? 'group' : 'user';
  return { id, title: title || entity.title || entity.firstName || entity.username || input,
    username: entity.username, type, entity, inputEntity: await client.getInputEntity(entity) };
}

export function assertMessagePeer(message: any, expected: string): void {
  if (!message || message.className === 'MessageEmpty' || !message.peerId) throw new Error('Message not found');
  if (peerId(message.peerId) !== expected) throw new Error(`Telegram returned a message from a different chat (expected ${expected})`);
}

export function parseMessageId(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || Number(value) > 2147483647) throw new Error('Message ID must be a positive 32-bit integer');
  return Number(value);
}

export function parseContextCount(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) > 100) throw new Error('Context count must be an integer from 0 to 100');
  return Number(value);
}
