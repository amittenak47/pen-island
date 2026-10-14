export interface Camera {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

export interface Viewport {
  width: number;
  height: number;
  offsetLeft: number;
  offsetTop: number;
}

export function sceneToScreen(cam: Camera, x: number, y: number): { x: number; y: number } {
  return {
    x: (x + cam.scrollX) * cam.zoom,
    y: (y + cam.scrollY) * cam.zoom,
  };
}

export function screenToScene(cam: Camera, x: number, y: number): { x: number; y: number } {
  return {
    x: x / cam.zoom - cam.scrollX,
    y: y / cam.zoom - cam.scrollY,
  };
}
