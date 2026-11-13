/**
 * `cli create-entity` on a Minimal-only deployment (no FACTORY_ADDRESS).
 *
 * The command runs the full onboarding saga, which claims an entities row and provisions custody
 * before the broadcast. Without a full-product factory the broadcast can never happen, and the
 * `failed` row it leaves makes every later API boot refuse. So it refuses at command time.
 */
import { expect, test, vi } from "vitest";
import { buildCli } from "../../src/cli/index";
import type { Config } from "../../src/config/env";

const ctxWith = (cfg: Partial<Config>) => ({
  cfg: cfg as Config,
  repo: {} as never,
  anchors: {} as never,
  docStore: {} as never,
  arc: {} as never,
  operatorSigner: {} as never,
});

test("cli create-entity refuses without a full-product factory, before the spec file is read", async () => {
  const program = buildCli(
    () => ctxWith({ legalBodyFactory: "0x00000000000000000000000000000000000000f2" }) as never,
  );
  await expect(
    program.parseAsync(["create-entity", "-c", "/nonexistent/agent.json"], { from: "user" }),
  ).rejects.toThrow(
    "full-product onboarding is not available on this deployment: it has no full-product factory; use the legal-body routes",
  );
});

test("with a full-product factory the command reaches its own argument handling", async () => {
  const makeContext = vi.fn(
    () => ctxWith({ factoryAddress: "0x00000000000000000000000000000000000000f1" }) as never,
  );
  const program = buildCli(makeContext);
  await expect(
    program.parseAsync(["create-entity", "-c", "/nonexistent/agent.json"], { from: "user" }),
  ).rejects.toThrow(/ENOENT|no such file/i);
  expect(makeContext).toHaveBeenCalled();
});
