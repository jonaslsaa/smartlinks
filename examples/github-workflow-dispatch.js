const owner = ctx.params.owner;
const repo = ctx.params.repo;
const workflow = ctx.params.workflow ?? "deploy.yml";
const ref = ctx.params.ref ?? "main";

if (!owner || !repo) {
  return { status: 400, body: "Required query parameters: owner and repo" };
}

const response = await fetch(
  `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
  {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${ctx.secrets.GITHUB_TOKEN}`,
      "content-type": "application/json",
      "user-agent": "smartlinks",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({ ref }),
  },
);

if (!response.ok) {
  return { status: 502, body: `GitHub returned HTTP ${response.status}: ${await response.text()}` };
}

return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions`;
