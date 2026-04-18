import test from "node:test";
import assert from "node:assert/strict";
import { InteractionController } from "../interactionController";

test("latest diff request wins", () => {
  const controller = new InteractionController();
  const first = controller.beginDiffRequest();
  const second = controller.beginDiffRequest();

  assert.equal(controller.isLatestDiffRequest(first), false);
  assert.equal(controller.isLatestDiffRequest(second), true);
});

test("session reset invalidates all previous diff and refresh tokens", () => {
  const controller = new InteractionController();
  const diff = controller.beginDiffRequest();
  const refresh = controller.beginRefreshRequest();

  controller.resetSession();

  assert.equal(controller.isLatestDiffRequest(diff), false);
  assert.equal(controller.isLatestRefreshRequest(refresh), false);
});

test("cancel diff requests invalidates only diff tokens", () => {
  const controller = new InteractionController();
  const diff = controller.beginDiffRequest();
  const refresh = controller.beginRefreshRequest();

  controller.cancelDiffRequests();

  assert.equal(controller.isLatestDiffRequest(diff), false);
  assert.equal(controller.isLatestRefreshRequest(refresh), true);
});

test("cancel refresh requests invalidates only refresh tokens", () => {
  const controller = new InteractionController();
  const diff = controller.beginDiffRequest();
  const refresh = controller.beginRefreshRequest();

  controller.cancelRefreshRequests();

  assert.equal(controller.isLatestDiffRequest(diff), true);
  assert.equal(controller.isLatestRefreshRequest(refresh), false);
});

test("random interaction sequence always keeps only the latest token valid in a session", () => {
  const controller = new InteractionController();
  let latestDiff = controller.beginDiffRequest();
  let latestRefresh = controller.beginRefreshRequest();

  for (let index = 0; index < 200; index += 1) {
    const action = index % 5;
    if (action === 0) {
      latestDiff = controller.beginDiffRequest();
      assert.equal(controller.isLatestDiffRequest(latestDiff), true);
    } else if (action === 1) {
      latestRefresh = controller.beginRefreshRequest();
      assert.equal(controller.isLatestRefreshRequest(latestRefresh), true);
    } else if (action === 2) {
      controller.cancelDiffRequests();
      assert.equal(controller.isLatestDiffRequest(latestDiff), false);
    } else if (action === 3) {
      controller.cancelRefreshRequests();
      assert.equal(controller.isLatestRefreshRequest(latestRefresh), false);
    } else {
      controller.resetSession();
      latestDiff = controller.beginDiffRequest();
      latestRefresh = controller.beginRefreshRequest();
      assert.equal(controller.isLatestDiffRequest(latestDiff), true);
      assert.equal(controller.isLatestRefreshRequest(latestRefresh), true);
    }
  }
});
