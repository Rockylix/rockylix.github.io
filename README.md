# Xinling Xie

Personal website and blog at [rockylix.github.io](https://rockylix.github.io).

## Preview

Use Node 24 and npm.

```sh
npm ci
npm run dev
npm run build
npm run preview
npm run test:export
```

The home page defines the News entries. Posts are built from Markdown in `src/content/blog/`. A push to `main` builds and deploys the website through GitHub Pages.

## Publish a selected Obsidian post

Open a website checkout and tell Codex which note you want to publish or update. In the source note's Properties, set `title`, `summary`, a stable `slug` using lowercase letters, numbers and hyphens, and `lang` (`en` or `zh`). Use headings starting at level two in the body. Keep the same slug for later revisions.

```sh
node scripts/export-post.mjs --vault "<vault-directory>" --note "<relative-note.md>"
```

The command previews the export. Pass `--asset "<relative-image>"` for each local image selected for publication. Add `--apply` to write the approved export, and `--update` to replace the existing post at that slug. First publication defaults to today's date in Shanghai. You can set it explicitly with `--date YYYY-MM-DD`. Updates retain the original date.

Review the exported Markdown and approved images, run the build, then preview the article. Commit and push the reviewed changes when publishing. The source note stays in Obsidian.
