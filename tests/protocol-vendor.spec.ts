// 本仓（dsh-typert-protocol）的自守护栏——把「pinned-source vendor」的定位变成静态断言。
//
// 背景：本仓是 `@deepseek-ai/dsh-typert-protocol` 的**声明源 vendor**（pinned source），
// 只服务构建期——给 typert 代码生成器提供协议的 TypeScript 源码。运行期一律走 npm 那份。
// 所有需要 typert codegen 的外部 DSH 仓库以 git submodule 把本仓挂载到
// 自己的 `packages/protocol`。生成器不认 node_modules 里的协议包（只认 workspace
// registration，见 analyzer.ts:476-500 loadRegistrations + :1975-1990 isTypeMetaSymbol）。
//
// 这个「只在构建期」靠两件事维持，任何一件被破坏都不报错、只是消费者仓的插件**凭空消失**：
//   ① 版本号后缀 `-vendor.0`——使它**不等于**消费者包 devDependencies 里那个精确 pin
//      （如 `0.2.1-rc.3`），pnpm 只能从 registry 取，linkWorkspacePackages 便不会把
//      运行期链接到本仓；
//      ⚠️ 准确说法是「不满足**精确 pin**」，**不是**「不满足任何依赖范围」——semver 把
//      `0.2.1-rc.3-vendor.0` 的 prerelease 解析成 ['rc','3-vendor',0]（`3-vendor`
//      是一个标识符），数字标识符小于字符串标识符 → **本仓版本比 npm 版本「更新」**，
//      它**满足** `>=0.2.1-rc.3 <0.3.0-0`（消费者包的 peer 范围）。
//      所以真正的防线是「消费者包 devDep 用精确版本」——那由**消费者仓自己的**
//      protocol-vendor.spec.ts 断言（各消费方仓内的同款 spec），
//      本仓管不到消费者的 manifest，只管自己的后缀。
//   ② 生成器 face program 的 paths 重定向只对生成器生效（消费者仓 tsconfig.host.json）。
//
// ⚠ 真实的失效链（2026-10-22 订正——早先的因果是**错的**）：
//   运行期一旦被链到本仓 → 插件产物的 `import '@deepseek-ai/dsh-typert-protocol'`
//   解析到本仓 → 本仓**没有 build 脚本、没有 `lib/` 产物**（package.json 的 main 指向
//   `lib/index.js`，文件不存在）→ **模块加载失败** → cordis loader 吞掉插件模块的加载
//   异常 → **插件凭空消失**（不抛错、不进日志、面板不见了）。
//   原先写的「extends 的 TypertRemoteService 变成另一个类对象 → Remote 静默失效」
//   **不成立**：Remote 方法的元数据是**原型上的字符串键**
//   （`Object.defineProperty(prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', …)`，
//   读取方 `remoteMethods(service)` 用同一个字符串键）→ 跨副本一致；所有权标记用
//   `Symbol.for('dsh.typert.owned-value')`（全局注册表）；全仓**没有**
//   `instanceof TypertRemoteService`；上游自己把该包列进 `DUPLICATE_SAFE_PACKAGES`
//   （「complete runtime surface is safe across duplicate installations」）→ 两份协议包
//   互相认得，**不是**失效原因。换句话说：防线的**目的**（不让运行期链到本仓）是对的，
//   只是**理由**要改成「本仓没有可加载的产物」。
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠ 根目录从本文件位置推导，不用 process.cwd()：本 spec 是自守的，可能在任意挂载点
// 被跑——本仓自己（cwd=本仓根），也可能被消费者仓的根 vitest 收进去
// （消费者的根 vitest 常以 packages/*/tests/** 收编本 spec，cwd=消费者仓根，manifest 会读错）。
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
/** 以 `-vendor.N` 结尾是这套设计的核心约定，不能改成裸版本号。 */
const VENDOR_SUFFIX = /-vendor\.\d+$/
const baseVersion = (version: string): string => version.replace(VENDOR_SUFFIX, '')

/** DSH checkout（可选）：给了就做源码级同步断言，没给（裸 clone / CI）自动跳过。 */
const CHECKOUT = process.env.DSH_CHECKOUT?.replace(/\/$/, '')

function readManifest(path = join(ROOT, 'package.json')): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8'))
}

describe('dsh-typert-protocol 自守护栏', () => {
  const manifest = readManifest()

  // ⚠ 这条是全套里「reinstall 之前就能拦住灾难」的断言：后缀一去掉，故障要等消费者仓
  //   下次 pnpm install 把运行期链接切到本仓才会显形，且症状是**插件凭空消失**
  //   （本仓没有 lib/ 产物 → 模块加载失败 → loader 吞异常，不抛错、不进日志）。
  it('版本号带 -vendor.N 后缀（使它不满足消费者包的精确 pin）', () => {
    expect(manifest.name).toBe('@deepseek-ai/dsh-typert-protocol')
    expect(
      VENDOR_SUFFIX.test(manifest.version),
      `版本 ${manifest.version} 缺少 -vendor.N 后缀——一旦变成裸版本号，`
      + '消费者仓的 linkWorkspacePackages 会把运行期链接到本仓；本仓没有 lib/ 产物，'
      + '插件的 import 解析到本仓就会加载失败 → 插件凭空消失（不抛错、不进日志）',
    ).toBe(true)
  })

  it('private: true——本仓永不发布 npm（运行期那份是官方 npm 包，不是本仓）', () => {
    expect(manifest.private).toBe(true)
  })

  it('manifest 是官方形态 exports（生成器按 exports 查子路径反推 src 源码）', () => {
    // 生成器按 manifest 的 exports 查子路径 → 取 target → sourcePathForExport()
    // 反推回 src/ 读源码，缺了整个子路径就报「package reference … is not exported by」。
    for (const key of ['.', './types', './src/*', './package.json']) {
      expect(
        Object.keys(manifest.exports ?? {}),
        `manifest.exports 缺少官方形态的 ${key}——生成器 sourcePathForExport 反推会失败`,
      ).toContain(key)
    }
  })

  it('本仓不参与产物生成：manifest 无 ./typert 导出面', () => {
    // 消费者仓 tsdown 用 mode:'workspace'（按 ./typert 筛 contributor），所以
    // 「没有 ./typert 导出」是它不进 emit/validate 的根据；有则会被当 contributor
    // 校验并误报缺 surface。
    expect(Object.keys(manifest.exports ?? {})).not.toContain('./typert')
  })

  it('本仓是「只有声明源」的包：没有 build/prepare 脚本、没有 lib/ 产物', () => {
    // 这条把「本仓的定位」钉死成**构建期的声明源**，而不是运行期的一份副本。
    //
    // 为什么要有这条：运行期一旦被链到本仓，插件的 import 会因为找不到
    // `lib/index.js` 而加载失败 → 插件凭空消失。**这个「失败得很响」的性质正是
    // 我们要的**（比「两份协议包互相不认」好得多——后者根本不会发生，见文件头）。
    // 但它成立的前提是：本仓**永远不被构建**。哪天有人加个 build 脚本、或者消费者仓
    // 的 `pnpm -r build` 把它编出了 lib/，那运行期链到它就不再是「立刻失败」
    // 而是「静默地跑起第二份协议包」——故障从「插件不见了」退化成「难查的漂移」。
    expect(
      (manifest.scripts ?? {}).build,
      '本仓不该有 build 脚本——它只有声明源，没有可运行产物',
    ).toBeUndefined()
    expect(
      (manifest.scripts ?? {}).prepare,
      '本仓不该有 prepare 脚本——git 安装/装包时会触发它构建出产物，同上',
    ).toBeUndefined()
    expect(
      existsSync(join(ROOT, 'lib')),
      '本仓出现了 lib/ 产物——它只该是声明源；有产物就可能被运行期链到',
    ).toBe(false)
  })

  it('LICENSE 在（MIT，随上游同步）', () => {
    expect(existsSync(join(ROOT, 'LICENSE'))).toBe(true)
    expect(readFileSync(join(ROOT, 'LICENSE'), 'utf8')).toContain('MIT License')
  })

  describe('与上游 monorepo 同步（需要 DSH_CHECKOUT，缺省跳过）', () => {
    const checkoutSrc = CHECKOUT ? join(CHECKOUT, 'packages', 'typert', 'protocol', 'src') : undefined

    it.skipIf(!existsSync(checkoutSrc))('src/ 与上游逐字节一致 + 版本主段一致', () => {
      const upstreamRoot = join(CHECKOUT!, 'packages', 'typert', 'protocol')
      const upstreamVersion = readManifest(join(upstreamRoot, 'package.json')).version
      expect(baseVersion(manifest.version)).toBe(upstreamVersion)
      const upstreamFiles = readdirSync(checkoutSrc!).filter(f => f.endsWith('.ts')).sort()
      const vendorFiles = readdirSync(join(ROOT, 'src')).filter(f => f.endsWith('.ts')).sort()
      expect(
        vendorFiles,
        'src 文件清单与上游不一致——重新同步（DSH_CHECKOUT=<路径> node scripts/vendor-protocol.mjs）',
      ).toEqual(upstreamFiles)
      for (const f of upstreamFiles) {
        expect(
          readFileSync(join(ROOT, 'src', f)).equals(readFileSync(join(checkoutSrc!, f))),
          `src/${f} 与上游内容不一致——重新同步`,
        ).toBe(true)
      }
    })
  })
})
