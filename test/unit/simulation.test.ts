import { describe, expect, it } from "vitest";
import { LocalSimulation } from "../../src/cli/simulation.js";

describe("local network simulation", () => {
  it("uses the guarded fetch policy and redacts exact secrets from the report", async () => {
    const secret = 'a"b c';
    const simulation = new LocalSimulation(
      {
        method: "POST",
        params: { token: [secret] },
        headers: { "x-input": secret },
        body: JSON.stringify({ token: secret }),
      },
      { API_TOKEN: secret },
    );
    const fetch = simulation.createGuestFetch(["runtime.example"]);

    const response = await fetch(`https://api.example/deploy?token=${encodeURIComponent(secret)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, host: "ignored.example" },
      body: JSON.stringify({ token: secret }),
    });
    expect(response).toMatchObject({
      status: 200,
      headers: { "content-type": "application/json" },
      text: "{}",
    });

    await expect(fetch("https://runtime.example/pk")).rejects.toThrow("Smartlinks runtime");
    const report = await simulation.success(
      new Response(JSON.stringify({ token: secret }), {
        status: 201,
        headers: { "x-result": secret },
      }),
      false,
    );

    expect(report.inputs).toEqual({
      method: "POST",
      params: { token: ["[secret:API_TOKEN]"] },
      headers: { "x-input": "[secret:API_TOKEN]" },
      body: '{"token":"[secret:API_TOKEN]"}',
    });
    expect(report.events).toEqual([
      {
        type: "fetch",
        request: {
          url: "https://api.example/deploy?token=[secret:API_TOKEN]",
          method: "POST",
          headers: { authorization: "Bearer [secret:API_TOKEN]" },
          body: '{"token":"[secret:API_TOKEN]"}',
        },
        response: {
          status: 200,
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      },
      {
        type: "fetch-blocked",
        request: { url: "https://runtime.example/pk", method: "GET" },
        reason: "Fetches to the Smartlinks runtime are blocked.",
      },
    ]);
    expect(report.response).toEqual({
      status: 201,
      headers: { "content-type": "text/plain;charset=UTF-8", "x-result": "[secret:API_TOKEN]" },
      body: '{"token":"[secret:API_TOKEN]"}',
    });
  });
});
