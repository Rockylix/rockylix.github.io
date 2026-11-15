import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFile, link, lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseDocument, stringify } from 'yaml';

const postDirectory = 'src/content/blog';
const imageExtensions = new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.webp']);
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function ifPresent(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function inside(directory, target) {
  const relative = path.relative(directory, target);
  return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

async function vaultFile(vault, relative, kind) {
  const normalized = relative.replaceAll('\\', '/');
  if (!normalized || /[:\x00-\x1f]/u.test(normalized) || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(kind + ' must be a vault-relative path.');
  }
  const file = await realpath(path.resolve(vault, normalized));
  if (!inside(vault, file) || !(await stat(file)).isFile()) {
    throw new Error(kind + ' must resolve to a file inside the vault.');
  }
  return { file, relative: path.posix.normalize(normalized) };
}

async function destination(site, relative) {
  let current = site;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    const info = await ifPresent(() => lstat(current));
    if (info?.isSymbolicLink()) throw new Error('A site destination contains a symbolic link.');
  }
  return current;
}

function parsePost(source, label) {
  const boundary = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(source);
  if (!boundary) throw new Error(label + ' must start with YAML frontmatter.');
  const document = parseDocument(boundary[1]);
  if (document.errors.length || document.warnings.length) throw new Error(label + ' has invalid YAML frontmatter.');
  const data = document.toJS({ maxAliasCount: 0 });
  const { title, summary, slug, lang = 'en', date } = data ?? {};
  if (typeof title !== 'string' || !title.trim() || typeof summary !== 'string' || !summary.trim()) {
    throw new Error(label + ' needs a title and summary.');
  }
  if (typeof slug !== 'string' || !slugPattern.test(slug)) throw new Error(label + ' needs a lowercase ASCII slug.');
  if (lang !== 'en' && lang !== 'zh') throw new Error(label + " language must be 'en' or 'zh'.");
  return { title: title.trim(), summary: summary.trim(), slug, lang, date, body: source.slice(boundary[0].length) };
}

function checkedDate(date) {
  const value = new Date(date + 'T00:00:00Z');
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
      Number.isNaN(value.valueOf()) || value.toISOString().slice(0, 10) !== date) {
    throw new Error('Date must be a valid calendar date in YYYY-MM-DD format.');
  }
  return date;
}

function currentDate() {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format();
}

function labelText(value) {
  return value.replace(/[\\[\]*_]/gu, '\\$&');
}

function articleKey(value) {
  return path.posix.basename(value.replaceAll('\\', '/').split('#')[0])
    .replace(/\.md$/iu, '').normalize('NFC').trim().toLowerCase();
}

async function publishedRoutes(site) {
  const directory = await destination(site, postDirectory);
  const entries = await ifPresent(() => readdir(directory, { withFileTypes: true })) ?? [];
  const posts = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    posts.push(parsePost(await readFile(path.join(directory, entry.name), 'utf8'), entry.name));
  }
  return posts;
}

function publicPostUrl(reference, published) {
  const key = articleKey(reference);
  const bySlug = published.find((post) => post.slug === key);
  const byTitle = published.filter((post) => articleKey(post.title) === key);
  const post = bySlug ?? (byTitle.length === 1 ? byTitle[0] : undefined);
  return post && '/blog/' + post.slug + '/';
}

function publicLink(url, published) {
  if (/^(https?:\/\/|mailto:|#)/iu.test(url)) return url;
  if (published.some((post) => url === '/blog/' + post.slug + '/')) return url;
  if (url === '/' || url === '/blog/') return url;
  return undefined;
}

function decodePath(value) {
  try {
    return decodeURIComponent(value).replaceAll('\\', '/');
  } catch {
    throw new Error('A linked path has invalid percent encoding.');
  }
}

function rewriteBody(body, title, note, published, approvedImages) {
  const pendingImages = new Map();
  const replacements = [];
  const definitions = new Map();
  const tree = fromMarkdown(body);

  function visit(node, callback) {
    if (callback(node) !== false) node.children?.forEach((child) => visit(child, callback));
  }

  function replace(node, value) {
    replacements.push({ start: node.position.start.offset, end: node.position.end.offset, value });
  }

  function textContent(node) {
    return node.value ?? node.alt ?? node.children?.map(textContent).join('') ?? '';
  }

  function imageMarkup(reference, label, wiki) {
    if (/^https?:\/\//iu.test(reference) && !wiki) {
      return '![' + labelText(label) + '](<' + reference + '>)';
    }
    const decoded = decodePath(reference);
    const relative = decoded.replace(/^\/+/u, '');
    const nextToNote = path.posix.normalize(path.posix.join(path.posix.dirname(note), relative));
    const direct = decoded.startsWith('/') ? approvedImages.get(relative) :
      approvedImages.get(nextToNote) ?? approvedImages.get(relative);
    const matches = wiki && !relative.includes('/') ?
      [...approvedImages.values()].filter((image) => path.posix.basename(image.relative) === relative) : [];
    const image = direct ?? (matches.length === 1 ? matches[0] : undefined);
    if (!image) throw new Error('A local image is missing or ambiguous. Supply its vault-relative path with --asset.');
    pendingImages.set(image.output, image);
    return '![' + labelText(label) + '](/' + image.output.replace(/^public\//u, '') + ')';
  }

  function rewriteText(node) {
    const raw = body.slice(node.position.start.offset, node.position.end.offset);
    if (raw.includes('%%')) throw new Error('Resolve hidden Obsidian comments before exporting.');
    const converted = raw.replace(/(?<!\\)(!)?\[\[([^\]\r\n]+)\]\]/gu, (_, embedded, value) => {
      const separator = value.indexOf('|');
      const reference = (separator === -1 ? value : value.slice(0, separator)).trim();
      const alias = separator === -1 ? '' : value.slice(separator + 1).trim();
      const extension = path.posix.extname(reference).toLowerCase();
      if (embedded && imageExtensions.has(extension)) {
        const alt = alias && !/^\d+(?:x\d+)?$/u.test(alias) ? alias : 'Figure';
        return imageMarkup(reference, alt, true);
      }
      if (embedded && extension && extension !== '.md') {
        throw new Error('An embedded file is not a supported image.');
      }
      const [target, heading] = reference.replaceAll('\\', '/').split('#', 2);
      const basename = path.posix.basename(target).replace(/\.md$/iu, '');
      const label = labelText(alias || [basename, heading].filter(Boolean).join(' › '));
      const url = publicPostUrl(reference, published);
      return url ? '[' + label + '](' + url + ')' : label;
    });
    if (raw !== converted) replace(node, converted);
  }

  visit(tree, (node) => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  });
  const first = tree.children[0];
  visit(tree, (node) => {
    if (node === first && node.type === 'heading' && node.depth === 1 && textContent(node) === title) {
      replace(node, '');
      return false;
    }
    if (node.type === 'html') throw new Error('Remove raw HTML and HTML comments before exporting.');
    if (node.type === 'text') rewriteText(node);
    if (node.type === 'image' || node.type === 'imageReference') {
      const url = node.url ?? definitions.get(node.identifier);
      if (!url) throw new Error('An image reference has no destination.');
      if (!/^https?:\/\//iu.test(url)) replace(node, imageMarkup(url, node.alt ?? 'Figure', false));
      return false;
    }
    if (node.type === 'link' || node.type === 'linkReference') {
      const url = node.url ?? definitions.get(node.identifier);
      if (/^(?:obsidian|file):/iu.test(url ?? '')) throw new Error('Remove private file or Obsidian URLs before exporting.');
      if (url && publicLink(url, published)) return;
      const label = textContent(node) || 'Related note';
      const route = publicPostUrl(decodePath(url ?? ''), published);
      replace(node, route ? '[' + labelText(label) + '](' + route + ')' : labelText(label));
      return false;
    }
    if (node.type === 'definition' && !publicLink(node.url, published)) replace(node, '');
  });

  let markdown = body;
  for (const { start, end, value } of replacements.sort((a, b) => b.start - a.start)) {
    markdown = markdown.slice(0, start) + value + markdown.slice(end);
  }
  visit(fromMarkdown(markdown), (node) => {
    if (node.type !== 'text') return;
    const raw = markdown.slice(node.position.start.offset, node.position.end.offset);
    if (/(?<!\\)\[\[/u.test(raw)) throw new Error('Use plain text inside each Obsidian link before exporting.');
  });
  return { markdown: markdown.trim(), images: [...pendingImages.values()] };
}

function checkPublicText(text) {
  if (/(?:\b(?:file|obsidian):\/\/|\b[a-z]:[\\/](?![\\/])|\\\\[\w.-]+\\[\w.-]+|(?<![\w./:-])\/(?:Users|home)\/[^/\s]+\/)/iu.test(text)) {
    throw new Error('The exported text contains a local path.');
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}/u.test(text)) {
    throw new Error('The exported text contains a credential-like value.');
  }
}

async function writePublicationFile(target, content, replaceExisting = false) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    if (replaceExisting) {
      await rename(temporary, target);
    } else {
      try {
        await link(temporary, target);
      } catch (error) {
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error;
        await copyFile(temporary, target, constants.COPYFILE_EXCL);
      }
    }
  } finally {
    await ifPresent(() => unlink(temporary));
  }
}

async function publishFiles(site, postFile, previous, content, images) {
  for (const image of images) {
    const target = await destination(site, image.output);
    const existing = await ifPresent(() => readFile(target));
    if (existing?.equals(image.data)) continue;
    try {
      await writePublicationFile(target, image.data);
    } catch (error) {
      if (error.code !== 'EEXIST' || !(await readFile(target)).equals(image.data)) throw error;
    }
  }
  if (await ifPresent(() => readFile(postFile, 'utf8')) !== previous) {
    throw new Error('The destination changed during export. Review it and retry.');
  }
  if (previous !== content) await writePublicationFile(postFile, content, previous !== undefined);
}

export async function exportPost(options) {
  if (!options.vault || !options.note) throw new Error('Supply --vault and --note.');
  const site = await realpath(options.site);
  const vault = await realpath(options.vault);
  const source = await vaultFile(vault, options.note, 'Note');
  if (path.extname(source.relative).toLowerCase() !== '.md') throw new Error('Only Markdown notes are supported.');
  const { title, summary, slug, lang, body } = parsePost(await readFile(source.file, 'utf8'), 'The note');

  const output = postDirectory + '/' + slug + '.md';
  const postFile = await destination(site, output);
  const previous = await ifPresent(() => readFile(postFile, 'utf8'));
  if (previous !== undefined && !options.update) throw new Error('The slug already exists. Review the destination and use --update.');
  if (previous === undefined && options.update) throw new Error('There is no existing post to update at this slug.');
  const firstDate = previous !== undefined ? checkedDate(parsePost(previous, 'The existing post').date) : undefined;
  const proposedDate = options.date === undefined ? undefined : checkedDate(options.date);
  if (firstDate && proposedDate && firstDate !== proposedDate) throw new Error('Updates preserve the first publication date.');
  const date = firstDate ?? proposedDate ?? checkedDate(currentDate());

  const approvedImages = new Map();
  for (const reference of options.asset ?? []) {
    const image = await vaultFile(vault, reference, 'Image');
    const extension = path.extname(image.file).toLowerCase();
    if (!imageExtensions.has(extension)) throw new Error('Approved attachments must be supported raster images.');
    const data = await readFile(image.file);
    const digest = createHash('sha256').update(data).digest('hex').slice(0, 20);
    image.output = 'public/blog-assets/' + slug + '/' + digest + extension;
    image.data = data;
    approvedImages.set(image.relative, image);
  }

  const published = await publishedRoutes(site);
  const { markdown, images } = rewriteBody(body, title, source.relative, published, approvedImages);
  if (!markdown) throw new Error('The note has no article body to export.');
  checkPublicText(title + '\n' + summary + '\n' + markdown);
  const frontmatter = stringify({ title, summary, slug, lang, date }, {
    defaultStringType: 'QUOTE_DOUBLE',
    defaultKeyType: 'PLAIN',
    lineWidth: 0,
  });
  const content = '---\n' + frontmatter + '---\n\n' + markdown + '\n';
  if (options.apply) await publishFiles(site, postFile, previous, content, images);
  return { applied: Boolean(options.apply), action: previous === undefined ? 'create' : 'update', output, date,
    images: images.map((image) => image.output) };
}

const script = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  try {
    const { values } = parseArgs({
      options: {
        vault: { type: 'string' },
        note: { type: 'string' },
        asset: { type: 'string', multiple: true },
        date: { type: 'string' },
        apply: { type: 'boolean' },
        update: { type: 'boolean' },
      },
    });
    const result = await exportPost({ ...values, site: path.resolve(path.dirname(script), '..') });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
