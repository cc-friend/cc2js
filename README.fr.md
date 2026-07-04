# cc2js

[![npm](https://img.shields.io/npm/v/cc2js.svg)](https://www.npmjs.com/package/cc2js)
[![ci](https://github.com/cc-friend/cc2js/actions/workflows/ci.yml/badge.svg)](https://github.com/cc-friend/cc2js/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[English](README.md) | [中文](README.zh.md) | **Français**

Cet outil CLI peut convertir n'importe quel binaire de Claude Code compilé avec Bun en un build JavaScript pur (Node.js) qui s'exécute sur un simple **Node 18+**. Aucun runtime Bun requis. Basé sur [unbun](https://github.com/cc-friend/unbun).

Claude Code 2.1.112+ d'Anthropic est distribué sous forme de binaire [Bun](https://bun.sh) `--compile`. cc2js le télécharge, analyse le graphe de modules embarqué avec unbun, « de-bun » le bundle d'entrée pour qu'il s'exécute sous Node, le transpile en un unique `cli.js` compatible Node (Node 18 minimum), et embarque ripgrep ainsi que les dépendances d'exécution que Bun fournissait nativement.

## Démarrage rapide

Installez cc2js globalement (vous devez d'abord avoir Node.js) :

```sh
npm i -g cc2js
```

(Ensuite, lancez `cc2js` directement ; ou sautez l'installation et utilisez `npx cc2js` à la place.)

Installer / mettre à jour le dernier Claude Code comme commande `cc2` sur le `PATH` :

```sh
cc2js        # = cc2js latest --link-name cc2
cc2            # lancer le Claude Code que cc2js vient d'installer
cc2 --version  # p. ex. 2.1.199 (Claude Code)
```

Ou seulement convertir une version dans un dossier, sans installer (`-o` = ne pas installer) :

```sh
cc2js 2.1.185 -o ./cc
node ./cc/cli.js --version  # 2.1.185 (Claude Code)
```

Graver des flags dans le lanceur (conservés d'une mise à jour à l'autre ; `--no-cc-flags` les efface) :

```sh
cc2js latest -- --dangerously-skip-permissions
```

Lister les versions et liens installés, ou tout supprimer :

```sh
cc2js ls
cc2js clean  # tout supprimer ; ou : rm <version>, delink [name]
```

## Pourquoi

Exécuter Claude Code là où le binaire officiel ne le peut pas : des systèmes anciens ou contraints où le binaire Bun signé ou un Node trop récent refuse de démarrer, par exemple, un MacBook macOS 11 Intel (le Node 24+ précompilé meurt avec une erreur libc++), un Linux ancien ou minimal (glibc ancienne ; le ripgrep embarqué est le build statique musl), ou des machines figées sur un vieux Node (images d'entreprise, politiques LTS, bases CI). Le `cli.js` produit par cc2js s'exécute sur tous ces environnements (Node 18+).

Autres usages :

- Lire ou auditer le vrai code source de `cli.js` (esbuild le reformate ; structure lisible, mais noms de variables minifiés).
- Comparer (diff) le `cli.js` de deux versions pour voir ce qui a changé.
- Patcher ou personnaliser via le shim Bun-vers-Node éditable.
- Déboguer sous `node --inspect`, profileurs, outils de couverture ou loaders personnalisés.
- Empreinte plus légère (environ 35 Mo contre 220 Mo pour le binaire).
- Installations reproductibles et hors ligne : construire une fois, exécuter plus tard avec seulement Node.
- Épingler et conserver plusieurs versions côte à côte.

Les addons natifs et `rg` sont spécifiques à la plateforme ; construisez donc avec `--platform` pour votre cible. Le cœur JavaScript est indépendant de la plateforme.

## Utilisation

`npm i -g cc2js` pour installer, puis :

```
cc2js [<version|latest|stable|tarball|binary>] [options]
cc2js                  installer/mettre à jour le dernier en `cc2` (= cc2js latest)
cc2js ls | rm <version> | delink [name] | clean   gérer les versions et liens installés

Toute version s'installe par défaut (dans ~/.cc2js, en `cc2` sur le PATH) ; passez -o pour un dossier.

Entrée :
  <version>            p. ex. 2.1.185, ou "latest" / "stable".
                       Téléchargé depuis downloads.claude.ai (repli sur GitHub, puis npm).
  <tarball|binary>     un claude-*.tar.gz ou un binaire Bun `claude` déjà extrait.

Options :
      --no-link        seulement convertir dans un dossier ; n'installe aucune commande `cc2`
      --link-name <n>  nommer la commande installée (par défaut : cc2)
      --bin-dir <dir>  où va le lanceur (par défaut : ~/.local/bin, ou %USERPROFILE%\.cc2js\bin sous Windows)
      --no-add-path    ne pas ajouter le dossier bin au PATH (à l'installation ; par défaut : l'ajouter)
  -t, --target <t>     cible de transpilation (nodeXX, ≥ node18) ; défaut : le Node qui exécute cc2js
  -p, --platform <p>   plateforme cible (par défaut : cet hôte)
  -o, --out <dir>      convertir dans <dir> (implique --no-link sauf si --link-name est donné)
  -f, --force          reconvertir même si en cache ; écraser un lanceur étranger
      --no-ripgrep     ne pas embarquer ripgrep
      --no-install     ne pas npm install les dépendances d'exécution dans la sortie
      --keep-temp      conserver le répertoire de travail temporaire
  -- <flags>           graver des flags Claude dans le lanceur ; conservés d'une mise à jour à l'autre
      --no-cc-flags    effacer les flags gravés
  -h, --help / -v, --version

Plateformes : linux-x64, linux-x64-musl, linux-arm64, linux-arm64-musl, darwin-x64, darwin-arm64, win32-x64, win32-arm64.

Gestion :
  cc2js ls             lister les versions et liens installés
  cc2js rm <version>   supprimer une version (délie en cascade)
  cc2js delink [name]  supprimer un lanceur (par défaut : cc2)
  cc2js clean          supprimer toutes les versions et liens (confirmation y/N, ou --yes)
  (tous acceptent --bin-dir <dir>)
```

Avec `-o <dir>` (ou `--no-link`), cc2js convertit dans un dossier contenant `cli.js`, `bun-shim.cjs`, les addons `*.node`, `rg` (`rg.exe` sous Windows), un `package.json` et un `node_modules` (ws, undici, ajv, ajv-formats). `cli.js` s'exécute sur la cible de transpilation et plus récent (par défaut : le Node avec lequel vous avez lancé cc2js ; utilisez `-t node18` pour le build le plus portable). La configuration est lue depuis `~/.claude`, comme le build officiel.

Par défaut (sans `-o`), le build va dans `~/.cc2js/versions/` et un lanceur (par défaut `cc2`) est placé dans `~/.local/bin` (sous Windows : `cc2.cmd` + `cc2.ps1` + un `cc2` pour Git Bash, dans `%USERPROFILE%\.cc2js\bin`). Si ce dossier n'est pas déjà sur votre PATH, cc2js l'y ajoute pour vous — le PATH utilisateur Windows (via l'API d'environnement, pas `setx`), ou votre rc bash/zsh — puis vous ouvrez un nouveau terminal pour qu'il soit pris en compte (aucun processus ne peut modifier un shell déjà ouvert). Il n'ajoute jamais de doublon et laisse intact un PATH déjà fonctionnel ; `--no-add-path` le désactive (affiche la ligne à la place), et fish/tcsh reçoivent toujours une commande manuelle correcte.

Chaque installation/mise à jour indique son résultat : `linked` (première installation), `updated` (`old → new`), ou `unchanged` (déjà à jour).

## Fonctionnement

1. Télécharger le binaire Bun depuis downloads.claude.ai (SHA-256 vérifié ; replis sur GitHub et npm).
2. Analyser le graphe de modules embarqué avec [unbun](https://github.com/cc-friend/unbun) et récupérer le module d'entrée ainsi que les addons natifs.
3. « De-bun » `cli.js` : retirer la directive `// @bun`, invoquer le wrapper CommonJS que Bun appelle normalement lui-même, et préfixer `bun-shim.cjs` (une réimplémentation Node des API `Bun.*`).
4. Transpiler vers Node 18 avec esbuild (abaissement de `using`) et préfixer de petits polyfills d'exécution, produisant un unique `cli.js` qui s'exécute de Node 18 à 26+.
5. Ajouter ripgrep et faire un `npm install` des dépendances d'exécution.

## API de bibliothèque

```ts
import { convert } from 'cc2js';

const { version, outDir } = await convert({ input: '2.1.185', platform: 'linux-x64' });
console.log(version, outDir);
```

`convert(options)` se résout en `{ version, platform, outDir, modules }`. Options : `input` (requis), `platform`, `out`, `ripgrep`, `install`, `keepTemp`, `log`. Également exportés : `PLATFORMS`, `hostPlatform`.

## Développement

```sh
npm install
npm run checkall   # tsc typecheck + biome lint + biome format check + unit tests (no writes)
npm run fixall     # biome autofix (lint + format)
npm test           # unit tests (tsx + node:test)
npm run build      # compile TypeScript to dist/
npm run e2e        # heavy: convert real releases and run cli.js across Node majors (network)
npm run release:patch   # vbt: bump, commit, tag vX.Y.Z, push → triggers the publish workflow (also :minor / :major)
```

La CI exécute `checkall` sur Node 18–24 à chaque push/PR.

## Licence

MIT
