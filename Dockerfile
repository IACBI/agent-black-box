FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS dependencies
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

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
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
