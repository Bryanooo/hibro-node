import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { TEST_SUITES } from "./catalog.ts";

test("every Node test file is registered in the central catalog", async () => {
  const discovered = (await readdir(new URL(".", import.meta.url)))
    .filter((file) => file.endsWith(".test.ts"))
    .sort();
  const registered = TEST_SUITES.map((suite) => suite.file).sort();

  assert.deepEqual(
    registered,
    discovered,
    "新增 *.test.ts 时必须同时登记到 test/catalog.ts",
  );
});

test("test suite metadata is unique and complete", () => {
  assert.equal(new Set(TEST_SUITES.map((suite) => suite.id)).size, TEST_SUITES.length);
  assert.equal(new Set(TEST_SUITES.map((suite) => suite.file)).size, TEST_SUITES.length);

  for (const suite of TEST_SUITES) {
    assert.match(suite.id, /^[a-z][a-z0-9.-]+$/);
    assert.match(suite.file, /^[a-z0-9-]+\.test\.ts$/);
    assert.ok(suite.area.trim());
    assert.ok(suite.description.trim());
  }
});
