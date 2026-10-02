import { z } from 'zod';
import type { Project } from './types';
import { resolveDesign, resolveReferences } from './design';
import { STYLES, TOKEN_META } from './presets';
const id = z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9_-]+$/),
  hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const token = z.union([z.string().max(500), z.number().finite()]);
const tokens = z.record(z.string().max(100), token).superRefine((v, ctx) => {
  for (const [k, val] of Object.entries(v)) {
    if (
      k.startsWith('color.') &&
      typeof val === 'string' &&
      !/^#[0-9a-f]{6}$/i.test(val) &&
      !/^\{[\w.-]+\}$/.test(val)
    )
      ctx.addIssue({ code: 'custom', message: `색상 형식 오류: ${k}` });
    const meta = TOKEN_META[k];
    const alias = typeof val === 'string' && /^\{[\w.-]+\}$/.test(val);
    if (meta && !alias) {
      if (
        meta.type === 'number' &&
        (typeof val !== 'number' || val < (meta.min ?? -Infinity) || val > (meta.max ?? Infinity))
      )
        ctx.addIssue({ code: 'custom', message: `숫자 범위 오류: ${k}` });
      if (meta.type === 'font' && (typeof val !== 'string' || !val.trim() || /[;{}<>]/.test(val)))
        ctx.addIssue({ code: 'custom', message: `글꼴 이름 오류: ${k}` });
    }
    if (['__proto__', 'constructor', 'prototype'].includes(k))
      ctx.addIssue({ code: 'custom', message: '허용되지 않는 키' });
  }
});
const effectSettings = z
  .object({
    durationFrames: z.number().int().min(1).max(36000).optional(),
    intensity: z.number().min(0).max(2).optional(),
    direction: z.enum(['auto', 'left', 'right', 'up', 'down']).optional(),
    delayFrames: z.number().int().min(0).max(36000).optional(),
    easing: z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut']).optional(),
  })
  .strict();
const element = z
  .object({
    id,
    type: z.enum(['text', 'shape', 'image', 'chart', 'table', 'video']),
    x: z.number().finite().min(-10000).max(10000),
    y: z.number().finite().min(-10000).max(10000),
    w: z.number().positive().max(10000),
    h: z.number().positive().max(10000),
    text: z.string().max(100000).optional(),
    fontSize: z.number().min(1).max(1000).optional(),
    fontWeight: z.number().min(100).max(900).optional(),
    color: z.string().max(100).optional(),
    fill: z.string().max(100).optional(),
    opacity: z.number().min(0).max(1).optional(),
    rotation: z.number().finite().optional(),
    locked: z.boolean().optional(),
    group: z.string().max(100).optional(),
    assetId: id.optional(),
    alt: z.string().max(1000).optional(),
    shape: z.enum(['rect', 'ellipse', 'line']).optional(),
    chartData: z
      .object({
        labels: z.array(z.string()).max(1000),
        values: z.array(z.number().finite()).max(1000),
        type: z.enum(['bar', 'line', 'pie']).optional(),
      })
      .optional(),
    tableData: z
      .array(z.array(z.string().max(5000)).max(100))
      .max(1000)
      .optional(),
    keyframes: z
      .array(
        z.object({
          frame: z.number().int().min(0),
          property: z.enum(['x', 'y', 'opacity', 'rotation', 'scale', 'color']),
          value: z.union([z.number().finite(), z.string().max(100)]),
          easing: z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut']).optional(),
        }),
      )
      .max(1000)
      .optional(),
    effect: z.string().max(100).optional(),
    effectSettings: effectSettings.optional(),
    startFrame: z.number().int().min(0).optional(),
    endFrame: z.number().int().min(0).optional(),
  })
  .strict();
const asset = z
  .object({
    id,
    name: z.string().max(500),
    mime: z.string().max(100),
    hash: z.string().max(128),
    size: z.number().min(0),
    relativePath: z
      .string()
      .max(1000)
      .refine((v) => !v.includes('..') && !/^[\\/]|:/.test(v), '자산 경로가 올바르지 않습니다.'),
    width: z.number().optional(),
    height: z.number().optional(),
    duration: z.number().optional(),
    source: z.string().max(1000).optional(),
    license: z.string().max(1000).optional(),
  })
  .strict();
const style = z.object({
  id,
  name: z.string().max(100),
  english: z.string().max(100),
  description: z.string().max(1000),
  tags: z.array(z.string().max(100)),
  accent: hex,
  dark: tokens,
  light: tokens,
  custom: z.boolean().optional(),
});
export const ProjectSchema: z.ZodType<Project> = z
  .object({
    schemaVersion: z.literal(1),
    id,
    name: z.string().min(1).max(200),
    revision: z.number().int().min(0),
    updatedAt: z.string(),
    brand: z.object({
      name: z.string().max(200),
      color: hex,
      font: z.string().min(1).max(150),
      logoAssetId: id.optional(),
    }),
    styleId: id,
    mode: z.enum(['light', 'dark']),
    target: z.enum(['ppt', 'web', 'motion']),
    overrides: z.object({ light: tokens, dark: tokens }),
    accessibility: z.object({
      highContrast: z.boolean(),
      largeText: z.boolean(),
      reducedMotion: z.boolean(),
    }),
    view: z.object({
      depth: z.number().min(0).max(1),
      typeScale: z.number().min(0.5).max(2),
      decor: z.number().min(0).max(1.4),
    }),
    slideSize: z.object({
      width: z.number().min(100).max(4000),
      height: z.number().min(100).max(4000),
    }),
    slides: z
      .array(
        z.object({
          id,
          name: z.string().max(200),
          layout: z.string().max(100),
          hidden: z.boolean(),
          notes: z.string().max(100000),
          elements: z.array(element).max(500),
        }),
      )
      .max(500),
    webPages: z
      .array(
        z.object({
          id,
          name: z.string().max(200),
          kind: z.enum(['portfolio', 'landing', 'dashboard']),
          title: z.string().max(500),
          description: z.string().max(1000),
          sections: z
            .array(
              z.object({
                id,
                type: z.enum([
                  'hero',
                  'features',
                  'projects',
                  'about',
                  'stats',
                  'table',
                  'chart',
                  'faq',
                  'contact',
                  'pricing',
                ]),
                title: z.string().max(1000),
                body: z.string().max(50000),
                enabled: z.boolean(),
                columns: z.number().int().min(1).max(6),
                assetId: id.optional(),
                dataId: id.optional(),
                items: z.array(z.object({ title: z.string(), body: z.string() })).optional(),
                align: z.enum(['left', 'center']).optional(),
                padding: z.number().min(0).max(300).optional(),
                mobileColumns: z.number().int().min(1).max(3).optional(),
              }),
            )
            .max(100),
        }),
      )
      .max(100),
    motion: z.object({
      id,
      width: z.number().int().min(64).max(7680),
      height: z.number().int().min(64).max(7680),
      fps: z.number().int().min(1).max(60),
      seed: z.number(),
      audioAssetId: id.optional(),
      volume: z.number().min(0).max(2).optional(),
      audioTrimStartFrames: z.number().int().min(0).max(36000000).optional(),
      audioTrimEndFrames: z.number().int().min(1).max(36000000).optional(),
      audioFadeInFrames: z.number().int().min(0).max(36000).optional(),
      audioFadeOutFrames: z.number().int().min(0).max(36000).optional(),
      transparent: z.boolean().optional(),
      captions: z
        .array(
          z.object({
            start: z.number().min(0),
            end: z.number().min(0),
            text: z.string().max(5000),
          }),
        )
        .optional(),
      scenes: z
        .array(
          z.object({
            id,
            name: z.string().max(200),
            template: z.string().max(100),
            durationFrames: z.number().int().min(1).max(36000),
            effect: z.string().max(100),
            effectSettings: effectSettings.optional(),
            elements: z.array(element).max(200),
          }),
        )
        .min(1)
        .max(100),
    }),
    assets: z.array(asset).max(10000),
    datasets: z
      .array(
        z.object({
          id,
          name: z.string().max(200),
          columns: z.array(z.string()).max(500),
          rows: z.array(z.record(z.union([z.string(), z.number().finite(), z.null()]))).max(100000),
          source: z.enum(['file', 'api', 'sample']),
          updatedAt: z.string(),
          connection: z
            .object({
              url: z.string().url(),
              headers: z.record(z.string()).optional(),
              secretRef: z.string().optional(),
              responsePath: z.string().optional(),
            })
            .optional(),
          formats: z.record(z.enum(['text', 'number', 'percent', 'currency', 'date'])).optional(),
        }),
      )
      .max(100),
    favorites: z.array(z.string()).max(10000),
    customStyles: z.array(style).max(1000),
    collections: z
      .array(z.object({ id, name: z.string().max(200), styleIds: z.array(z.string()) }))
      .max(1000),
  })
  .strict()
  .superRefine((p, ctx) => {
    for (const mode of ['light', 'dark'] as const) {
      try {
        const d = resolveDesign(p as Project, p.target, mode);
        for (const [key, value] of Object.entries(d.tokens)) {
          const meta = TOKEN_META[key];
          if (meta?.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value)))
            throw new Error('숫자 타입의 별칭이 아닙니다: ' + key);
          if (
            meta?.type === 'color' &&
            (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))
          )
            throw new Error('색상 타입의 별칭이 아닙니다: ' + key);
        }
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          message: error instanceof Error ? error.message : String(error),
          path: ['overrides', mode],
        });
      }
    }
    if (![...STYLES, ...p.customStyles].some((s) => s.id === p.styleId))
      ctx.addIssue({ code: 'custom', message: '알 수 없는 스타일입니다.', path: ['styleId'] });
    const ids = new Set<string>();
    for (const doc of [...p.slides, ...p.webPages, ...p.motion.scenes]) {
      for (const node of 'elements' in doc ? doc.elements : doc.sections) {
        if (ids.has(node.id)) ctx.addIssue({ code: 'custom', message: '중복 요소 ID: ' + node.id });
        ids.add(node.id);
      }
    }
  });
