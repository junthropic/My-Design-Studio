import type { Composition, EffectSettings } from '../core/types';
import { resizeSceneDuration } from './effects';

export function audioClipFrames(
  composition: Composition,
  totalFrames: number,
  sourceDurationSeconds?: number,
): number {
  const start = composition.audioTrimStartFrames ?? 0,
    sourceEnd =
      sourceDurationSeconds === undefined
        ? Infinity
        : Math.ceil(sourceDurationSeconds * composition.fps),
    end = Math.min(composition.audioTrimEndFrames ?? Infinity, sourceEnd);
  return Math.max(0, Math.min(totalFrames, end - start));
}
/** Envelope starts at timeline frame zero after source trim; last audible frame fades to zero. */
export function audioVolumeAtFrame(
  composition: Composition,
  frame: number,
  clipFrames: number,
): number {
  if (frame < 0 || frame >= clipFrames || clipFrames <= 0) return 0;
  const fadeIn = composition.audioFadeInFrames ?? 0,
    fadeOut = composition.audioFadeOutFrames ?? 0;
  const opening = fadeIn ? Math.min(1, frame / fadeIn) : 1,
    closing = fadeOut ? Math.min(1, Math.max(0, clipFrames - 1 - frame) / fadeOut) : 1;
  return Math.max(0, Math.min(2, composition.volume ?? 0.8)) * Math.min(opening, closing);
}

export function rescaleMotionFps(composition: Composition, fps: number): Composition {
  const ratio = fps / composition.fps,
    optional = (value: number | undefined, max = 36000000) =>
      value === undefined ? undefined : Math.min(max, Math.round(value * ratio));
  const settings = (value: EffectSettings | undefined) =>
    value
      ? {
          ...value,
          durationFrames:
            value.durationFrames === undefined
              ? undefined
              : Math.max(1, optional(value.durationFrames, 36000)!),
          delayFrames: optional(value.delayFrames, 36000),
        }
      : undefined;
  return {
    ...composition,
    fps,
    audioTrimStartFrames: optional(composition.audioTrimStartFrames),
    audioTrimEndFrames:
      composition.audioTrimEndFrames === undefined
        ? undefined
        : Math.max(
            (optional(composition.audioTrimStartFrames) ?? 0) + 1,
            optional(composition.audioTrimEndFrames)!,
          ),
    audioFadeInFrames: optional(composition.audioFadeInFrames, 36000),
    audioFadeOutFrames: optional(composition.audioFadeOutFrames, 36000),
    scenes: composition.scenes.map((scene) => {
      const scaled = {
        ...scene,
        durationFrames: Math.max(1, Math.round(scene.durationFrames * ratio)),
        effectSettings: settings(scene.effectSettings),
        elements: scene.elements.map((element) => ({
          ...element,
          startFrame: optional(element.startFrame),
          endFrame: optional(element.endFrame),
          effectSettings: settings(element.effectSettings),
          keyframes: element.keyframes?.map((key) => ({
            ...key,
            frame: Math.round(key.frame * ratio),
          })),
        })),
      };
      return resizeSceneDuration(scaled, scaled.durationFrames);
    }),
  };
}
