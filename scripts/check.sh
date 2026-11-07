#!/usr/bin/env bash
# 门禁，按序执行（设计 §P.5）。四道基线门禁全绿才退出 0。
#
# 基线（唯一的失败来源）：
#   1. 自包含类型检查      npx tsc -p .
#   2. 插件测试            orca plugin test . --json
#   3. 面板情景检查        orca plugin check . --json
#   4. 清单校验            orca plugin validate . --json
#
# `orca plugin types .` 只是探针，不参与退出码：在 Orca 1.4.253 上它成功并写出
# `.orca/types`，脚本随即追加一次基于生成类型的额外类型检查——**仅作参考
# （informational）**，因为自包含的 `types/*.d.ts` + `tsconfig.json` 才是基线，
# 生成类型与手写声明目前有差异（对齐是独立决定，§N.3）。若某个 Orca 版本上它又
# 失败了（1.4.251 就是如此），脚本把它记为「已知缺陷，忽略」并打印复核语句，
# 退出码同样不变。
#
# 用法：scripts/check.sh [--help]
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

FAILED=0
STEP=0

# 跑一步基线门禁：打印标题、命令与退出码；失败时记下来但继续跑后面的步骤。
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

# 跑一步「仅作参考」的检查：打印格式与 run_gate 一样，但结果不计入 FAILED，
# 因此永远不会改变脚本退出码——自包含基线才是唯一的失败来源。
run_info() {
  local title="$1"
  shift
  STEP=$((STEP + 1))
  printf '\n== %d. %s ==\n$ %s\n' "$STEP" "$title" "$*"
  "$@"
  local code=$?
  printf -- '-> exit %d (informational — does not affect the exit code)\n' "$code"
  if [[ $code -ne 0 ]]; then
    printf 'note: generated types disagree with the hand-written declarations (design §N.3);\n'
    printf '      the self-contained tsconfig is the baseline and decides the result.\n'
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

# `orca plugin types` 成功后的额外类型检查：临时 tsconfig extends 生成的配置（存在才跑）。
# 自包含 tsconfig 仍是基线，这份只是叠加参考；调用方用 run_info，故不影响退出码。
run_extra_typecheck() {
  if [[ ! -f .orca/types/tsconfig.json ]]; then
    printf 'no .orca/types/tsconfig.json; extra typecheck skipped\n'
    return 0
  fi
  local generated="./tsconfig.orca.json"
  printf '{ "extends": "./.orca/types/tsconfig.json", "include": ["src", "tests", "types"] }\n' \
    >"$generated"
  printf 'generated config: %s (extends ./.orca/types/tsconfig.json, deleted afterwards)\n' "$generated"
  run_tsc -p "$generated"
  local code=$?
  rm -f "$generated"
  return $code
}

# `orca plugin types .` 的探针：两个方向都不改变退出码（§N.3、§P.5）。
probe_plugin_types() {
  printf '\n== 0. orca plugin types . (probe: informational either way) ==\n'
  local output code
  output="$(orca plugin types . --json 2>&1)"
  code=$?
  printf '%s\n' "$output" | head -20
  printf -- '-> exit %d\n' "$code"
  if [[ $code -eq 0 && -d .orca/types ]]; then
    printf 'orca plugin types . succeeded: the extra typecheck below runs against .orca/types.\n'
    printf 'It is informational only: the self-contained tsconfig is the baseline (design §N.3).\n'
    run_info "extra typecheck (.orca/types — extra check, NOT the baseline)" run_extra_typecheck
  else
    printf 'Known defect, ignored: `orca plugin types .` failed (1.4.251 lacked the bundled\n'
    printf 'resources/plugins/declarative/orca.d.ts; this branch is kept for a regression).\n'
    printf 'It never affects the exit code: the self-contained tsconfig is the baseline and the\n'
    printf 'three host commands are authoritative.\n'
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
