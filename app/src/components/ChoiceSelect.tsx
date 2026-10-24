import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { AnimatedDisclosure } from "./AnimatedDisclosure";
import { SlidingSegmented } from "./SlidingSegmented";
import "./choiceControls.css";

export interface ChoiceOption { value: string; label: string }

/** A dropdown whose list unfolds in the layout, pushing what follows, so a scrolling sheet never clips it. */
export function ChoiceSelect({ options, value, onChange, ariaLabel, placeholder = "Choose one" }: {
  options: readonly ChoiceOption[]; value: string | null; onChange: (value: string) => void; ariaLabel: string; placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", onPointer, true);
    return () => window.removeEventListener("pointerdown", onPointer, true);
  }, [open]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && open) { event.stopPropagation(); setOpen(false); root.current?.querySelector<HTMLButtonElement>(".lc-choice-select-trigger")?.focus(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...root.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []];
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };
  return <div ref={root} className="lc-choice-select" data-open={open ? "" : undefined} onKeyDown={onKeyDown}>
    <button type="button" className="lc-choice-select-trigger" aria-haspopup="listbox" aria-expanded={open}
      aria-controls={listId} aria-label={`${ariaLabel}: ${selected?.label ?? placeholder}`} onClick={() => setOpen(!open)}>
      <span className={selected ? undefined : "is-placeholder"}>{selected?.label ?? placeholder}</span>
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    <AnimatedDisclosure open={open}>
      <div id={listId} className="lc-choice-select-list" role="listbox" aria-label={ariaLabel}>
        {options.map((option) => <button key={option.value} type="button" role="option" aria-selected={option.value === value}
          className="lc-choice-select-option" onClick={() => { onChange(option.value); setOpen(false); }}>{option.label}</button>)}
      </div>
    </AnimatedDisclosure>
  </div>;
}

/** Up to three answers read as one sliding control; more belong in a dropdown. */
export function ChoicePicker({ options, value, onChange, ariaLabel, placeholder }: {
  options: readonly ChoiceOption[]; value: string | null; onChange: (value: string) => void; ariaLabel: string; placeholder?: string;
}) {
  return options.length > 3
    ? <ChoiceSelect options={options} value={value} onChange={onChange} ariaLabel={ariaLabel} placeholder={placeholder} />
    : <SlidingSegmented options={options} value={value} onChange={onChange} ariaLabel={ariaLabel} />;
}
