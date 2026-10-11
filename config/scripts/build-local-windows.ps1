param(
    [Parameter(Mandatory)][string]$BaseApp,
    [Parameter(Mandatory)][string]$OutputDirectory,
    [string]$CacheRoot = 'E:\OrcaLocal'
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Run this script with PowerShell 7 on Windows.' }
Set-Location (Join-Path $PSScriptRoot '..\..')
$env:TEMP = Join-Path $CacheRoot 'temp'
$env:TMP = $env:TEMP
$env:PNPM_HOME = Join-Path $CacheRoot 'pnpm'
$env:XDG_CACHE_HOME = Join-Path $CacheRoot 'cache'
$env:npm_config_cache = Join-Path $CacheRoot 'cache\npm'
$env:ORCA_BACKGROUND_LAUNCH = '1'
New-Item -ItemType Directory -Path $env:TEMP,$env:npm_config_cache -Force | Out-Null

npm exec --yes --package=pnpm@12.8.1 -- pnpm install --frozen-lockfile --ignore-scripts --store-dir (Join-Path $CacheRoot 'cache\pnpm')
if ($LASTEXITCODE -ne 0) { throw 'Dependency install failed' }
node config/scripts/run-typecheck-projects-in-parallel.mjs
if ($LASTEXITCODE -ne 0) { throw 'Type checking failed' }
node node_modules/vitest/vitest.mjs run --config config/vitest.config.ts src/shared/dsh-startup.test.ts src/shared/tui-agent-startup.test.ts src/shared/tui-agent-config.test.ts src/main/updater.self-managed.test.ts src/main/updater.check-preflight.test.ts --maxWorkers=1 --hookTimeout=180000
if ($LASTEXITCODE -ne 0) { throw 'Regression tests failed' }
node node_modules/typescript/bin/tsc -p config/tsconfig.cli.json --outDir out --composite false --incremental false
if ($LASTEXITCODE -ne 0) { throw 'CLI build failed' }
foreach ($script in @('config/scripts/verify-cli-bin.mjs --fix-executable --fix-package-json', 'config/scripts/run-electron-vite-build.mjs', 'config/scripts/verify-skills-cli-runtime.cjs out', 'config/scripts/project-renderer-web-client.mjs', 'config/scripts/verify-web-build.mjs')) {
    $scriptArguments = $script.Split(' ')
    node @scriptArguments
    if ($LASTEXITCODE -ne 0) { throw "Build step failed: $script" }
}
node config/scripts/package-local-windows.mjs $BaseApp $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw 'Packaging failed' }
