import { cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { removeTreeSync } from '../../src/shared/windows-transient-lock-removal.ts'
import {
  mkTempProject,
  runRebuildScript,
  writeFakeUsableElectronPackage
} from './rebuild-native-deps-test-fixtures.mjs'

it('rebuilds only the nested worktree dependencies, leaving the parent checkout alone', () => {
  const parent = mkTempProject()
  const project = join(parent, 'worktree')
  try {
    cpSync(join(parent, 'config'), join(project, 'config'), { recursive: true })
    for (const root of [parent, project]) {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ dependencies: { 'node-pty': '*' } })
      )
      const moduleDir = join(root, 'node_modules', 'node-pty')
      mkdirSync(moduleDir, { recursive: true })
      writeFileSync(join(moduleDir, 'package.json'), JSON.stringify({ name: 'node-pty' }))
    }
    writeFakeUsableElectronPackage(project)
    const rebuildDir = join(project, 'node_modules', '@electron', 'rebuild')
    mkdirSync(rebuildDir, { recursive: true })
    writeFileSync(join(rebuildDir, 'package.json'), JSON.stringify({ type: 'module' }))
    const require = createRequire(import.meta.url)
    const walkerUrl = pathToFileURL(
      join(dirname(require.resolve('@electron/rebuild')), 'module-walker.js')
    ).href
    // Exercise the installed library's real dependency traversal with the production call's options.
    writeFileSync(
      join(rebuildDir, 'index.js'),
      `import { ModuleWalker } from ${JSON.stringify(walkerUrl)}
import { writeFileSync } from 'node:fs'
export async function rebuild(options) {
  const walker = new ModuleWalker(options.buildPath, options.projectRootPath, ['prod'], new Set(), options.onlyModules)
  await walker.walkModules()
  for (const path of await walker.nodeModulesPaths) await walker.findAllModulesIn(path)
  writeFileSync('rebuild-paths.json', JSON.stringify(walker.modulesToRebuild))
}
`
    )
    const result = runRebuildScript(project, {}, ['--platform=linux', '--arch=arm64', '--force'])
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(readFileSync(join(project, 'rebuild-paths.json'), 'utf8'))).toEqual([
      realpathSync(join(project, 'node_modules', 'node-pty'))
    ])
  } finally {
    removeTreeSync(parent)
  }
})
