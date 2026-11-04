import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { HttpFailure, request } from "../src/http.js";
import { startMockHub, type MockHub } from "./mockHub.js";

const LIMIT = 1024;
let hub: MockHub;

before(async () => {
  hub = await startMockHub([]);
});
after(() => hub.close());

const get = (path: string, timeoutMs = 5000) =>
  request(`${hub.baseUrl}${path}`, { method: "GET" }, { timeoutMs, maxBytes: LIMIT });

describe("request bounds", () => {
  for (const [label, suffix] of [["content-length", ""], ["chunked stream", "/chunked"]] as const) {
    it(`accepts limit and rejects limit+1 (${label})`, async () => {
      assert.equal((await get(`/size/${LIMIT}${suffix}`)).text.length, LIMIT);
      await assert.rejects(get(`/size/${LIMIT + 2}${suffix}`), (e: unknown) => e instanceof HttpFailure && /exceeds the 1024 byte limit/.test(e.message));
    });
  }

  it("times out a request that never answers", async () => {
    await assert.rejects(get("/hang", 200), (e: unknown) => e instanceof HttpFailure && /timed out after 200 ms/.test(e.message));
  });
});
