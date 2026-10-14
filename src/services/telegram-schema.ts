// Teach GramJS the current Telegram schema. Import this before anything imports 'telegram'.
//
// GramJS 2.26 is frozen at layer 198, which predates rich messages (tables,
// headings, checklists) and date entities. It builds every API class from the
// schema string in `telegram/tl/apiTl.js` the first time `telegram/tl/api.js`
// loads, so replacing that string beforehand upgrades the whole client: new
// constructors serialize, and the server's layer-229 replies parse instead of
// failing with "Could not find a matching Constructor ID".
//
// The schema is vendored from TDLib by scripts/update-telegram-schema.mjs.

import { createRequire } from 'module';
import { SCHEMA_LAYER, SCHEMA_TL } from './telegram-schema-tl.js';

const require = createRequire(import.meta.url);

const apiPath = require.resolve('telegram/tl/api.js');
if (require.cache[apiPath]) {
  // The classes are already built from the old schema; swapping now would leave
  // requests and replies on different layers.
  throw new Error('telegram-schema.ts must be imported before the telegram package');
}

const apiTlPath = require.resolve('telegram/tl/apiTl.js');
require(apiTlPath);
require.cache[apiTlPath]!.exports = SCHEMA_TL;

// initConnection announces this layer, which is what makes the server reply in
// the schema just installed.
const allTlObjects = require('telegram/tl/AllTLObjects.js') as { LAYER: number };
allTlObjects.LAYER = SCHEMA_LAYER;

// Communities (new since 198) link several groups under one channel-backed
// container, and GramJS's own code has never heard of them: getDialogs throws
// "Cannot cast Community to any kind of int" computing the entity's id, then
// "Cannot read properties of undefined" building a Dialog from a
// dialogCommunity, which has no peer or top message. The API addresses a
// community as an InputChannel, so to GramJS it is a channel; its dialog entry
// is a container like a folder, which GramJS already skips.
const { Api } = require('telegram') as { Api: Record<string, any> };
Object.setPrototypeOf(Api.Community.prototype, Api.Channel.prototype);
Object.setPrototypeOf(Api.CommunityForbidden.prototype, Api.ChannelForbidden.prototype);
Object.setPrototypeOf(Api.DialogCommunity.prototype, Api.DialogFolder.prototype);
for (const cls of [Api.DialogCommunity, Api.DialogPeerCommunity]) {
  Object.defineProperty(cls.prototype, 'peer', {
    get(this: { communityId: unknown }) {
      return new Api.PeerChannel({ channelId: this.communityId });
    },
  });
}

export { SCHEMA_LAYER };
