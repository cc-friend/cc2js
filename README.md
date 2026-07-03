# cc2node

[![npm](https://img.shields.io/npm/v/cc2node.svg)](https://www.npmjs.com/package/cc2node)
[![ci](https://github.com/cc-friend/cc2node/actions/workflows/ci.yml/badge.svg)](https://github.com/cc-friend/cc2node/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**English** | [中文](README.zh.md) | [Français](README.fr.md)

Convert any Bun-compiled Claude Code release into a pure-Node build that runs on plain **Node 18+**.
No Bun runtime required. Built on [unbun](https://www.npmjs.com/package/unbunjs).

Claude Code 2.1.112+ ships as a [Bun](https://bun.sh) `--compile` binary. cc2node downloads it, parses
the embedded module graph with unbun, de-buns the entry bundle so it runs under Node, transpiles it
to a single Node-18-compatible `cli.js`, and bundles ripgrep plus the runtime deps Bun provided natively.

```sh
# install / update the latest Claude Code as a `cc2` command on your PATH:
npx cc2node          # = cc2node latest
cc2 --version        # e.g. 2.1.199 (Claude Code)

# or just convert a version into a folder instead of installing (-o = don't install):
npx cc2node 2.1.185 -o ./cc          # Or: npx cc2node latest -o ./cc
node ./cc/cli.js --version           # 2.1.185 (Claude Code)
```

## Why

Run Claude Code where the official binary cannot: old or constrained systems where the signed Bun binary or a new-enough Node refuses to launch, for example, a macOS 11 Intel MacBook (prebuilt Node 24+ dies with a libc++ error), old or minimal Linux (old glibc; the bundled ripgrep is the static musl build), or machines pinned to old Node (corporate images, LTS policies, CI bases). The `cli.js` cc2node emits runs on all of them (Node 18+).

Other uses:

- Read or audit the real `cli.js` source (esbuild beautifies it).
- Diff two releases' `cli.js` to see what changed.
- Patch or customize through the editable Bun-to-Node shim.
- Debug under `node --inspect`, profilers, coverage, or custom loaders.
- Smaller footprint (about 35 MB versus the 220 MB binary).
- Reproducible, air-gapped installs: build once, run later with only Node.
- Pin and keep multiple versions side by side.

Native addons and `rg` are platform-specific, so build with `--platform` for your target. The
JavaScript core is platform-independent.

## Usage

```
cc2node [<version|latest|stable|tarball|binary>] [options]
cc2node                  install/update the latest as `cc2` (= cc2node latest)

Any version installs by default (to ~/.cc2node, as `cc2` on PATH); pass -o to get a folder instead.

Input:
  <version>            e.g. 2.1.185, or "latest" / "stable".
                       Downloaded from downloads.claude.ai (falls back to GitHub, then npm).
  <tarball|binary>     a claude-*.tar.gz or an already-extracted Bun `claude` binary.

Options:
      --no-link        just convert to a folder; install no `cc2` command
      --link-name <n>  name the installed command (default: cc2)
      --bin-dir <dir>  where the launcher goes (default: ~/.local/bin, or %USERPROFILE%\.cc2node\bin on Windows)
      --no-add-path    don't persist the bin dir onto PATH (when linking; default: do)
  -t, --target <t>     transpile target (nodeXX, node18+); default: the Node running cc2node
  -p, --platform <p>   target platform (default: this host)
  -o, --out <dir>      convert into <dir> (implies --no-link unless --link-name given)
  -f, --force          re-convert even if cached; overwrite a foreign launcher
      --no-ripgrep     do not bundle ripgrep
      --no-install     do not npm install runtime deps into the output
      --keep-temp      keep the temp work dir
  -h, --help / -v, --version

Platforms: linux-x64, linux-x64-musl, linux-arm64, linux-arm64-musl, darwin-x64, darwin-arm64, win32-x64, win32-arm64.
```

With `-o <dir>` (or `--no-link`) cc2node converts into a folder containing `cli.js`, `bun-shim.cjs`, the `*.node` addons, `rg` (`rg.exe` on Windows), a `package.json`,
and a `node_modules` (ws, undici, ajv, ajv-formats). `cli.js` runs on the transpile target and newer
(default: the Node you ran cc2node with; use `-t node18` for the most portable build). Config is read
from `~/.claude`, like the official build.

By default (no `-o`) the build instead goes to `~/.cc2node/versions/` and a
launcher (default `cc2`) lands in `~/.local/bin` (on Windows: `cc2.cmd` + `cc2.ps1` + a Git Bash `cc2`
in `%USERPROFILE%\.cc2node\bin`). If that dir isn't already on your PATH, cc2node adds it for you — the
Windows user PATH (via the environment API, not `setx`), or your bash/zsh rc — then you open a new
terminal to pick it up (an already-open shell can't be changed by any process). It never adds a
duplicate and leaves an already-working PATH untouched; `--no-add-path` opts out (prints the line
instead), and fish/tcsh always get a correct manual line.

## How it works

1. Download the Bun binary from downloads.claude.ai (SHA-256 checked; GitHub and npm fallbacks).
2. Parse the embedded module graph with [unbun](https://www.npmjs.com/package/unbunjs) and take the
   entry module plus native addons.
3. De-bun `cli.js`: drop the `// @bun` directive, invoke the CommonJS wrapper Bun normally calls
   itself, and prepend `bun-shim.cjs` (a Node reimplementation of the `Bun.*` APIs).
4. Transpile to Node 18 with esbuild (lowering `using`) and prepend small runtime polyfills, producing
   one `cli.js` that runs on Node 18 through 26+.
5. Add ripgrep and `npm install` the runtime deps.

## Library API

```ts
import { convert } from 'cc2node';

const { version, outDir } = await convert({ input: '2.1.185', platform: 'linux-x64' });
console.log(version, outDir);
```

`convert(options)` resolves to `{ version, platform, outDir, modules }`. Options: `input` (required),
`platform`, `out`, `ripgrep`, `install`, `keepTemp`, `log`. Also exported: `PLATFORMS`, `hostPlatform`.

## Development

```sh
npm install
npm run checkall   # tsc typecheck + biome lint + biome format check + unit tests (no writes)
npm run fixall     # biome autofix (lint + format)
npm test           # unit tests (tsx + node:test)
npm run build      # compile TypeScript to dist/
npm run e2e        # heavy: convert real releases and run cli.js across Node majors (network)
npm run release:patch   # vbt: bump, commit, tag vX.Y.Z, push → triggers the publish workflow (also :minor / :major)
```

CI runs `checkall` across Node 18–24 on push/PR.

## License

MIT
