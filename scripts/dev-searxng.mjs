import { spawnSync } from "node:child_process";

const composeArgs = ["compose", "-f", "searxng/docker-compose.yml", "up", "-d"];

const dockerCheck = spawnSync("docker", ["info"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (dockerCheck.status !== 0) {
  console.error(`
SearXNG is not a Node service, so this npm helper starts the bundled Docker container.

Docker is not reachable right now. Start Docker Desktop, then run:

  npm run dev:searxng

To avoid Docker entirely, run any SearXNG instance yourself and set this in backend/.env:

  SEARXNG_URL=http://localhost:8080
`);
  process.exit(dockerCheck.status ?? 1);
}

const compose = spawnSync("docker", composeArgs, { stdio: "inherit" });
process.exit(compose.status ?? 1);
