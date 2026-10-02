export type Mode = 'light' | 'dark';
export type Target = 'ppt' | 'web' | 'motion';
export type TokenValue = string | number;
export type ElementType = 'text' | 'shape' | 'image' | 'chart' | 'table' | 'video';
export interface Keyframe {
  frame: number;
  property: 'x' | 'y' | 'opacity' | 'rotation' | 'scale' | 'color';
  value: number | string;
  easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
}
export interface EffectSettings {
  durationFrames?: number;
  intensity?: number;
  direction?: 'auto' | 'left' | 'right' | 'up' | 'down';
  delayFrames?: number;
  easing?: Keyframe['easing'];
}
export interface StudioElement {
  id: string;
  type: ElementType;
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  fontSize?: number;
  fontWeight?: number;
  color?: string;
  fill?: string;
  opacity?: number;
  rotation?: number;
  locked?: boolean;
  group?: string;
  assetId?: string;
  alt?: string;
  shape?: 'rect' | 'ellipse' | 'line';
  chartData?: { labels: string[]; values: number[]; type?: 'bar' | 'line' | 'pie' };
  tableData?: string[][];
  keyframes?: Keyframe[];
  effect?: string;
  effectSettings?: EffectSettings;
  startFrame?: number;
  endFrame?: number;
}
export interface Slide {
  id: string;
  name: string;
  layout: string;
  hidden: boolean;
  notes: string;
  elements: StudioElement[];
}
export interface WebSection {
  id: string;
  type:
    | 'hero'
    | 'features'
    | 'projects'
    | 'about'
    | 'stats'
    | 'table'
    | 'chart'
    | 'faq'
    | 'contact'
    | 'pricing';
  title: string;
  body: string;
  enabled: boolean;
  columns: number;
  assetId?: string;
  dataId?: string;
  items?: { title: string; body: string }[];
  align?: 'left' | 'center';
  padding?: number;
  mobileColumns?: number;
}
export interface WebPage {
  id: string;
  name: string;
  kind: 'portfolio' | 'landing' | 'dashboard';
  title: string;
  description: string;
  sections: WebSection[];
}
export interface MotionScene {
  id: string;
  name: string;
  template: string;
  durationFrames: number;
  effect: string;
  effectSettings?: EffectSettings;
  elements: StudioElement[];
}
export interface Composition {
  id: string;
  width: number;
  height: number;
  fps: number;
  scenes: MotionScene[];
  audioAssetId?: string;
  volume?: number;
  audioTrimStartFrames?: number;
  audioTrimEndFrames?: number;
  audioFadeInFrames?: number;
  audioFadeOutFrames?: number;
  transparent?: boolean;
  captions?: { start: number; end: number; text: string }[];
  seed: number;
}
export interface Asset {
  id: string;
  name: string;
  mime: string;
  hash: string;
  size: number;
  relativePath: string;
  width?: number;
  height?: number;
  duration?: number;
  source?: string;
  license?: string;
}
export interface Dataset {
  id: string;
  name: string;
  columns: string[];
  rows: Record<string, string | number | null>[];
  source: 'file' | 'api' | 'sample';
  updatedAt: string;
  connection?: {
    url: string;
    headers?: Record<string, string>;
    secretRef?: string;
    responsePath?: string;
  };
  formats?: Record<string, 'text' | 'number' | 'percent' | 'currency' | 'date'>;
}
export interface StylePreset {
  id: string;
  name: string;
  english: string;
  description: string;
  tags: string[];
  accent: string;
  dark: Record<string, TokenValue>;
  light: Record<string, TokenValue>;
  custom?: boolean;
}
export interface Project {
  schemaVersion: 1;
  id: string;
  name: string;
  revision: number;
  updatedAt: string;
  brand: { name: string; color: string; font: string; logoAssetId?: string };
  styleId: string;
  mode: Mode;
  target: Target;
  overrides: { light: Record<string, TokenValue>; dark: Record<string, TokenValue> };
  accessibility: { highContrast: boolean; largeText: boolean; reducedMotion: boolean };
  view: { depth: number; typeScale: number; decor: number };
  slides: Slide[];
  slideSize: { width: number; height: number };
  webPages: WebPage[];
  motion: Composition;
  assets: Asset[];
  datasets: Dataset[];
  favorites: string[];
  customStyles: StylePreset[];
  collections: { id: string; name: string; styleIds: string[] }[];
}
export interface ResolvedDesign {
  mode: Mode;
  target: Target;
  style: StylePreset;
  tokens: Record<string, TokenValue>;
  sources: Record<string, string>;
  brandOriginal: string;
  css: Record<string, string>;
}
export interface ValidationIssue {
  id: string;
  severity: 'error' | 'warning' | 'manual';
  message: string;
  target?: string;
  elementId?: string;
}
export interface ValidationReport {
  issues: ValidationIssue[];
  passed: number;
  failed: number;
  manual: number;
  checkedAt: string;
}
export interface ExportFile {
  name: string;
  path: string;
  mime: string;
}
export interface ExportResult {
  files: ExportFile[];
  manifest: Record<string, unknown>;
}
export interface ExportContext {
  outputDir: string;
  assetsDir: string;
  assetPath?: (asset: Asset) => string;
  onProgress?: (progress: number, message: string) => void;
  signal?: AbortSignal;
}
export interface Job {
  id: string;
  projectId: string;
  revision: number;
  format: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
  progress: number;
  message: string;
  createdAt: string;
  files?: ExportFile[];
  manifest?: Record<string, unknown>;
  error?: string;
}
