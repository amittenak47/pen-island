/**
 * Background colour swatches for board + UI chrome.
 * Inline in the problem browser, or a compact popover in the header / map chrome.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { APP_THEMES, type AppTheme } from "../theme/appThemes";
import { usePopPlacement } from "./usePopPlacement";
import { usePresence } from "./usePresence";

export interface BackgroundPaletteProps {
  themeId: string;
  /** Caption and accessible group name for the inline palette. */
  label?: string;
  onPick: (id: string) => void;
  /** `inline` in the browser footer; `compact`/`header`/`map` are popovers. */
  variant?: "inline" | "compact" | "header" | "map";
}

const LIGHT_THEMES = APP_THEMES.filter((theme) => theme.mode === "light");
const DARK_THEMES = APP_THEMES.filter((theme) => theme.mode === "dark");

export function BackgroundPalette({ themeId, onPick, variant = "compact", label = "Theme" }: BackgroundPaletteProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const current = APP_THEMES.find((theme) => theme.id === themeId) ?? APP_THEMES[0];

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    // pointerdown, not mousedown: Android synthesizes a delayed mousedown after
    // the opening tap, which would close the popover before it can paint.
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  // Map popover opens left of the chip; header opens below — tip on the far side.
  const tipPlacement =
    variant === "map" ? "bottom" : variant === "header" ? "bottom" : "left";

  if (variant === "inline") {
    return (
      <div className="lc-bg-palette lc-bg-palette-inline" role="group" aria-label={label}>
        <span className="lc-bg-palette-label">{label}</span>
        <div className="lc-bg-palette-swatches">
          {APP_THEMES.map((theme) => (
            <Swatch
              key={theme.id}
              theme={theme}
              active={theme.id === themeId}
              onPick={onPick}
              tipPlacement="top"
            />
          ))}
        </div>
      </div>
    );
  }

  const popoverClass =
    variant === "header"
      ? "lc-palette-popover lc-palette-popover-header"
      : variant === "map"
        ? "lc-palette-popover lc-palette-popover-map"
        : "lc-palette-popover";

  return (
    <div
      ref={rootRef}
      className={`lc-palette-compact${variant === "header" ? " lc-palette-header" : ""}${variant === "map" ? " lc-palette-map" : ""}`}
    >
      <button
        type="button"
        className={
          variant === "header"
            ? "lc-palette-trigger lc-palette-trigger-header lc-tip-target lc-secondary"
            : variant === "map"
              ? "lc-map-btn lc-palette-trigger lc-palette-trigger-map lc-tip-target"
              : "lc-map-btn lc-palette-trigger lc-tip-target"
        }
        style={
          variant === "header" || variant === "map"
            ? undefined
            : { background: current.background }
        }
        data-tip={variant === "map" ? undefined : "Board and UI theme"}
        data-tip-placement={tipPlacement}
        aria-label="Theme"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {variant === "header" && (
          <>
            <span className="lc-palette-chip" style={{ background: current.background }} aria-hidden />
            Theme
          </>
        )}
        {variant === "map" && (
          <span className="lc-palette-chip" style={{ background: current.background }} aria-hidden />
        )}
      </button>
      {open && (
        <div className={popoverClass} role="listbox" aria-label="Theme">
          {variant === "map" ? (
            <div className="lc-palette-grouped">
              <ThemeGroup
                label="Light"
                themes={LIGHT_THEMES}
                themeId={themeId}
                onPick={(id) => {
                  onPick(id);
                  setOpen(false);
                }}
                tipPlacement={tipPlacement}
              />
              <ThemeGroup
                label="Dark"
                themes={DARK_THEMES}
                themeId={themeId}
                onPick={(id) => {
                  onPick(id);
                  setOpen(false);
                }}
                tipPlacement={tipPlacement}
              />
            </div>
          ) : (
            <div className="lc-palette-grid">
              {APP_THEMES.map((theme) => (
                <Swatch
                  key={theme.id}
                  theme={theme}
                  active={theme.id === themeId}
                  onPick={(id) => {
                    onPick(id);
                    setOpen(false);
                  }}
                  tipPlacement={tipPlacement}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One swatch showing the current background; tapping it opens every theme in
 * a small card beside it. The card stays open while you try themes, and
 * closes on a second tap, a tap outside or Escape. It fades in and out, the
 * chip's colour slides to the new theme, and the ring moves between swatches.
 */
export function BackgroundSwatchButton({
  themeId,
  onPick,
  prefer = "above",
}: {
  themeId: string;
  onPick: (id: string) => void;
  prefer?: "above" | "below";
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const pop = useRef<HTMLDivElement | null>(null);
  const current = APP_THEMES.find((theme) => theme.id === themeId) ?? APP_THEMES[0];
  const presence = usePresence(open);
  const placed = usePopPlacement(trigger, pop, presence.mounted, themeId, prefer);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (trigger.current?.contains(target) || pop.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    // pointerdown: see BackgroundPalette.
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="lc-palette-swatch-trigger"
        aria-label={`Background: ${current.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="lc-palette-swatch-chip" style={{ background: current.background }} aria-hidden />
      </button>
      {presence.mounted &&
        createPortal(
          <div
            ref={pop}
            className={`lc-palette-swatch-pop${presence.leaving ? " is-leaving" : ""}`}
            data-side={prefer}
            style={placed}
            role="listbox"
            aria-label="Background"
          >
            <div className="lc-palette-swatch-cap">
              <span>Background</span>
              <em key={current.id}>{current.label}</em>
            </div>
            <ThemeGroup label="Light" themes={LIGHT_THEMES} themeId={themeId} onPick={onPick} tipPlacement="top" />
            <ThemeGroup label="Dark" themes={DARK_THEMES} themeId={themeId} onPick={onPick} tipPlacement="top" />
          </div>,
          document.body,
        )}
    </>
  );
}

function ThemeGroup({
  label,
  themes,
  themeId,
  onPick,
  tipPlacement,
}: {
  label: string;
  themes: AppTheme[];
  themeId: string;
  onPick: (id: string) => void;
  tipPlacement: "top" | "left" | "bottom" | "right";
}) {
  return (
    <div className="lc-palette-group">
      <span className="lc-palette-group-label">{label}</span>
      <div className="lc-palette-group-swatches">
        {themes.map((theme) => (
          <Swatch
            key={theme.id}
            theme={theme}
            active={theme.id === themeId}
            onPick={onPick}
            tipPlacement={tipPlacement}
            tips={false}
          />
        ))}
      </div>
    </div>
  );
}

function Swatch({
  theme,
  active,
  onPick,
  tipPlacement,
  tips = true,
}: {
  theme: AppTheme;
  active: boolean;
  onPick: (id: string) => void;
  tipPlacement: "top" | "left" | "bottom" | "right";
  tips?: boolean;
}) {
  return (
    <button
      type="button"
      role="option"
      className={
        active
          ? "lc-swatch lc-swatch-active lc-tip-target"
          : theme.mode === "dark"
            ? "lc-swatch lc-swatch-dark lc-tip-target"
            : "lc-swatch lc-tip-target"
      }
      style={{ background: theme.background }}
      data-tip={tips ? theme.label : undefined}
      data-tip-placement={tipPlacement}
      aria-label={`${theme.label} background`}
      aria-selected={active}
      onClick={() => onPick(theme.id)}
    />
  );
}
