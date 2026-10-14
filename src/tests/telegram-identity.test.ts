import '../services/telegram-schema.js'; // must precede the telegram package
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { Api } from 'telegram';
import { getDatabase, closeDatabase, getDatabasePath, migrateDatabase, getCacheGeneration, bindCacheAccount, rememberPeer } from '../db/index.js';
import { getEmbeddingsDb, closeEmbeddingsDb, loadEmbeddingsVectorExtension } from '../db/embeddings.js';
import { selectPeer, peerId, resolvePeer, rememberClientSession, verifyCacheAccount, parseMessageId, parseContextCount } from '../services/telegram-peer.js';
import { upsertMessageFromApi } from '../services/telegram-sync.js';
import { getMessage, getMessagesAround, searchMessages, resolveChatId, resolveReplyChain, findMissingReplyTargets } from '../services/telegram-search.js';
import { buildClusters, findClusterForMessage, getClusterMessages } from '../services/telegram-cluster.js';
import { storeEmbedding, deleteEmbeddings, ensureTelegramEmbeddingGeneration } from '../services/embedding-service.js';
import { TelegramService } from '../services/telegram.js';
import { searchResultToMessageData } from '../commands/telegram/index.js';
import { toMessageData as unreadMessageData } from '../commands/telegram/unread.js';
import { formatMessageLink, formatMessageCompact } from '../commands/telegram/format.js';
import { escapeForMarkdownV2 } from '../services/telegram.js';

let fixture: string;
beforeEach(() => { fixture = mkdtempSync(join(tmpdir(), 'telegram-identity-')); process.env.CLAUDE_TOOLS_CONFIG_DIR = fixture;
  for(const key of ['TELEGRAM_API_ID','TELEGRAM_API_HASH','TELEGRAM_SESSION_STRING','TELEGRAM_SESSION']) delete process.env[key]; });
afterEach(() => { closeDatabase(); closeEmbeddingsDb(); rmSync(fixture, {recursive:true, force:true}); delete process.env.CLAUDE_TOOLS_CONFIG_DIR; });
const A = '-1000000000042';
const B = '-1000000000043';
function cache(chatId:string, id:number, date=100, extra:Record<string,unknown>={}) {
  upsertMessageFromApi({chatId,id,date,chatTitle:chatId===A?'Alpha':'Beta',sender:'Fixture',text:`needle ${chatId} ${id}`,replyToId:null,hasMedia:false,mediaType:null,...extra});
}
function channel(id:number, title='Fixture'): any { return new Api.Channel({id:BigInt(id) as any, title, photo:new Api.ChatPhotoEmpty(), date:1, megagroup:true}); }
function fakeClient(entities:any[] = [channel(42),channel(43)]) {
  return { getMe:async()=>new Api.User({id:999n as any,firstName:'Self'}), getDialogs:async()=>entities.map(entity=>({entity,title:entity.title||entity.firstName})), getInputEntity:async(entity:any)=>entity, getEntity:async(input:string)=>input==='me'?new Api.User({id:999n as any,firstName:'Self'}):entities[0] };
}
function apiMessage(id:number, chat=42): any { return new Api.Message({id,peerId:new Api.PeerChannel({channelId:BigInt(chat) as any}),date:100,message:`fixture ${id}`}); }

test('message identity isolates duplicate IDs, FTS and same-second context', () => {
  for (const chat of [A,B]) for (const id of [4,5,6]) cache(chat,id);
  assert.equal(getDatabase().prepare('SELECT COUNT(*) n FROM messages').get() && getMessage(A,5)?.chatId,A);
  assert.deepEqual(getMessagesAround(A,5,1,1).map(m=>[m.chatId,m.id]),[[A,4],[A,5],[A,6]]);
  assert.equal(searchMessages('needle',{chatId:B}).results.length,3);
  assert.ok(searchMessages('needle',{chatId:B}).results.every(m=>m.chatId===B));
  assert.equal(getMessage(A,99),null);
});

test('reply chains stop cycles and external peer references', () => {
  cache(A,1,100,{replyToId:2}); cache(A,2,100,{replyToId:1}); cache(B,2);
  assert.equal(resolveReplyChain(A,1,10).length,2);
  cache(A,1,100,{replyToId:2,replyToPeerId:B});
  assert.equal(resolveReplyChain(A,1,10).length,1);
  assert.deepEqual(findMissingReplyTargets([getMessage(A,1)!]),[]);
});

test('cluster membership and rebuilding remain chat-qualified', () => {
  for(const chat of [A,B]) for(const id of [1,2,3]) cache(chat,id);
  buildClusters(A); buildClusters(B);
  const a = findClusterForMessage(A,2)!; const b = findClusterForMessage(B,2)!;
  assert.notEqual(a.id,b.id);
  assert.ok(getClusterMessages(a.id).every(m=>m.chat_id===A));
  getDatabase().pragma('foreign_keys=OFF');
  getDatabase().prepare('DELETE FROM messages WHERE chat_id=?').run(A);
  getDatabase().pragma('foreign_keys=ON');
  assert.equal(buildClusters(A),0);
  assert.equal(findClusterForMessage(A,2),null);
});

test('chat selection rejects duplicate titles and raw peer collisions, numeric titles never match IDs', () => {
  const peers=[{id:A,title:'Same'},{id:'42',title:'Same'},{id:'-42',title:'Numeric'},{id:B,title:'42'}];
  assert.throws(()=>selectPeer('Same',peers),/Ambiguous/);
  assert.throws(()=>selectPeer('42',peers),/Ambiguous/);
  assert.equal(selectPeer(A,peers)?.id,A);
  assert.equal(selectPeer('-42',peers)?.id,'-42');
  assert.equal(selectPeer('num',peers)?.id,'-42');
  assert.equal(selectPeer('123',peers),null);
  cache(A,1); cache(B,1,100,{chatTitle:'Alpha'});
  assert.throws(()=>resolveChatId('Alpha'),/Ambiguous/);
});

test('live resolver preserves peer kinds and resolves usernames and Saved Messages',async()=>{
  assert.equal(peerId(channel(42)),A);
  assert.equal(peerId(new Api.PeerChat({chatId:42n as any})),'-42');
  assert.equal(peerId(new Api.PeerUser({userId:42n as any})),'42');
  const client=fakeClient();
  assert.equal((await resolvePeer(client,'@fixture')).id,A);
  assert.equal((await resolvePeer(client,'me')).id,'999');
  await assert.rejects(resolvePeer(client,'Fixture'),/Ambiguous/);
});

test('strict ID and context validation rejects partial, negative and oversized values',()=>{
  for(const input of ['0','-1','1x','1.2','2147483648','']) assert.throws(()=>parseMessageId(input));
  for(const input of ['-1','101','2x','Infinity']) assert.throws(()=>parseContextCount(input));
  assert.equal(parseMessageId('2147483647'),2147483647); assert.equal(parseContextCount('0'),0);
});

for(const version of [0,2]) test(`legacy schema ${version} migration preserves rows and sync metadata with backup`,()=>{
  const path=join(fixture,'legacy.db'); const legacy=new Database(path);
  legacy.exec(`CREATE TABLE messages (${version===2?'msg_rowid INTEGER PRIMARY KEY,':' '}id INTEGER,chat_id TEXT,text TEXT); CREATE TABLE sync_state(chat_id TEXT PRIMARY KEY,last_message_id INTEGER); INSERT INTO messages(id,chat_id,text) VALUES (5,'42','preserve'); INSERT INTO sync_state VALUES ('42',5); PRAGMA user_version=${version}`);
  migrateDatabase(legacy,path);
  assert.equal((legacy.prepare('SELECT text FROM legacy_messages').get() as any).text,'preserve');
  assert.equal((legacy.prepare('SELECT last_message_id FROM legacy_sync_state').get() as any).last_message_id,5);
  assert.equal((legacy.prepare('SELECT count(*) n FROM messages').get() as any).n,0);
  assert.equal(legacy.pragma('user_version',{simple:true}),3);
  migrateDatabase(legacy,path);
  assert.equal(readdirSync(fixture).filter(p=>p.includes('before-v3')).length,1);
  legacy.close();
});

test('failed migration rolls back and future schemas fail without deletion',()=>{
  const path=join(fixture,'legacy.db');const legacy=new Database(path);
  legacy.exec('CREATE TABLE messages(id INTEGER PRIMARY KEY); INSERT INTO messages VALUES (5); CREATE TABLE cache_metadata(key TEXT)');
  assert.throws(()=>migrateDatabase(legacy,path));
  assert.equal((legacy.prepare('SELECT id FROM messages').get() as any).id,5);
  assert.equal(legacy.pragma('user_version',{simple:true}),0);
  legacy.pragma('user_version=99'); assert.throws(()=>migrateDatabase(legacy,path),/future/);
  assert.ok(existsSync(path)); legacy.close();
});

test('account binding fails closed and cache generation survives restart',()=>{
  const generation=getCacheGeneration();bindCacheAccount('1');assert.throws(()=>bindCacheAccount('2'),/account changed/);
  closeDatabase();assert.equal(getCacheGeneration(),generation);
});

test('embedding migration and unloaded-vector deletion preserve unrelated types',()=>{
  const vec=Array(768).fill(0);vec[0]=1;
  storeEmbedding({type:'jira_issue',id:'fixture',text:''},vec);
  const db=getEmbeddingsDb();
  db.prepare("INSERT INTO embeddings(content_type,content_id,embedding,model,created_at) VALUES ('message','old',?,'fixture',1)").run(Buffer.from(new Float32Array(vec).buffer));
  ensureTelegramEmbeddingGeneration();
  assert.equal((db.prepare("SELECT count(*) n FROM embeddings WHERE content_type='message'").get() as any).n,0);
  assert.equal((db.prepare("SELECT count(*) n FROM embeddings WHERE content_type='jira_issue'").get() as any).n,1);
  storeEmbedding({type:'message',id:`tg3:${getCacheGeneration()}:${A}:1`,text:''},vec);
  closeEmbeddingsDb(); deleteEmbeddings('message');
  const reopened=getEmbeddingsDb();
  assert.equal((reopened.prepare("SELECT count(*) n FROM vector_content_map WHERE content_type='message'").get() as any).n,0);
  assert.equal((reopened.prepare("SELECT count(*) n FROM embeddings WHERE content_type='jira_issue'").get() as any).n,1);
});

test('explicit context fetch uses only selected peer and correct before/after requests',async()=>{
  const client:any=fakeClient(); const requests:any[]=[];
  client.getMessages=async(entity:any,options:any)=>{requests.push({id:peerId(entity),options});return options.ids?[apiMessage(5)]:options.reverse?[apiMessage(6),apiMessage(8)]:[apiMessage(3)];};
  const service=new TelegramService({} as any);(service as any).client=client;
  const result=await service.getContextById(A,5,1,2);
  assert.deepEqual(result.map(m=>m.id).sort((a,b)=>a-b),[3,5,6,8]);
  assert.ok(requests.every(r=>r.id===A));
  assert.deepEqual(requests.slice(1).map(r=>r.options),[{offsetId:5,limit:1},{offsetId:5,reverse:true,limit:2}]);
  client.getMessages=async()=>[apiMessage(5,43)];await assert.rejects(service.getContextById(A,5,1,1),/different chat/);
  client.getMessages=async()=>[undefined];assert.deepEqual(await service.getContextById(A,5,1,1),[]);
});

test('media rejects wrong-peer and missing ID responses before download',async()=>{
  const client:any=fakeClient();client.getMessages=async()=>[apiMessage(5,43)];client.downloadMedia=async()=>{throw Error('must not download');};
  const service=new TelegramService({} as any);(service as any).client=client;
  await assert.rejects(service.getMediaInfo(A,5),/different chat/);
  await assert.rejects(service.downloadMedia(A,5),/different chat/);
  client.getMessages=async()=>[undefined];await assert.rejects(service.getMediaInfo(A,5),/not found/);
});

test('outbound methods route explicit peers without real sends',async()=>{
  const client:any=fakeClient(); const calls:any[]=[];
  client.sendMessage=async(peer:any,options:any)=>{calls.push([peerId(peer),options]);return {id:5};};
  client.editMessage=async(peer:any,options:any)=>{calls.push([peerId(peer),options]);};
  client.invoke=async(request:any)=>{calls.push([peerId(request.peer),request]);};
  const service=new TelegramService({} as any);(service as any).client=client;
  await service.sendMessage(A,'fixture',7);await service.editMessage(B,7,'fixture');await service.addReaction(A,7,'👍');await service.removeReaction(B,7);
  assert.deepEqual(calls.map(c=>c[0]),[A,B,A,B]);assert.equal(calls[0][1].replyTo,7);
});

test('a rich edit of a media message edits its caption with markdown instead of blanking it',async()=>{
  const client:any=fakeClient(); const calls:any[]=[];
  const withDocument=new Api.Message({id:7,peerId:new Api.PeerChannel({channelId:42n as any}),date:100,message:'old caption',
    media:new Api.MessageMediaDocument({document:new Api.DocumentEmpty({id:1n as any})})});
  client.getMessages=async()=>[withDocument];
  client.editMessage=async(peer:any,options:any)=>{calls.push(['caption',peerId(peer),options]);};
  client.invoke=async(request:any)=>{calls.push(['rich',request]);};
  const service=new TelegramService({} as any);(service as any).client=client;
  const result=await service.editRichMessage(A,7,'**New** caption');
  assert.deepEqual(result,{caption:true});
  assert.deepEqual(calls.map(c=>c[0]),['caption']);
  assert.equal(calls[0][2].message,7);
  assert.match(calls[0][2].text,/New/);
});

test('a rich edit of a text message still sends a rich message',async()=>{
  const client:any=fakeClient(); const calls:any[]=[];
  client.getMessages=async()=>[apiMessage(7)];
  client.editMessage=async()=>{calls.push('caption');};
  client.invoke=async(request:any)=>{calls.push(request.className??'rich');};
  const service=new TelegramService({} as any);(service as any).client=client;
  assert.deepEqual(await service.editRichMessage(A,7,'| a |\n|---|\n| 1 |'),{caption:false});
  assert.equal(calls.length,1);assert.notEqual(calls[0],'caption');
  client.getMessages=async()=>[undefined];
  await assert.rejects(service.editRichMessage(A,8,'x'),/not found/);
});

test('formatter never invents channel links for user/basic-group IDs and labels external replies',()=>{
  assert.equal(formatMessageLink(A,5),'https://t.me/c/42/5');
  assert.equal(formatMessageLink('42',5),'[chat:42] #5');
  assert.equal(formatMessageLink('-42',5),'[chat:-42] #5');
  const result=formatMessageCompact({id:5,chatId:A,sender:'Fixture',text:'hello',date:new Date(),replyToId:6,replyToChatId:B});
  assert.ok(result.includes('https://t.me/c/43/6'));
});

test('compiled CLI requires chat before DB access even for unique cached IDs; JSON remains parseable',()=>{
  const cli=resolve('dist/cli.js');
  const run=(args:string[])=>spawnSync(process.execPath,[cli,'telegram','read-around',...args],{env:process.env,encoding:'utf8'});
  const missing=run(['5','--json']);assert.notEqual(missing.status,0);assert.match(missing.stderr,/required option.*--chat/);assert.equal(existsSync(getDatabasePath()),false);
  const invalid=run(['5x','--chat',A]);assert.notEqual(invalid.status,0);assert.equal(existsSync(getDatabasePath()),false);
  cache(A,5);closeDatabase();const unique=run(['5']);assert.notEqual(unique.status,0);
  const okay=run(['5','--chat',A,'--json']);assert.equal(okay.status,0,okay.stderr);assert.equal(JSON.parse(okay.stdout).target.chatId,A);
  const wrong=run(['5','--chat',B,'--json']);assert.notEqual(wrong.status,0);assert.equal(wrong.stdout,'');
});

test('realistic v2 migration backs up FTS, clusters, media, replies and metadata without loss',()=>{
  cache(A,1,100,{replyToId:2,hasMedia:true,mediaType:'photo',reactions:[{emoji:'👍',count:2}],entities:[{type:'textUrl',offset:0,length:6,url:'https://example.com'}]});
  cache(A,2); cache(A,3); buildClusters(A);
  const path=getDatabasePath();closeDatabase();
  const legacy=new Database(path);
  legacy.exec("DROP TABLE cache_metadata; DROP TABLE peer_registry; ALTER TABLE messages DROP COLUMN reply_to_peer_id; UPDATE messages SET chat_id='42'; INSERT INTO sync_state(chat_id,last_message_id,oldest_message_id,message_count,last_sync_at) VALUES ('42',3,1,3,123); PRAGMA user_version=2");
  migrateDatabase(legacy,path);
  const preserved=legacy.prepare('SELECT * FROM legacy_messages WHERE id=1').get() as any;
  assert.equal(preserved.reply_to_id,2);assert.equal(preserved.has_media,1);assert.match(preserved.entities,/example.com/);assert.match(preserved.reactions,/👍/);
  assert.equal((legacy.prepare('SELECT message_count FROM legacy_sync_state').get() as any).message_count,3);
  const backupName=readdirSync(fixture).find(name=>name.includes('before-v3'))!;
  const backup=new Database(join(fixture,backupName),{readonly:true});
  assert.equal((backup.prepare('SELECT count(*) n FROM messages').get() as any).n,3);
  assert.equal((backup.prepare("SELECT count(*) n FROM messages_fts WHERE messages_fts MATCH 'needle'").get() as any).n,3);
  assert.ok((backup.prepare('SELECT count(*) n FROM clusters').get() as any).n>0);
  backup.close();legacy.close();
  cache(A,1);assert.equal(searchMessages('needle',{chatId:A}).results.length,1);
});

test('session changes preserve existing cache and cannot reuse its identities',()=>{
  getDatabase();closeDatabase();
  process.env.TELEGRAM_API_ID='123';process.env.TELEGRAM_API_HASH='fixture';process.env.TELEGRAM_SESSION_STRING='fixture-other-session';
  assert.throws(()=>getDatabase(),/session changed/);
  delete process.env.TELEGRAM_API_ID;delete process.env.TELEGRAM_API_HASH;delete process.env.TELEGRAM_SESSION_STRING;
  assert.ok(getDatabase());
});

function useSession(value:string|null){
  closeDatabase();
  if(value===null){for(const k of ['TELEGRAM_API_ID','TELEGRAM_API_HASH','TELEGRAM_SESSION_STRING']) delete process.env[k];return;}
  process.env.TELEGRAM_API_ID='123';process.env.TELEGRAM_API_HASH='fixture';process.env.TELEGRAM_SESSION_STRING=value;
}
const storedSession=()=>(getDatabase().prepare("SELECT value FROM cache_metadata WHERE key='session'").get() as any).value;

test('a relogin to the same account keeps the cache once the live session confirms the account',async()=>{
  useSession('fixture-login-1');cache(A,1);bindCacheAccount('999');const before=storedSession();
  useSession('fixture-login-2');
  assert.throws(()=>getDatabase(),/run any live command/);
  const client=fakeClient();rememberClientSession(client,'fixture-login-2');
  assert.equal((await resolvePeer(client,'me')).id,'999');
  const after=storedSession();
  assert.notEqual(after,before);
  assert.equal(getMessage(A,1)?.chatId,A);
  useSession('fixture-login-2');assert.equal(storedSession(),after);
});

test('a command that needs the cache before any chat (sync) unlocks it by verifying the account first',async()=>{
  useSession('fixture-login-1');cache(A,1);bindCacheAccount('999','fixture-login-1');
  useSession('fixture-login-2');
  // What sync used to do first, and why it stayed locked after a relogin (Codex review on PR 18).
  assert.throws(()=>getDatabase(),/run any live command/);
  const client=fakeClient();rememberClientSession(client,'fixture-login-2');
  await verifyCacheAccount(client);
  assert.equal(getMessage(A,1)?.chatId,A);
});

test('a different account on a new session is refused and leaves the binding untouched',()=>{
  useSession('fixture-login-1');cache(A,1);bindCacheAccount('999');const before=storedSession();
  useSession('fixture-other-account');
  assert.throws(()=>bindCacheAccount('1000','fixture-other-account'),/account changed/);
  assert.throws(()=>getDatabase(),/session changed/);
  useSession('fixture-login-1');assert.equal(storedSession(),before);
  assert.equal(getMessage(A,1)?.chatId,A);
});

test('a session change on a cache with no recorded account is still refused',()=>{
  useSession('fixture-login-1');cache(A,1);
  useSession('fixture-login-2');
  assert.throws(()=>bindCacheAccount('999','fixture-login-2'),/records no account/);
});

test('a relogin is accepted only for the session the verifying client was built from',async()=>{
  useSession('fixture-login-1');cache(A,1);bindCacheAccount('999','fixture-login-1');const before=storedSession();
  useSession('fixture-login-3');
  // The client connected with login-2, then the config moved on to login-3: its getMe proves login-2 only.
  const stale=fakeClient();rememberClientSession(stale,'fixture-login-2');
  await assert.rejects(resolvePeer(stale,'me'),/session changed/);
  // A client with no recorded session vouches for nothing.
  await assert.rejects(resolvePeer(fakeClient(),'me'),/session changed/);
  useSession('fixture-login-1');assert.equal(storedSession(),before);
});

test('failed vector extension load preserves rows and mappings for retry',()=>{
  const vec=Array(768).fill(0);vec[0]=1;
  storeEmbedding({type:'message',id:`tg3:${getCacheGeneration()}:${A}:1`,text:''},vec);
  const db=getEmbeddingsDb();
  const before=(db.prepare("SELECT count(*) n FROM vector_content_map WHERE content_type='message'").get() as any).n;
  assert.ok(before>0);
  assert.throws(()=>deleteEmbeddings('message',()=>false),/preserved for retry/);
  assert.equal((db.prepare("SELECT count(*) n FROM vector_content_map WHERE content_type='message'").get() as any).n,before);
  assert.equal((db.prepare("SELECT count(*) n FROM embeddings WHERE content_type='message'").get() as any).n,1);
  deleteEmbeddings('message');assert.equal((db.prepare("SELECT count(*) n FROM embeddings WHERE content_type='message'").get() as any).n,0);
});

test('legacy v1 sqlite-vec tables are backed up and removed only as derived indexes',()=>{
  const path=join(fixture,'v1vec.db');let legacy=new Database(path);sqliteVec.load(legacy);
  legacy.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY,chat_id TEXT,text TEXT); INSERT INTO messages VALUES (5,'42','preserve'); CREATE VIRTUAL TABLE message_vectors USING vec0(embedding FLOAT[768]); CREATE TABLE vector_map(vec_rowid INTEGER PRIMARY KEY,message_id INTEGER); CREATE TABLE message_embeddings(message_id INTEGER PRIMARY KEY,embedding BLOB)");
  legacy.close();legacy=new Database(path);
  migrateDatabase(legacy,path);
  assert.equal((legacy.prepare('SELECT text FROM legacy_messages').get() as any).text,'preserve');
  assert.equal(legacy.prepare("SELECT name FROM sqlite_master WHERE name='message_vectors'").get(),undefined);
  legacy.close();
});

test('verified user input peer survives a colliding channel in dialogs',async()=>{
  const user=new Api.User({id:42n as any,firstName:'Selected user',username:'fixtureuser'});
  const client:any=fakeClient([channel(42)]);
  client.getEntity=async()=>user;
  const requested:string[]=[];
  client.getMessages=async(entity:any,options:any)=>{
    requested.push(peerId(entity));
    return options.ids ? [new Api.Message({id:5,peerId:new Api.PeerUser({userId:42n as any}),date:100,message:'selected user'})] : [];
  };
  const service=new TelegramService({} as any);(service as any).client=client;
  const selected=await service.resolveChat('@fixtureuser');
  const messages=await service.getContextById(selected,5,1,1);
  assert.ok(requested.every(id=>id==='42'));assert.equal(messages[0].chatId,'42');assert.equal(messages[0].text,'selected user');
});

test('verified username transfer clears former ownership; ambiguous registry fails',()=>{
  rememberPeer(A,'Former','fixture');rememberPeer(B,'Current','fixture');
  assert.equal(resolveChatId('@FIXTURE'),B);
  assert.equal((getDatabase().prepare('SELECT username FROM peer_registry WHERE id=?').get(A) as any).username,null);
  getDatabase().prepare('UPDATE peer_registry SET username=? WHERE id=?').run('fixture',A);
  assert.throws(()=>resolveChatId('@fixture'),/Ambiguous/);
});

test('search and unread adapters retain canonical chat and external reply identity',()=>{
  cache(A,1,100,{replyToId:2,replyToPeerId:B});cache(A,2,100,{text:'wrong-local-preview'});
  const searched=searchResultToMessageData(getMessage(A,1)!);
  assert.equal(searched.chatId,A);assert.equal(searched.replyToChatId,B);assert.equal(searched.replyToText,undefined);
  const unread=unreadMessageData({id:1,chatId:A,date:new Date(),sender:'Fixture',text:'body',replyToId:2,replyToPeerId:B});
  assert.equal(unread.chatId,A);assert.equal(unread.replyToChatId,B);
  assert.match(formatMessageCompact(unread),/external chat; context not followed/);
});

test('download lookup failure has structured JSON and nonzero process exit',()=>{
  const script=`
    import {Command} from 'commander';
    import {TelegramService} from './dist/services/telegram.js';
    import {registerMediaCommands} from './dist/commands/telegram/media.js';
    TelegramService.prototype.connect=async function(){};
    TelegramService.prototype.disconnect=async function(){};
    TelegramService.prototype.resolveChat=async function(){return {id:'-1000000000042',title:'Fixture',inputEntity:{}}};
    TelegramService.prototype.downloadMedia=async function(){throw new Error('Message not found in selected peer')};
    const command=new Command();registerMediaCommands(command);
    await command.parseAsync(['download','5','--chat','-1000000000042','--json'],{from:'user'});
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,TELEGRAM_API_ID:'123',TELEGRAM_API_HASH:'fixture',TELEGRAM_SESSION_STRING:'fixture'}});
  assert.equal(result.status,1,result.stderr);assert.equal(JSON.parse(result.stdout).errors.length,1);
});

test('cached read sync progress stays off JSON stdout',()=>{
  const script=`
    import {Command} from 'commander';
    import './dist/services/telegram-schema.js';
    import {Api} from 'telegram';
    import {TelegramService} from './dist/services/telegram.js';
    import {registerTelegramCommands} from './dist/commands/telegram/index.js';
    const entity=new Api.Channel({id:42n,title:'Fixture',photo:new Api.ChatPhotoEmpty(),date:1,megagroup:true});
    const client={getMe:async()=>new Api.User({id:999n,firstName:'Self'}),getDialogs:async()=>[{entity,title:'Fixture'}],getInputEntity:async e=>e,getMessages:async()=>[]};
    TelegramService.prototype.connect=async function(){this.client=client};
    TelegramService.prototype.disconnect=async function(){};
    const command=new Command();registerTelegramCommands(command);
    await command.parseAsync(['telegram','read','--use-cache','--json','--','-1000000000042'],{from:'user'});
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,TELEGRAM_API_ID:'123',TELEGRAM_API_HASH:'fixture',TELEGRAM_SESSION_STRING:'fixture'}});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),[]);assert.match(result.stderr,/Syncing/);
});

test('Saved Messages context accepts the verified InputPeerSelf',async()=>{
  const client:any=fakeClient();
  client.getInputEntity=async()=>new Api.InputPeerSelf();
  client.getMessages=async(_entity:any,options:any)=>options.ids?[new Api.Message({id:5,peerId:new Api.PeerUser({userId:999n as any}),date:100,message:'saved'})]:[];
  const service=new TelegramService({} as any);(service as any).client=client;
  const selected=await service.resolveChat('me');assert.equal(selected.inputEntity.className,'InputPeerSelf');
  assert.equal((await service.getContextById(selected,5,1,1))[0].chatId,'999');
});

test('verified reply peer does not re-resolve a reassigned selector',async()=>{
  const client:any=fakeClient();let lookups=0;
  client.getEntity=async()=>{lookups++;return channel(lookups===1?42:43);};
  client.getMessages=async(entity:any)=>[apiMessage(7,peerId(entity)===A?42:43)];
  const service=new TelegramService({} as any);(service as any).client=client;
  const selected=await service.resolveChat('@changing');
  const reply=await service.getMessageById(selected,7);
  assert.equal(lookups,1);assert.equal(reply?.chatId,A);
});

test('live raw-ID lookup rejects a cached user/channel namespace collision',async()=>{
  cache('42',1);
  await assert.rejects(resolvePeer(fakeClient([channel(42)]),'42'),/Ambiguous/);
});

test('multi-file preflight failure preserves results and continues with later IDs',()=>{
  const script=`
    import {Command} from 'commander';
    import {TelegramService} from './dist/services/telegram.js';
    import {registerMediaCommands} from './dist/commands/telegram/media.js';
    TelegramService.prototype.connect=async function(){};
    TelegramService.prototype.disconnect=async function(){};
    TelegramService.prototype.resolveChat=async function(){return {id:'-1000000000042',title:'Fixture',inputEntity:{}}};
    TelegramService.prototype.getMediaInfo=async function(_peer,id){if(id===5)throw new Error('missing');return {extension:'.jpg'}};
    TelegramService.prototype.downloadMedia=async function(peer,id){return {chatId:peer.id,messageId:id,filepath:'fixture',filename:'fixture',type:'photo',size:1}};
    const command=new Command();registerMediaCommands(command);
    await command.parseAsync(['download','5,6','--chat','Fixture','--output','fixture','--json'],{from:'user'});
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,TELEGRAM_API_ID:'123',TELEGRAM_API_HASH:'fixture',TELEGRAM_SESSION_STRING:'fixture'}});
  assert.equal(result.status,1,result.stderr);const parsed=JSON.parse(result.stdout);
  assert.equal(parsed.errors[0].id,5);assert.equal(parsed.results[0].messageId,6);
});

test('empty cluster listing serializes an empty JSON array',()=>{
  const result=spawnSync(process.execPath,[resolve('dist/cli.js'),'telegram','clusters','--json'],{encoding:'utf8',env:process.env});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),[]);
});

test('on-demand cached reply retains link entities and reactions',()=>{
  const script=`
    import assert from 'node:assert/strict';
    import {Command} from 'commander';
    import './dist/services/telegram-schema.js';
    import {Api} from 'telegram';
    import {TelegramService} from './dist/services/telegram.js';
    import {upsertMessageFromApi,updateSyncState} from './dist/services/telegram-sync.js';
    import {getMessage} from './dist/services/telegram-search.js';
    import {registerTelegramCommands} from './dist/commands/telegram/index.js';
    const id='-1000000000042';
    upsertMessageFromApi({id:6,chatId:id,chatTitle:'Fixture',sender:'Fixture',text:'reply',date:100,replyToId:5,hasMedia:false,mediaType:null});
    updateSyncState(id,'Fixture',6,6,1);
    const entity=new Api.Channel({id:42n,title:'Fixture',photo:new Api.ChatPhotoEmpty(),date:1,megagroup:true});
    const reply=new Api.Message({id:5,peerId:new Api.PeerChannel({channelId:42n}),date:100,message:'Link',entities:[new Api.MessageEntityTextUrl({offset:0,length:4,url:'https://example.com/'})],reactions:new Api.MessageReactions({results:[new Api.ReactionCount({reaction:new Api.ReactionEmoji({emoticon:'👍'}),count:2})]})});
    const client={getMe:async()=>new Api.User({id:999n,firstName:'Self'}),getDialogs:async()=>[{entity,title:'Fixture'}],getInputEntity:async e=>e,getMessages:async()=>[reply]};
    TelegramService.prototype.connect=async function(){this.client=client};
    TelegramService.prototype.disconnect=async function(){};
    const command=new Command();registerTelegramCommands(command);
    await command.parseAsync(['telegram','read','--use-cache','--json','--',id],{from:'user'});
    const cached=getMessage(id,5);
    assert.equal(cached.entities[0].url,'https://example.com/');assert.deepEqual(cached.reactions,[{emoji:'👍',count:2}]);
  `;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,TELEGRAM_API_ID:'123',TELEGRAM_API_HASH:'fixture',TELEGRAM_SESSION_STRING:'fixture'}});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout)[0].replyToId,5);
});

test('single-chat, all-chat and empty cluster builds always serialize JSON arrays',()=>{
  const run=(args:string[])=>spawnSync(process.execPath,[resolve('dist/cli.js'),'telegram','clusters',...args,'--json'],{encoding:'utf8',env:process.env});
  const empty=run(['--build']);assert.equal(empty.status,0,empty.stderr);assert.deepEqual(JSON.parse(empty.stdout),[]);
  cache(A,1);cache(A,2);cache(A,3);
  getDatabase().prepare('INSERT INTO sync_state(chat_id,chat_title) VALUES (?,?)').run(A,'Fixture');
  closeDatabase();
  const single=run([`--build=${A}`]);assert.equal(single.status,0,single.stderr);assert.equal(JSON.parse(single.stdout)[0].chatId,A);assert.equal(JSON.parse(single.stdout)[0].chatTitle,'Fixture');
  const all=run(['--build']);assert.equal(all.status,0,all.stderr);assert.equal(JSON.parse(all.stdout)[0].clustersBuilt,1);assert.equal(JSON.parse(all.stdout)[0].chatTitle,JSON.parse(single.stdout)[0].chatTitle);
});

// --- md2 escaping -----------------------------------------------------------

test('placeholders survive the md2 parser', () => {
  // GramJS's md2 converts markdown to HTML and then HTML-parses it, so a literal
  // <placeholder> was read as a tag and dropped - silently breaking every
  // command example ever sent through this client.
  assert.equal(
    escapeForMarkdownV2('transcribe --tg <msgId> --chat <chat>'),
    'transcribe --tg &lt;msgId&gt; --chat &lt;chat&gt;',
  );
});

test('ampersands are escaped first, so entities are not double-escaped', () => {
  assert.equal(escapeForMarkdownV2('a & b < c'), 'a &amp; b &lt; c');
  assert.equal(escapeForMarkdownV2('&lt;'), '&amp;lt;', 'literal text, not a pre-made entity');
});

test('markdown markers are left alone', () => {
  // Escaping must not disturb the formatting the parser is there to apply.
  const markup = '__*Title*__ `code` [label](https://example.com) ~strike~';
  assert.equal(escapeForMarkdownV2(markup), markup);
});

test('code reaches the reader exactly as written, fenced or inline', async () => {
  // The md2 parser ran bold/underline/strike/spoiler over code too: two ~ on a
  // line vanished, and *.ts *.js lost its stars (2026-10-06).
  const { MarkdownV2Parser } = await import('telegram/extensions/markdownv2.js');
  const parse = (text: string) => MarkdownV2Parser.parse(escapeForMarkdownV2(text));
  const command = 'scp ~/.ssh/id ~/.kube/config host: && ls *.ts *.js __init__ ||x|| [l](u) a_b `q` npm --version --x';
  const [fenced, fencedEntities] = parse('Run:\n```\n' + command + '\n```\ndone');
  assert.equal(fenced, 'Run:\n\n' + command + '\n\ndone');
  assert.deepEqual(fencedEntities.map((e: any) => e.className), ['MessageEntityPre']);
  const [inline, inlineEntities] = parse('try `ls ~/a ~/b *.ts *.js` now');
  assert.equal(inline, 'try ls ~/a ~/b *.ts *.js now');
  assert.deepEqual(inlineEntities.map((e: any) => [e.className, e.offset, e.length]), [['MessageEntityCode', 4, 20]]);
  // The parser marks every fence before any inline code, so a fence inside what
  // looks like a code span is still a fence (Codex review).
  const [nested] = parse('`a ```*x* ~/p ~/q``` b`');
  assert.ok(nested.includes('*x* ~/p ~/q'), nested);
  // Upstream GramJS also has an -italic- rule (our postinstall disables it). Hyphens
  // in code are encoded anyway, so long options survive an unpatched install too.
  assert.equal(escapeForMarkdownV2('`npm --version`').replace(/-(.*?)-/g, '<i>$1</i>'), '`npm &#45;&#45;version`');
});

test('prose around code keeps its markdown', async () => {
  const { MarkdownV2Parser } = await import('telegram/extensions/markdownv2.js');
  const [text, entities] = MarkdownV2Parser.parse(escapeForMarkdownV2('*bold* then `a*b` and ~gone~ <x>'));
  assert.equal(text, 'bold then a*b and gone <x>');
  assert.deepEqual(entities.map((e: any) => e.className).sort(), ['MessageEntityBold', 'MessageEntityCode', 'MessageEntityStrike']);
});

test('plain prose is unchanged', () => {
  const prose = 'A sentence with a hyphen - a dot. And (parens).';
  assert.equal(escapeForMarkdownV2(prose), prose);
});
