#!/bin/sh

set -eu

dependency_directories="
/workspace/node_modules
/workspace/apps/backend/node_modules
/workspace/apps/frontend/node_modules
/workspace/apps/proxy/node_modules
/workspace/packages/api-contracts/node_modules
/pnpm/store
"

for directory in ${dependency_directories}; do
  mkdir -p "${directory}"
  ownership_marker="${directory}/.apinteract-development-volume"
  if [ ! -e "${ownership_marker}" ]; then
    chown -R node:node "${directory}"
    touch "${ownership_marker}"
  fi
  chown node:node "${directory}" "${ownership_marker}"
done

exec gosu node "$@"
