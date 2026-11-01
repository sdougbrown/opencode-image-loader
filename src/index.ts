import type { Plugin as V1Plugin } from "@opencode-ai/plugin";
import type { Plugin } from "@opencode/plugin";
import { readFile, stat } from "fs/promises";
import { extname, resolve } from "path";
import { tool } from "@opencode-ai/plugin/tool";

const SUPPORTED: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
};

const imageTool = tool({
  description:
    "Loads an image file from disk and converts it to a base64 data URL. Use this when you need to 'see' an image file provided by the user.",
  args: {
    filePath: tool.schema
      .string()
      .describe("The absolute or relative path to the image file."),
  },
  async execute({ filePath }, ctx) {
    try {
      const absolutePath = resolve(ctx.directory, filePath);
      const stats = await stat(absolutePath);

      if (!stats.isFile()) {
        return {
          output: `Error: '${filePath}' is not a file.`,
        };
      }

      const buffer = await readFile(absolutePath);
      const ext = extname(absolutePath).toLowerCase();
      const mimeType = SUPPORTED[ext] || "application/octet-stream";

      if (!SUPPORTED[ext]) {
        return {
          output: `Error: Unsupported image extension '${ext}'. Supported: ${Object.keys(SUPPORTED).join(", ")}`,
        };
      }

      const base64 = buffer.toString("base64");
      const dataUrl = `data:${mimeType};base64,${base64}`;

      ctx.metadata({
        metadata: {
          mimeType,
          fileSize: stats.size,
          path: absolutePath,
        },
      });

      return {
        output: `Successfully converted '${filePath}' to base64.`,
        attachments: [
          {
            type: "file",
            mime: mimeType,
            url: dataUrl,
            filename: absolutePath.split("/").pop(),
          },
        ],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { output: `Error loading image: ${message}` };
    }
  },
});

type ToolResultLike = {
  output: string;
  title?: string;
  metadata?: Record<string, unknown>;
  attachments?: Array<{ type: string; mime: string; url: string; filename?: string }>;
};

type V2ToolResult = {
  content: string | Array<{ type: "text"; text: string } | { type: "file"; uri: string; mime: string; name?: string }>;
  metadata?: Record<string, unknown>;
};

/** Project the V1 tool result shape onto the V2 Tool.Result shape. */
export function toV2ToolResult(result: string | ToolResultLike): V2ToolResult {
  if (typeof result === "string") return { content: result };
  const content: NonNullable<V2ToolResult["content"]> = result.attachments?.length
    ? [
        { type: "text", text: result.output },
        ...result.attachments.map((attachment) => ({
          type: "file" as const,
          uri: attachment.url,
          mime: attachment.mime,
          ...(attachment.filename ? { name: attachment.filename } : {}),
        })),
      ]
    : result.output;
  return {
    content,
    metadata: {
      ...(result.metadata ?? {}),
      ...(result.title ? { title: result.title } : {}),
    },
  };
}

export const ImageLoaderPlugin: V1Plugin = async () => ({
  tool: {
    image_to_base64: imageTool,
  },
});

/**
 * The OpenCode 2 setup. Registers the same tool through the V2 tool transform;
 * the V1 tool context lacks `directory`, so the plugin location supplies it.
 */
export async function setupImageLoader(ctx: Plugin.Context): Promise<() => void> {
  const directory = ctx.location.directory;

  await ctx.tool.transform((editor) => {
    editor.add({
      name: "image_to_base64",
      description: imageTool.description,
      input: tool.schema.toJSONSchema(tool.schema.object(imageTool.args)),
      execute: async (rawInput, context) => {
        const input = rawInput as { filePath: string };
        const result = await imageTool.execute(input, {
          sessionID: context.sessionID,
          agent: context.agent,
          messageID: context.messageID,
          directory,
          worktree: directory,
          abort: context.signal,
          metadata: (update) => {
            void context.progress(update);
          },
          ask: () => {
            throw new Error("permission prompts are not supported in OpenCode 2 tool context");
          },
        });
        return toV2ToolResult(result);
      },
    });
  });

  return () => {};
}

function isMissingV2Package(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") return false;
  const message = "message" in error ? String(error.message) : "";
  return message.includes("@opencode/plugin");
}

/**
 * `@opencode/plugin` only exists on OpenCode 2 hosts, so the V2 definition is
 * contributed when that package resolves and skipped otherwise.
 */
async function v2Definition(): Promise<Partial<Plugin.Plugin>> {
  try {
    const { Plugin: v2 } = await import("@opencode/plugin");
    return v2.define({ id: "image-loader", setup: setupImageLoader });
  } catch (error) {
    if (!isMissingV2Package(error)) throw error;
    return {};
  }
}

/**
 * One entrypoint for both OpenCode generations: V2 reads `id` and `setup()`,
 * V1 (1.18.29+) calls `server()`.
 */
const v2 = await v2Definition();

export default {
  ...v2,
  async server(ctx: Parameters<typeof ImageLoaderPlugin>[0]) {
    return ImageLoaderPlugin(ctx);
  },
};
