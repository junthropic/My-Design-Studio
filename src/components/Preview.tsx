import React from 'react';
import type { Project, StylePreset } from '../core/types';
import { resolveDesign } from '../core/design';
export function MiniPreview({
  project,
  style,
  kind = 'web',
  large = false,
}: {
  project: Project;
  style?: StylePreset;
  kind?: string;
  large?: boolean;
}) {
  const p = style ? { ...project, styleId: style.id, overrides: { light: {}, dark: {} } } : project;
  const d = resolveDesign(p);
  const t = d.tokens;
  const css = {
    '--pv-font': t['font.family'],
    '--pv-bg': t['color.bg'],
    '--pv-surface': t['color.surface'],
    '--pv-text': t['color.text'],
    '--pv-muted': t['color.muted'],
    '--pv-accent': t['color.accent'],
    '--pv-border': t['color.border'],
    '--pv-radius': `${Math.min(Number(t['radius.card']), 16)}px`,
  } as React.CSSProperties;
  return (
    <div
      className={`mini-preview ${large ? 'large' : ''} variant-${style?.id || project.styleId} kind-${kind}`}
      style={css}
    >
      <div className="mini-top">
        <span className="mini-brand">
          <i />
          {project.brand.name}
        </span>
        <span>
          Work <b>About</b> ↗
        </span>
      </div>
      {kind === 'ppt' ? (
        <div className="mini-slide">
          <small>DESIGN THAT CONNECTS</small>
          <h3>
            생각을 디자인으로.
            <br />
            경험을 더 선명하게.
          </h3>
          <div className="mini-slide-rule" />
          <p>Brand direction / {project.brand.name}</p>
          <div className="mini-orbit" />
        </div>
      ) : kind === 'motion' ? (
        <div className="mini-motion">
          <div className="mini-orbit" />
          <small>FRAME / 001</small>
          <h3>
            Make
            <br />
            <em>your move.</em>
          </h3>
          <div className="mini-timeline">
            <span />
            <span />
            <span />
          </div>
        </div>
      ) : (
        <>
          <div className="mini-hero">
            <div>
              <small>INDEPENDENT DESIGN STUDIO</small>
              <h3>
                새로운 관점,
                <br />
                <em>선명한 경험.</em>
              </h3>
              <p>브랜드의 생각을 형태로 만듭니다.</p>
              <span className="mini-cta">
                작업 살펴보기 <span>↗</span>
              </span>
            </div>
            <div className="mini-art">
              <div />
              <i />
              <b />
            </div>
          </div>
          <div className="mini-metrics">
            <div>
              <strong>12</strong>
              <span>Projects</span>
            </div>
            <div>
              <strong>06</strong>
              <span>Collections</span>
            </div>
            <div>
              <div className="mini-bars">
                {[26, 43, 35, 60, 49, 77, 92].map((h, i) => (
                  <i key={i} style={{ height: h + '%' }} />
                ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
