#!/bin/sh
set -eu
export PATH="/runtime/node_modules/node/bin:/runtime/node_modules/.bin:$PATH"
cd /work
start=$(date +%s)
/runtime/node_modules/.bin/pnpm generate
/runtime/node_modules/.bin/pnpm lint
/runtime/node_modules/.bin/pnpm typecheck
/runtime/node_modules/.bin/pnpm build
end=$(date +%s)
printf '{"seconds":%s,"peakBytes":%s}\n' "$((end-start))" "$(cat /sys/fs/cgroup/memory.peak)" > /results/verifier-measured.json
