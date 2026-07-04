import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { getComponentData, getPage, glob, grep, list, navigate, search } from "superlore/mcp";
import { buildIndexFromSource } from "superlore/source";
import type { KKind } from "superlore";
import { source } from "@/lib/source";

// superlore's docs are public and MCP-enabled: the same structured content the site renders is
// exposed to agents here. No auth — this deploy is intentionally open. mcp-handler routes via the
// [transport] segment; with basePath "/api" the Streamable HTTP endpoint resolves to /api/mcp.

const DOCS_DIR = join(process.cwd(), "content", "docs");

/** Map a doc URL (`/docs/agents/mcp/tools`) to its source file (`…/tools.mdx` or `…/index.mdx`). */
function fileForUrl(url: string): string | null {
  const rel = url.replace(/^\/docs\/?/, "");
  const candidates = rel === "" ? ["index.mdx"] : [`${rel}.mdx`, `${rel}/index.mdx`];
  for (const candidate of candidates) {
    const abs = join(DOCS_DIR, candidate);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/** Drop the YAML frontmatter block so the body reads as clean MDX. */
function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw;
  const after = raw.indexOf("\n", end + 1);
  return after === -1 ? "" : raw.slice(after + 1);
}

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

// Deferred to first request (not built at module scope): if index-building or handler setup ever
// throws, module import still succeeds, so Next.js can route the request to our own error handler
// below instead of crashing to its generic, undiagnosable 500 page. On failure, cachedHandler stays
// unset so the next request retries rather than pinning a transient error for the instance's life.
let cachedHandler: ReturnType<typeof createMcpHandler> | undefined;

function getHandler() {
  if (cachedHandler) return cachedHandler;

  // Wire the raw MDX body into the index: get_page returns the literal authored source (components
  // and all), and grep matches the real text — not just the extracted prose.
  const index = buildIndexFromSource(source, {
    readContent: (url) => {
      const file = fileForUrl(url);
      return file ? stripFrontmatter(readFileSync(file, "utf8")).trim() : undefined;
    },
  });

  cachedHandler = createMcpHandler(
    (server) => {
      server.tool(
        "search",
        "Full-text search across the superlore documentation. Returns ranked page hits.",
        { query: z.string(), limit: z.number().int().positive().optional() },
        async ({ query, limit }) => json(search(index, query, limit)),
      );
      server.tool(
        "get_page",
        "Get a documentation page's full content by path (e.g. /docs/components) — frontmatter, the " +
          "readable MDX body, headings, and the typed knowledge nodes.",
        { path: z.string() },
        async ({ path }) => {
          const page = getPage(index, path);
          return page ? json(page) : json({ error: "not_found", path });
        },
      );
      server.tool(
        "grep",
        "Regex search across every page body, line by line (ripgrep-style). Returns { path, line, " +
          "text } hits — find anything in the docs the way you'd grep a folder.",
        {
          pattern: z.string(),
          flags: z.string().optional(),
          path: z.string().optional(),
          limit: z.number().int().positive().optional(),
        },
        async ({ pattern, flags, path, limit }) =>
          json(grep(index, pattern, { flags, path, limit })),
      );
      server.tool(
        "glob",
        "List documentation page paths matching a shell-style glob (e.g. /docs/agents plus two stars).",
        { pattern: z.string() },
        async ({ pattern }) => json(glob(index, pattern)),
      );
      server.tool(
        "list",
        "List knowledge nodes across the corpus, filtered by kind / tag / entityType.",
        {
          kind: z.string().optional(),
          tag: z.string().optional(),
          entityType: z.string().optional(),
        },
        async ({ kind, tag, entityType }) =>
          json(list(index, { kind: kind as KKind | undefined, tag, entityType })),
      );
      server.tool(
        "navigate",
        "Follow relations from a page path / node id / entity ref — returns outgoing refs + backlinks.",
        { target: z.string() },
        async ({ target }) => json(navigate(index, target)),
      );
      server.tool(
        "get_component_data",
        "Get the structured data behind a rendered component (its knowledge face) by id.",
        { id: z.string() },
        async ({ id }) => {
          const node = getComponentData(index, id);
          return node ? json(node) : json({ error: "not_found", id });
        },
      );
    },
    {},
    { basePath: "/api" },
  );
  return cachedHandler;
}

async function withErrorHandling(req: Request) {
  try {
    return await getHandler()(req);
  } catch (err) {
    console.error("[api/mcp] request failed:", err);
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Internal server error" }, id: null },
      { status: 500 },
    );
  }
}

export { withErrorHandling as GET, withErrorHandling as POST };
