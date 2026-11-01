import type { Plugin as V1Plugin } from "@opencode-ai/plugin";
import type { Plugin } from "@opencode/plugin";
import { readFile, stat } from "fs/promises";
import { extname, resolve } from "path";

const DESCRIPTION =
  "Loads an image file from disk and converts it to a base64 data URL. Use this when you need to 'see' an image file provided by the user.";
const FILE_PATH_DESCRIPTION = "The absolute or relative path to the image file.";

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

/** The parts of a tool context this tool reads, so both generations can supply one. */
type ExecuteContext = {
  readonly directory: string;
  metadata(input: { title?: string; metadata?: Record<string, unknown> }): void;
};

async function imageToBase64(
  { filePath }: { filePath: string },
  ctx: ExecuteContext,
): Promise<ToolResultLike> {
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
}

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

/**
 * The OpenCode 1 setup. `@opencode-ai/plugin` is only installed on OpenCode 1
 * hosts, so it is loaded here rather than at module scope.
 */
export const ImageLoaderPlugin: V1Plugin = async () => {
  const { tool } = await import("@opencode-ai/plugin/tool");
  return {
    tool: {
      image_to_base64: tool({
        description: DESCRIPTION,
        args: {
          filePath: tool.schema.string().describe(FILE_PATH_DESCRIPTION),
        },
        execute: (input, context) => imageToBase64(input, context),
      }),
    },
  };
};

/**
 * The OpenCode 2 setup. Registers the same tool through the V2 tool transform;
 * the V1 tool context lacks `directory`, so the plugin location supplies it.
 */
export async function setupImageLoader(ctx: Plugin.Context): Promise<() => void> {
  const directory = ctx.location.directory;

  await ctx.tool.transform((editor) => {
    editor.add({
      name: "image_to_base64",
      description: DESCRIPTION,
      input: {
        type: "object",
        properties: {
          filePath: { type: "string", description: FILE_PATH_DESCRIPTION },
        },
        required: ["filePath"],
        additionalProperties: false,
      },
      execute: async (rawInput, context) => {
        const result = await imageToBase64(rawInput as { filePath: string }, {
          directory,
          metadata: (update) => {
            void context.progress(update.metadata ?? {});
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
