# syntax=docker/dockerfile:1
# The Node fallback port of div-report (doc/guides/fallback-drill.md): the
# Worker's code on a plain Node 22 process, with long polling, a minute loop
# and node:sqlite (src/node.ts). Node runs the TypeScript sources through
# its own type stripping, with the port's module hook (src/node-hooks.ts;
# doc/guides/developer-setup.md, "The Node port", says why): there is no
# build step, and the image holds the production dependencies only.
#
# No secret is ever baked in (critical invariant 6): every value comes from
# the environment when the container runs (docker-compose.yml's env_file),
# and .dockerignore keeps .env, .dev.vars, the database and the tests out of
# the build context.
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# The production dependencies (grammy, zod, @grammyjs/runner) exactly as the
# lockfile records them, with no install script run.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# The sources and the migrations the port applies at start, owned by root:
# the user the port runs as reads them and cannot change them.
COPY src ./src
COPY migrations ./migrations

# The database's directory, owner-only, for that unprivileged user;
# docker-compose.yml mounts a volume here, which takes this ownership.
RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data
USER node

CMD ["node", "--import", "./src/node-hooks.ts", "src/node.ts"]
