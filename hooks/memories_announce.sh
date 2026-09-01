#!/bin/bash
# mcs registers hooks as `bash .claude/hooks/<pack>/<file>`, so this file must be
# bash. All logic is in the sibling TypeScript. The command -v guard keeps a
# missing interpreter fail-open, matching the jq guard it replaces.
command -v node >/dev/null 2>&1 || { echo "memories_announce: node not found; skipping" >&2; exit 0; }
d=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd) || exit 0
exec node --experimental-strip-types --disable-warning=ExperimentalWarning \
  "$d/../../shared-memories/hooks/announce.ts"
