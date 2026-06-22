import type { Plugin } from "@opencode-ai/plugin";
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
        mimeType,
        fileSize: stats.size,
        path: absolutePath,
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

export const ImageLoaderPlugin: Plugin = async () => ({
  tool: {
    image_to_base64: imageTool,
  },
});
