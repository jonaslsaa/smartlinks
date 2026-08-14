import { afterEach, describe, expect, it } from "vitest";
import { resolveSecrets } from "../../src/cli/values.js";

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

  it("does not prompt when the command disables interactive output", async () => {
    await expect(resolveSecrets(["SMARTLINKS_TEST_SECRET"], { prompt: false })).rejects.toThrow(
      "is not set in the environment and cannot be prompted for",
    );
  });
});
