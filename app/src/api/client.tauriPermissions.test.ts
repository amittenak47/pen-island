import { describe, expect, it } from "vitest";
import native from "../../src-tauri/src/lib.rs?raw";
import permissions from "../../src-tauri/permissions/app.toml?raw";
import docSourcePermissions from "../../src-tauri/permissions/doc_source.toml?raw";
import capability from "../../src-tauri/capabilities/default.json";

describe("packaged native client permissions", () => {
  it("grants the main window every registered harness command", () => {
    const harness = permissions.split("[[permission]]").find(block => /identifier\s*=\s*"allow-lc-harness"/.test(block));
    expect(harness, "the native client capability must exist").toBeDefined();
    expect(capability.windows).toContain("main");
    expect(capability.permissions).toContain("allow-lc-harness");
    const allowed = new Set([...harness!.matchAll(/"(lc_\w+)"/g)].map(match => match[1]));
    const registered = [...new Set([...native.matchAll(/lc_routes::(lc_\w+)/g)].map(match => match[1]))];
    expect(registered.length).toBeGreaterThan(0);
    expect(registered.filter(command => !allowed.has(command)), "registered commands rejected by Tauri ACL").toEqual([]);
  });

  it("grants the main window every registered document source and HTML folder command", () => {
    expect(capability.permissions).toContain("allow-doc-source");
    const allowed = new Set([...docSourcePermissions.matchAll(/"(\w+)"/g)].map(match => match[1]));
    const registered = [...new Set([...native.matchAll(/(?:doc_source|html_assets)::([a-z_]+),/g)].map(match => match[1]))];
    expect(registered).toEqual(expect.arrayContaining(["read_document_source", "open_html_folder", "grant_html_folder"]));
    expect(registered.filter(command => !allowed.has(command)), "registered commands rejected by Tauri ACL").toEqual([]);
  });
});
