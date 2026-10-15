import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeFingerRest } from "./fingerRest";

describe("makeFingerRest", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const onRest = vi.fn();
    const onResume = vi.fn();
    const rest = makeFingerRest({ restMs: 250, slopPx: 3, onRest, onResume });
    return { rest, onRest, onResume };
  };

  it("rests a finger that holds still, through jitter", () => {
    const { rest, onRest } = setup();
    rest.start(100, 100);
    vi.advanceTimersByTime(150);
    rest.move(102, 101);
    vi.advanceTimersByTime(100);
    expect(onRest).toHaveBeenCalledTimes(1);
    expect(rest.rested).toBe(true);
  });

  it("restarts the wait while the finger keeps moving", () => {
    const { rest, onRest } = setup();
    rest.start(100, 100);
    for (let i = 1; i <= 5; i++) {
      vi.advanceTimersByTime(100);
      rest.move(100, 100 + i * 10);
    }
    expect(onRest).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(onRest).toHaveBeenCalledTimes(1);
  });

  it("resumes when a rested finger moves, and can rest again", () => {
    const { rest, onRest, onResume } = setup();
    rest.start(0, 0);
    vi.advanceTimersByTime(250);
    rest.move(0, 20);
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(rest.rested).toBe(false);
    vi.advanceTimersByTime(250);
    expect(onRest).toHaveBeenCalledTimes(2);
  });

  it("does nothing after the finger lifts", () => {
    const { rest, onRest, onResume } = setup();
    rest.start(0, 0);
    rest.stop();
    vi.advanceTimersByTime(1000);
    rest.move(0, 50);
    expect(onRest).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
    expect(rest.rested).toBe(false);
  });
});
