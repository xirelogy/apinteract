FROM node:24-bookworm-slim

ARG APT_MIRROR_URL

USER root

# The slim image may not yet contain a system CA bundle. Seed one from Node's
# embedded Mozilla roots so an HTTPS APT mirror can be used to install the
# authoritative ca-certificates package.
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
      g++ \
      git \
      gosu \
      make \
      python3 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace /pnpm/store \
    && chown -R node:node /workspace /pnpm \
    && npm install --global pnpm@8.15.0

ENV HOME=/home/node
ENV NPM_CONFIG_STORE_DIR=/pnpm/store

WORKDIR /workspace

COPY deploy/development/workspace-entrypoint.sh /usr/local/bin/apinteract-development-entrypoint

RUN chmod 0755 /usr/local/bin/apinteract-development-entrypoint \
    && node --version \
    && pnpm --version

ENTRYPOINT ["apinteract-development-entrypoint"]
CMD ["sleep", "infinity"]
