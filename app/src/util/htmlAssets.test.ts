import { beforeEach, expect, it, vi } from "vitest";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { grantHtmlFolder, htmlAssetBase, openHtmlFolder } from "./htmlAssets";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string, protocol: string) => `http://${protocol}.localhost/${encodeURIComponent(path)}`),
}));
beforeEach(() => vi.clearAllMocks());

it("builds the folder's address from the platform's form of the scheme", () => {
  expect(htmlAssetBase("0123abcd")).toBe("http://lcasset.localhost/0123abcd/");
  expect(convertFileSrc).toHaveBeenCalledWith("", "lcasset");
});

it("passes the linked file to the native folder commands", async () => {
  vi.mocked(invoke).mockResolvedValue({ status: "ready", token: "t" });
  expect(await openHtmlFolder("path", "D:/Graphs/black_box_tracer.html")).toEqual({ status: "ready", token: "t" });
  expect(invoke).toHaveBeenLastCalledWith("open_html_folder", { kind: "path", location: "D:/Graphs/black_box_tracer.html" });
  await grantHtmlFolder("content://docs/document/primary%3AGraphs%2Fpage.html");
  expect(invoke).toHaveBeenLastCalledWith("grant_html_folder", { location: "content://docs/document/primary%3AGraphs%2Fpage.html" });
});
