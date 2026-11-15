import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const blog = defineCollection({
  loader: glob({ base: "./src/content/blog", pattern: "*.md" }),
  schema: z.object({
    title: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    date: z.iso.date(),
    lang: z.enum(["en", "zh"]).default("en"),
  }).strict(),
});

export const collections = { blog };
