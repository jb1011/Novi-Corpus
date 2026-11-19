/**
 * Where the Charter flow's test page is served, and that nothing leads to it.
 *
 * The page is served by the development server only. Every build answers the site's not-found
 * page at its path, and no file of the site outside the page's own three folders names the path
 * or imports from those folders: the page is reached by typing its address, and by nothing else.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, test } from "vitest";
import type { LegalBodyConfig } from "@/lib/api/types";
import {
  CHARTER_TEST_PATH,
  charterTestPageServed,
  deploymentStop,
  type CharterTestConfig,
} from "@/lib/charterTest/served";

const SRC = join(import.meta.dirname, "..", "src");
/** The page's own folders, relative to `src`, with `/` between segments. */
const OWN_FOLDERS = ["app/charter-test", "components/charterTest", "lib/charterTest"];

/** Every file under `dir`, as a path relative to `src` with `/` between segments. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return [relative(SRC, full).split(sep).join("/")];
  });
}

describe("the test page is served by the development server only", () => {
  test("served under `next dev`", () => {
    expect(charterTestPageServed("development")).toBe(true);
  });

  test.each([["production"], ["test"], [""], [undefined], ["Development"], ["development "]])(
    "not served when NODE_ENV is %j",
    (nodeEnv) => {
      expect(charterTestPageServed(nodeEnv)).toBe(false);
    },
  );

  test("the path is the folder of its route", () => {
    expect(CHARTER_TEST_PATH).toBe("/charter-test");
    expect(filesUnder(join(SRC, "app", "charter-test"))).toEqual(["app/charter-test/page.tsx"]);
  });

  test("the route refuses before it renders anything, on the value the build inlines", () => {
    const page = readFileSync(join(SRC, "app", "charter-test", "page.tsx"), "utf8");
    expect(page).toContain("if (!charterTestPageServed(process.env.NODE_ENV)) notFound();");
    expect(page).not.toContain('"use client"');
    // Refused before the page's component is named in what is returned.
    expect(page.indexOf("notFound();")).toBeLessThan(page.indexOf("<CharterTestPage"));
    expect(page).toContain("robots: { index: false, follow: false }");
  });
});

describe("nothing leads to the test page", () => {
  const others = filesUnder(SRC).filter(
    (file) => !OWN_FOLDERS.some((folder) => file.startsWith(`${folder}/`)),
  );

  test("the walk reads the site's files", () => {
    expect(others).toContain("app/layout.tsx");
    expect(others).toContain("app/legal-body/page.tsx");
    expect(others.length).toBeGreaterThan(100);
  });

  test("no file outside its own folders names its path or imports from them", () => {
    const naming = others.filter((file) => {
      const text = readFileSync(join(SRC, file), "utf8");
      return /charter-test|charterTest/i.test(text);
    });
    expect(naming).toEqual([]);
  });
});

describe("the deployment the page runs against", () => {
  const sandbox: CharterTestConfig = {
    available: true,
    declarations: true,
    statements: true,
    environment: "sandbox",
    chainId: 5042002,
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    factory: "0x00000000000000000000000000000000000fAc70",
    gasSeedOffered: false,
    paymentRequired: false,
    linkTtl: { min: 600, max: 85800, default: 3600 },
  };
  const ready = (config: LegalBodyConfig) => deploymentStop({ status: "ready", config });

  test("a sandbox that takes declarations runs", () => {
    expect(ready(sandbox)).toBe(null);
  });

  test("it stops while /config is not read, and when it did not answer", () => {
    expect(deploymentStop({ status: "loading", config: null })).toBe("Reading /config.");
    expect(deploymentStop({ status: "error", config: null })).toBe("GET /config did not answer.");
    expect(deploymentStop({ status: "ready", config: null })).toBe("GET /config did not answer.");
  });

  test("it stops on a deployment with no legal-body doors", () => {
    expect(ready({ available: false })).toBe(
      "This deployment offers no legal-body doors: /config.legalBodies.available is false.",
    );
  });

  test("it stops on a production deployment, whatever else it offers", () => {
    expect(ready({ ...sandbox, environment: "production" })).toBe(
      "This page runs against a sandbox deployment only: /config.legalBodies.environment is production.",
    );
  });

  test("it stops on a deployment that takes no declaration", () => {
    expect(ready({ ...sandbox, declarations: false })).toBe(
      "This deployment takes no declaration: /config.legalBodies.declarations is false.",
    );
  });
});
