import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Board } from "../src/canvas/Board";
import type { BoardHandle } from "../src/canvas/BoardHandle";
import { AnnotateDocument } from "../src/modes/AnnotateDocument";
import { PdfDocument } from "../src/modes/PdfDocument";
import { ANNOTATE_REGION, annotatePageHeight, buildAnnotateTemplate } from "../src/templates/annotate";
import { buildWhiteboardTemplate } from "../src/templates/whiteboard";
import { announceSplitResize } from "../src/util/splitResize";
import { reviewPdf } from "./reviewPdf";
import "../src/styles.css";

const query = new URLSearchParams(location.search);
const notebook = query.has("whiteboard"), pdf = query.has("pdf");
const bytes = pdf ? reviewPdf() : null;
const source = "# Camera parity\n\n" + Array.from({ length: 60 }, (_, i) =>
  `## Section ${i + 1}\n\nA fixed **Markdown** slot with fractional camera pixels, ink and selection.\n\n`,
).join("");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function Review() {
  const ref = useRef<BoardHandle>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => { void (async () => {
    await sleep(500);
    const board = ref.current!;
    board.seedTemplate(notebook ? buildWhiteboardTemplate(2, false) : buildAnnotateTemplate(1100));
    await board.waitForTemplate();
    if (pdf) {
      for (let i = 0; i < 300 && board.readingPageFrames().length === 0; i++) await sleep(100);
      if (board.readingPageFrames().length === 0) throw Error("PDF frames did not load");
    }
    board.syncDocumentScrollBounds();
    await board.settleFitView();
    const view = board.getViewportBounds()!;
    board.setInkOps([{ kind: "draw", color: "#e00000", baseWidth: 8, pressureSensitive: false, points: [
      { x: view.x + view.width * 0.3, y: view.y + view.height * 0.3, pressure: 0.5 },
      { x: view.x + view.width * 0.6, y: view.y + view.height * 0.6, pressure: 0.5 },
    ] }]);
    await board.primeInkSnap();
    Object.assign(window, {
      reviewReady: true, reviewBoard: board,
      setReviewOpen: () => {
        document.getElementById("root")!.style.width = "800px";
        announceSplitResize("settle");
      },
    });
  })(); }, []);
  return <Board ref={ref} filmScope="camera-parity" themeId="paper"
    mobileRegion={notebook ? "pad-0" : ANNOTATE_REGION}
    focusRegion={notebook ? "pad-0" : ANNOTATE_REGION}
    transparentCanvas docPaper selectableContent linedPaperToggle annotateToggle
    pageContent={notebook ? undefined : bytes
      ? <PdfDocument filmScope="camera-parity" bytes={bytes} frameWidth={1100} onMeasure={setHeight} />
      : <AnnotateDocument source={source} onMeasure={setHeight} />}
    pageContentHeight={notebook ? undefined : annotatePageHeight(height)} />;
}

const style = document.createElement("style");
style.textContent = "html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}.lc-board{width:100%;height:100%}";
document.head.append(style);
createRoot(document.getElementById("root")!).render(<Review />);
