import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { exportPost } from '../scripts/export-post.mjs';

async function fixture(t, body) {
  const temporaryRoot = await realpath(os.tmpdir());
  const temporary = await mkdtemp(path.join(temporaryRoot, 'blog-export-'));
  t.after(async () => {
    const resolved = await realpath(temporary);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.equal(resolved, temporary);
    await rm(resolved, { recursive: true, force: true });
  });
  const vault = path.join(temporary, 'vault');
  const site = path.join(temporary, 'site');
  const note = 'Learning/sample.md';
  await mkdir(path.join(vault, 'Learning', 'attachments'), { recursive: true });
  await mkdir(site);
  const writeNote = (content) => writeFile(path.join(vault, note), [
    '---',
    'title: Sample article',
    'summary: A synthetic fixture.',
    'slug: sample-article',
    'lang: zh',
    'private_property: discarded',
    '---',
    content,
  ].join('\n'));
  await writeNote(body);
  return { vault, site, note, writeNote };
}

test('dry run and confirmed export preserve only public metadata and stable URLs', async (t) => {
  const sample = await fixture(t, [
    '# Sample article',
    '',
    'See [[A public article]], [[some-private-folder/local-only|private label]], and [the docs](https://example.org/docs).',
    '',
    '~~~md',
    '[[This is literal code]]',
    '~~~',
  ].join('\n'));
  const blog = path.join(sample.site, 'src', 'content', 'blog');
  await mkdir(blog, { recursive: true });
  await writeFile(path.join(blog, 'public-article.md'), [
    '---', 'title: A public article', 'summary: Another fixture', 'slug: public-article',
    'lang: en', 'date: "2026-11-09"', '---', 'A public fixture.', '',
  ].join('\n'));
  const args = { ...sample, date: '2026-11-15' };
  const dry = await exportPost(args);
  assert.equal(dry.applied, false);
  assert.equal(dry.action, 'create');
  assert.deepEqual(await readdir(blog), ['public-article.md']);
  const created = await exportPost({ ...args, apply: true });
  const output = path.join(sample.site, created.output);
  const before = await readFile(output, 'utf8');
  assert.match(before, /date: "2026-11-15"/u);
  assert.match(before, /\[A public article\]\(\/blog\/public-article\/\)/u);
  assert.match(before, /private label/u);
  assert.match(before, /\[the docs\]\(https:\/\/example.org\/docs\)/u);
  assert.match(before, /\[\[This is literal code\]\]/u);
  assert.doesNotMatch(before, /private_property|some-private-folder|^# Sample article/mu);

  await sample.writeNote('A revised article.');
  await assert.rejects(exportPost({ ...sample, apply: true }), /use --update/u);
  await assert.rejects(exportPost({ ...sample, update: true, apply: true, date: '2026-11-16' }), /first publication date/u);
  assert.equal(await readFile(output, 'utf8'), before);
  const updated = await exportPost({ ...sample, update: true, apply: true });
  assert.equal(updated.output, created.output);
  assert.equal(updated.date, created.date);
  assert.match(await readFile(output, 'utf8'), /A revised article\./u);
});

test('only explicitly approved and referenced images are exported', async (t) => {
  const sample = await fixture(t, [
    '![[synthetic.png|A figure]]',
    '[![Figure](attachments/synthetic.png)](https://example.org/)',
  ].join('\n\n'));
  const paths = ['Learning/attachments/synthetic.png', 'Learning/attachments/unreferenced.png'];
  const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDv0AAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(sample.vault, paths[0]), data);
  await writeFile(path.join(sample.vault, paths[1]), data);
  await assert.rejects(exportPost({ ...sample, apply: true }), /local image is missing/u);
  assert.deepEqual(await readdir(sample.site), []);
  const result = await exportPost({ ...sample, asset: paths, apply: true });
  assert.equal(result.images.length, 1);
  const image = path.join(sample.site, result.images[0]);
  assert.deepEqual(await readFile(image), data);
  const output = await readFile(path.join(sample.site, result.output), 'utf8');
  const assetUrl = '/' + result.images[0].replace('public/', '');
  assert.ok(output.includes('![A figure](' + assetUrl + ')'));
  assert.ok(output.includes('[![Figure](' + assetUrl + ')](https://example.org/)'));
  assert.doesNotMatch(output, /attachments\/|synthetic\.png/u);
});

test('refuses private paths, hidden content, and traversal before creating files', async (t) => {
  const sample = await fixture(t, 'A working copy at C:\\Users\\sample\\notes.md.');
  await assert.rejects(exportPost({ ...sample, apply: true }), /contains a local path/u);
  await assert.rejects(exportPost({ ...sample, note: '../sample.md', apply: true }), /vault-relative path/u);
  await sample.writeNote('Visible. %%Private copy.%%');
  await assert.rejects(exportPost({ ...sample, apply: true }), /hidden Obsidian comments/u);
  await sample.writeNote('Visible.\n\n<!-- Hidden comment. -->');
  await assert.rejects(exportPost({ ...sample, apply: true }), /raw HTML/u);
  await sample.writeNote('![[hidden.png|*formatted alt text*]]');
  await assert.rejects(exportPost({ ...sample, apply: true }), /Use plain text inside each Obsidian link/u);
  assert.deepEqual(await readdir(sample.site), []);
});
