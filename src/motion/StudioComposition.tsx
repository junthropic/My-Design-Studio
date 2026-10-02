import React from 'react';
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { Project, MotionScene, StudioElement, TokenValue } from '../core/types';
import { resolveDesign } from '../core/design';
import { computeEffect, evaluateElement, visibleText } from './effects';
import { FontReady } from './FontReady';
import { AudioTrack } from './AudioTrack';

export interface StudioCompositionProps extends Record<string, unknown> {
  project: Project;
  assetSources?: Record<string, string>;
}
export const compositionFrames = (project: Project) =>
  Math.max(
    1,
    project.motion.scenes.reduce(
      (sum, scene) => sum + Math.max(1, Math.round(scene.durationFrames)),
      0,
    ),
  );
export function sceneAtFrame(
  project: Project,
  frame: number,
): { index: number; offset: number; localFrame: number } {
  let offset = 0;
  for (let index = 0; index < project.motion.scenes.length; index++) {
    const duration = Math.max(1, project.motion.scenes[index].durationFrames);
    if (frame < offset + duration) return { index, offset, localFrame: frame - offset };
    offset += duration;
  }
  return {
    index: Math.max(0, project.motion.scenes.length - 1),
    offset: Math.max(0, offset - (project.motion.scenes.at(-1)?.durationFrames ?? 1)),
    localFrame: Math.max(0, (project.motion.scenes.at(-1)?.durationFrames ?? 1) - 1),
  };
}
export function colorValue(
  value: string | undefined,
  tokens: Record<string, TokenValue>,
  fallback: string,
): string {
  if (!value) return String(tokens[fallback] ?? fallback);
  const ref = value.startsWith('$')
    ? value.slice(1)
    : /^\{[^}]+\}$/.test(value)
      ? value.slice(1, -1)
      : null;
  return ref ? String(tokens[ref] ?? tokens[fallback] ?? '#64748b') : value;
}

function Chart({
  element,
  accent,
  text,
}: {
  element: StudioElement;
  accent: string;
  text: string;
}) {
  const data = element.chartData ?? { labels: ['A', 'B', 'C'], values: [30, 55, 80] },
    w = element.w,
    h = element.h,
    pad = Math.min(30, w / 10),
    label = Math.max(12, Math.min(26, h * 0.13)),
    values = data.values.map((v) => (Number.isFinite(v) ? v : 0)),
    lo = Math.min(0, ...values),
    hi = Math.max(1, ...values),
    plotH = Math.max(1, h - label * 2),
    step = (w - pad * 2) / Math.max(1, values.length),
    y = (v: number) => plotH - ((v - lo) / Math.max(1, hi - lo)) * plotH;
  if (data.type === 'pie') {
    const sum = values.reduce((a, v) => a + Math.max(0, v), 0) || 1,
      r = Math.max(1, Math.min(w, h) * 0.32),
      cx = w / 2,
      cy = h / 2;
    let offset = 0;
    return (
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label={element.alt ?? '원형 차트'}
      >
        {values.map((v, i) => {
          const size = Math.max(0, v) / sum,
            circle = (
              <circle
                key={i}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke={accent}
                opacity={1 - (i / Math.max(1, values.length)) * 0.7}
                strokeWidth={r * 0.6}
                strokeDasharray={`${size * 2 * Math.PI * r} ${2 * Math.PI * r}`}
                strokeDashoffset={-offset * 2 * Math.PI * r}
                transform={`rotate(-90 ${cx} ${cy})`}
              />
            );
          offset += size;
          return circle;
        })}
      </svg>
    );
  }
  return (
    <svg
      width="100%"
      height="100%"
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={element.alt ?? '차트'}
    >
      <line x1={pad} x2={w - pad} y1={y(0)} y2={y(0)} stroke={text} opacity={0.25} />
      {data.type === 'line' && (
        <polyline
          points={values.map((v, i) => `${pad + step * (i + 0.5)},${y(v)}`).join(' ')}
          fill="none"
          stroke={accent}
          strokeWidth={Math.max(2, w / 250)}
        />
      )}
      {values.map((value, i) => (
        <g key={i}>
          {data.type !== 'line' ? (
            <rect
              x={pad + step * (i + 0.2)}
              y={Math.min(y(value), y(0))}
              width={step * 0.6}
              height={Math.max(1, Math.abs(y(value) - y(0)))}
              rx={3}
              fill={accent}
              opacity={0.7 + (0.3 * i) / Math.max(1, values.length - 1)}
            />
          ) : (
            <circle cx={pad + step * (i + 0.5)} cy={y(value)} r={5} fill={accent} />
          )}
          <text
            x={pad + step * (i + 0.5)}
            y={Math.max(label, y(value) - 8)}
            textAnchor="middle"
            fill={text}
            fontSize={label}
          >
            {value}
          </text>
          <text
            x={pad + step * (i + 0.5)}
            y={h - 3}
            textAnchor="middle"
            fill={text}
            fontSize={label}
          >
            {data.labels[i] ?? i + 1}
          </text>
        </g>
      ))}
    </svg>
  );
}

function SceneLayer({
  element,
  scene,
  project,
  tokens,
  assetSources,
}: {
  element: StudioElement;
  scene: MotionScene;
  project: Project;
  tokens: Record<string, TokenValue>;
  assetSources: Record<string, string>;
}) {
  const frame = useCurrentFrame(),
    { fps } = useVideoConfig(),
    value = evaluateElement(
      element,
      frame,
      scene.durationFrames,
      fps,
      project.accessibility.reducedMotion,
    );
  if (!value.visible) return null;
  const color = colorValue(value.color, tokens, 'color.text'),
    fill = colorValue(
      element.fill,
      tokens,
      element.type === 'shape' ? 'color.accent' : 'color.surface',
    ),
    accent = String(tokens['color.accent'] ?? '#3b82f6');
  const asset = project.assets.find((a) => a.id === element.assetId),
    source = element.assetId
      ? (assetSources[element.assetId] ?? `/api/assets/${encodeURIComponent(element.assetId)}`)
      : undefined;
  const style: React.CSSProperties = {
    position: 'absolute',
    left: value.x,
    top: value.y,
    width: element.w,
    height: element.h,
    opacity: value.opacity,
    transform: `rotate(${value.rotation}deg) scale(${value.scale})`,
    transformOrigin: '50% 50%',
    filter: value.blur ? `blur(${value.blur}px)` : undefined,
    clipPath: value.clipPath,
    color,
    fontFamily: String(tokens['font.family'] ?? project.brand.font),
    fontSize: element.fontSize ?? 48,
    fontWeight: element.fontWeight ?? 400,
    lineHeight: 1.25,
    letterSpacing: value.letterSpacing,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    boxSizing: 'border-box',
  };
  let content: React.ReactNode = null;
  switch (element.type) {
    case 'text':
      content = visibleText(element.text ?? '', value.visibleProgress, value.wordReveal);
      break;
    case 'shape':
      style.background = fill;
      style.borderRadius = element.shape === 'ellipse' ? '50%' : Number(tokens['radius.card'] ?? 0);
      if (element.shape === 'line') {
        style.height = Math.max(2, Math.min(element.h, 8));
        style.borderRadius = 0;
      }
      break;
    case 'image':
      content = source ? (
        <Img
          src={source}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            borderRadius: Number(tokens['radius.card'] ?? 0),
          }}
          alt={element.alt ?? asset?.name ?? ''}
        />
      ) : (
        <div
          style={{
            height: '100%',
            background: fill,
            display: 'grid',
            placeItems: 'center',
            fontSize: 24,
          }}
        >
          이미지를 선택하세요
        </div>
      );
      break;
    case 'video':
      content = source ? (
        <Sequence from={Math.max(0, element.startFrame ?? 0)} layout="none">
          <OffthreadVideo
            src={source}
            muted
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </Sequence>
      ) : (
        <div
          style={{
            height: '100%',
            background: fill,
            display: 'grid',
            placeItems: 'center',
            fontSize: 24,
          }}
        >
          영상을 선택하세요
        </div>
      );
      break;
    case 'chart':
      content = <Chart element={element} accent={accent} text={color} />;
      break;
    case 'table':
      content = (
        <table
          style={{
            width: '100%',
            height: '100%',
            borderCollapse: 'collapse',
            tableLayout: 'fixed',
            fontSize: element.fontSize ?? 28,
          }}
        >
          <tbody>
            {(
              element.tableData ?? [
                ['항목', '값'],
                ['샘플', '42'],
              ]
            ).map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td
                    key={j}
                    style={{
                      padding: '0.4em 0.6em',
                      borderBottom: `1px solid ${tokens['color.border'] ?? '#475569'}`,
                      background: i === 0 ? fill : undefined,
                      fontWeight: i === 0 ? 700 : 400,
                    }}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
      break;
  }
  return <div style={style}>{content}</div>;
}

function Scene({
  scene,
  project,
  tokens,
  assetSources,
}: {
  scene: MotionScene;
  project: Project;
  tokens: Record<string, TokenValue>;
  assetSources: Record<string, string>;
}) {
  const frame = useCurrentFrame(),
    { fps } = useVideoConfig(),
    fx = project.accessibility.reducedMotion
      ? {}
      : computeEffect(scene.effect, frame, scene.durationFrames, fps, scene.effectSettings);
  return (
    <AbsoluteFill
      style={{
        opacity: fx.opacity ?? 1,
        transform: `translate(${fx.x ?? 0}px,${fx.y ?? 0}px) scale(${fx.scale ?? 1}) rotate(${fx.rotation ?? 0}deg)`,
        filter: fx.blur ? `blur(${fx.blur}px)` : undefined,
        clipPath: fx.clipPath,
      }}
    >
      {scene.elements.map((element) => (
        <SceneLayer
          key={element.id}
          element={element}
          scene={scene}
          project={project}
          tokens={tokens}
          assetSources={assetSources}
        />
      ))}
    </AbsoluteFill>
  );
}

export function StudioComposition({ project, assetSources = {} }: StudioCompositionProps) {
  const frame = useCurrentFrame(),
    { fps, width, height } = useVideoConfig(),
    tokens = resolveDesign(project, 'motion', project.mode).tokens;
  let offset = 0;
  const time = frame / fps,
    caption = project.motion.captions?.find((c) => time >= c.start && time < c.end),
    audio = project.motion.audioAssetId;
  const logo = project.assets.find(
    (asset) => asset.id === project.brand.logoAssetId && asset.mime.startsWith('image/'),
  );
  return (
    <AbsoluteFill
      style={{
        backgroundColor: project.motion.transparent
          ? 'transparent'
          : String(tokens['color.bg'] ?? '#111827'),
        fontFamily: String(tokens['font.family'] ?? project.brand.font),
      }}
    >
      <FontReady
        key={`${String(tokens['font.family'])}:${project.assets
          .filter((a) => a.mime.startsWith('font/'))
          .map((a) => a.hash)
          .join(':')}`}
        family={String(tokens['font.family'] ?? project.brand.font)}
        assets={project.assets}
        assetSources={assetSources}
      />
      {project.motion.scenes.map((scene) => {
        const from = offset;
        offset += Math.max(1, scene.durationFrames);
        return (
          <Sequence key={scene.id} from={from} durationInFrames={Math.max(1, scene.durationFrames)}>
            <Scene scene={scene} project={project} tokens={tokens} assetSources={assetSources} />
          </Sequence>
        );
      })}
      {logo && (
        <Img
          src={assetSources[logo.id] ?? `/api/assets/${encodeURIComponent(logo.id)}`}
          alt={project.brand.name}
          style={{
            position: 'absolute',
            width: width * 0.05,
            height: height * 0.08,
            objectFit: 'contain',
            objectPosition: 'top right',
            top: height * 0.045,
            right: width * 0.045,
          }}
        />
      )}
      {audio && (
        <AudioTrack
          key={audio}
          src={assetSources[audio] ?? `/api/assets/${encodeURIComponent(audio)}`}
          composition={project.motion}
          totalFrames={compositionFrames(project)}
        />
      )}
      {caption && (
        <div
          style={{
            position: 'absolute',
            bottom: height > width ? height * 0.22 : height * 0.065,
            left: '8%',
            width: '84%',
            textAlign: 'center',
            whiteSpace: 'pre-wrap',
            fontSize: Math.max(22, height * 0.035),
            fontWeight: 700,
            lineHeight: 1.4,
            color: '#ffffff',
          }}
        >
          <span
            style={{
              background: 'rgba(0,0,0,0.8)',
              padding: '0.16em 0.5em',
              boxDecorationBreak: 'clone',
              borderRadius: 8,
            }}
          >
            {caption.text}
          </span>
        </div>
      )}
    </AbsoluteFill>
  );
}
export default StudioComposition;
