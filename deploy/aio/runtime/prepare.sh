#!/command/with-contenv sh

# Prepare writable state and private component configuration before services run.
set -eu

install -d -o apinteract -g apinteract -m 0700 \
  /run/apinteract \
  /data/database \
  /data/blobs \
  /data/blob-staging \
  /data/backups \
  /data/audit \
  /cache

node /opt/apinteract/runtime/prepare-runtime.mjs
chown apinteract:apinteract \
  /run/apinteract/backend.yaml \
  /run/apinteract/proxy.yaml \
  /run/apinteract/proxy-bearer-token
chmod 0600 \
  /run/apinteract/backend.yaml \
  /run/apinteract/proxy.yaml \
  /run/apinteract/proxy-bearer-token
