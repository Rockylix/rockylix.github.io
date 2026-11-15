import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://rockylix.github.io",
  trailingSlash: "always",
  markdown: {
    shikiConfig: { theme: "github-light" },
  },
});
