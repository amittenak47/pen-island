export function PictureInPictureIcon() {
  return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
    <g fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <rect x="7.5" y="7.5" width="5" height="4" rx=".5" />
    </g>
  </svg>;
}

/** The same expand artwork as the Agent panel. */
export function ExpandNoteIcon() {
  return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden>
    <g fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.5 6.5v-3h-3M12.5 3.5l-4 4" />
      <path d="M3.5 9.5v3h3M3.5 12.5l4-4" />
    </g>
  </svg>;
}

export function CloseNoteIcon() {
  return <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" aria-hidden>
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>;
}
