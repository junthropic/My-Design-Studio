import React from 'react';
import type { EffectSettings } from '../core/types';

export function EffectSettingsControls({
  settings = {},
  onChange,
}: {
  settings?: EffectSettings;
  onChange: (settings: EffectSettings | undefined) => void;
}) {
  const number = (
    key: 'durationFrames' | 'delayFrames' | 'intensity',
    value: string,
    min: number,
    max: number,
  ) =>
    onChange({
      ...settings,
      [key]: value === '' ? undefined : Math.max(min, Math.min(max, Number(value) || 0)),
    });
  return (
    <details className="motion-effect-settings">
      <summary>효과 세부 설정</summary>
      <div className="motion-fields">
        <label>
          길이 / 반복 주기 (프레임)
          <input
            type="number"
            min={1}
            max={36000}
            step={1}
            value={settings.durationFrames ?? ''}
            placeholder="효과 기본값"
            onChange={(e) =>
              number(
                'durationFrames',
                e.target.value ? String(Math.round(Number(e.target.value))) : '',
                1,
                36000,
              )
            }
          />
        </label>
        <label>
          시작 지연 (프레임)
          <input
            type="number"
            min={0}
            max={36000}
            step={1}
            value={settings.delayFrames ?? 0}
            onChange={(e) =>
              number('delayFrames', String(Math.round(Number(e.target.value))), 0, 36000)
            }
          />
        </label>
        <label>
          강도 (0~2)
          <input
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={settings.intensity ?? 1}
            onChange={(e) => number('intensity', e.target.value, 0, 2)}
          />
        </label>
        <label>
          방향
          <select
            value={settings.direction ?? 'auto'}
            onChange={(e) =>
              onChange({ ...settings, direction: e.target.value as EffectSettings['direction'] })
            }
          >
            <option value="auto">효과 기본 방향</option>
            <option value="left">왼쪽</option>
            <option value="right">오른쪽</option>
            <option value="up">위</option>
            <option value="down">아래</option>
          </select>
        </label>
        <label>
          이징
          <select
            value={settings.easing ?? ''}
            onChange={(e) =>
              onChange({
                ...settings,
                easing: (e.target.value || undefined) as EffectSettings['easing'],
              })
            }
          >
            <option value="">효과 기본값</option>
            <option value="linear">선형</option>
            <option value="easeIn">천천히 출발</option>
            <option value="easeOut">천천히 도착</option>
            <option value="easeInOut">부드럽게</option>
          </select>
        </label>
        <button onClick={() => onChange(undefined)}>기본 설정 복원</button>
      </div>
      <small>
        방향은 이동·와이프, 이징은 등장·퇴장·진행 효과에 적용합니다. 반복 효과의 길이는 한
        주기입니다. 지연·길이가 장면보다 길면 효과가 끝나기 전에 장면이 종료됩니다.
      </small>
    </details>
  );
}
