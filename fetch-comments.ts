import { Version2Client } from 'jira.js';
import { loadConfig } from './src/config/loader.js';

async function main() {
  const cfg = loadConfig();
  if (!cfg.jira) throw new Error('no jira cfg');
  const client = new Version2Client({
    host: cfg.jira.host.startsWith('http') ? cfg.jira.host : `https://${cfg.jira.host}`,
    authentication: { basic: { email: cfg.jira.email, apiToken: cfg.jira.apiToken } },
  });
  const keys = process.argv.slice(2);
  const out: any = {};
  for (const key of keys) {
    try {
      const res = await client.issueComments.getComments({ issueIdOrKey: key, orderBy: '-created', maxResults: 5 });
      out[key] = (res.comments || []).map((c: any) => ({
        author: c.author?.displayName,
        created: c.created,
        body: typeof c.body === 'string' ? c.body : JSON.stringify(c.body).slice(0, 3000),
      }));
    } catch (e: any) {
      out[key] = { error: e.message };
    }
  }
  console.log(JSON.stringify(out, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
