import { describe, it, expect } from 'vitest';
import {
  EFFECTS,
  computeEffect,
  evaluateElement,
  sampleKeyframes,
  visibleText,
  resizeSceneDuration,
} from '../src/motion/effects';
import { SCENE_TEMPLATES, makeScene, parseSrt } from '../src/motion/templates';
import { validateMotion, exportMotion, unpackRuntimePath } from '../src/motion/export';
import type { Project, StudioElement } from '../src/core/types';
import { audioClipFrames, audioVolumeAtFrame, rescaleMotionFps } from '../src/motion/audio';
import { fontFamilyForAsset, activeFontAsset } from '../src/motion/font';
import { ProjectSchema } from '../src/core/schema';

function project(): Project {
  return {
    schemaVersion: 1,
    id: 'motion-test',
    name: '모션 시험',
    revision: 7,
    updatedAt: '2026-10-02',
    brand: { name: 'Test', color: '#3b82f6', font: 'Malgun Gothic' },
    styleId: 'glass',
    mode: 'dark',
    target: 'motion',
    overrides: { light: {}, dark: {} },
    accessibility: { highContrast: false, largeText: false, reducedMotion: false },
    view: { depth: 0, typeScale: 1, decor: 1 },
    slides: [],
    slideSize: { width: 960, height: 540 },
    webPages: [],
    motion: {
      id: 'composition',
      width: 320,
      height: 180,
      fps: 24,
      seed: 42,
      scenes: [{ ...makeScene('title', 320, 180, 24), durationFrames: 12 }],
    },
    assets: [],
    datasets: [],
    favorites: [],
    customStyles: [],
    collections: [],
  };
}
const element: StudioElement = {
  id: 'layer',
  type: 'text',
  x: 10,
  y: 20,
  w: 200,
  h: 50,
  text: '가나다 한글',
  opacity: 0.8,
};

describe('frame deterministic motion', () => {
  it('has 24 unique effects in six complete categories', () => {
    expect(new Set(EFFECTS.map((e) => e.id)).size).toBe(24);
    expect(new Set(EFFECTS.map((e) => e.category)).size).toBe(6);
    for (const category of new Set(EFFECTS.map((e) => e.category)))
      expect(EFFECTS.filter((e) => e.category === category)).toHaveLength(4);
  });
  it('returns exactly the same frame values independent of evaluation order', () => {
    for (const effect of EFFECTS) {
      const a = computeEffect(effect.id, 35, 120, 24);
      computeEffect(effect.id, 80, 120, 24);
      computeEffect(effect.id, 0, 120, 24);
      expect(computeEffect(effect.id, 35, 120, 24)).toEqual(a);
      for (const value of Object.values(a))
        if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
    }
  });
  it('interpolates absolute position and opacity keys with destination easing', () => {
    const layer = {
      ...element,
      keyframes: [
        { frame: 0, property: 'x' as const, value: 0 },
        { frame: 10, property: 'x' as const, value: 100, easing: 'linear' as const },
        { frame: 0, property: 'opacity' as const, value: 0 },
        { frame: 10, property: 'opacity' as const, value: 1, easing: 'easeIn' as const },
      ],
    };
    expect(evaluateElement(layer, 5, 60).x).toBe(50);
    expect(evaluateElement(layer, 5, 60).opacity).toBeCloseTo(0.125);
  });
  it('handles unsorted, zero-width, and boundary keyframe intervals', () => {
    const keys = [
      { frame: 10, property: 'x' as const, value: 100 },
      { frame: 0, property: 'x' as const, value: 20 },
    ];
    expect(sampleKeyframes(keys, -5, 'x', 0)).toBe(20);
    expect(sampleKeyframes(keys, 99, 'x', 0)).toBe(100);
    expect(sampleKeyframes([], -1, 'x', 12)).toBe(12);
    expect(
      sampleKeyframes(
        [
          { frame: 0, property: 'x', value: 0 },
          { frame: 0, property: 'x', value: 20 },
        ],
        5,
        'x',
        0,
      ),
    ).toBe(20);
  });
  it('interpolates hexadecimal colors', () =>
    expect(
      sampleKeyframes(
        [
          { frame: 0, property: 'color', value: '#000' },
          { frame: 10, property: 'color', value: '#fff' },
        ],
        5,
        'color',
        '',
      ),
    ).toBe('#808080'));
  it('honors start and exclusive end frames', () => {
    const e = { ...element, startFrame: 12, endFrame: 24, effect: 'slide-up' };
    expect(evaluateElement(e, 11, 100).visible).toBe(false);
    expect(evaluateElement(e, 12, 100).visible).toBe(true);
    expect(evaluateElement(e, 24, 100).visible).toBe(false);
    expect(evaluateElement(e, 12, 100).y).toBe(68);
  });
  it('reduced motion preserves content and removes decorative movement', () => {
    const normal = evaluateElement({ ...element, effect: 'slide-up' }, 0, 100),
      reduced = evaluateElement({ ...element, effect: 'slide-up' }, 0, 100, 30, true);
    expect(normal.opacity).toBe(0);
    expect(reduced.opacity).toBe(0.8);
    expect(reduced.x).toBe(10);
    expect(reduced.y).toBe(20);
    expect(reduced.visibleProgress).toBe(1);
  });
  it('does not split emoji surrogate pairs when typing', () => {
    expect(visibleText('가😀나', 2 / 3)).toBe('가😀');
    expect(visibleText('가 나', 1, true)).toBe('가 나');
  });
  it('applies duration, delay, intensity, direction, and easing deterministically', () => {
    const settings = {
      durationFrames: 20,
      delayFrames: 10,
      intensity: 0.5,
      direction: 'left' as const,
      easing: 'linear' as const,
    };
    const fx = computeEffect('slide-up', 20, 90, 30, settings);
    expect(fx.x).toBeCloseTo(12);
    expect(fx.y).toBeCloseTo(0);
    expect(fx.opacity).toBeCloseTo(0.75);
    expect(computeEffect('slide-up', 20, 90, 30, settings)).toEqual(fx);
    expect(computeEffect('slide-up', 20, 90, 30, { intensity: 0 })).toEqual({});
    expect(computeEffect('pan-left', 5, 90, 30, { delayFrames: 10 })).toEqual({});
  });
  it('uses the configured period for loop effects', () => {
    expect(computeEffect('pulse', 15, 120, 30, { durationFrames: 60 }).scale).toBeCloseTo(1.035);
    expect(computeEffect('pulse', 45, 120, 30, { durationFrames: 60 }).scale).toBeCloseTo(0.965);
  });
});

describe('audio trim, fades, and font aliases', () => {
  it('uses the first ending source, explicit trim, or composition boundary', () => {
    const c = project().motion;
    c.audioTrimStartFrames = 24;
    c.audioTrimEndFrames = 72;
    expect(audioClipFrames(c, 100, 2)).toBe(24);
    expect(audioClipFrames(c, 100, 5)).toBe(48);
    expect(audioClipFrames(c, 12, 5)).toBe(12);
  });
  it('computes fades after source trim and reaches silence at the last frame', () => {
    const c = {
      ...project().motion,
      volume: 1,
      audioFadeInFrames: 6,
      audioFadeOutFrames: 6,
      audioTrimStartFrames: 12,
    };
    expect(audioVolumeAtFrame(c, 0, 24)).toBe(0);
    expect(audioVolumeAtFrame(c, 3, 24)).toBe(0.5);
    expect(audioVolumeAtFrame(c, 12, 24)).toBe(1);
    expect(audioVolumeAtFrame(c, 20, 24)).toBe(0.5);
    expect(audioVolumeAtFrame(c, 23, 24)).toBe(0);
    expect(audioVolumeAtFrame(c, 24, 24)).toBe(0);
  });
  it('preserves seconds for audio and effect settings across FPS changes', () => {
    const c = project().motion;
    c.audioTrimStartFrames = 12;
    c.audioTrimEndFrames = 48;
    c.audioFadeInFrames = 6;
    c.scenes[0].effectSettings = { durationFrames: 12, delayFrames: 6, intensity: 0.7 };
    c.scenes[0].elements[0].effectSettings = { durationFrames: 24 };
    const out = rescaleMotionFps(c, 48);
    expect(out.audioTrimStartFrames).toBe(24);
    expect(out.audioTrimEndFrames).toBe(96);
    expect(out.audioFadeInFrames).toBe(12);
    expect(out.scenes[0].effectSettings).toEqual({
      durationFrames: 24,
      delayFrames: 12,
      intensity: 0.7,
    });
    expect(out.scenes[0].elements[0].effectSettings?.durationFrames).toBe(48);
    expect(c.audioTrimStartFrames).toBe(12);
  });
  it('accepts optional settings without breaking older project documents', () => {
    const p = project();
    expect(ProjectSchema.safeParse(p).success).toBe(true);
    p.motion.audioFadeInFrames = 6;
    p.motion.audioTrimEndFrames = 48;
    p.motion.scenes[0].effectSettings = { intensity: 1.2, direction: 'up' };
    expect(ProjectSchema.safeParse(p).success).toBe(true);
    p.motion.scenes[0].effectSettings.intensity = 3;
    expect(ProjectSchema.safeParse(p).success).toBe(false);
  });
  it('matches server-compatible normalized font aliases', () => {
    const a = {
      id: 'font',
      name: '나의 폰트!.woff2',
      mime: 'font/woff2',
      hash: 'abcdef',
      size: 1,
      relativePath: 'font.woff2',
    };
    expect(fontFamilyForAsset(a)).toBe('나의 폰트');
    expect(activeFontAsset([a], '"나의 폰트", sans-serif')).toBe(a);
  });
});

describe('scene templates and captions', () => {
  it('creates all six templates at either aspect with independent IDs', () => {
    for (const template of SCENE_TEMPLATES) {
      for (const [w, h] of [
        [1920, 1080],
        [1080, 1920],
      ]) {
        const a = makeScene(template.id, w, h, 24),
          b = makeScene(template.id, w, h, 24);
        expect(a.durationFrames).toBe(120);
        expect(a.id).not.toBe(b.id);
        expect(a.elements.length).toBeGreaterThan(1);
        expect(
          a.elements.every((e) => e.w > 0 && e.h > 0 && Number.isFinite(e.x) && e.x + e.w <= w + 1),
        ).toBe(true);
      }
    }
  });
  it('parses BOM/CRLF, multiline Korean, and fractional seconds without HTML', () => {
    const rows = parseSrt(
      '\uFEFF1\r\n00:00:01,200 --> 00:00:03,400\r\n<b>안녕하세요</b>\r\n두 번째 줄\r\n\r\n2\r\n00:00:04.000 --> 00:00:05.000\r\n다음',
    );
    expect(rows).toEqual([
      { start: 1.2, end: 3.4, text: '안녕하세요\n두 번째 줄' },
      { start: 4, end: 5, text: '다음' },
    ]);
  });
  it('ignores malformed or reverse-time subtitle blocks', () =>
    expect(parseSrt('1\n00:00:03,000 --> 00:00:01,000\n역순\n\nbroken')).toEqual([]));
  it('shortens clips and preserves a usable last endpoint key without duplicates', () => {
    const scene = {
      ...makeScene('title'),
      durationFrames: 60,
      elements: [
        {
          ...element,
          startFrame: 40,
          endFrame: 60,
          keyframes: [
            { frame: 0, property: 'x' as const, value: 0 },
            { frame: 40, property: 'x' as const, value: 40 },
            { frame: 59, property: 'x' as const, value: 100 },
          ],
        },
      ],
    };
    const result = resizeSceneDuration(scene, 20);
    expect(result.durationFrames).toBe(20);
    expect(result.elements[0].startFrame).toBe(19);
    expect(result.elements[0].endFrame).toBe(20);
    expect(result.elements[0].keyframes).toEqual([
      { frame: 0, property: 'x', value: 0 },
      { frame: 19, property: 'x', value: 100 },
    ]);
    expect(scene.elements[0].endFrame).toBe(60);
  });
});

describe('motion export validation', () => {
  it('accepts a concrete composition', () => expect(() => validateMotion(project())).not.toThrow());
  it('rejects empty scenes and invalid frame counts', () => {
    const p = project();
    p.motion.scenes = [];
    expect(() => validateMotion(p)).toThrow('장면');
    p.motion.scenes = [{ ...makeScene('title'), durationFrames: 0 }];
    expect(() => validateMotion(p)).toThrow('길이');
  });
  it('rejects media placeholders instead of exporting fake media', () => {
    const p = project();
    p.motion.scenes[0].elements = [{ ...element, type: 'video' }];
    expect(() => validateMotion(p)).toThrow('영상 자산');
  });
  it('rejects transparent MP4 before launching a renderer', async () => {
    const p = project();
    p.motion.transparent = true;
    await expect(
      exportMotion(p, 'mp4', { outputDir: 'unused', assetsDir: 'unused' }),
    ).rejects.toThrow('투명 배경');
  });
  it('rejects odd H264 dimensions before launching a renderer', async () => {
    const p = project();
    p.motion.width = 319;
    await expect(
      exportMotion(p, 'mp4', { outputDir: 'unused', assetsDir: 'unused' }),
    ).rejects.toThrow('짝수');
  });
  it('rejects reversed layer/caption ranges and nonnumeric position keys', () => {
    const p = project();
    p.motion.scenes[0].elements = [{ ...element, startFrame: 10, endFrame: 5 }];
    expect(() => validateMotion(p)).toThrow('시작·종료');
    p.motion.scenes[0].elements = [
      { ...element, keyframes: [{ frame: 0, property: 'x', value: 'bad' }] },
    ];
    expect(() => validateMotion(p)).toThrow('키프레임 값');
    p.motion.scenes[0].elements = [element];
    p.motion.captions = [{ start: 4, end: 2, text: 'bad' }];
    expect(() => validateMotion(p)).toThrow('자막');
  });
  it('maps installed native binary paths out of asar without changing ordinary paths', () => {
    expect(unpackRuntimePath('C:\\App\\resources\\app.asar\\dist-remotion')).toBe(
      'C:\\App\\resources\\app.asar.unpacked\\dist-remotion',
    );
    expect(unpackRuntimePath('/work/design-studio/dist-remotion')).toBe(
      '/work/design-studio/dist-remotion',
    );
  });
});

// Opt in to a real browser/encoder smoke test; output remains under the workspace's work/.
it.skipIf(process.env.STUDIO_RENDER_TEST !== '1')(
  'renders a real MP4 with the exact saved duration and nonempty bytes',
  async () => {
    const { mkdir, readFile } = await import('node:fs/promises'),
      path = await import('node:path');
    const dir = path.resolve('../../work/motion-render-smoke');
    await mkdir(dir, { recursive: true });
    const p = project();
    p.brand.font = 'Pretendard';
    const result = await exportMotion(p, 'mp4', { outputDir: dir, assetsDir: dir });
    const file = result.files.find((f) => f.mime === 'video/mp4');
    expect(file).toBeDefined();
    const bytes = await readFile(file!.path);
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes.subarray(4, 8).toString()).toBe('ftyp');
    expect(result.manifest.durationFrames).toBe(12);
    expect(result.manifest.fps).toBe(24);
  },
  240000,
);

it.skipIf(process.env.STUDIO_AUDIO_PARAM_TEST !== '1')(
  'renders trimmed audio with real fades, uploaded font, master logo, and effect parameters',
  async () => {
    const { mkdir, writeFile, readFile, copyFile } = await import('node:fs/promises'),
      path = await import('node:path'),
      { spawnSync } = await import('node:child_process');
    const dir = path.resolve('../../work/motion-verification/audio-parameters');
    await mkdir(dir, { recursive: true });
    const wav = Buffer.alloc(44 + 32000);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(32000, 40);
    for (let i = 0; i < 16000; i++)
      wav.writeInt16LE(
        Math.round(Math.sin((i / 8000) * Math.PI * 2 * (i < 4000 ? 220 : 880)) * 10000),
        44 + i * 2,
      );
    await writeFile(path.join(dir, 'tone.wav'), wav);
    await writeFile(
      path.join(dir, 'logo.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="20" fill="#6d9fff"/><circle cx="40" cy="40" r="20" fill="white"/></svg>',
    );
    await copyFile('public/fonts/PretendardVariable.woff2', path.join(dir, 'font.woff2'));
    const p = project();
    p.id = 'audio-parameters';
    p.brand.font = 'Personal Studio';
    p.brand.logoAssetId = 'logo';
    p.motion.width = 640;
    p.motion.height = 360;
    p.motion.fps = 30;
    p.motion.audioAssetId = 'tone';
    p.motion.volume = 1;
    p.motion.audioTrimStartFrames = 15;
    p.motion.audioTrimEndFrames = 45;
    p.motion.audioFadeInFrames = 6;
    p.motion.audioFadeOutFrames = 6;
    p.motion.scenes = [{ ...makeScene('title', 640, 360, 30), durationFrames: 60 }];
    p.motion.scenes[0].elements[1].effectSettings = {
      durationFrames: 12,
      delayFrames: 6,
      intensity: 0.5,
      direction: 'left',
      easing: 'linear',
    };
    p.assets = [
      {
        id: 'tone',
        name: 'Tone.wav',
        mime: 'audio/wav',
        hash: 'test',
        size: wav.length,
        relativePath: 'tone.wav',
      },
      {
        id: 'font',
        name: 'Personal Studio.woff2',
        mime: 'font/woff2',
        hash: 'test-font',
        size: 1,
        relativePath: 'font.woff2',
      },
      {
        id: 'logo',
        name: 'Logo.svg',
        mime: 'image/svg+xml',
        hash: 'test-logo',
        size: 1,
        relativePath: 'logo.svg',
      },
    ];
    const output = await exportMotion(p, 'mp4', { outputDir: dir, assetsDir: dir }),
      pcm = path.join(dir, 'decoded.wav');
    const ffmpeg = path.resolve('node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe'),
      decoded = spawnSync(
        ffmpeg,
        [
          '-v',
          'error',
          '-y',
          '-i',
          output.files[0].path,
          '-map',
          '0:a:0',
          '-c:a',
          'pcm_s16le',
          '-f',
          'wav',
          '-ac',
          '1',
          '-ar',
          '8000',
          pcm,
        ],
        { windowsHide: true, encoding: 'utf8' },
      );
    expect(decoded.status, decoded.stderr).toBe(0);
    const decodedWav = await readFile(pcm);
    let dataOffset = 12;
    while (
      dataOffset + 8 < decodedWav.length &&
      decodedWav.toString('ascii', dataOffset, dataOffset + 4) !== 'data'
    ) {
      const size = decodedWav.readUInt32LE(dataOffset + 4);
      dataOffset += 8 + size + (size % 2);
    }
    expect(dataOffset + 8).toBeLessThan(decodedWav.length);
    const bytes = decodedWav.subarray(dataOffset + 8),
      sample = (i: number) => (i * 2 + 2 <= bytes.length ? bytes.readInt16LE(i * 2) : 0),
      rms = (start: number, end: number) => {
        let sum = 0,
          count = 0;
        for (let i = Math.floor(start * 8000); i < Math.floor(end * 8000); i++) {
          sum += sample(i) ** 2;
          count++;
        }
        return Math.sqrt(sum / count);
      };
    const middle = rms(0.4, 0.6);
    expect(middle).toBeGreaterThan(3000);
    expect(rms(0, 0.025)).toBeLessThan(middle * 0.15);
    expect(rms(0.97, 1)).toBeLessThan(middle * 0.4);
    expect(rms(1.2, 1.4)).toBeLessThan(100);
    let crossings = 0;
    for (let i = 3201; i < 4800; i++) if (sample(i - 1) < 0 && sample(i) >= 0) crossings++;
    expect(crossings / 0.2).toBeGreaterThan(820);
    expect(crossings / 0.2).toBeLessThan(940);
    const summary = {
      beginRms: rms(0, 0.025),
      middleRms: middle,
      endRms: rms(0.97, 1),
      afterRms: rms(1.2, 1.4),
      sourceFrequencyHz: crossings / 0.2,
      manifest: output.manifest,
    };
    await writeFile(path.join(dir, 'verification.json'), JSON.stringify(summary, null, 2));
    const image = spawnSync(
      ffmpeg,
      [
        '-v',
        'error',
        '-y',
        '-i',
        output.files[0].path,
        '-ss',
        '0.6',
        '-frames:v',
        '1',
        path.join(dir, 'preview.png'),
      ],
      { windowsHide: true, encoding: 'utf8' },
    );
    expect(image.status, image.stderr).toBe(0);
  },
  240000,
);

it.skipIf(process.env.STUDIO_FULL_MOTION_TEST !== '1')(
  'exports 5-second MP4 and transparent WebM plus a complete PNG sequence',
  async () => {
    const { mkdir, readFile, writeFile } = await import('node:fs/promises'),
      path = await import('node:path');
    const dir = path.resolve('../../work/motion-verification');
    await mkdir(dir, { recursive: true });
    const p = project();
    p.motion.width = 640;
    p.motion.height = 360;
    p.motion.scenes = ['title', 'statistics', 'comparison'].map((id) => ({
      ...makeScene(id, 640, 360, 24),
      durationFrames: 40,
    }));
    const mp4 = await exportMotion(p, 'mp4', { outputDir: path.join(dir, 'mp4'), assetsDir: dir });
    expect(mp4.manifest.durationSeconds).toBe(5);
    expect((await readFile(mp4.files[0].path)).length).toBeGreaterThan(1000);
    p.motion.transparent = true;
    const webm = await exportMotion(p, 'webm', {
      outputDir: path.join(dir, 'webm'),
      assetsDir: dir,
    });
    expect(webm.manifest.durationSeconds).toBe(5);
    const webmBytes = await readFile(webm.files[0].path);
    expect(webmBytes.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
    p.motion.scenes = [{ ...p.motion.scenes[0], durationFrames: 12 }];
    const sequence = await exportMotion(p, 'png-sequence', {
      outputDir: path.join(dir, 'sequence'),
      assetsDir: dir,
    });
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(await readFile(sequence.files[0].path));
    expect(Object.keys(zip.files).filter((n) => n.endsWith('.png'))).toHaveLength(12);
    const sharp = (await import('sharp')).default;
    const alpha = await sharp(await zip.file('element-11.png')!.async('nodebuffer')).stats();
    expect(alpha.isOpaque).toBe(false);
    expect(alpha.channels[3].max).toBeGreaterThan(0);
    const image = path.join(dir, 'test-image.svg');
    await writeFile(
      image,
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#40a0ff"/><circle cx="60" cy="40" r="25" fill="white"/></svg>',
    );
    const wav = Buffer.alloc(44 + 16000);
    wav.write('RIFF', 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24);
    wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write('data', 36);
    wav.writeUInt32LE(16000, 40);
    for (let i = 0; i < 8000; i++)
      wav.writeInt16LE(Math.round(Math.sin((i / 8000) * Math.PI * 880) * 5000), 44 + i * 2);
    await writeFile(path.join(dir, 'test-audio.wav'), wav);
    p.motion.transparent = false;
    p.motion.audioAssetId = 'audio';
    p.motion.captions = [{ start: 0, end: 1, text: '자막 검증' }];
    p.assets = [
      {
        id: 'video',
        name: 'Test video',
        mime: 'video/mp4',
        hash: 'test',
        size: 1,
        relativePath: path.relative(dir, mp4.files[0].path),
      },
      {
        id: 'image',
        name: 'Test image',
        mime: 'image/svg+xml',
        hash: 'test',
        size: 1,
        relativePath: 'test-image.svg',
      },
      {
        id: 'audio',
        name: 'Test audio',
        mime: 'audio/wav',
        hash: 'test',
        size: wav.length,
        relativePath: 'test-audio.wav',
      },
    ];
    p.motion.scenes = [
      {
        ...makeScene('title', 640, 360, 24),
        durationFrames: 24,
        elements: [
          { id: 'video-layer', type: 'video', x: 0, y: 0, w: 320, h: 180, assetId: 'video' },
          { id: 'image-layer', type: 'image', x: 360, y: 40, w: 240, h: 160, assetId: 'image' },
        ],
      },
    ];
    const media = await exportMotion(p, 'mp4', {
      outputDir: path.join(dir, 'media'),
      assetsDir: dir,
    });
    expect((await readFile(media.files[0].path)).length).toBeGreaterThan(1000);
  },
  240000,
);
