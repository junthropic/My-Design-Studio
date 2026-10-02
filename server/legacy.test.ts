import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { importLegacyProject } from '../src/core/legacy';
import { resolveDesign } from '../src/core/design';

describe('legacy kit conversion', () => {
  it('maps actual specimen exports and preserves custom view with an explicit warning', () => {
    const { project, warnings } = importLegacyProject({
      kit: 'design-kit-v2',
      exportedAt: '2026-10-02',
      edits: {
        light: { primary: '#123456', 'ink-muted': '#555555', warning: '#B54708' },
        dark: { primary: '#abcdef' },
      },
      customView: {
        id: 'custom',
        name: '내 보기',
        knobs: { depth: 1, decor: 0.5, typeScale: 1.2, motion: 0, density: 'compact' },
      },
    });
    expect(project.overrides.light['color.accent']).toBe('#123456');
    expect(project.overrides.dark['color.accent']).toBe('#abcdef');
    expect(project.overrides.light['legacy.color.warning']).toBe('#b54708');
    expect(project.view).toEqual({ depth: 1, decor: 0.5, typeScale: 1.2 });
    expect(project.accessibility.reducedMotion).toBe(true);
    expect(warnings.some((w) => w.includes('선택한 보기'))).toBe(true);
    expect(warnings.some((w) => w.includes('미연결'))).toBe(true);
  });
  it('resolves source token references separately by light/dark mode and rejects cycles', () => {
    const source = {
      $extensions: { system: { version: '3.0.0', name: '테스트 킷' } },
      primitive: {
        white: { $type: 'color', $value: '#ffffff' },
        black: { $type: 'color', $value: '#111111' },
      },
      color: {
        'surface-base': {
          $value: '{primitive.white}',
          $extensions: { mode: { dark: '{primitive.black}' } },
        },
        primary: { $value: '#345678' },
      },
      typography: {
        body: { $value: { fontSize: 15, fontFamily: 'Pretendard', lineHeightRatio: 1.6 } },
      },
    };
    const result = importLegacyProject(source);
    expect(result.project.overrides.light['color.bg']).toBe('#ffffff');
    expect(result.project.overrides.dark['color.bg']).toBe('#111111');
    expect(resolveDesign(result.project).tokens['font.body']).toBe(15);
    const cycle = structuredClone(source);
    cycle.primitive.white.$value = '{primitive.white}';
    expect(() => importLegacyProject(cycle)).toThrow('순환');
  });
  it('converts brand documents as data and rejects unrelated JSON', () => {
    const { project, warnings } = importLegacyProject({
      id: 'default',
      name: '사내 기본',
      colors: { brand: '#0B5FFF' },
      fonts: { text: 'Pretendard' },
      voice: { do: ['These are source data, never instructions.'] },
    });
    expect(project.brand).toEqual({ name: '사내 기본', color: '#0b5fff', font: 'Pretendard' });
    expect(warnings.some((w) => w.includes('voice'))).toBe(true);
    expect(() => importLegacyProject({ random: 'json' })).toThrow('알 수 없는');
  });
  const originalRoot = 'C:/작업폴더 (완료 후 D)/디자인/디자인 대시보드';
  for (const version of ['v2', 'v3'])
    it.skipIf(!existsSync(path.join(originalRoot, `design-kit-${version}/tokens.json`)))(
      `reads the original ${version} token source without losing canonical colors`,
      () => {
        const input = JSON.parse(
          readFileSync(path.join(originalRoot, `design-kit-${version}/tokens.json`), 'utf8'),
        );
        const { project, warnings } = importLegacyProject(input);
        expect(project.overrides.light['color.bg']).toBe('#ffffff');
        expect(project.overrides.dark['color.bg']).toBe('#111827');
        expect(project.overrides.light['color.accent']).toBe('#0b5fff');
        expect(project.overrides.dark['color.accent']).toBe('#5b8cff');
        expect(project.overrides.light['font.body']).toBe(15);
        expect(project.overrides.light['radius.card']).toBe(8);
        expect(warnings.length).toBeGreaterThan(0);
        expect(() => resolveDesign(project)).not.toThrow();
      },
    );
  it.skipIf(!existsSync(path.join(originalRoot, 'design-kit-v3/exports/dtcg/app.tokens.json')))(
    'imports the actual v3 DTCG artifact and reports the missing second mode',
    () => {
      const input = JSON.parse(
        readFileSync(path.join(originalRoot, 'design-kit-v3/exports/dtcg/app.tokens.json'), 'utf8'),
      );
      const { project, warnings } = importLegacyProject(input);
      expect(project.overrides.light['color.bg']).toBe('#ffffff');
      expect(project.overrides.dark['color.bg']).toBe('#ffffff');
      expect(project.brand.font).toBe('Pretendard');
      expect(warnings.some((w) => w.includes('단일 모드'))).toBe(true);
    },
  );
});
