import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { indexVideo, probeVideo, readVideoRange } from './pipeline.ts'

function renderJson(value: unknown): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** Register the bounded probe, index, and range-reading tool surface. */
export function registerVideoTools(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'video_probe',
    description: 'Inspect a local video container or an online video page. Online probing retrieves metadata and caption availability without saving the media file.',
    timeoutMs: 120_000,
    parameters: {
      source: {
        type: 'string',
        required: true,
        description: 'Absolute local video path or public HTTP(S) video/page URL.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', required: true },
          sourceKind: { type: 'string', required: true, enum: ['local', 'online'] },
          title: { type: 'string', required: true },
          durationSeconds: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          videoCodec: { type: 'string' },
          audioCodec: { type: 'string' },
          uploader: { type: 'string' },
          webpageUrl: { type: 'string' },
          chapters: { type: 'integer', required: true },
          subtitleLanguages: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    execute: (args, exec) => probeVideo(ctx, args.source.trim(), exec.signal),
  }))

  ctx.tools.register(defineTool({
    name: 'video_index',
    description: 'Build or reuse a durable chapter index. Online mode can use a stable resumable private cache or refresh a direct stream without saving media.',
    timeoutMs: 2 * 60 * 60 * 1_000,
    parameters: {
      source: {
        type: 'string',
        required: true,
        description: 'Absolute local video path or public HTTP(S) video/page URL.',
      },
      online_mode: {
        type: 'string',
        enum: ['cache', 'stream'],
        description: 'Online only: cache (default) downloads resumably for stability; stream avoids saving media and reads sampled ranges from refreshed direct URLs.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          manifestPath: { type: 'string', required: true },
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          durationSeconds: { type: 'number', required: true },
          mediaPath: { type: 'string', required: true },
          sourceKind: { type: 'string', required: true, enum: ['local', 'online'] },
          onlineMode: { type: 'string', enum: ['cache', 'stream'] },
          chapters: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'integer', required: true },
                startSeconds: { type: 'number', required: true },
                endSeconds: { type: 'number', required: true },
                title: { type: 'string', required: true },
              },
            },
          },
          captionFiles: { type: 'array', required: true, items: { type: 'string' } },
          analysisMode: { type: 'string', required: true, enum: ['visual-and-captions', 'visual-only'] },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const indexed = await indexVideo(ctx, args.source.trim(), {
        ...(args.online_mode === undefined ? {} : { onlineMode: args.online_mode }),
      }, exec.signal)
      return {
        manifestPath: indexed.manifestPath,
        id: indexed.manifest.id,
        title: indexed.manifest.title,
        durationSeconds: indexed.manifest.durationSeconds,
        mediaPath: indexed.manifest.mediaPath,
        sourceKind: indexed.manifest.sourceKind,
        ...(indexed.manifest.onlineMode === undefined ? {} : { onlineMode: indexed.manifest.onlineMode }),
        chapters: indexed.manifest.chapters,
        captionFiles: indexed.manifest.captionFiles,
        analysisMode: indexed.manifest.captionFiles.length > 0 ? 'visual-and-captions' as const : 'visual-only' as const,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'video_read',
    description: 'Read one bounded chapter or time range from a video index. Returns timestamped local JPEG paths and matching text captions for visual inspection.',
    timeoutMs: 20 * 60 * 1_000,
    parameters: {
      manifest_path: { type: 'string', required: true, description: 'Absolute manifest path returned by video_index.' },
      chapter: { type: 'integer', description: 'Zero-based chapter index. Use this for long videos.' },
      start_seconds: { type: 'number', description: 'Optional explicit range start in seconds.' },
      end_seconds: { type: 'number', description: 'Optional explicit range end in seconds.' },
      max_frames: { type: 'integer', description: 'Frames to materialize, from 1 to 32. Defaults to 12.' },
      width: { type: 'integer', description: 'Maximum JPEG width, from 320 to 1920. Defaults to 960.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', required: true },
          startSeconds: { type: 'number', required: true },
          endSeconds: { type: 'number', required: true },
          frames: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                timestampSeconds: { type: 'number', required: true },
                path: { type: 'string', required: true },
              },
            },
          },
          captions: { type: 'string', required: true },
          captionSegments: { type: 'integer', required: true },
          captionsTruncated: { type: 'boolean', required: true },
          analysisMode: { type: 'string', required: true, enum: ['visual-and-captions', 'visual-only'] },
        },
      },
      render: (_args, value) => renderJson(value),
    },
    async execute(args, exec) {
      const maxFrames = args.max_frames ?? 12
      if (maxFrames < 1 || maxFrames > 32) throw new Error('max_frames must be between 1 and 32')
      const width = args.width ?? 960
      if (width < 320 || width > 1920) throw new Error('width must be between 320 and 1920')
      const result = await readVideoRange(ctx, args.manifest_path, {
        ...(args.chapter === undefined ? {} : { chapter: args.chapter }),
        ...(args.start_seconds === undefined ? {} : { startSeconds: args.start_seconds }),
        ...(args.end_seconds === undefined ? {} : { endSeconds: args.end_seconds }),
        maxFrames,
        width,
      }, exec.signal)
      return {
        title: result.manifest.title,
        startSeconds: result.startSeconds,
        endSeconds: result.endSeconds,
        frames: result.frames,
        captions: result.captions,
        captionSegments: result.captionSegments,
        captionsTruncated: result.captionsTruncated,
        analysisMode: result.analysisMode,
      }
    },
  }))
}
