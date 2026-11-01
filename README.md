# dsh-typert-protocol — DSH Typert 协议包 pinned-source vendor（共享仓）

`@deepseek-ai/dsh-typert-protocol` 的**声明源 vendor**（pinned source，对齐 DSH 官方 vendoring 惯例）。

> **一句话定位**：本仓**只服务构建期**——给 typert 代码生成器提供协议的 TypeScript
> 源码。**运行期一律走 npm 那份**，本仓不参与、也不可能有产物。
>
> 所有需要 typert codegen 的外部 DSH 仓库（外部 DSH 定制仓 及后续），都以 git submodule 把
> 本仓挂载到自己的 `packages/protocol`，统一从这里同步上游、维护版本。

## 消费方接入（每个需要 codegen 的外部 DSH 仓库）

### ① 挂载位置：必须是 `<root>/packages/protocol`（不可软链、不可挪窝）

```sh
git submodule add git@github.com:dreamariner/dsh-typert-protocol.git packages/protocol
```

为什么钉死在这个位置——生成器有三道结构性门槛，软链和别的路径都过不去：

1. `loadRegistrations`（`analyzer.ts:531`）只把 **`<root>/packages/` 下**的包收进 workspace registration；
2. `isTypeMetaSymbol`（`analyzer.ts:2084`）只认名为 `@deepseek-ai/dsh-typert-protocol` 的 **workspace registration**（`tsconfig.host.json` projectReferences 且位于 `<root>/packages/` 下）或同名 ambient 声明；
3. 生成器对路径做 `realPath` → **软链会被解析成真实路径**而逃出 `packages/`，registration 失效。

挂成 submodule 后目录就是真实路径，三道门槛全过；`packages/*` workspace glob 也照常把它收进 pnpm 工作区（它的 devDeps 照常安装，供生成器诊断程序与自身测试使用）。

### ② 消费者仓侧的四件接线（缺一不可）

1. **根 `tsconfig.json` exclude 本目录**：进根程序会与 npm 协议包 d.ts 的同名 Context 增强撞车（TS2717 双重声明）。它只属于生成器 face program。
2. **`tsconfig.host.json` 两条**：`paths` 把 `@deepseek-ai/dsh-typert-protocol` 重定向到 `./packages/protocol/src/index.ts`（仅生成器 face program 生效）+ `references` 指向 `packages/protocol`（构成 workspace registration）。
3. **消费者包把 npm 协议包 pin 成精确版本**：`devDependencies` 写 `0.2.1-rc.3` 这种裸精确版本（不含 `^ ~ >=`）。放宽成范围会让本仓版本变成合法候选（原因见下节 semver 细节）。
4. **消费者仓自己的守卫 spec**：参考 外部 DSH 定制仓 的 `scripts/tests/protocol-vendor.spec.ts`——断言后缀、精确 pin、运行期解析不落 vendor 目录。本仓的 `tests/protocol-vendor.spec.ts` 只守本仓自身形态，管不到消费者的 manifest。

## 为什么存在（构建期刚需，跑不掉）

typert 生成器（`@deepseek-ai/dsh-typert-generator`）的 `isTypeMetaSymbol` 只认两类 `Remote` / `TypertRemoteService` 声明来源：

1. 名为 `@deepseek-ai/dsh-typert-protocol` 的 **workspace registration**（`tsconfig.host.json` projectReferences 且位于 `<root>/packages/` 下）；
2. `declare module "@deepseek-ai/dsh-typert-protocol"` ambient 声明内部。

npm 安装的协议包在 node_modules 里，两条都不满足 → `collectInvocations` 收不到任何 `@Remote` 方法 → `typert.remote-client.*` 产物不生成（外部 DSH 定制仓 issue 007 Phase 5 的 invocations=0 根因）。官方 monorepo 里协议包本就是 workspace 成员，本仓把等价结构复刻给外部仓库。

> 上游**没有**为「外部仓库跑 typert 生成」提供任何官方流程（`typertPlugin` 的选项只有
> `mode` 与 `faces`，没有 `includeVendor`；生成路径 `loadRegistrations()` 也不含
> `vendor/`），所以这份 vendor 是目前唯一可行的解法。

## 运行期零耦合

- **本仓没有 build 脚本、没有 `lib/` 产物**（`main` 指向 `lib/index.js`，文件不存在）→ 运行期一旦被链到它，插件的 `import '@deepseek-ai/dsh-typert-protocol'` **加载失败** → cordis loader 吞异常 → **插件凭空消失**（不抛错、不进日志）。
  - 这正是「**失败得很响**」的性质，我们要的就是它。护栏（本仓 `tests/protocol-vendor.spec.ts` 与消费者仓 spec）把「没有 build 脚本、没有 lib/」钉死，防止哪天它被编出产物、退化成「静默跑起第二份协议包」那种难查的漂移。
- **版本号刻意用 `<上游版本>-vendor.0`**：消费者包在 `devDependencies` 里 pin 的是**精确版本**（如 `0.2.1-rc.3`），而本仓的版本**不等于**它 → pnpm 只能从 registry 取，`linkWorkspacePackages: true` 便不会把运行时链接到本仓——node 解析始终走 npm 包的编译产物。
  - ⚠️ **准确说法是「不满足那个精确 pin」，不是「不满足任何依赖范围」**：semver 把 `0.2.1-rc.3-vendor.0` 的 prerelease 解析成 `['rc','3-vendor',0]`（`3-vendor` 是**一个**标识符），而数字标识符小于字符串标识符 → **本仓的版本比 npm 那份「更新」**，它**满足** `>=0.2.1-rc.3 <0.3.0-0`（消费者包的 peer 范围）。因此真正的防线是「**devDep 用精确版本**」——消费者仓 spec 对此有专门断言。
- **为什么必须同名、只能靠版本区分**：`isTypeMetaSymbol` 只认同名 workspace registration 或 ambient 声明（`analyzer.ts:1975-1990`）→ 本仓**不能改名**（改名即生成器认不出）→ 唯一的区分手段就是版本号 → 这才是 `-vendor.N` 后缀存在的根本理由。
- **manifest 必须保持官方形态 `exports`**：生成器按 manifest 的 exports 查子路径 → 取 target → `sourcePathForExport()` 反推回 `src/` 读源码，缺了整个子路径就报 `package reference … is not exported by`。
- **但它不参与消费者仓的产物生成**：靠的是 manifest **没有 `./typert` 导出面** —— 消费者仓 tsdown 用 `mode: 'workspace'`（按 `./typert` 筛 contributor），所以无 `./typert` 的包既不 emit 也不 validate（`mode: 'package'` 会把所有 surface 包当 contributor 校验而误报）。

> ⚠️ **运行期的「同一份协议包」不靠本仓保证**，靠 DSH 官方的 **peer 拦截**：
> 插件以 `link:` 装进 profile → 成为 linked root → 插件 manifest 的 `peerDependencies`
> 里声明了 `@deepseek-ai/dsh-typert-protocol` → 宿主运行期解析在该位置供给
> **宿主那一份**（同一模块实例）。本仓是**第二道**保险，不是唯一一道。
> 且两份协议包互相认得：Remote 方法元数据是原型上的**字符串键**、所有权标记用
> `Symbol.for`（全局注册表）、上游把该包列进 `DUPLICATE_SAFE_PACKAGES`——真正的
> 失效链只有「被链到本仓 → 加载失败 → 插件凭空消失」这一条。

## 同步与升级（本仓是 protocol 源码同步的唯一事实点）

协议包升级（跟随 DSH 泳道）时，在本仓（或任意消费者的 `packages/protocol` 挂载点里）**一条命令**：

```sh
export DSH_CHECKOUT=<DSH 仓库 checkout 路径>
node scripts/vendor-protocol.mjs           # 同步（也可 pnpm run vendor）
node scripts/vendor-protocol.mjs --check   # 只校验（也可 pnpm run vendor:check）
```

它做四件事：① 从 **DSH checkout 的 `packages/typert/protocol/src/`** 拷 `.ts`（清空后重拷，避免上游删文件时留残骸）；② 拷 `LICENSE`（取 monorepo 根那份——协议包目录自己不带）；③ 把 `version` 改成 `<上游版本>-vendor.0`（只动 version 一个字段，scripts/devDeps 是本仓自维护内容）；④ `--check` 时逐字节比对并校验版本号，不一致则退出码 1。

⚠️ **源是上游 monorepo，不是 npm 包**：npm 的 `@deepseek-ai/dsh-typert-protocol` 的 `files` 字段只有 `lib/index.js` 与 `lib/types/**`，**根本不发行 `src/`**（0.2.1-alpha.1 与 0.2.1-rc.2 都如此）。早先文档写的是「从新版 npm 包拷贝 src/」——**照做会拷不到**（2026-10-22 升级到 rc.2 时发现并订正）。

同步完的发布节奏：

```sh
pnpm test                                    # 本仓自守护栏（给 DSH_CHECKOUT 则含逐字节同步断言）
git commit && git push                       # 建议打 tag：<version>
```

然后各消费者仓：`git submodule update --remote packages/protocol`（或进目录 pull）→ 提交 submodule 指针 → 消费者侧验证（typert 产物重新生成并比对 + 全量测试 + `check:lib`，见各消费者仓约定）。

## 自守护卫

`tests/protocol-vendor.spec.ts` 把这套纪律变成静态断言——

① 版本号带 `-vendor.N` 后缀（**reinstall 之前就能拦住灾难的一条**：后缀一去掉，消费者仓运行期会被 `linkWorkspacePackages` 链到本仓 → 本仓没有 `lib/` 产物 → 插件 import 加载失败 → **插件凭空消失**）；② `private: true`（永不发布 npm）；③ manifest 是官方形态 exports（`.`/`./types`/`./src/*`/`./package.json`）；④ manifest 无 `./typert` 导出面；⑤ 没有 build/prepare 脚本、没有 `lib/` 产物；⑥ LICENSE 在；⑦ 给了 `DSH_CHECKOUT` 时：src/ 与上游**逐字节**一致 + 版本主段一致（裸 clone / CI 自动跳过）。

消费者仓侧另有自己的 spec（外部 DSH 定制仓：`scripts/tests/protocol-vendor.spec.ts`）守：消费者包精确 pin、运行期解析不落 vendor 目录且版本等于 npm 主版本、vendor 版本主段跟得上已安装 npm 版本。
