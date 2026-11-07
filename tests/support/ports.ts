// 测试用的 loopback 端口获取（#53）：只「当场绑定并持有」，绝不「先探测空闲、之后再绑」。
//
// 竞态的形状：探测（`listen(0)` → 读端口 → close）与真正的绑定之间有一段窗口，同机并行跑的
// 另一个测试进程（`orca plugin test` 按文件并行）的 `listen(0)` 可能正好把这个端口分走，
// 于是绑定时 `EADDRINUSE`。#24 用「base+1 也探测一遍」缩小了窗口，窗口还在：#28 报了
// `twenty occupied increments fall back to an ephemeral port` 的 EADDRINUSE，#44 的合并门禁
// 又见过一次同族失败。
//
// 这里换成两条不会相撞的做法：
//
//   1. **端口段由本进程真实绑定并持住**（blocker 监听器一直开着）。别人想拿只能拿到
//      `EADDRINUSE`；本进程也不是「先看一眼空闲、再回来绑」，而是当场绑、当场算数。
//      一次取一整段连续端口时，任何一个当场绑失败就整段放掉、换一个起点重取——这是
//      「这个端口此刻属于别人」的事实判定，不是把「刚才探测到空闲」当成承诺。
//   2. **端口取自内核临时端口区间之外的窄带**。内核不会把临时端口分给这个窄带，
//      所以别的测试文件的 `listen(0)`（以及同机另一轮测试）永远拿不到这里的端口。
//      窄带 [25000, 32000)：macOS/BSD/Windows 的临时区间是 49152–65535
//      （`sysctl net.inet.ip.portrange.first/last`），Linux 缺省是 32768–60999
//      （`ip_local_port_range`），都在它上面。
//
// 起点由 pid 派生：同机并发的两轮 `orca plugin test` pid 不同，取到的段不会重叠。
import { createServer, type AddressInfo, type Server } from 'node:http'

/** 窄带起点（含）。 */
export const PORT_BAND_START = 25_000

/** 窄带终点（不含）：低于 Linux 缺省的临时端口下界 32768。 */
export const PORT_BAND_END = 32_000

/** 一段由本进程持有（正在监听）的连续端口，以及放掉它们的出口。 */
export interface PortBlock {
  /** 持有的连续端口，从低到高。 */
  readonly ports: readonly number[]
  /** 关掉全部 blocker 监听器（幂等）。 */
  release(): void
}

/** 起一个只占端口、不接受业务的 loopback 监听器。 */
function bindLoopback(port: number): Promise<Server> {
  const server = createServer((_request, response) => response.end('blocked'))
  return new Promise<Server>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve(server)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

/** 每次重取的位移：与窄带宽度互质，尽量不落回刚失败的那一段。 */
const RETRY_STRIDE = 739

/** 最多换几个起点；每次失败都意味着「这个端口此刻被别人的进程占着」。 */
const MAX_ATTEMPTS = 24

/** 本进程已取过几段：同一进程里的多次获取不挤在同一段上。 */
let acquisitions = 0

/**
 * 绑定并**持有** `size` 个连续端口，返回它们与关闭函数。
 *
 * 调用方必须在 `finally` 里 `release()`；持有期间别的进程无法绑这些端口。
 */
export async function holdPortBlock(size: number): Promise<PortBlock> {
  if (!Number.isInteger(size) || size < 1 || size > PORT_BAND_END - PORT_BAND_START) {
    throw new RangeError(`holdPortBlock: ${size} is not a size between 1 and the port band`)
  }
  // 可用的起点数（含两端）：宽 7000 的窄带里放 21 个连续端口有 6980 个起点。
  const span = PORT_BAND_END - PORT_BAND_START - size + 1
  const seed = (process.pid * 7919 + size * 31 + (acquisitions += 1) * 1499) % span
  let lastError: unknown = null

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const base = PORT_BAND_START + ((seed + attempt * RETRY_STRIDE) % span)
    const held: Server[] = []
    const release = (): void => {
      for (const server of held.splice(0)) {
        server.closeAllConnections()
        server.close()
      }
    }
    try {
      for (let offset = 0; offset < size; offset += 1) held.push(await bindLoopback(base + offset))
      const ports = held.map((server) => (server.address() as AddressInfo).port)
      return { ports: Object.freeze(ports), release }
    } catch (error) {
      // 这段里有个端口归别人：整段放掉，换起点。已经拿到的那几个只在这次尝试里存在，
      // 不会在之后被当作「仍然归我」使用。
      lastError = error
      release()
    }
  }
  throw new Error(
    `holdPortBlock: could not hold ${size} consecutive ports in [${PORT_BAND_START}, ${PORT_BAND_END}): ${String(lastError)}`
  )
}

/**
 * 一个**现在没有监听者**的端口：在窄带里绑定一次再立刻放掉。
 *
 * 给「连不上」类断言用（`defaultPortProbe` 返回 false、CLI 把 `not_ready` 报出来）。
 * 断言前后都不会再绑它，所以不存在「探测后绑定」的窗口；又因为它在窄带的临时端口区间
 * 之外，别的测试的 `listen(0)` 也分不到它。
 */
export async function closedPort(): Promise<number> {
  const block = await holdPortBlock(1)
  const port = block.ports[0] as number
  block.release()
  return port
}
