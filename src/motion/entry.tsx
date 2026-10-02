import React from 'react';
import { Composition, registerRoot } from 'remotion';
import type { Project } from '../core/types';
import { StudioComposition, compositionFrames } from './StudioComposition';

const fallback: Project = {
  schemaVersion: 1,
  id: 'render',
  name: '렌더',
  revision: 0,
  updatedAt: '',
  brand: { name: 'Studio', color: '#3b82f6', font: 'Malgun Gothic' },
  styleId: 'default',
  mode: 'dark',
  target: 'motion',
  overrides: { light: {}, dark: {} },
  accessibility: { highContrast: false, largeText: false, reducedMotion: false },
  view: { depth: 1, typeScale: 1, decor: 1 },
  slides: [],
  slideSize: { width: 1920, height: 1080 },
  webPages: [],
  motion: { id: 'motion', width: 1920, height: 1080, fps: 30, seed: 1, scenes: [] },
  assets: [],
  datasets: [],
  favorites: [],
  customStyles: [],
  collections: [],
};
export function RemotionRoot() {
  return (
    <Composition
      id="Studio"
      component={StudioComposition}
      width={1920}
      height={1080}
      fps={30}
      durationInFrames={1}
      defaultProps={{ project: fallback, assetSources: {} }}
      calculateMetadata={({ props }) => ({
        width: props.project.motion.width,
        height: props.project.motion.height,
        fps: props.project.motion.fps,
        durationInFrames: compositionFrames(props.project),
      })}
    />
  );
}
registerRoot(RemotionRoot);
