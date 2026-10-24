import type { CSSProperties, KeyboardEvent } from "react";
import "./choiceControls.css";

export interface SegmentedOption<T extends string | number> { value: T; label: string; sub?: string }

/** A radio group whose highlight slides to the chosen option instead of jumping. */
export function SlidingSegmented<T extends string | number>({ options, value, onChange, ariaLabel, className = "" }: {
  options: readonly SegmentedOption<T>[]; value: T | null; onChange: (value: T) => void; ariaLabel: string; className?: string;
}) {
  const selected = options.findIndex((option) => option.value === value);
  const focusable = selected >= 0 ? selected : 0;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]:not(:disabled)')];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (current + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
    buttons[index]?.focus(); buttons[index]?.click();
  };
  return <div role="radiogroup" aria-label={ariaLabel} className={`lc-sliding-seg ${className}`} onKeyDown={onKeyDown}
    data-empty={selected < 0 ? "" : undefined}
    style={{ "--seg-count": options.length, "--seg-index": Math.max(0, selected) } as CSSProperties}>
    <span className="lc-sliding-seg-thumb" aria-hidden="true" />
    {options.map((option, index) => <button key={String(option.value)} type="button" role="radio" aria-checked={index === selected}
      tabIndex={index === focusable ? 0 : -1} className="lc-sliding-seg-option" onClick={() => onChange(option.value)}>
      <span data-label>{option.label}</span>{option.sub ? <small>{option.sub}</small> : null}
    </button>)}
  </div>;
}
