import { afterEach, describe, expect, it } from "vitest";
import { resolveSecrets, secretNames } from "../../src/cli/values.js";

describe("CLI secret resolution", () => {
  afterEach(() => {
    delete process.env.SMARTLINKS_TEST_SECRET;
  });

  it("reads a missing command-line value from the environment", async () => {
    process.env.SMARTLINKS_TEST_SECRET = "from-env";

    await expect(resolveSecrets(["SMARTLINKS_TEST_SECRET"], { prompt: false })).resolves.toEqual({
      SMARTLINKS_TEST_SECRET: "from-env",
    });
  });

  it("generates high-entropy values for @random assignments", async () => {
    const resolved = await resolveSecrets(["FIRST=@random", "SECOND=@random"], { prompt: false });

    expect(resolved.FIRST).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(resolved.SECOND).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(resolved.FIRST).not.toBe(resolved.SECOND);
  });

  it("extracts and validates secret names without resolving their values", () => {
    expect(secretNames(["FIRST=value", "SECOND=@random", "THIRD"])).toEqual([
      "FIRST",
      "SECOND",
      "THIRD",
    ]);
    expect(() => secretNames(["invalid=value"])).toThrow("Invalid secret name");
    expect(() => secretNames(["DUPLICATE=one", "DUPLICATE=two"])).toThrow(
      "Secret DUPLICATE was provided more than once.",
    );
  });

  it("does not prompt when the command disables interactive output", async () => {
    await expect(resolveSecrets(["SMARTLINKS_TEST_SECRET"], { prompt: false })).rejects.toThrow(
      "is not set in the environment and cannot be prompted for",
    );
  });
});
