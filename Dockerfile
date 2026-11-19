FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS dependencies
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./

FROM dependencies AS build
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm exec tsc -p tsconfig.build.json

FROM dependencies AS production-dependencies
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime
RUN apt-get update \
    && apt-get install --no-install-recommends -y git \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 abb \
    && useradd --uid 10001 --gid 10001 --create-home abb \
    && git config --system safe.directory /workspace
WORKDIR /app
COPY package.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["analyze"]
