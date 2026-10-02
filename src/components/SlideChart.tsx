import type { StudioElement } from '../core/types';
export function SlideChart({
  element: e,
  tokens: t,
}: {
  element: StudioElement;
  tokens: Record<string, string | number>;
}) {
  const data = e.chartData;
  if (!data?.values.length) return null;
  const ink = String(t['color.muted']),
    accent = String(t['color.accent']),
    values = data.values;
  if (data.type === 'pie') {
    const total = values.reduce((n, v) => n + Math.max(0, v), 0);
    if (total <= 0) return null;
    let angle = -Math.PI / 2;
    const radius = Math.max(1, Math.min(e.w * 0.35, e.h * 0.42)),
      cx = e.x + e.w * 0.35,
      cy = e.y + e.h / 2;
    return (
      <g>
        {values.map((v, i) => {
          const share = Math.max(0, v) / total,
            start = angle,
            end = angle + share * Math.PI * 2;
          angle = end;
          const x1 = cx + radius * Math.cos(start),
            y1 = cy + radius * Math.sin(start),
            x2 = cx + radius * Math.cos(end),
            y2 = cy + radius * Math.sin(end);
          return (
            <g key={i}>
              {share === 1 ? (
                <circle cx={cx} cy={cy} r={radius} fill={accent} />
              ) : (
                <path
                  d={`M${cx} ${cy} L${x1} ${y1} A${radius} ${radius} 0 ${share > 0.5 ? 1 : 0} 1 ${x2} ${y2} Z`}
                  fill={accent}
                  opacity={0.35 + (0.65 * (i + 1)) / values.length}
                />
              )}
              <text x={e.x + e.w * 0.73} y={e.y + 25 + i * 26} fill={ink} fontSize={14}>
                {data.labels[i]} {Math.round(share * 100)}%
              </text>
            </g>
          );
        })}
      </g>
    );
  }
  const min = Math.min(0, ...values),
    max = Math.max(1, ...values),
    height = e.h - 45,
    base = e.y + height - (max / (max - min)) * height + (max / (max - min)) * height;
  const y = (v: number) => e.y + height - ((v - min) / (max - min)) * height,
    zero = y(0),
    bw = e.w / values.length;
  return (
    <g>
      <line x1={e.x} y1={zero} x2={e.x + e.w} y2={zero} stroke={String(t['color.border'])} />
      {data.type === 'line' && (
        <polyline
          points={values.map((v, i) => `${e.x + bw * (i + 0.5)},${y(v)}`).join(' ')}
          fill="none"
          stroke={accent}
          strokeWidth={4}
        />
      )}{' '}
      {values.map((v, i) => (
        <g key={i}>
          {data.type === 'line' ? (
            <circle cx={e.x + bw * (i + 0.5)} cy={y(v)} r={5} fill={accent} />
          ) : (
            <rect
              x={e.x + i * bw + 8}
              y={Math.min(y(v), zero)}
              width={Math.max(1, bw - 20)}
              height={Math.max(0.1, Math.abs(y(v) - zero))}
              rx={3}
              fill={accent}
              opacity={0.5 + (0.5 * (i + 1)) / values.length}
            />
          )}
          <text
            x={e.x + bw * (i + 0.5)}
            y={e.y + e.h - 10}
            fill={ink}
            textAnchor="middle"
            fontSize={14}
          >
            {data.labels[i]}
          </text>
        </g>
      ))}
    </g>
  );
}
