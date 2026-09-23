# cc2js

[![npm](https://img.shields.io/npm/v/cc2js.svg)](https://www.npmjs.com/package/cc2js)
[![ci](https://github.com/cc-friend/cc2js/actions/workflows/ci.yml/badge.svg)](https://github.com/cc-friend/cc2js/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[English](README.md) | **中文** | [Français](README.fr.md)

这个 CLI 工具可以把任意 Claude Code 版本的 Bun 编译二进制转换为纯 JavaScript（Node.js）构建，可在普通 **Node 18+** 上运行。无需 Bun 运行时。基于 [unbun](https://github.com/cc-friend/unbun)。

Anthropic 的 Claude Code 2.1.112+ 以 [Bun](https://bun.sh)（[`--compile`](https://bun.com/docs/bundler/executables)）编译的二进制形式发布。cc2js 会下载它，用 unbun 解析内嵌的模块图，让入口能在 Node 下运行——旧版本带的是单个 CommonJS bundle，做去 Bun 化（de-bun）即可；新版本被代码分割成约 1800 个 ESM chunk，则重新打包回单文件——再转译为单个 Node 兼容的 `cli.js`（最低 Node 18），并打包 ripgrep 以及 Bun 原生提供的那些运行时依赖。

## 快速开始

全局安装 cc2js（你需要先有 Node.js）：

```sh
npm i -g cc2js
```

（然后直接运行 `cc2js`；或者不安装，改用 `npx cc2js`。）

把最新版 Claude Code 装成 `PATH` 上的 `cc2` 命令（或更新）：

```sh
cc2js          # = cc2js latest --link-name cc2
cc2            # 运行 cc2js 刚装的 Claude Code
cc2 --version  # 例如 2.1.199 (Claude Code)
```

或只转换到一个文件夹、不安装（`-o` = 不装）：

```sh
cc2js 2.1.185 -o ./cc
node ./cc/cli.js  # 运行 cc2js 刚装的 Claude Code
```

把 flags 固化进 launcher（跨更新保留；`--no-cc-flags` 清除）：

```sh
cc2js -- --dangerously-skip-permissions
```

列出已安装的版本与链接，或删除它们：

```sh
cc2js ls
cc2js clean  # 删除全部；或用 rm <version>，或 delink [name]
```

## 用途

在官方二进制无法运行的地方运行 Claude Code：那些签名的 Bun 二进制或较新的 Node 拒绝启动的老旧或受限系统，例如 macOS 11 Intel MacBook（预编译的 Node 24+ 会因 libc++ 错误崩溃）、老旧或精简的 Linux（glibc 太旧；所打包的 ripgrep 是静态 musl 构建），或被锁定在旧 Node 的机器（公司镜像、LTS 政策、CI 基础镜像）。cc2js 产出的 `cli.js` 在它们上面都能运行（Node 18+）。

其他用途：

- 阅读或审计真实的 `cli.js` 源码（esbuild 会重排格式，结构可读，但变量名仍是压缩后的短名）。
- Diff 两个版本的 `cli.js`，查看改动。
- 通过可编辑的 Bun-to-Node shim 打补丁或定制。
- 在 `node --inspect`、性能分析器、覆盖率工具或自定义 loader 下调试。
- 体积更小（约 35 MB，而二进制为 220 MB）。
- 可复现、可离线的安装：构建一次，之后仅凭 Node 运行。
- 固定并同时保留多个版本。

原生插件和 `rg` 与平台相关，请用 `--platform` 针对你的目标平台构建。JavaScript 核心与平台无关。

## 用法

`npm i -g cc2js` 安装后：

```
cc2js [<version|latest|stable|tarball|binary>] [options]
cc2js                  安装/更新最新版为 `cc2`（= cc2js latest）
cc2js ls | rm <version> | delink [name] | clean   管理已安装的版本与链接

任何版本默认都会安装（装到 ~/.cc2js，作为 PATH 上的 `cc2`）；想要文件夹就加 -o。

输入：
  <version>            例如 2.1.185，或 "latest" / "stable"。
                       从 downloads.claude.ai 下载（依次回退到 GitHub、npm）。
  <tarball|binary>     一个 claude-*.tar.gz，或已解压出来的 Bun `claude` 二进制。

选项：
      --no-link        只转换到文件夹，不装 `cc2` 命令
      --link-name <n>  给安装的命令起名（默认：cc2）
      --bin-dir <dir>  launcher 存放目录（默认：~/.local/bin；Windows 上为 %USERPROFILE%\.cc2js\bin）
      --no-add-path    不把 bin 目录写进 PATH（安装时；默认：会写）
  -t, --target <t>     转译目标（nodeXX，≥node18）；默认：跑 cc2js 的当前 Node
  -p, --platform <p>   目标平台（默认：当前主机）
  -o, --out <dir>      转换到 <dir>（隐含 --no-link，除非给了 --link-name）
  -f, --force          已缓存也重转；覆盖非本工具生成的同名 launcher
      --no-ripgrep     不打包 ripgrep
      --no-install     不在输出目录里 npm install 运行时依赖
      --keep-temp      保留临时工作目录
  -- <flags>           把 flags 固化进 launcher；随更新保留
      --no-cc-flags    清除已固化的 flags
  -h, --help / -v, --version

平台：linux-x64、linux-x64-musl、linux-arm64、linux-arm64-musl、darwin-x64、darwin-arm64、win32-x64、win32-arm64。

管理：
  cc2js ls             列出已安装版本与链接
  cc2js rm <version>   删除一个版本（级联 delink）
  cc2js delink [name]  删除一个 launcher（默认：cc2）
  cc2js clean          删除所有版本与链接（提示 y/N，或 --yes）
  （均接受 --bin-dir <dir>）
```

用 `-o <dir>`（或 `--no-link`）时，cc2js 转换到一个文件夹，内含 `cli.js`、`bun-shim.cjs`、`*.node` 原生插件、bundle 运行时要读取的内嵌资源（技能与文档文本）、`rg`（Windows 上为 `rg.exe`）、一个 `package.json`，以及一个 `node_modules`（ws、undici、ajv、ajv-formats）。`cli.js` 运行于转译目标及更新的 Node（默认：你跑 cc2js 的那个 Node；要最可移植就用 `-t node18`）。配置从 `~/.claude` 读取，与官方构建一致。

默认（不带 `-o`）时，产物放到 `~/.cc2js/versions/`，并放一个 launcher（默认 `cc2`）到 `~/.local/bin`（Windows 上是 `cc2.cmd` + `cc2.ps1` + 一个 Git Bash 用的 `cc2`，位于 `%USERPROFILE%\.cc2js\bin`）。若该目录还不在 PATH 上，cc2js 会替你加进去 —— Windows 写用户级 PATH（走环境变量 API，不是 `setx`），bash/zsh 写对应 rc —— 然后你开一个新终端即可生效（已经开着的终端任何进程都改不了）。它不会重复添加，也不动本来就能用的 PATH；`--no-add-path` 可关掉（改为只打印那一行），fish/tcsh 则始终给你一条正确语法的手动命令。

每次安装/更新都会报告结果：`linked`（首次安装）、`updated`（`old → new`）或 `unchanged`（已是最新）。

## 工作原理

1. 从 downloads.claude.ai 下载 Bun 二进制（校验 SHA-256；并有 GitHub 与 npm 兜底）。
2. 用 [unbun](https://github.com/cc-friend/unbun) 解析内嵌的模块图，取出入口模块、原生插件与内嵌资源。
3. 让入口能在 Node 下运行，两种形态都支持。到 ~2.1.235 为止，入口是一个自包含的 CommonJS bundle：去掉 `// @bun` 指令，调用 Bun 平时自己调用的那个包装函数即可。从 ~2.1.243 起，入口变成代码分割的 ESM 模块图——约 20 KB 的入口 import 约 1800 个 `chunk-*.js` 兄弟模块——于是用 esbuild 把整个图重新打包回单个 CommonJS 文件，并把 Bun 的 `import.meta` 映射到 Node 的对应物。
4. 在前面拼上 `bun-shim.cjs`（用 Node 重新实现的 `Bun.*` API）与少量运行时 polyfill，同时用 esbuild 按目标降级 `using` 之类的语法，产出一个能在 Node 18 到 26+ 上运行的 `cli.js`。
5. 把内嵌文件写到它旁边——原生插件，以及 bundle 会通过 Bun 虚拟文件系统读回的技能／文档资源（转换时所用的 Node 若支持 zstd，`.zst` 会预先解压）。
6. 加入 ripgrep，并 `npm install` 运行时依赖。

## 库 API

```ts
import { convert } from 'cc2js';

const { version, outDir } = await convert({ input: '2.1.185', platform: 'linux-x64' });
console.log(version, outDir);
```

`convert(options)` 解析为 `{ version, platform, outDir, modules }`。选项：`input`（必填）、`platform`、`out`、`ripgrep`、`install`、`keepTemp`、`log`。同时还导出：`PLATFORMS`、`hostPlatform`。

## 开发

需要 Node.js 和 Bun 1.4.2。开发依赖由 Bun 管理；CLI 及其测试仍在 Node 上运行。发布仍使用 npm，以便走 OIDC 可信发布。

```sh
bun install --frozen-lockfile
bun run checkall   # tsc typecheck + biome lint + biome format check + unit tests (no writes)
bun run fixall     # biome autofix (lint + format)
bun run test       # unit tests (tsx + node:test)
bun run build      # compile TypeScript to dist/
bun run e2e        # heavy: convert real releases and run cli.js across Node majors (network)
bun run release:patch   # vbt: bump, commit, tag vX.Y.Z, push → triggers the publish workflow (also :minor / :major)
```

CI 在 push/PR 时跨 Node 18–24 运行 `checkall`。

## 许可证

MIT
