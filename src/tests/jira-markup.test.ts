import test from 'node:test';
import assert from 'node:assert/strict';

import { markdownToJira, jiraToMarkdown } from '../utils/markdown-to-jira.js';

/**
 * Regression tests for PROJ-4329. Each case below is a shape that was observed in a filed
 * ticket, not a hypothetical: the converter reported success and stored, or displayed,
 * something other than what it was given.
 */

test('bold stays bold instead of being downgraded to italic', () => {
  // Jira bold is *x* and italic is _x_. The italic rule used to re-match the bold rule's
  // own output, so every bold in every filed ticket was stored as italic.
  assert.equal(markdownToJira('**plain bold**'), '*plain bold*');
  assert.equal(markdownToJira('text **bold here** more'), 'text *bold here* more');
  assert.equal(markdownToJira('- **bold at list start.** Rest.'), '* *bold at list start.* Rest.');
});

test('bold and italic remain distinguishable', () => {
  assert.equal(markdownToJira('**bold** and *italic* together'), '*bold* and _italic_ together');
});

test('an asterisk inside a bold span does not defeat the bold', () => {
  // A glob such as *.example.com inside the span left literal ** in Jira, because the
  // bold pattern could not cross an asterisk.
  assert.equal(
    markdownToJira('**Wildcard certs (`*.example.com`) for internal names**, so NEW'),
    '*Wildcard certs ({{*.example.com}}) for internal names*, so NEW',
  );
});

test('emphasis markers inside inline code are left alone in both directions', () => {
  const md = '`a_b_c` and `x*y*z`';
  const jira = markdownToJira(md);
  assert.equal(jira, '{{a_b_c}} and {{x*y*z}}');
  assert.equal(jiraToMarkdown(jira), md);
});

test('reading back a filename with underscores returns the filename', () => {
  // The defect that made `jira show` unusable as a verification step: the displayed
  // filename did not exist, while the stored one was correct all along.
  const stored = '{{20260616164918_create_suggested_edit_event_rpc.sql}}';
  assert.equal(jiraToMarkdown(stored), '`20260616164918_create_suggested_edit_event_rpc.sql`');
});

test('underscores inside a code block survive a read back', () => {
  const stored = '{code}\ndb/migrations/2026090710252253_protect_inspection_trigger.sql\n{code}';
  assert.match(jiraToMarkdown(stored), /2026090710252253_protect_inspection_trigger\.sql/);
});

test('a description containing code and emphasis round-trips', () => {
  const md = [
    '## Done when',
    '',
    '- **migration-version-check passing.** It deletes `20260616164918_create_x_rpc.sql`.',
    '- Verified *by result*, not by "the rollout succeeded".',
  ].join('\n');
  const back = jiraToMarkdown(markdownToJira(md));
  assert.match(back, /\*\*migration-version-check passing\.\*\*/);
  assert.match(back, /`20260616164918_create_x_rpc\.sql`/);
  assert.match(back, /\*by result\*/);
});

test('code fences still become Jira code blocks', () => {
  assert.equal(markdownToJira('```\nfoo_bar\n```'), '{code}\nfoo_bar\n{code}');
  assert.equal(markdownToJira('```sql\nselect 1\n```'), '{code:sql}\nselect 1\n{code}');
});

test('headings, lists, links and quotes are unaffected', () => {
  assert.equal(markdownToJira('## Problem'), 'h2. Problem');
  assert.equal(markdownToJira('1. first'), '# first');
  assert.equal(markdownToJira('[text](https://example.com)'), '[text|https://example.com]');
  assert.equal(markdownToJira('> quoted'), '{quote}\nquoted\n{quote}');
});

// ---------------------------------------------------------------------------
// Codex review of PR 8: whole-output assertions, so a leaked placeholder cannot hide behind a substring match
// ---------------------------------------------------------------------------

test('a Jira code block written inside inline code stays literal, and no placeholder leaks', () => {
  assert.equal(markdownToJira('see `{code}x{code}` here'), 'see {{{code}x{code}}} here');
  const back = jiraToMarkdown('see {{a_b}} and {code}\nx_y\n{code} end');
  assert.equal(back, 'see `a_b` and ```\nx_y\n``` end');
  for (const out of [markdownToJira('`{code}x{code}` **b** *i*'), jiraToMarkdown('{{{code}}} *b* _i_')]) {
    assert.doesNotMatch(out, /[\u0000\u0001-]/, `no sentinel may reach the output: ${JSON.stringify(out)}`);
  }
});

test('italic inside bold is converted, and bold stays bold', () => {
  assert.equal(markdownToJira('**bold *italic* text**'), '*bold _italic_ text*');
  assert.equal(markdownToJira('**bold** and *it*'), '*bold* and _it_');
});

test('an unprotected asterisk inside bold does not defeat it', () => {
  assert.equal(markdownToJira('**a*b**'), '*a*b*');
});

test('text containing NUL or other control characters is carried through unchanged', () => {
  const tricky = 'a \u00000\u0000 b \u00010\u0001 c';
  assert.equal(markdownToJira(tricky), tricky);
  assert.equal(jiraToMarkdown(tricky), tricky);
  assert.equal(markdownToJira('`x` \u00000\u0000'), '{{x}} \u00000\u0000');
});

test('a description survives a write and a read-back whole', () => {
  const md = '## Files\n- `20260616164918_create_suggested_edit_event_rpc.sql`\n- **bold** and *italic*';
  assert.equal(markdownToJira(md), 'h2. Files\n* {{20260616164918_create_suggested_edit_event_rpc.sql}}\n* *bold* and _italic_');
  assert.equal(
    jiraToMarkdown(markdownToJira(md)),
    '## Files\n- `20260616164918_create_suggested_edit_event_rpc.sql`\n- **bold** and *italic*',
  );
});

test("cross-service's reproductions: no content is lost, in either direction", () => {
  // Before: the write side gave {{<NUL>0<NUL>}} and the read side `<NUL>0<NUL>`: the x was gone.
  assert.equal(markdownToJira('`{code}x{code}`'), '{{{code}x{code}}}');
  assert.equal(jiraToMarkdown('{{{code}x{code}}}'), '`{code}x{code}`');
  // Before: a<NUL>0<NUL>b came back as "aundefinedb".
  assert.equal(markdownToJira('a\u00000\u0000b'), 'a\u00000\u0000b');
  assert.equal(jiraToMarkdown('a\u00000\u0000b'), 'a\u00000\u0000b');
});

test('a *** run is split between bold and italic by how they nest', () => {
  assert.equal(markdownToJira('**bold *italic***'), '*bold _italic_*');
  assert.equal(markdownToJira('***both***'), '*_both_*');
  assert.equal(markdownToJira('**a** and **b**'), '*a* and *b*');
  assert.equal(markdownToJira('*italic **bold***'), '_italic *bold*_');
  assert.equal(markdownToJira('***a** b*'), '_*a* b_');
  assert.equal(markdownToJira('***a* b**'), '*_a_ b*');
  assert.equal(markdownToJira('**a*b**'), '*a*b*');
});

test('URLs and snake_case identifiers are not emphasis', () => {
  assert.equal(markdownToJira('*See **[s](https://e.com/?q=*)***'), '_See *[s|https://e.com/?q=*]*_');
  assert.equal(markdownToJira('[a](https://x.io/~~a~~) and ~~gone~~'), '[a|https://x.io/~~a~~] and -gone-');
  assert.equal(markdownToJira('raw https://e.com/?a=*b* here'), 'raw https://e.com/?a=*b* here');
  assert.equal(markdownToJira('**See https://example.com**'), '*See https://example.com*');
  assert.equal(markdownToJira('**https://example.com**/health'), '*https://example.com*/health');
  assert.equal(markdownToJira('get https://ci.example/job/build/42/artifact/**/surefire-reports/*zip*/archive.zip now'), 'get https://ci.example/job/build/42/artifact/**/surefire-reports/*zip*/archive.zip now');
  assert.equal(markdownToJira('*see https://x.io/a_b*, then'), '_see https://x.io/a_b_, then');
  assert.equal(jiraToMarkdown('*See https://x.io/a_b* and _https://x.io/c_d_.'), '**See https://x.io/a_b** and *https://x.io/c_d*.');
  assert.equal(
    jiraToMarkdown('See [log|https://x.io/a_b_c/d_e] and _it_'),
    'See [log](https://x.io/a_b_c/d_e) and *it*',
  );
  assert.equal(jiraToMarkdown('raw https://x.io/a_b_c_d link'), 'raw https://x.io/a_b_c_d link');
  assert.equal(jiraToMarkdown('set user_id and group_id, _really_'), 'set user_id and group_id, *really*');
  assert.equal(jiraToMarkdown('_one line\nwrapped_ x'), '*one line\nwrapped* x');
  assert.equal(jiraToMarkdown('a _b\n\nc_ d'), 'a _b\n\nc_ d');
  assert.equal(jiraToMarkdown('covers _redaction of api_key from logs_ only'), 'covers *redaction of api_key from logs* only');
  assert.equal(markdownToJira('*one line\nwrapped* x'), '_one line\nwrapped_ x');
  assert.equal(markdownToJira('* one\n* two'), '* one\n* two');
  assert.equal(jiraToMarkdown('*Description:* text'), '**Description:** text');
  assert.equal(jiraToMarkdown('{code:hcl}\na = 1\n{code}'), '```hcl\na = 1\n```');
  assert.equal(jiraToMarkdown('* one\n* *two*'), '- one\n- **two**');
  const md = 'See [log](https://x.io/a_b_c/d_e?q=*x*) and *it*';
  assert.equal(jiraToMarkdown(markdownToJira(md)), md);
});

test('a bold span does not cross a paragraph break', () => {
  assert.equal(
    markdownToJira('Ignore **/*.test.ts for now.\n\nThen run the suite.\n\n**Result:** all green.'),
    'Ignore **/*.test.ts for now.\n\nThen run the suite.\n\n*Result:* all green.',
  );
  assert.equal(markdownToJira('**a\n\nb**'), '**a\n\nb**');
  assert.equal(markdownToJira('**one line\nwrapped** x'), '*one line\nwrapped* x');
});
