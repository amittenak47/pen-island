/** @vitest-environment jsdom */
import { beforeEach, expect, it } from "vitest";

import {
  llmFirstRunAsked,
  loadLlmAskAtStartup,
  markLlmFirstRunAsked,
  saveLlmAskAtStartup,
} from "./llmStartupPref";

beforeEach(() => localStorage.clear());

it("asks at startup until told not to, and remembers it", () => {
  expect(loadLlmAskAtStartup()).toBe(true);
  saveLlmAskAtStartup(false);
  expect(loadLlmAskAtStartup()).toBe(false);
  saveLlmAskAtStartup(true);
  expect(loadLlmAskAtStartup()).toBe(true);
});

it("asks the first-launch question once per device", () => {
  expect(llmFirstRunAsked()).toBe(false);
  markLlmFirstRunAsked();
  expect(llmFirstRunAsked()).toBe(true);
});
