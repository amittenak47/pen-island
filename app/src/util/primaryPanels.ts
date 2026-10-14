/**
 * One primary panel at a time: the footnote panel or the ChatBot sheet.
 *
 * Opening the ChatBot sheet dismisses the open footnote panel; opening any
 * footnote panel (a ribbon tap, a link, a jump from History) closes the sheet
 * and, with it, its History details. Mini notes are separate windows and are
 * not affected.
 */

import { useCallback, useEffect, useState } from "react";

export function usePrimaryPanels(openFootnoteId: string | null, dismissFootnote: () => void) {
  const [chatBotOpen, setChatBotOpen] = useState(false);
  const openChatBot = useCallback(() => {
    dismissFootnote();
    setChatBotOpen(true);
  }, [dismissFootnote]);
  useEffect(() => {
    if (openFootnoteId) setChatBotOpen(false);
  }, [openFootnoteId]);
  return { chatBotOpen, openChatBot, setChatBotOpen };
}
