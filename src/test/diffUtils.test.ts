import test from "node:test";
import assert from "node:assert/strict";
import { buildPatchRows, createJsonPayload, decideNativeDiff, shouldUsePatchView, shouldUseSummaryView } from "../diffUtils";

test("createJsonPayload escapes html-sensitive characters", () => {
  const payload = createJsonPayload({ text: "</script><div>" });
  assert.equal(payload.includes("<"), false);
  assert.equal(payload.includes("\\u003c"), true);
});

test("shouldUsePatchView requires both large content and large changed lines for normal thresholds", () => {
  assert.equal(
    shouldUsePatchView({ added: 20, deleted: 10, isBinary: false }, 400_000, 390_000, 250_000, 200),
    false
  );
  assert.equal(
    shouldUsePatchView({ added: 120, deleted: 100, isBinary: false }, 40_000, 30_000, 250_000, 200),
    false
  );
  assert.equal(
    shouldUsePatchView({ added: 120, deleted: 100, isBinary: false }, 400_000, 390_000, 250_000, 200),
    true
  );
});

test("shouldUsePatchView switches to patch view for very large change counts even on medium files", () => {
  assert.equal(
    shouldUsePatchView({ added: 34, deleted: 2943, isBinary: false }, 122_999, 2_805, 250_000, 200),
    true
  );
  assert.equal(
    shouldUsePatchView({ added: 14, deleted: 1924, isBinary: false }, 56_939, 1_651, 250_000, 200),
    true
  );
  assert.equal(
    shouldUsePatchView({ added: 107, deleted: 107, isBinary: false }, 80_642, 80_642, 250_000, 200),
    false
  );
});

test("decideNativeDiff blocks known slow csv rewrite cases", () => {
  assert.deepEqual(
    decideNativeDiff({
      path: "hvdcli/doc/dictionary/cropped/data_dictionary.csv",
      stats: { added: 713, deleted: 5796, isBinary: false },
      leftLength: 2_101_027,
      rightLength: 374_846,
      largeDiffThresholdBytes: 250_000,
      largeChangeThresholdLines: 200
    }),
    {
      shouldUseNative: false,
      reason: "large-change-threshold"
    }
  );
});

test("decideNativeDiff prefers custom diff after prior native timeout", () => {
  assert.deepEqual(
    decideNativeDiff({
      path: "foo.csv",
      stats: { added: 10, deleted: 2, isBinary: false },
      leftLength: 10_000,
      rightLength: 11_000,
      largeDiffThresholdBytes: 250_000,
      largeChangeThresholdLines: 200,
      history: {
        fallbackCount: 1,
        timedOut: true,
        lastReason: "timeout"
      }
    }),
    {
      shouldUseNative: false,
      reason: "history-timeout"
    }
  );
});

test("decideNativeDiff keeps native for small csv changes", () => {
  assert.deepEqual(
    decideNativeDiff({
      path: "small.csv",
      stats: { added: 3, deleted: 2, isBinary: false },
      leftLength: 50_000,
      rightLength: 50_100,
      largeDiffThresholdBytes: 250_000,
      largeChangeThresholdLines: 200
    }),
    {
      shouldUseNative: true,
      reason: "native-ok"
    }
  );
});

test("shouldUseSummaryView blocks extreme diff volumes regardless of file type", () => {
  assert.equal(
    shouldUseSummaryView({
      stats: { added: 14_607, deleted: 173_199, isBinary: false },
      leftLength: 4_761_071,
      rightLength: 769_846
    }),
    true
  );
  assert.equal(
    shouldUseSummaryView({
      stats: { added: 713, deleted: 5_796, isBinary: false },
      leftLength: 2_101_027,
      rightLength: 374_846
    }),
    false
  );
});

test("decideNativeDiff returns summary reason for extreme xml-like rewrites", () => {
  assert.deepEqual(
    decideNativeDiff({
      path: "foo.xml",
      stats: { added: 14_607, deleted: 173_199, isBinary: false },
      leftLength: 4_761_071,
      rightLength: 769_846,
      largeDiffThresholdBytes: 250_000,
      largeChangeThresholdLines: 200
    }),
    {
      shouldUseNative: false,
      reason: "summary-too-large"
    }
  );
});

test("buildPatchRows aligns deleted and added rows around a hunk", () => {
  const patch = [
    "diff --git a/a.txt b/a.txt",
    "index 123..456 100644",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,3 +1,4 @@",
    " line1",
    "-line2",
    "+line2_changed",
    "+line2_extra",
    " line3"
  ].join("\n");

  const rows = buildPatchRows(patch);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].type, "spacer");
  assert.equal(rows[1].type, "context");
  assert.equal(rows[2].type, "spacer");
  assert.equal(rows[2].leftText, "line2");
  assert.equal(rows[2].rightText, "line2_changed");
  assert.equal(rows[3].type, "add");
  assert.equal(rows[3].rightText, "line2_extra");
  assert.equal(rows[4].type, "context");
});
