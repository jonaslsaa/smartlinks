type SmartlinkResponse = {
  body: string;
  headers: Record<string, string>;
};

const name: string = ctx.params.name ?? "world";
return {
  body: `Hello from TypeScript, ${name}!`,
  headers: { "content-type": "text/plain; charset=utf-8" },
} satisfies SmartlinkResponse;
