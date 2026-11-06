// 面板壳（本票只到能加载）：真正的七页导航由 F4（#14）落地，这里给 Orca 一个可渲染的入口，
// 让 `orca plugin check` 有东西可画、`validate` 有东西可解析。
import { Heading, Stack, Text } from 'orca'

/** 面板入口：渲染当前导航页。 */
export default function Panel() {
  return (
    <Stack gap="sm">
      <Heading>Superagent</Heading>
      <Text muted size="xs">
        The worker is starting. The panel arrives with the panel shell ticket.
      </Text>
    </Stack>
  )
}
