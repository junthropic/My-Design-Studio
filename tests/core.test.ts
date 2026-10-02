import { describe, it, expect } from 'vitest';
import { createProject } from '../src/core/templates';
import { resolveDesign, resolveReferences, contrast, toDTCG } from '../src/core/design';
import { ProjectSchema } from '../src/core/schema';
import { STYLES } from '../src/core/presets';
import { useStudio } from '../src/store';

describe('Shared design contract', () => {
  it('all starter styles and default documents validate', () => {
    for (const style of STYLES) {
      const p = createProject();
      p.styleId = style.id;
      expect(ProjectSchema.safeParse(p).success).toBe(true);
    }
  });
  it('view adjustment is applied once before project overrides, including after JSON reopen', () => {
    const p = createProject();
    p.view.depth = 1;
    p.overrides.dark['color.bg'] = '#141b2a';
    const reopened = ProjectSchema.parse(JSON.parse(JSON.stringify(p)));
    expect(resolveDesign(p).tokens).toEqual(resolveDesign(reopened).tokens);
    expect(resolveDesign(p).tokens['color.bg']).toBe('#141b2a');
  });
  it('editing light mode never changes dark overrides', () => {
    const p = createProject(),
      before = resolveDesign(p, 'web', 'dark').tokens;
    p.overrides.light['color.bg'] = '#eeeeee';
    expect(resolveDesign(p, 'web', 'dark').tokens).toEqual(before);
  });
  it('brand original is retained while derived accent remains readable', () => {
    const p = createProject();
    p.brand.color = '#1b2133';
    const d = resolveDesign(p);
    expect(d.brandOriginal).toBe('#1b2133');
    expect(
      contrast(String(d.tokens['color.accent']), String(d.tokens['color.surface'])),
    ).toBeGreaterThanOrEqual(4.5);
  });
  it('aliases observe the final derived accent', () => {
    const p = createProject();
    p.brand.color = '#1b2133';
    p.overrides.dark['color.text'] = '{color.accent}';
    const d = resolveDesign(p);
    expect(d.tokens['color.text']).toBe(d.tokens['color.accent']);
  });
  it('rejects missing, circular, inherited and wrong-type references before applying an import', () => {
    expect(() => resolveReferences({ a: '{missing}' })).toThrow();
    expect(() => resolveReferences({ a: '{b}', b: '{a}' })).toThrow();
    expect(() => resolveReferences({ a: '{constructor}' })).toThrow();
    const p = createProject();
    p.overrides.dark['font.body'] = '{color.text}';
    expect(ProjectSchema.safeParse(p).success).toBe(false);
    p.overrides.dark = { 'color.text': '{color.bg}', 'color.bg': '{color.text}' };
    expect(ProjectSchema.safeParse(p).success).toBe(false);
  });
  it('rejects out-of-range numbers, unsupported versions and path traversal', () => {
    const p = createProject();
    p.overrides.dark['effect.blur'] = -1;
    expect(ProjectSchema.safeParse(p).success).toBe(false);
    expect(ProjectSchema.safeParse({ ...createProject(), schemaVersion: 99 }).success).toBe(false);
    p.overrides.dark = {};
    p.assets = [
      { id: 'test', name: 'x', mime: 'image/png', hash: 'hash', size: 12, relativePath: '../x' },
    ];
    expect(ProjectSchema.safeParse(p).success).toBe(false);
  });
  it('DTCG typography uses unitless line-height and explicit letter-spacing units', () => {
    const p = createProject(),
      dt = toDTCG(p);
    expect(dt.dark.typography.body.$value.lineHeight).toBe(1.55);
    expect(dt.dark.typography.body.$value.letterSpacing).toEqual({ value: 0, unit: 'px' });
    expect(dt.dark.color.text.$value.components).toHaveLength(3);
  });
  it('accessibility settings override project appearance and record their source', () => {
    const p = createProject();
    p.overrides.dark['color.bg'] = '#aabbcc';
    p.accessibility.highContrast = true;
    p.accessibility.reducedMotion = true;
    const d = resolveDesign(p);
    expect(d.tokens['color.bg']).toBe('#000000');
    expect(d.tokens['motion.duration']).toBe(0);
    expect(d.sources['color.bg']).toContain('고대비');
  });
  it('undo after a save keeps the current revision for optimistic writes', () => {
    const p = createProject();
    useStudio.getState().setProject(p);
    useStudio.getState().change({ ...p, name: 'Changed' });
    useStudio.getState().markSaved(8, new Date().toISOString());
    useStudio.getState().undo();
    expect(useStudio.getState().project?.name).toBe(p.name);
    expect(useStudio.getState().project?.revision).toBe(8);
    useStudio.getState().redo();
    expect(useStudio.getState().project?.name).toBe('Changed');
  });
});
