#!/usr/bin/env node
// dsh-typert-protocol :: vendor-protocol.mjs — 把 DSH 协议包的**源码**同步进本仓
//
// ## 这个脚本取代什么
//
// 以前每次 DSH 升级都要**手工**做四步：去 checkout 里找 `packages/typert/protocol/src/`
// → 一个文件一个文件拷进 src/ → 手改 `package.json` 的 version → 手改 README。
// 2026-10-22 升级到 rc.2 时就差点照着旧 README 去 npm 包里拷 `src/`——
// **npm 包根本不发行 src/**（`files` 只有 `lib/index.js` 与 `lib/types/**`），
// 照做会拷不到。
//
// 现在这四步里可机械化的都归本脚本：拷贝、LICENSE、版本号、清单校验。
//
// ## 唯一事实源
//
// **上游 monorepo 的 `packages/typert/protocol/src/`**（不是 npm 包）——
// 路径由环境变量 `DSH_CHECKOUT` 显式指定（指向 DSH 仓库根的 checkout），零机器路径硬编码。
//
// ## 为什么必须 vendor（构建期刚需，跑不掉）
//
// typert 生成器的 `isTypeMetaSymbol` 只认两类协议声明来源：名为
// `@deepseek-ai/dsh-typert-protocol` 的 **workspace registration**，或同名 ambient
// 声明。npm 安装的协议包在 node_modules 里，两条都不满足 → 生成器收不到任何
// `@Remote` 方法 → `typert.remote-client.*` 产物不生成（外部仓库跑 typert 的
// invocations=0）。官方 monorepo 里协议包本就是 workspace 成员；外部仓库只能复刻一份。
//
// ## 运行期：本仓**不参与**
//
// 运行期一律走 npm 那份（消费者包 devDep 精确 pin）。本仓没有 build 脚本、
// 没有 `lib/` 产物 → 运行期一旦被链到，插件的 `import '@deepseek-ai/dsh-typert-protocol'`
// 直接找不到 `lib/index.js` → 插件模块加载失败 → cordis loader 吞掉异常 →
// **插件凭空消失**（不抛错、不进日志）。这才是「版本号必须带 `-vendor.N` 后缀」
// 的真实理由（详见 tests/protocol-vendor.spec.ts 与 README）。
//
// ## 用法（在消费者仓的 `packages/protocol` 挂载点里跑，或在本仓跑）
//
//   DSH_CHECKOUT=<DSH checkout 路径> node scripts/vendor-protocol.mjs           # 同步
//   DSH_CHECKOUT=<DSH checkout 路径> node scripts/vendor-protocol.mjs --check   # 只校验
//
// 退出码：0 = 已同步（或 check 通过）；1 = 失败 / 与上游不一致。
//
// ## 同步完之后
//
// 本仓：`pnpm test`（自守护栏）→ commit + push（带版本号 tag 更佳）。
// 各消费者仓：更新 submodule 指针到新 commit → 消费者侧验证
// （typert 产物比对 + 全量测试，见各消费者仓的 protocol-vendor.spec.ts）。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠ 必须用 fileURLToPath：new URL(...).pathname 给的是**百分号编码**的路径
// （挂载路径里有中文 → %E8%B0%81...），直接拿去做 fs 操作会 ENOENT。
const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const VENDOR = REPO // 本仓自身就是 vendor 目录（消费者仓里挂载于 packages/protocol）
const CHECK_ONLY = process.argv.includes('--check')

// DSH checkout 显式指定（零默认推导）：vendored 协议只从 checkout 源码同步。
const CHECKOUT = process.env.DSH_CHECKOUT?.replace(/\/$/, '')
if (!CHECKOUT) {
  console.error('[vendor-protocol] 需要显式指定 DSH checkout：export DSH_CHECKOUT=<checkout 路径>')
  console.error('[vendor-protocol] vendored 协议只从 checkout 源码同步（typert 生成器不认 npm 包，见 README）')
  process.exit(1)
}

/** 上游协议包在 DSH monorepo 里的位置。 */
const upstreamRoot = join(CHECKOUT, 'packages', 'typert', 'protocol')
const upstreamSrc = join(upstreamRoot, 'src')
/** 协议包目录本身没有 LICENSE（它继承仓库根那份）。 */
const upstreamLicense = join(CHECKOUT, 'LICENSE')

if (!existsSync(upstreamSrc)) {
  console.error(`[vendor-protocol] 找不到上游源码：${upstreamSrc}`)
  console.error('[vendor-protocol] 指定的 DSH_CHECKOUT 下找不到上游源码——确认它指向 DSH 仓库根')
  process.exit(1)
}

/** 上游 src 下的 .ts 文件名（排序）。 */
const upstreamFiles = readdirSync(upstreamSrc).filter(f => f.endsWith('.ts')).sort()
if (upstreamFiles.length === 0) {
  console.error(`[vendor-protocol] 上游 src 里没有 .ts 文件：${upstreamSrc}`)
  process.exit(1)
}

/** 上游协议包的版本号（vendor 副本的主段跟它一致）。 */
const upstreamVersion = JSON.parse(readFileSync(join(upstreamRoot, 'package.json'), 'utf8')).version
const expectedVersion = `${upstreamVersion}-vendor.0`

/** 现有 vendor 副本的 src 文件名（排序）。 */
const vendorSrc = join(VENDOR, 'src')
const vendorFiles = existsSync(vendorSrc) ? readdirSync(vendorSrc).filter(f => f.endsWith('.ts')).sort() : []

/** 某个 .ts 文件的字节内容（两边比字节——上游 patch src 时文件名不变但内容会变）。 */
const readBytes = (p) => readFileSync(p)

/** 当前是否已同步：文件清单一致 + 每个文件字节一致 + 版本号正确。 */
function diffReason() {
  const missing = upstreamFiles.filter(f => !vendorFiles.includes(f))
  if (missing.length > 0) return `vendor 缺 ${missing.length} 个文件：${missing.join(', ')}`
  const extra = vendorFiles.filter(f => !upstreamFiles.includes(f))
  if (extra.length > 0) return `vendor 多 ${extra.length} 个文件：${extra.join(', ')}`
  for (const f of upstreamFiles) {
    if (!readBytes(join(upstreamSrc, f)).equals(readBytes(join(vendorSrc, f)))) {
      return `文件内容不一致：${f}`
    }
  }
  const manifest = JSON.parse(readFileSync(join(VENDOR, 'package.json'), 'utf8'))
  if (manifest.version !== expectedVersion) {
    return `version 是 ${manifest.version}，应为 ${expectedVersion}`
  }
  return undefined
}

const reason = diffReason()

if (CHECK_ONLY) {
  if (reason === undefined) {
    console.log(`[vendor-protocol] ✅ 与上游一致（${upstreamFiles.length} 个文件，version ${expectedVersion}）`)
    process.exit(0)
  }
  console.error(`[vendor-protocol] ❌ 与上游不一致：${reason}`)
  console.error('[vendor-protocol] 修法：DSH_CHECKOUT=<路径> node scripts/vendor-protocol.mjs')
  process.exit(1)
}

if (reason === undefined) {
  console.log(`[vendor-protocol] 已经与上游一致（${upstreamFiles.length} 个文件，version ${expectedVersion}），未改动`)
  process.exit(0)
}

console.log(`[vendor-protocol] 同步上游协议包源码（${upstreamVersion} → ${expectedVersion}）`)
console.log(`  上游：${upstreamSrc}`)

// 先清空再拷：上游删了文件时，本地不能留残骸（残骸会让「文件清单一致」这条护栏永远红）。
// ⚠ copyFileSync **不会建父目录** → 清空后必须把 src/ 目录本身建回来，否则复制报 ENOENT。
rmSync(vendorSrc, { recursive: true, force: true })
mkdirSync(vendorSrc, { recursive: true })
for (const f of upstreamFiles) {
  copyFileSync(join(upstreamSrc, f), join(vendorSrc, f))
}
console.log(`  已同步 ${upstreamFiles.length} 个 .ts 文件 → ${vendorSrc}`)

if (existsSync(upstreamLicense)) {
  copyFileSync(upstreamLicense, join(VENDOR, 'LICENSE'))
  console.log('  已同步 LICENSE')
}

// 版本号：主段跟上游一致，后缀保持 -vendor.0（后缀是「运行期不被链到本副本」的依据）。
// 只改 version 一个字段：本仓 package.json 的 scripts/devDeps 是自维护内容，不许被同步动到。
const manifestPath = join(VENDOR, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (manifest.version !== expectedVersion) {
  manifest.version = expectedVersion
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`  version → ${expectedVersion}`)
}

console.log('[vendor-protocol] 接下来：本仓 pnpm test && commit + push；消费者仓更新 submodule 指针并跑全量验证')
