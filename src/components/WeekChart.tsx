import { useEffect, useRef, useState } from 'react';
import { formatShortDate, formatWeekday } from '../domain/dates';
import type { DayStats } from '../domain/reports';

interface WeekChartProps {
  data: DayStats[];
  selectedDate: string;
  today: string;
  /** Names what is counted, for the accessible description, for example "All OPDs". */
  scopeLabel: string;
  onSelect: (date: string) => void;
}

const HEIGHT = 280;
const MARGIN = { top: 28, right: 12, bottom: 48, left: 40 };
const BAR_MAX = 24; // Columns are never thicker than this.
const BAR_RADIUS = 4;

/** Round tick step so the axis ends on a clean number, with at most about five gridlines. */
function niceScale(max: number): { top: number; step: number } {
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500];
  const step = steps.find((s) => Math.ceil(Math.max(max, 1) / s) <= 5) ?? 500;
  return { top: Math.max(step, Math.ceil(max / step) * step), step };
}

/** A column with a rounded top and a square bottom, so it sits flat on the baseline. */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(BAR_RADIUS, h, w / 2);
  return [
    `M${x},${y + h}`,
    `L${x},${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `L${x + w - r},${y}`,
    `Q${x + w},${y} ${x + w},${y + r}`,
    `L${x + w},${y + h}`,
    'Z',
  ].join(' ');
}

function useContainerWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(280, Math.floor(el.getBoundingClientRect().width)));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/**
 * Seven day column chart. One series, so the chosen day is emphasised in the accent colour
 * and there is no legend. Every value is also available in the table view next to the chart.
 */
export function WeekChart({ data, selectedDate, today, scopeLabel, onSelect }: WeekChartProps) {
  const [ref, width] = useContainerWidth();
  const [active, setActive] = useState<number | null>(null);

  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const { top, step } = niceScale(Math.max(...data.map((d) => d.total)));
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);
  const band = plotW / data.length;
  const barW = Math.min(BAR_MAX, band - 12);
  const y = (value: number) => MARGIN.top + plotH - (value / top) * plotH;

  const selected = data.find((d) => d.date === selectedDate);
  const activeDay = active !== null ? data[active] : null;
  const summary = `Patients per day for the last 7 days, ${scopeLabel}. ${data
    .map((d) => `${formatWeekday(d.date)} ${formatShortDate(d.date)}: ${d.total}`)
    .join('. ')}.`;

  return (
    <div className="chart-wrap" ref={ref}>
      <svg
        className="chart"
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="group"
        aria-label={summary}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className={tick === 0 ? 'chart__axis' : 'chart__grid'}
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text className="chart__muted" x={MARGIN.left - 8} y={y(tick) + 4} textAnchor="end">
              {tick}
            </text>
          </g>
        ))}

        {data.map((day, i) => {
          const cx = MARGIN.left + band * i + band / 2;
          const barH = (day.total / top) * plotH;
          const isSelected = day.date === selectedDate;
          // The spoken name starts with exactly the words drawn under the column, so the two never disagree.
          const dayWord = day.date === today ? 'Today' : formatWeekday(day.date);
          const label = `${dayWord} ${formatShortDate(day.date)}: ${day.total} ${
            day.total === 1 ? 'patient' : 'patients'
          }. ${isSelected ? 'Selected day.' : 'Press to select this day.'}`;
          return (
            <g
              key={day.date}
              className="chart__slot"
              role="button"
              tabIndex={0}
              aria-label={label}
              aria-pressed={isSelected}
              onClick={() => onSelect(day.date)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(day.date);
                }
              }}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive((a) => (a === i ? null : a))}
              onFocus={() => setActive(i)}
              onBlur={() => setActive((a) => (a === i ? null : a))}
            >
              {/* The hit area is the whole column slot, much larger than the painted bar. */}
              <rect className="chart__hit" x={cx - band / 2} y={MARGIN.top} width={band} height={plotH + 1} />
              {barH > 0 && (
                <path
                  className={isSelected ? 'chart__bar chart__bar--selected' : 'chart__bar'}
                  d={columnPath(cx - barW / 2, y(day.total), barW, barH)}
                />
              )}
              <text className="chart__muted" x={cx} y={HEIGHT - MARGIN.bottom + 18} textAnchor="middle">
                <tspan x={cx}>{dayWord}</tspan>
                {' '}
                <tspan x={cx} dy={15}>
                  {formatShortDate(day.date)}
                </tspan>
              </text>
            </g>
          );
        })}

        {/* One direct label, on the selected day. The tooltip and the table carry the other values. */}
        {selected && (
          <text
            className="chart__value"
            x={MARGIN.left + band * data.indexOf(selected) + band / 2}
            y={y(selected.total) - 8}
            textAnchor="middle"
          >
            {selected.total}
          </text>
        )}
      </svg>

      {activeDay && active !== null && (
        <div
          className="chart-tip"
          aria-hidden="true"
          style={{
            left: Math.min(Math.max(MARGIN.left + band * active + band / 2, 70), width - 70),
            top: Math.max(y(activeDay.total) - 14, 40),
          }}
        >
          <strong>
            {activeDay.total} {activeDay.total === 1 ? 'patient' : 'patients'}
          </strong>
          <span>
            {formatWeekday(activeDay.date)} {formatShortDate(activeDay.date)}
          </span>
        </div>
      )}
    </div>
  );
}
