# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e
ARG APT_MIRROR_URL

FROM ${NODE_IMAGE} AS build

ARG APT_MIRROR_URL

ENV PNPM_HOME=/opt/pnpm
ENV PATH=/opt/pnpm:${PATH}

WORKDIR /workspace

RUN mkdir -p /etc/ssl/certs \
    && node -e "require('node:fs').writeFileSync('/etc/ssl/certs/ca-certificates.crt', require('node:tls').rootCertificates.join('\\n'))" \
    && if [ -n "${APT_MIRROR_URL}" ]; then \
      sed --in-place \
        "s|http://deb.debian.org/debian|${APT_MIRROR_URL%/}|g" \
        /etc/apt/sources.list.d/debian.sources; \
    fi \
    && npm install --global pnpm@8.15.0 \
    && apt-get update \
    && apt-get install --yes --no-install-recommends \
      g++ \
      make \
      python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY apps/proxy/package.json apps/proxy/package.json
COPY packages/api-contracts/package.json packages/api-contracts/package.json
COPY packages/plugin-api/package.json packages/plugin-api/package.json
COPY packages/plugin-sdk/package.json packages/plugin-sdk/package.json
COPY plugins/basic-http-content/package.json plugins/basic-http-content/package.json
COPY plugins/json-content/package.json plugins/json-content/package.json
COPY plugins/xml-content/package.json plugins/xml-content/package.json
COPY plugins/html-preview/package.json plugins/html-preview/package.json
COPY plugins/raster-image-preview/package.json plugins/raster-image-preview/package.json
COPY plugins/openapi-import/package.json plugins/openapi-import/package.json
COPY plugins/har-import/package.json plugins/har-import/package.json

RUN --mount=type=cache,id=apinteract-pnpm-store,target=/opt/pnpm/store \
    pnpm install --frozen-lockfile

COPY apps apps
COPY packages packages
COPY plugins plugins
COPY docs docs
COPY tooling tooling
COPY logo.png ./logo.png

RUN --mount=type=cache,id=apinteract-pnpm-store,target=/opt/pnpm/store \
    pnpm build \
    && mkdir -p /artifacts/plugins \
    && for plugin in plugins/*; do \
      target="/artifacts/plugins/$(basename "${plugin}")"; \
      mkdir -p "${target}"; \
      cp "${plugin}/package.json" "${plugin}/apinteract-plugin.json" "${target}/"; \
      cp -R "${plugin}/dist" "${target}/dist"; \
    done \
    && pnpm --prefer-offline --filter @apinteract/backend deploy --prod --no-optional /artifacts/backend \
    && pnpm --prefer-offline --filter @apinteract/proxy deploy --prod --no-optional /artifacts/proxy

FROM ${NODE_IMAGE} AS runtime

ARG APT_MIRROR_URL
ARG S6_OVERLAY_VERSION=3.2.1.0
# These values are published beside the named upstream release assets.
ARG S6_OVERLAY_NOARCH_SHA256=42e038a9a00fc0fef70bf0bc42f625a9c14f8ecdfe77d4ad93281edf717e10c5
ARG S6_OVERLAY_X86_64_SHA256=8bcbc2cada58426f976b159dcc4e06cbb1454d5f39252b3bb0c778ccf71c9435
ARG S6_OVERLAY_AARCH64_SHA256=c8fd6b1f0380d399422fc986a1e6799f6a287e2cfa24813ad0b6a4fb4fa755cc
ARG TARGETARCH
ARG APINTERACT_VERSION=0.0.0-dev
ARG APINTERACT_SOURCE_COMMIT=unknown

LABEL org.opencontainers.image.title="APInteract all-in-one" \
      org.opencontainers.image.description="APInteract frontend, backend, and local request proxy" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${APINTERACT_VERSION}" \
      org.opencontainers.image.revision="${APINTERACT_SOURCE_COMMIT}"

RUN mkdir -p /etc/ssl/certs \
    && node -e "require('node:fs').writeFileSync('/etc/ssl/certs/ca-certificates.crt', require('node:tls').rootCertificates.join('\\n'))" \
    && if [ -n "${APT_MIRROR_URL}" ]; then \
      sed --in-place \
        "s|http://deb.debian.org/debian|${APT_MIRROR_URL%/}|g" \
        /etc/apt/sources.list.d/debian.sources; \
    fi \
    && apt-get update \
    && apt-get install --yes --no-install-recommends \
      ca-certificates \
      curl \
      xz-utils \
    && case "${TARGETARCH}" in \
      amd64) s6_arch=x86_64; s6_arch_sha256="${S6_OVERLAY_X86_64_SHA256}" ;; \
      arm64) s6_arch=aarch64; s6_arch_sha256="${S6_OVERLAY_AARCH64_SHA256}" ;; \
      *) printf 'Unsupported target architecture: %s\n' "${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl --fail --location --retry 3 \
      "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-noarch.tar.xz" \
      --output /tmp/s6-overlay-noarch.tar.xz \
    && curl --fail --location --retry 3 \
      "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-${s6_arch}.tar.xz" \
      --output /tmp/s6-overlay-arch.tar.xz \
    && printf '%s  %s\n%s  %s\n' \
      "${S6_OVERLAY_NOARCH_SHA256}" /tmp/s6-overlay-noarch.tar.xz \
      "${s6_arch_sha256}" /tmp/s6-overlay-arch.tar.xz \
      >/tmp/s6-overlay.sha256 \
    && sha256sum --check --strict /tmp/s6-overlay.sha256 \
    && tar --directory / --extract --xz --preserve-permissions \
      --file /tmp/s6-overlay-noarch.tar.xz \
    && tar --directory / --extract --xz --preserve-permissions \
      --file /tmp/s6-overlay-arch.tar.xz \
    && rm \
      /tmp/s6-overlay-noarch.tar.xz \
      /tmp/s6-overlay-arch.tar.xz \
      /tmp/s6-overlay.sha256 \
    && apt-get purge --yes --auto-remove curl xz-utils \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf \
      /usr/local/lib/node_modules/corepack \
      /usr/local/lib/node_modules/npm \
    && rm -f \
      /usr/local/bin/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/pnpm \
      /usr/local/bin/pnpx \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg \
    && groupadd --gid 10001 apinteract \
    && useradd --uid 10001 --gid apinteract --no-create-home \
      --home-dir /nonexistent --shell /usr/sbin/nologin apinteract \
    && install --directory --owner=apinteract --group=apinteract --mode=0700 \
      /cache \
      /data \
      /run/apinteract \
    && install --directory --owner=root --group=apinteract --mode=0750 \
      /etc/apinteract

COPY --from=build --chown=apinteract:apinteract /artifacts/backend /opt/apinteract/backend
COPY --from=build --chown=apinteract:apinteract /artifacts/proxy /opt/apinteract/proxy
COPY --from=build --chown=apinteract:apinteract /workspace/apps/frontend/dist /opt/apinteract/frontend
COPY --from=build --chown=apinteract:apinteract /artifacts/plugins /opt/apinteract/plugins
COPY --chown=root:root LICENSE /opt/apinteract/LICENSE
COPY --chown=apinteract:apinteract deploy/aio/runtime /opt/apinteract/runtime
COPY --chmod=0755 deploy/aio/apinteract-admin /usr/local/bin/apinteract-admin
COPY deploy/aio/s6-rc.d /etc/s6-overlay/s6-rc.d

RUN chmod 0755 \
      /etc/s6-overlay/s6-rc.d/apinteract-prepare/up \
      /etc/s6-overlay/s6-rc.d/backend/run \
      /etc/s6-overlay/s6-rc.d/proxy/run \
      /opt/apinteract/runtime/prepare.sh \
    && chmod 0644 \
      /etc/s6-overlay/s6-rc.d/apinteract-prepare/type \
      /etc/s6-overlay/s6-rc.d/backend/type \
      /etc/s6-overlay/s6-rc.d/backend/dependencies.d/apinteract-prepare \
      /etc/s6-overlay/s6-rc.d/backend/dependencies.d/proxy \
      /etc/s6-overlay/s6-rc.d/backend/flag-essential \
      /etc/s6-overlay/s6-rc.d/backend/timeout-kill \
      /etc/s6-overlay/s6-rc.d/proxy/type \
      /etc/s6-overlay/s6-rc.d/proxy/dependencies.d/apinteract-prepare \
      /etc/s6-overlay/s6-rc.d/proxy/flag-essential \
      /etc/s6-overlay/s6-rc.d/proxy/timeout-kill \
      /etc/s6-overlay/s6-rc.d/user/contents.d/apinteract-prepare \
      /etc/s6-overlay/s6-rc.d/user/contents.d/backend \
      /etc/s6-overlay/s6-rc.d/user/contents.d/proxy

ENV NODE_ENV=production \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0 \
    S6_KILL_FINISH_MAXTIME=10000 \
    S6_SERVICES_GRACETIME=30000

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=4s --start-period=20s --retries=6 \
  CMD ["node", "/opt/apinteract/runtime/healthcheck.mjs"]

ENTRYPOINT ["/init"]
