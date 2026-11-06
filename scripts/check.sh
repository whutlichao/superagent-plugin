#!/usr/bin/env bash
# 四道门禁，依次执行（设计 §P.5）。全绿才退出 0。
#
# 1. 自包含类型检查      npx tsc -p .
# 2. 插件测试            orca plugin test . --json
# 3. 面板情景检查        orca plugin check . --json
# 4. 清单校验            orca plugin validate . --json
#
# `orca plugin types .` 在 Orca 1.4.251 上因应用包缺
# resources/plugins/declarative/orca.d.ts 而失败（§N.3 的实测缺陷）。脚本把它记为
# 「已知缺陷，忽略」并打印复核语句，绝不让它使门禁失败；若未来的 Orca 修好了它
# （退出 0 且写出了 .orca/types），脚本自动追加一次基于生成类型的额外类型检查，
# 但仍以自包含 tsconfig 为基线。
#
# 用法：scripts/check.sh [--help]
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

FAILED=0
STEP=0

# 跑一步门禁：打印标题、命令与退出码；失败时记下来但继续跑后面的步骤。
run_gate() {
  local title="$1"
  shift
  STEP=$((STEP + 1))
  printf '\n== %d. %s ==\n$ %s\n' "$STEP" "$title" "$*"
  "$@"
  local code=$?
  printf -- '-> exit %d\n' "$code"
  if [[ $code -ne 0 ]]; then
    FAILED=$((FAILED + 1))
    printf '!! gate failed: %s\n' "$title"
  fi
  return 0
}

# 调 tsc：优先用仓库内装的 typescript；没有 node_modules 时退回 npx 拉同一个版本，
# 保证「全新克隆」也能跑。参数是传给 tsc 的其余参数。
run_tsc() {
  if [[ -x node_modules/.bin/tsc ]]; then
    node_modules/.bin/tsc "$@"
  else
    npx --yes --package typescript@5.9.2 -- tsc "$@"
  fi
}

# 未来 Orca 修好 types 后的额外类型检查：extends 生成的 tsconfig（存在才跑）。
# 自包含 tsconfig 仍是基线，这份只是叠加验证。
run_extra_typecheck() {
  if [[ ! -f .orca/types/tsconfig.json ]]; then
    printf 'no .orca/types/tsconfig.json; extra typecheck skipped\n'
    return 0
  fi
  local generated="./tsconfig.orca.json"
  printf '{ "extends": "./.orca/types/tsconfig.json", "include": ["src", "tests", "types"] }\n' \
    >"$generated"
  run_tsc -p "$generated"
  local code=$?
  rm -f "$generated"
  return $code
}

# `orca plugin types .` 的已知缺陷探针：成功则追加一次额外类型检查，失败则记录并忽略。
probe_plugin_types() {
  printf '\n== 0. orca plugin types . (known defect probe) ==\n'
  local output code
  output="$(orca plugin types . --json 2>&1)"
  code=$?
  printf '%s\n' "$output" | head -20
  printf -- '-> exit %d\n' "$code"
  if [[ $code -eq 0 && -d .orca/types ]]; then
    printf 'orca plugin types . now succeeds: running the extra typecheck against .orca/types\n'
    run_gate "extra typecheck (.orca/types, not the baseline)" run_extra_typecheck
  else
    printf 'Known defect, ignored: `orca plugin types .` fails on Orca 1.4.251 because the app bundle\n'
    printf 'is missing resources/plugins/declarative/orca.d.ts (design §N.3). The self-contained\n'
    printf 'tsconfig is the baseline and the three host commands are authoritative.\n'
    printf 'Re-check after an Orca upgrade with: orca plugin types . --json && ls .orca/types\n'
  fi
}

probe_plugin_types

run_gate "self-contained typecheck" run_tsc -p .
run_gate "plugin tests" orca plugin test . --json
run_gate "panel check" orca plugin check . --json
run_gate "manifest validation" orca plugin validate . --json

printf '\n'
if [[ $FAILED -eq 0 ]]; then
  printf 'All gates passed.\n'
  exit 0
fi
printf '%d gate(s) failed.\n' "$FAILED"
exit 1
