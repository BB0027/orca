import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { runProcessSync } from './script-child-process.mjs'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const root = resolve(import.meta.dirname, '../..')
const [baseArgument, outputArgument] = process.argv.slice(2)
if (process.platform !== 'win32' || !baseArgument || !outputArgument) {
  throw new Error(
    'Usage on Windows: node config/scripts/package-local-windows.mjs <official-app-directory> <new-output-directory>'
  )
}
const base = resolve(baseArgument)
const output = resolve(outputArgument)
if (existsSync(output)) {
  throw new Error(`Output already exists: ${output}`)
}
const sourcePackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const baseArchive = join(base, 'resources', 'app.asar')
const basePackage = JSON.parse(asar.extractFile(baseArchive, 'package.json').toString())
if (!sourcePackage.version.startsWith(`${basePackage.version}+custom.`)) {
  throw new Error('Use the exact official base version with a +custom.N version suffix.')
}
for (const key of ['dependencies', 'optionalDependencies']) {
  if (!isDeepStrictEqual(sourcePackage[key], basePackage[key])) {
    throw new Error(`Changed ${key} require a full native release build.`)
  }
}
for (const entry of [
  'cli/index.js',
  'main/index.js',
  'preload/index.js',
  'renderer/index.html',
  'web/web-index.html'
]) {
  if (!existsSync(join(root, 'out', entry))) {
    throw new Error(`Build output missing: ${entry}`)
  }
}
const git = (args) => {
  const result = runProcessSync({ program: 'git', args, cwd: root, timeoutMs: 30000 })
  if (result.code !== 0) {
    throw new Error(result.stderr || 'Git verification failed')
  }
  return result.stdout.trim()
}
// These artifacts are reused verbatim; changing their inputs requires the normal release pipeline.
const retainedChanges = git([
  'diff',
  `v${basePackage.version}`,
  '--name-only',
  '--',
  'native',
  'mobile',
  'src/relay',
  'resources',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'config/patches',
  'config/electron-builder.config.cjs'
])
if (retainedChanges) {
  throw new Error(`Retained artifact inputs changed:\n${retainedChanges}`)
}
if (git(['status', '--porcelain'])) {
  throw new Error('Commit local changes before packaging so the manifest identifies the source.')
}

const staging = `${output}.asar-source`
if (existsSync(staging)) {
  throw new Error(`Staging already exists: ${staging}`)
}
mkdirSync(dirname(output), { recursive: true })
cpSync(base, output, { recursive: true })
asar.extractAll(baseArchive, staging)
for (const name of ['cli', 'main', 'shared', 'preload', 'renderer', 'web']) {
  const destination = join(staging, 'out', name)
  if (!relative(staging, destination).startsWith('out')) {
    throw new Error('Unsafe staging path')
  }
  rmSync(destination, { recursive: true, force: true })
  cpSync(join(root, 'out', name), destination, { recursive: true })
}
function removeBuildOnlyFiles(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, item.name)
    if (item.isDirectory()) {
      removeBuildOnlyFiles(file)
    } else if (item.name.endsWith('.map') || item.name.endsWith('.test.js')) {
      rmSync(file)
    }
  }
}
removeBuildOnlyFiles(join(staging, 'out'))
writeFileSync(
  join(staging, 'package.json'),
  JSON.stringify({ ...basePackage, version: sourcePackage.version }, null, 2)
)
const boundary = JSON.parse(readFileSync(join(root, 'out', 'package.json'), 'utf8'))
writeFileSync(
  join(staging, 'out', 'package.json'),
  JSON.stringify({ ...boundary, version: sourcePackage.version }, null, 2)
)
const archive = join(output, 'resources', 'app.asar')
// Only the newly-created output is modified; the official install remains a rollback source.
rmSync(`${archive}.unpacked`, { recursive: true, force: true })
rmSync(archive)
await asar.createPackageWithOptions(staging, archive, { unpackDir: '{out,resources,node_modules}' })
writeFileSync(
  join(output, 'local-build.json'),
  JSON.stringify(
    {
      version: sourcePackage.version,
      upstreamTag: `v${basePackage.version}`,
      commit: git(['rev-parse', 'HEAD']),
      dirty: Boolean(git(['status', '--porcelain'])),
      builtAt: new Date().toISOString(),
      retainedArtifacts:
        'Official Electron, native modules, relay and mobile bundle from the matching release'
    },
    null,
    2
  )
)
console.log(`Packaged ${sourcePackage.version} at ${output}`)
