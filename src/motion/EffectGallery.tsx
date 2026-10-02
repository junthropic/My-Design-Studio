import React, { useEffect, useState } from 'react';
import { EFFECTS, EFFECT_CATEGORIES, computeEffect, visibleText } from './effects';
import type { EffectSettings } from '../core/types';
import { EffectSettingsControls } from './EffectSettingsControls';

interface Props {
  selectedEffect: string;
  selectedKind: string;
  onApply: (effect: string) => void;
  reducedMotion: boolean;
  settings?: EffectSettings;
  onSettingsChange: (settings: EffectSettings | undefined) => void;
  durationFrames: number;
  fps: number;
}

/** All thumbnails share one clock and the same pure evaluator used by export. */
export function EffectGallery({
  selectedEffect,
  selectedKind,
  onApply,
  reducedMotion,
  settings,
  onSettingsChange,
  durationFrames,
  fps,
}: Props) {
  const [category, setCategory] = useState('all'),
    [frame, setFrame] = useState(15),
    [playing, setPlaying] = useState(false),
    [open, setOpen] = useState(true);
  useEffect(() => {
    if (!playing || !open || reducedMotion) return;
    const timer = window.setInterval(
      () => setFrame((value) => (value + 1) % durationFrames),
      1000 / fps,
    );
    return () => window.clearInterval(timer);
  }, [playing, open, reducedMotion, durationFrames, fps]);
  const effects = EFFECTS.filter((effect) => category === 'all' || effect.category === category);
  return (
    <details
      className="motion-effect-gallery"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <strong>효과 갤러리</strong>
        <span>24개 효과 · 6개 분류</span>
      </summary>
      <div className="motion-effect-toolbar">
        <div className="motion-effect-categories">
          <button aria-pressed={category === 'all'} onClick={() => setCategory('all')}>
            전체
          </button>
          {Object.entries(EFFECT_CATEGORIES).map(([id, name]) => (
            <button key={id} aria-pressed={category === id} onClick={() => setCategory(id)}>
              {name}
            </button>
          ))}
        </div>
        <button disabled={reducedMotion} onClick={() => setPlaying((value) => !value)}>
          {playing && !reducedMotion ? '미리보기 정지' : '효과 재생'}
        </button>
        <input
          type="range"
          aria-label="효과 갤러리 프레임"
          min={0}
          max={durationFrames - 1}
          value={Math.min(frame, durationFrames - 1)}
          onChange={(event) => {
            setPlaying(false);
            setFrame(Number(event.target.value));
          }}
        />
        <output>{Math.min(frame, durationFrames - 1)} f</output>
      </div>
      <p>
        {selectedKind === 'scene'
          ? '카드를 누르면 현재 장면에 적용합니다. 타이포 효과는 텍스트 레이어를 선택하세요.'
          : '카드를 누르면 선택한 레이어에 적용합니다.'}{' '}
        {reducedMotion ? '동작 줄이기가 켜져 있습니다. 슬라이더로 효과를 확인할 수 있습니다.' : ''}
      </p>
      <div className="motion-effect-grid">
        {effects.map((effect) => {
          const fx = computeEffect(
              effect.id,
              Math.min(frame, durationFrames - 1),
              durationFrames,
              fps,
              settings,
            ),
            disabled = effect.category === 'text' && selectedKind !== 'text';
          return (
            <button
              key={effect.id}
              className={`motion-effect-card ${selectedEffect === effect.id ? 'active' : ''}`}
              disabled={disabled}
              onClick={() => onApply(effect.id)}
              title={disabled ? '텍스트 레이어를 선택해 적용하세요.' : effect.description}
              aria-label={`${effect.name} 효과 적용`}
            >
              <span className="motion-effect-preview">
                <span
                  style={{
                    opacity: fx.opacity ?? 1,
                    transform: `translate(${(fx.x ?? 0) * 0.35}px,${(fx.y ?? 0) * 0.35}px) rotate(${fx.rotation ?? 0}deg) scale(${fx.scale ?? 1})`,
                    filter: fx.blur ? `blur(${fx.blur * 0.2}px)` : undefined,
                    clipPath: fx.clipPath,
                    letterSpacing: (fx.letterSpacing ?? 0) * 0.3,
                  }}
                >
                  {effect.category === 'text' ? (
                    visibleText('나의 디자인', fx.visibleProgress ?? 1, fx.wordReveal)
                  ) : (
                    <>
                      <i />
                      <b>Design</b>
                    </>
                  )}
                </span>
              </span>
              <strong>{effect.name}</strong>
              <small>{effect.description}</small>
            </button>
          );
        })}
      </div>
      <EffectSettingsControls settings={settings} onChange={onSettingsChange} />
    </details>
  );
}
