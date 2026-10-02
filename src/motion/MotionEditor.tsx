import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import type { Project, MotionScene, StudioElement, Keyframe, Composition } from '../core/types';
import { StudioComposition, compositionFrames, sceneAtFrame } from './StudioComposition';
import {
  EFFECTS,
  EFFECT_CATEGORIES,
  evaluateElement,
  sampleKeyframes,
  resizeSceneDuration,
} from './effects';
import { MOTION_PRESETS, SCENE_TEMPLATES, makeScene, parseSrt, uid } from './templates';
import { EffectGallery } from './EffectGallery';
import { EffectSettingsControls } from './EffectSettingsControls';
import { rescaleMotionFps } from './audio';
import './motion.css';

export interface MotionEditorProps {
  project: Project;
  onChange: (project: Project) => void;
  onExport: (format: string) => void;
}
const numeric = (value: string, fallback = 0) =>
  Number.isFinite(Number(value)) ? Number(value) : fallback;

function EffectOptions({ scene = false }: { scene?: boolean }) {
  return (
    <>
      <option value="none">효과 없음</option>
      {Object.entries(EFFECT_CATEGORIES)
        .filter(([id]) => !scene || id !== 'text')
        .map(([id, name]) => (
          <optgroup label={name} key={id}>
            {EFFECTS.filter((e) => e.category === id).map((e) => (
              <option value={e.id} key={e.id}>
                {e.name}
              </option>
            ))}
          </optgroup>
        ))}
    </>
  );
}

export function MotionEditor({ project, onChange, onExport }: MotionEditorProps) {
  const [sceneIndex, setSceneIndex] = useState(0),
    [selectedId, setSelectedId] = useState(''),
    [frame, setFrame] = useState(0),
    [playing, setPlaying] = useState(false),
    [template, setTemplate] = useState('title'),
    [notice, setNotice] = useState(''),
    [keyProperty, setKeyProperty] = useState<Keyframe['property']>('opacity'),
    [keyValue, setKeyValue] = useState('1'),
    [keyEasing, setKeyEasing] = useState<Keyframe['easing']>('easeOut');
  const player = useRef<PlayerRef>(null),
    stage = useRef<HTMLDivElement>(null),
    srt = useRef<HTMLInputElement>(null),
    pendingSeek = useRef<number | null>(null),
    drag = useRef<{
      id: string;
      x: number;
      y: number;
      clientX: number;
      clientY: number;
      scale: number;
    } | null>(null);
  const c = project.motion,
    duration = compositionFrames(project),
    scene = c.scenes[Math.min(sceneIndex, c.scenes.length - 1)],
    selected = scene?.elements.find((e) => e.id === selectedId),
    sceneOffset = c.scenes.slice(0, sceneIndex).reduce((n, s) => n + s.durationFrames, 0),
    localFrame = frame - sceneOffset;
  const inputProps = useMemo(() => ({ project }), [project]);
  const change = (motion: Composition) => onChange({ ...project, motion });
  const changeScene = (patch: Partial<MotionScene>) =>
    scene &&
    change({ ...c, scenes: c.scenes.map((s) => (s.id === scene.id ? { ...s, ...patch } : s)) });
  const changeElement = (id: string, patch: Partial<StudioElement>) =>
    scene &&
    changeScene({ elements: scene.elements.map((e) => (e.id === id ? { ...e, ...patch } : e)) });
  const moveElement = (element: StudioElement, x: number, y: number) => {
    if (element.keyframes?.some((k) => k.property === 'x' || k.property === 'y')) {
      const at = Math.max(0, Math.min(scene.durationFrames - 1, localFrame));
      changeElement(element.id, {
        keyframes: [
          ...(element.keyframes ?? []).filter(
            (k) => !(k.frame === at && (k.property === 'x' || k.property === 'y')),
          ),
          { frame: at, property: 'x', value: x, easing: 'linear' },
          { frame: at, property: 'y', value: y, easing: 'linear' },
        ],
      });
    } else changeElement(element.id, { x, y });
  };
  const seek = (value: number) => {
    const next = Math.max(0, Math.min(duration - 1, Math.round(value)));
    player.current?.seekTo(next);
    setFrame(next);
  };
  useEffect(() => {
    const instance = player.current;
    if (!instance) return;
    const update = (event: { detail: { frame: number } }) => setFrame(event.detail.frame),
      play = () => setPlaying(true),
      pause = () => setPlaying(false);
    instance.addEventListener('frameupdate', update);
    instance.addEventListener('play', play);
    instance.addEventListener('pause', pause);
    return () => {
      instance.removeEventListener('frameupdate', update);
      instance.removeEventListener('play', play);
      instance.removeEventListener('pause', pause);
    };
  }, [project.id, !!c.scenes.length]);
  useEffect(() => {
    if (sceneIndex >= c.scenes.length) setSceneIndex(Math.max(0, c.scenes.length - 1));
    if (frame >= duration) seek(duration - 1);
  }, [c.scenes.length, duration]);
  useEffect(() => {
    if (pendingSeek.current !== null) {
      seek(pendingSeek.current);
      pendingSeek.current = null;
    }
  }, [c.fps]);
  useEffect(() => {
    if (scene) {
      player.current?.seekTo(sceneOffset);
      setFrame(sceneOffset);
    }
  }, [scene?.id, sceneOffset]);
  useEffect(() => {
    setSceneIndex(0);
    setSelectedId('');
    setFrame(0);
    setPlaying(false);
  }, [project.id]);
  const selectScene = (index: number) => {
    setSceneIndex(index);
    setSelectedId('');
    seek(c.scenes.slice(0, index).reduce((n, s) => n + s.durationFrames, 0));
  };
  const addScene = () => {
    const added = makeScene(template, c.width, c.height, c.fps);
    change({ ...c, scenes: [...c.scenes, added] });
    setSceneIndex(c.scenes.length);
    setSelectedId('');
    setFrame(duration);
  };
  const reorderScene = (delta: number) => {
    if (!scene) return;
    const next = sceneIndex + delta;
    if (next < 0 || next >= c.scenes.length) return;
    const scenes = [...c.scenes];
    [scenes[sceneIndex], scenes[next]] = [scenes[next], scenes[sceneIndex]];
    change({ ...c, scenes });
    setSceneIndex(next);
  };
  const duplicateScene = () => {
    if (!scene) return;
    const copy = {
      ...structuredClone(scene),
      id: uid(),
      name: scene.name + ' 복사',
      elements: scene.elements.map((e) => ({ ...structuredClone(e), id: uid() })),
    };
    const scenes = [...c.scenes];
    scenes.splice(sceneIndex + 1, 0, copy);
    change({ ...c, scenes });
    setSceneIndex(sceneIndex + 1);
  };
  const addLayer = (type: StudioElement['type']) => {
    if (!scene) return;
    const scale = c.width / 1920,
      element: StudioElement = {
        id: uid(),
        type,
        x: c.width * 0.1,
        y: c.height * 0.2,
        w: c.width * 0.65,
        h: type === 'text' ? c.height * 0.15 : c.height * 0.4,
        fontSize: 64 * scale,
        fontWeight: 700,
        text: type === 'text' ? '텍스트를 입력하세요' : undefined,
        shape: 'rect',
        effect: 'fade-in',
        startFrame: 0,
        endFrame: scene.durationFrames,
        ...(type === 'chart'
          ? { chartData: { labels: ['A', 'B', 'C'], values: [30, 60, 45], type: 'bar' as const } }
          : {}),
        ...(type === 'table'
          ? {
              tableData: [
                ['항목', '값'],
                ['A', '42'],
                ['B', '64'],
              ],
            }
          : {}),
      };
    changeScene({ elements: [...scene.elements, element] });
    setSelectedId(element.id);
  };
  const updateFps = (fps: number) => {
    pendingSeek.current = Math.round((frame * fps) / c.fps);
    change(rescaleMotionFps(c, fps));
  };
  const resize = (width: number, height: number) => {
    const xScale = width / c.width,
      yScale = height / c.height;
    change({
      ...c,
      width,
      height,
      scenes: c.scenes.map((s) => ({
        ...s,
        elements: s.elements.map((e) => ({
          ...e,
          x: e.x * xScale,
          y: e.y * yScale,
          w: e.w * xScale,
          h: e.h * yScale,
          fontSize: e.fontSize ? e.fontSize * Math.min(xScale, yScale) : undefined,
          keyframes: e.keyframes?.map((k) => ({
            ...k,
            value:
              typeof k.value === 'number' && k.property === 'x'
                ? k.value * xScale
                : typeof k.value === 'number' && k.property === 'y'
                  ? k.value * yScale
                  : k.value,
          })),
        })),
      })),
    });
  };
  const importSrt = async (file: File) => {
    try {
      const captions = parseSrt(await file.text());
      if (!captions.length) throw new Error('읽을 수 있는 SRT 타임코드가 없습니다.');
      change({ ...c, captions });
      setNotice(`자막 ${captions.length}개를 불러왔습니다.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };
  const addKey = () => {
    if (!selected || !scene) return;
    const value = keyProperty === 'color' ? keyValue : numeric(keyValue),
      at = Math.max(0, Math.min(scene.durationFrames - 1, localFrame)),
      key: Keyframe = { frame: at, property: keyProperty, value, easing: keyEasing };
    changeElement(selected.id, {
      keyframes: [
        ...(selected.keyframes ?? []).filter(
          (k) => !(k.frame === at && k.property === keyProperty),
        ),
        key,
      ].sort((a, b) => a.frame - b.frame),
    });
  };
  const numField = (
    label: string,
    key: 'x' | 'y' | 'w' | 'h' | 'fontSize' | 'rotation' | 'opacity',
    min?: number,
    max?: number,
    step = 1,
  ) =>
    selected && (
      <label>
        {label}
        <input
          type="number"
          value={selected[key] ?? (key === 'opacity' ? 1 : 0)}
          min={min}
          max={max}
          step={step}
          onChange={(e) =>
            changeElement(selected.id, {
              [key]: Math.max(min ?? -Infinity, Math.min(max ?? Infinity, numeric(e.target.value))),
            })
          }
        />
      </label>
    );
  const currentScene = sceneAtFrame(project, frame);

  return (
    <div className="motion-editor">
      <div className="motion-heading">
        <div>
          <h2>모션 스튜디오</h2>
          <p>템플릿과 레이어를 조합하고, 프레임 단위로 미리 봅니다.</p>
        </div>
        <div className="motion-actions">
          <button onClick={() => onExport('mp4')}>MP4 내보내기</button>
          <button onClick={() => onExport('webm')}>WebM</button>
          <button onClick={() => onExport('png-sequence')}>PNG 시퀀스</button>
        </div>
      </div>
      <EffectGallery
        durationFrames={scene?.durationFrames ?? c.fps * 3}
        fps={c.fps}
        settings={selected ? selected.effectSettings : scene?.effectSettings}
        onSettingsChange={(effectSettings) =>
          selected
            ? changeElement(selected.id, { effectSettings })
            : changeScene({ effectSettings })
        }
        selectedEffect={selected?.effect ?? scene?.effect ?? 'none'}
        selectedKind={selected?.type ?? 'scene'}
        reducedMotion={project.accessibility.reducedMotion}
        onApply={(effect) =>
          selected ? changeElement(selected.id, { effect }) : changeScene({ effect })
        }
      />
      <div className="motion-workspace">
        <aside className="motion-scenes">
          <h3>
            장면 <span>{c.scenes.length}</span>
          </h3>
          <div className="motion-template-add">
            <select
              aria-label="장면 템플릿"
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
            >
              {SCENE_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button onClick={addScene}>장면 추가</button>
          </div>
          <div className="motion-scene-list">
            {c.scenes.map((s, i) => (
              <button
                className={i === sceneIndex ? 'active' : ''}
                key={s.id}
                onClick={() => selectScene(i)}
              >
                <span className="motion-scene-number">{String(i + 1).padStart(2, '0')}</span>
                <span>
                  {s.name}
                  <small>
                    {(s.durationFrames / c.fps).toFixed(1)}초 · {s.elements.length} 레이어
                  </small>
                </span>
              </button>
            ))}
          </div>
          {scene && (
            <div className="motion-small-actions">
              <button onClick={() => reorderScene(-1)} disabled={!sceneIndex}>
                위로
              </button>
              <button onClick={() => reorderScene(1)} disabled={sceneIndex === c.scenes.length - 1}>
                아래로
              </button>
              <button onClick={duplicateScene}>복제</button>
              <button
                className="danger"
                disabled={c.scenes.length === 1}
                title={
                  c.scenes.length === 1 ? '프로젝트에는 최소 한 장면이 필요합니다.' : undefined
                }
                onClick={() => {
                  change({ ...c, scenes: c.scenes.filter((s) => s.id !== scene.id) });
                  setSelectedId('');
                }}
              >
                삭제
              </button>
            </div>
          )}
          <div className="motion-global">
            <h3>출력 설정</h3>
            <label>
              화면 비율
              <select
                value={
                  MOTION_PRESETS.find((p) => p.width === c.width && p.height === c.height)?.id ??
                  'custom'
                }
                onChange={(e) => {
                  const preset = MOTION_PRESETS.find((p) => p.id === e.target.value);
                  if (preset) resize(preset.width, preset.height);
                }}
              >
                <option value="custom" disabled>
                  사용자 크기 {c.width}×{c.height}
                </option>
                {MOTION_PRESETS.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              프레임레이트
              <select value={c.fps} onChange={(e) => updateFps(Number(e.target.value))}>
                {![24, 30, 60].includes(c.fps) && (
                  <option value={c.fps}>{c.fps} fps · 저장된 값</option>
                )}
                {[24, 30, 60].map((f) => (
                  <option value={f} key={f}>
                    {f} fps
                  </option>
                ))}
              </select>
            </label>
            <label className="motion-checkbox">
              <input
                type="checkbox"
                checked={!!c.transparent}
                onChange={(e) => change({ ...c, transparent: e.target.checked })}
              />
              투명 배경 (WebM / PNG)
            </label>
            <small>
              비율 변경은 위치와 크기를 함께 조정합니다. FPS 변경은 장면의 초 단위를 유지합니다.
            </small>
          </div>
        </aside>

        <main className="motion-center">
          <div className="motion-stage-checker">
            <div
              ref={stage}
              className="motion-stage"
              style={{
                aspectRatio: `${c.width}/${c.height}`,
                maxWidth: c.height > c.width ? (540 * c.width) / c.height : undefined,
              }}
            >
              {c.scenes.length ? (
                <>
                  <Player
                    ref={player}
                    component={StudioComposition}
                    inputProps={inputProps}
                    durationInFrames={duration}
                    compositionWidth={c.width}
                    compositionHeight={c.height}
                    fps={c.fps}
                    controls={false}
                    loop={false}
                    style={{ width: '100%', height: '100%' }}
                    errorFallback={({ error }) => (
                      <div className="motion-render-error">
                        미리보기를 표시하지 못했습니다: {error.message}
                      </div>
                    )}
                  />
                  {!playing &&
                    currentScene.index === sceneIndex &&
                    scene.elements.map((element) => {
                      const value = evaluateElement(
                        element,
                        localFrame,
                        scene.durationFrames,
                        c.fps,
                        project.accessibility.reducedMotion,
                      );
                      if (!value.visible) return null;
                      return (
                        <div
                          key={element.id}
                          role="button"
                          tabIndex={0}
                          aria-label={`${element.type} 레이어 ${element.text?.slice(0, 20) ?? element.id.slice(0, 6)}`}
                          className={`motion-layer-hit ${selectedId === element.id ? 'selected' : ''} ${element.locked ? 'locked' : ''}`}
                          style={{
                            left: `${(value.x / c.width) * 100}%`,
                            top: `${(value.y / c.height) * 100}%`,
                            width: `${(element.w / c.width) * 100}%`,
                            height: `${(element.h / c.height) * 100}%`,
                            transform: `rotate(${value.rotation}deg) scale(${value.scale})`,
                          }}
                          onFocus={() => setSelectedId(element.id)}
                          onPointerDown={(event) => {
                            setSelectedId(element.id);
                            if (element.locked) return;
                            event.currentTarget.setPointerCapture(event.pointerId);
                            drag.current = {
                              id: element.id,
                              x: Number(
                                sampleKeyframes(
                                  element.keyframes ?? [],
                                  localFrame,
                                  'x',
                                  element.x,
                                ),
                              ),
                              y: Number(
                                sampleKeyframes(
                                  element.keyframes ?? [],
                                  localFrame,
                                  'y',
                                  element.y,
                                ),
                              ),
                              clientX: event.clientX,
                              clientY: event.clientY,
                              scale:
                                (stage.current?.getBoundingClientRect().width ?? c.width) / c.width,
                            };
                          }}
                          onPointerMove={(event) => {
                            const d = drag.current;
                            if (!d || d.id !== element.id) return;
                            const x = Math.round(d.x + (event.clientX - d.clientX) / d.scale),
                              y = Math.round(d.y + (event.clientY - d.clientY) / d.scale);
                            moveElement(element, x, y);
                          }}
                          onPointerUp={() => {
                            drag.current = null;
                          }}
                          onPointerCancel={() => {
                            drag.current = null;
                          }}
                          onKeyDown={(event) => {
                            if (element.locked) return;
                            const amount = event.shiftKey ? 10 : 1;
                            if (
                              ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
                                event.key,
                              )
                            ) {
                              event.preventDefault();
                              moveElement(
                                element,
                                Number(
                                  sampleKeyframes(
                                    element.keyframes ?? [],
                                    localFrame,
                                    'x',
                                    element.x,
                                  ),
                                ) +
                                  (event.key === 'ArrowLeft'
                                    ? -amount
                                    : event.key === 'ArrowRight'
                                      ? amount
                                      : 0),
                                Number(
                                  sampleKeyframes(
                                    element.keyframes ?? [],
                                    localFrame,
                                    'y',
                                    element.y,
                                  ),
                                ) +
                                  (event.key === 'ArrowUp'
                                    ? -amount
                                    : event.key === 'ArrowDown'
                                      ? amount
                                      : 0),
                              );
                            }
                          }}
                        />
                      );
                    })}
                </>
              ) : (
                <div className="motion-empty">
                  <h3>첫 장면을 추가하세요</h3>
                  <p>왼쪽에서 템플릿을 고르면 편집 가능한 레이어가 생성됩니다.</p>
                  <button onClick={addScene}>타이틀 장면 추가</button>
                </div>
              )}
            </div>
          </div>
          <div className="motion-player-tools">
            <button aria-label="한 프레임 뒤로" onClick={() => seek(frame - 1)}>
              −1f
            </button>
            <button
              className="motion-play"
              onClick={() => {
                if (!c.scenes.length) return;
                player.current?.toggle();
              }}
            >
              {playing ? '일시정지' : '재생'}
            </button>
            <button aria-label="한 프레임 앞으로" onClick={() => seek(frame + 1)}>
              +1f
            </button>
            <output>
              {frame} / {duration - 1} f · {(frame / c.fps).toFixed(2)}초
            </output>
            <span>
              {c.width} × {c.height} · {c.fps} fps
            </span>
          </div>
          <input
            className="motion-scrub"
            type="range"
            aria-label="전체 타임라인 프레임"
            min={0}
            max={duration - 1}
            step={1}
            value={Math.min(frame, duration - 1)}
            onChange={(e) => seek(Number(e.target.value))}
          />
          <div className="motion-timeline">
            <div className="motion-timeline-scenes">
              {c.scenes.map((s, i) => (
                <button
                  key={s.id}
                  className={i === currentScene.index ? 'active' : ''}
                  style={{ flex: s.durationFrames }}
                  onClick={() => selectScene(i)}
                >
                  {s.name}
                </button>
              ))}
            </div>
            {scene && (
              <>
                <div className="motion-timeline-head">
                  <strong>{scene.name}</strong>
                  <span>
                    장면 프레임 {Math.max(0, localFrame)} / {scene.durationFrames - 1}
                  </span>
                </div>
                {scene.elements
                  .slice()
                  .reverse()
                  .map((e) => (
                    <div
                      className={`motion-track ${selectedId === e.id ? 'active' : ''}`}
                      key={e.id}
                    >
                      <button onClick={() => setSelectedId(e.id)}>
                        {e.locked ? '▣ ' : ''}
                        {e.text?.replace(/\n/g, ' ').slice(0, 18) || e.type}
                      </button>
                      <div
                        className="motion-track-body"
                        onClick={(event) => {
                          const bounds = event.currentTarget.getBoundingClientRect();
                          seek(
                            sceneOffset +
                              Math.round(
                                ((event.clientX - bounds.left) / bounds.width) *
                                  (scene.durationFrames - 1),
                              ),
                          );
                        }}
                      >
                        <div
                          className="motion-track-clip"
                          style={{
                            left: `${((e.startFrame ?? 0) / scene.durationFrames) * 100}%`,
                            width: `${(((e.endFrame ?? scene.durationFrames) - (e.startFrame ?? 0)) / scene.durationFrames) * 100}%`,
                          }}
                        />
                        {e.keyframes?.map((k, i) => (
                          <button
                            key={i}
                            title={`${k.frame}f · ${k.property}: ${k.value}`}
                            className="motion-key-dot"
                            style={{ left: `${(k.frame / scene.durationFrames) * 100}%` }}
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedId(e.id);
                              seek(sceneOffset + k.frame);
                            }}
                          >
                            ◆
                          </button>
                        ))}
                        {localFrame >= 0 && localFrame < scene.durationFrames && (
                          <span
                            className="motion-playhead"
                            style={{ left: `${(localFrame / scene.durationFrames) * 100}%` }}
                          />
                        )}
                      </div>
                    </div>
                  ))}
              </>
            )}
          </div>
          <div className="motion-audio">
            <h3>오디오 · 자막</h3>
            <div className="motion-fields">
              <label>
                배경 오디오
                <select
                  value={c.audioAssetId ?? ''}
                  onChange={(e) => change({ ...c, audioAssetId: e.target.value || undefined })}
                >
                  <option value="">없음</option>
                  {project.assets
                    .filter((a) => a.mime.startsWith('audio/'))
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                볼륨
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={c.volume ?? 0.8}
                  onChange={(e) => change({ ...c, volume: Number(e.target.value) })}
                />
              </label>
              <button onClick={() => srt.current?.click()}>SRT 불러오기</button>
              <input
                ref={srt}
                type="file"
                accept=".srt,text/plain"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importSrt(file);
                  event.target.value = '';
                }}
              />
            </div>
            {c.audioAssetId && (
              <div className="motion-fields motion-audio-envelope">
                <label>
                  원본 시작 (초)
                  <input
                    type="number"
                    min={0}
                    step={1 / c.fps}
                    value={(c.audioTrimStartFrames ?? 0) / c.fps}
                    onChange={(e) => {
                      const audioTrimStartFrames = Math.max(
                        0,
                        Math.round(numeric(e.target.value) * c.fps),
                      );
                      change({
                        ...c,
                        audioTrimStartFrames,
                        audioTrimEndFrames:
                          c.audioTrimEndFrames === undefined
                            ? undefined
                            : Math.max(audioTrimStartFrames + 1, c.audioTrimEndFrames),
                      });
                    }}
                  />
                </label>
                <label>
                  원본 끝 (초, 비우면 전체)
                  <input
                    type="number"
                    min={(c.audioTrimStartFrames ?? 0) / c.fps + 1 / c.fps}
                    step={1 / c.fps}
                    value={c.audioTrimEndFrames === undefined ? '' : c.audioTrimEndFrames / c.fps}
                    onChange={(e) =>
                      change({
                        ...c,
                        audioTrimEndFrames:
                          e.target.value === ''
                            ? undefined
                            : Math.max(
                                (c.audioTrimStartFrames ?? 0) + 1,
                                Math.round(numeric(e.target.value) * c.fps),
                              ),
                      })
                    }
                  />
                </label>
                <label>
                  페이드 인 (초)
                  <input
                    type="number"
                    min={0}
                    max={36000 / c.fps}
                    step={0.1}
                    value={(c.audioFadeInFrames ?? 0) / c.fps}
                    onChange={(e) =>
                      change({
                        ...c,
                        audioFadeInFrames: Math.max(
                          0,
                          Math.min(36000, Math.round(numeric(e.target.value) * c.fps)),
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  페이드 아웃 (초)
                  <input
                    type="number"
                    min={0}
                    max={36000 / c.fps}
                    step={0.1}
                    value={(c.audioFadeOutFrames ?? 0) / c.fps}
                    onChange={(e) =>
                      change({
                        ...c,
                        audioFadeOutFrames: Math.max(
                          0,
                          Math.min(36000, Math.round(numeric(e.target.value) * c.fps)),
                        ),
                      })
                    }
                  />
                </label>
              </div>
            )}
            <small>
              선택한 원본 구간을 타임라인 0초부터 재생합니다. 페이드 아웃은 실제 원본·잘라낸
              구간·영상 중 먼저 끝나는 시점에 적용합니다.
            </small>
            <small>
              오디오·이미지·영상은 자산 라이브러리에서 먼저 업로드하세요. 영상 레이어의 원래 소리는
              끄고 이 오디오 트랙을 사용합니다.
            </small>
            {!!c.captions?.length && (
              <details>
                <summary>자막 {c.captions.length}개 편집</summary>
                {c.captions.map((caption, i) => (
                  <div className="motion-caption-row" key={i}>
                    <input
                      aria-label={`자막 ${i + 1} 시작 초`}
                      type="number"
                      min={0}
                      step={0.1}
                      value={caption.start}
                      onChange={(e) =>
                        change({
                          ...c,
                          captions: c.captions?.map((v, j) =>
                            i === j
                              ? {
                                  ...v,
                                  start: Math.max(0, numeric(e.target.value)),
                                  end: Math.max(
                                    v.end,
                                    Math.max(0, numeric(e.target.value)) + 1 / c.fps,
                                  ),
                                }
                              : v,
                          ),
                        })
                      }
                    />
                    <input
                      aria-label={`자막 ${i + 1} 종료 초`}
                      type="number"
                      min={0}
                      step={0.1}
                      value={caption.end}
                      onChange={(e) =>
                        change({
                          ...c,
                          captions: c.captions?.map((v, j) =>
                            i === j
                              ? {
                                  ...v,
                                  end: Math.max(v.start + 1 / c.fps, numeric(e.target.value)),
                                }
                              : v,
                          ),
                        })
                      }
                    />
                    <textarea
                      aria-label={`자막 ${i + 1} 내용`}
                      value={caption.text}
                      onChange={(e) =>
                        change({
                          ...c,
                          captions: c.captions?.map((v, j) =>
                            i === j ? { ...v, text: e.target.value } : v,
                          ),
                        })
                      }
                    />
                    <button
                      onClick={() =>
                        change({ ...c, captions: c.captions?.filter((_, j) => i !== j) })
                      }
                    >
                      삭제
                    </button>
                  </div>
                ))}
              </details>
            )}
          </div>
        </main>

        <aside className="motion-inspector">
          {scene ? (
            <>
              <h3>장면 속성</h3>
              <label>
                이름
                <input value={scene.name} onChange={(e) => changeScene({ name: e.target.value })} />
              </label>
              <div className="motion-fields">
                <label>
                  길이 (초)
                  <input
                    type="number"
                    min={1 / c.fps}
                    max={600}
                    step={1 / c.fps}
                    value={Math.round((scene.durationFrames / c.fps) * 1000) / 1000}
                    onChange={(e) => {
                      const frames = Math.max(
                        1,
                        Math.min(600 * c.fps, Math.round(numeric(e.target.value, 1) * c.fps)),
                      );
                      changeScene(resizeSceneDuration(scene, frames));
                    }}
                  />
                </label>
                <label>
                  장면 효과
                  <select
                    value={scene.effect}
                    onChange={(e) => changeScene({ effect: e.target.value })}
                  >
                    <EffectOptions scene />
                  </select>
                </label>
              </div>
              <EffectSettingsControls
                settings={scene.effectSettings}
                onChange={(effectSettings) => changeScene({ effectSettings })}
              />
              <h3>레이어 추가</h3>
              <div className="motion-add-layers">
                {(
                  [
                    ['text', '텍스트'],
                    ['shape', '도형'],
                    ['image', '이미지'],
                    ['video', '영상'],
                    ['chart', '차트'],
                    ['table', '표'],
                  ] as const
                ).map(([type, name]) => (
                  <button key={type} onClick={() => addLayer(type)}>
                    {name}
                  </button>
                ))}
              </div>
              <label>
                선택 레이어
                <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
                  <option value="">레이어를 선택하세요</option>
                  {scene.elements.map((e, i) => (
                    <option value={e.id} key={e.id}>
                      {i + 1}. {e.text?.slice(0, 20) || e.type}
                    </option>
                  ))}
                </select>
              </label>
              {selected && (
                <div className="motion-layer-properties">
                  <h3>{selected.type} 속성</h3>
                  <div className="motion-fields">
                    {numField('X', 'x')}
                    {numField('Y', 'y')}
                    {numField('폭', 'w', 1)}
                    {numField('높이', 'h', 1)}
                    {numField('회전', 'rotation', -360, 360)}
                    {numField('불투명도', 'opacity', 0, 1, 0.05)}
                  </div>
                  {selected.type === 'text' && (
                    <>
                      <label>
                        내용
                        <textarea
                          rows={3}
                          value={selected.text ?? ''}
                          onChange={(e) => changeElement(selected.id, { text: e.target.value })}
                        />
                      </label>
                      <div className="motion-fields">
                        {numField('글자 크기', 'fontSize', 8, 600)}
                        <label>
                          굵기
                          <select
                            value={selected.fontWeight ?? 400}
                            onChange={(e) =>
                              changeElement(selected.id, { fontWeight: Number(e.target.value) })
                            }
                          >
                            <option value={400}>보통</option>
                            <option value={600}>중간</option>
                            <option value={700}>굵게</option>
                            <option value={900}>매우 굵게</option>
                          </select>
                        </label>
                      </div>
                    </>
                  )}
                  {selected.type === 'shape' && (
                    <label>
                      도형
                      <select
                        value={selected.shape ?? 'rect'}
                        onChange={(e) =>
                          changeElement(selected.id, {
                            shape: e.target.value as StudioElement['shape'],
                          })
                        }
                      >
                        <option value="rect">사각형</option>
                        <option value="ellipse">원형</option>
                        <option value="line">선</option>
                      </select>
                    </label>
                  )}
                  <div className="motion-fields">
                    <label>
                      글자색
                      <input
                        value={selected.color ?? ''}
                        placeholder="$color.text"
                        onChange={(e) =>
                          changeElement(selected.id, { color: e.target.value || undefined })
                        }
                      />
                    </label>
                    <label>
                      채움색
                      <input
                        value={selected.fill ?? ''}
                        placeholder="$color.accent"
                        onChange={(e) =>
                          changeElement(selected.id, { fill: e.target.value || undefined })
                        }
                      />
                    </label>
                  </div>
                  {(selected.type === 'image' || selected.type === 'video') && (
                    <>
                      <label>
                        자산
                        <select
                          value={selected.assetId ?? ''}
                          onChange={(e) =>
                            changeElement(selected.id, { assetId: e.target.value || undefined })
                          }
                        >
                          <option value="">선택하세요</option>
                          {project.assets
                            .filter((a) =>
                              a.mime.startsWith(selected.type === 'image' ? 'image/' : 'video/'),
                            )
                            .map((a) => (
                              <option value={a.id} key={a.id}>
                                {a.name}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label>
                        대체 설명
                        <input
                          value={selected.alt ?? ''}
                          onChange={(e) => changeElement(selected.id, { alt: e.target.value })}
                        />
                      </label>
                    </>
                  )}
                  {selected.type === 'chart' && (
                    <>
                      <label>
                        차트
                        <select
                          value={selected.chartData?.type ?? 'bar'}
                          onChange={(e) =>
                            changeElement(selected.id, {
                              chartData: {
                                labels: selected.chartData?.labels ?? [],
                                values: selected.chartData?.values ?? [],
                                type: e.target.value as 'bar' | 'line' | 'pie',
                              },
                            })
                          }
                        >
                          <option value="bar">막대</option>
                          <option value="line">선</option>
                          <option value="pie">원형</option>
                        </select>
                      </label>
                      <label>
                        라벨 (쉼표 구분)
                        <input
                          value={selected.chartData?.labels.join(', ') ?? ''}
                          onChange={(e) =>
                            changeElement(selected.id, {
                              chartData: {
                                ...selected.chartData!,
                                labels: e.target.value.split(',').map((v) => v.trim()),
                              },
                            })
                          }
                        />
                      </label>
                      <label>
                        값 (쉼표 구분)
                        <input
                          value={selected.chartData?.values.join(', ') ?? ''}
                          onChange={(e) =>
                            changeElement(selected.id, {
                              chartData: {
                                ...selected.chartData!,
                                values: e.target.value.split(',').map((v) => numeric(v.trim())),
                              },
                            })
                          }
                        />
                      </label>
                    </>
                  )}
                  {selected.type === 'table' && (
                    <label>
                      표 (줄=행, 탭=셀)
                      <textarea
                        rows={5}
                        value={selected.tableData?.map((r) => r.join('\t')).join('\n') ?? ''}
                        onChange={(e) =>
                          changeElement(selected.id, {
                            tableData: e.target.value.split('\n').map((r) => r.split('\t')),
                          })
                        }
                      />
                    </label>
                  )}
                  <label>
                    레이어 효과
                    <select
                      value={selected.effect ?? 'none'}
                      onChange={(e) => changeElement(selected.id, { effect: e.target.value })}
                    >
                      <EffectOptions scene={selected.type !== 'text'} />
                    </select>
                  </label>
                  <EffectSettingsControls
                    settings={selected.effectSettings}
                    onChange={(effectSettings) => changeElement(selected.id, { effectSettings })}
                  />
                  <div className="motion-fields">
                    <label>
                      시작 프레임
                      <input
                        type="number"
                        min={0}
                        max={scene.durationFrames - 1}
                        value={selected.startFrame ?? 0}
                        onChange={(e) => {
                          const startFrame = Math.max(
                            0,
                            Math.min(scene.durationFrames - 1, Math.round(numeric(e.target.value))),
                          );
                          changeElement(selected.id, {
                            startFrame,
                            endFrame: Math.max(
                              startFrame + 1,
                              selected.endFrame ?? scene.durationFrames,
                            ),
                          });
                        }}
                      />
                    </label>
                    <label>
                      종료 프레임
                      <input
                        type="number"
                        min={(selected.startFrame ?? 0) + 1}
                        max={scene.durationFrames}
                        value={selected.endFrame ?? scene.durationFrames}
                        onChange={(e) =>
                          changeElement(selected.id, {
                            endFrame: Math.max(
                              (selected.startFrame ?? 0) + 1,
                              Math.min(scene.durationFrames, Math.round(numeric(e.target.value))),
                            ),
                          })
                        }
                      />
                    </label>
                  </div>
                  <label className="motion-checkbox">
                    <input
                      type="checkbox"
                      checked={!!selected.locked}
                      onChange={(e) => changeElement(selected.id, { locked: e.target.checked })}
                    />
                    캔버스에서 위치 잠금
                  </label>
                  <div className="motion-small-actions">
                    <button
                      onClick={() => {
                        const elements = [...scene.elements],
                          i = elements.findIndex((e) => e.id === selected.id);
                        if (i < elements.length - 1) {
                          [elements[i], elements[i + 1]] = [elements[i + 1], elements[i]];
                          changeScene({ elements });
                        }
                      }}
                    >
                      앞으로
                    </button>
                    <button
                      onClick={() => {
                        const elements = [...scene.elements],
                          i = elements.findIndex((e) => e.id === selected.id);
                        if (i > 0) {
                          [elements[i], elements[i - 1]] = [elements[i - 1], elements[i]];
                          changeScene({ elements });
                        }
                      }}
                    >
                      뒤로
                    </button>
                    <button
                      onClick={() => {
                        const copy = {
                          ...structuredClone(selected),
                          id: uid(),
                          x: selected.x + 24,
                          y: selected.y + 24,
                        };
                        changeScene({ elements: [...scene.elements, copy] });
                        setSelectedId(copy.id);
                      }}
                    >
                      복제
                    </button>
                    <button
                      className="danger"
                      onClick={() => {
                        changeScene({
                          elements: scene.elements.filter((e) => e.id !== selected.id),
                        });
                        setSelectedId('');
                      }}
                    >
                      삭제
                    </button>
                  </div>
                  <details className="motion-keys" open>
                    <summary>
                      키프레임 · {Math.max(0, Math.min(scene.durationFrames - 1, localFrame))} f
                    </summary>
                    <div className="motion-fields">
                      <label>
                        속성
                        <select
                          value={keyProperty}
                          onChange={(e) => {
                            setKeyProperty(e.target.value as Keyframe['property']);
                            setKeyValue(
                              e.target.value === 'color'
                                ? '#ffffff'
                                : e.target.value === 'opacity' || e.target.value === 'scale'
                                  ? '1'
                                  : '0',
                            );
                          }}
                        >
                          {['x', 'y', 'opacity', 'rotation', 'scale', 'color'].map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        값<input value={keyValue} onChange={(e) => setKeyValue(e.target.value)} />
                      </label>
                    </div>
                    <label>
                      도착 이징
                      <select
                        value={keyEasing}
                        onChange={(e) => setKeyEasing(e.target.value as Keyframe['easing'])}
                      >
                        <option value="linear">선형</option>
                        <option value="easeIn">천천히 출발</option>
                        <option value="easeOut">천천히 도착</option>
                        <option value="easeInOut">부드럽게</option>
                      </select>
                    </label>
                    <button onClick={addKey}>현재 프레임에 저장</button>
                    <small>같은 속성의 키 두 개를 추가하면 그 사이를 보간합니다.</small>
                    {selected.keyframes?.map((k, i) => (
                      <div className="motion-key-row" key={i}>
                        <button onClick={() => seek(sceneOffset + k.frame)}>
                          {k.frame}f · {k.property} = {k.value}
                        </button>
                        <button
                          aria-label={`${k.frame} 프레임 ${k.property} 삭제`}
                          onClick={() =>
                            changeElement(selected.id, {
                              keyframes: selected.keyframes?.filter((_, j) => i !== j),
                            })
                          }
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </details>
                </div>
              )}
            </>
          ) : (
            <p>장면을 추가한 뒤 속성을 편집하세요.</p>
          )}
        </aside>
      </div>
      {notice && (
        <div className="motion-notice" role="status">
          {notice}
          <button onClick={() => setNotice('')}>닫기</button>
        </div>
      )}
    </div>
  );
}
export default MotionEditor;
