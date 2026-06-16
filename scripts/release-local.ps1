param(
  [string]$Version = (Get-Date -Format "yyyyMMdd-HHmm")
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$releaseDir = Join-Path $root "release"
$stagingDir = Join-Path $releaseDir "research-figure-reader-local"
$zipPath = Join-Path $releaseDir "research-figure-reader-local-$Version.zip"
$rootUri = New-Object System.Uri(($root.Path.TrimEnd("\") + "\"))

$excludedDirectories = @(
  ".git",
  "app\node_modules",
  "app\dist",
  "app\dist-ssr",
  "app\data",
  "app\output",
  "release"
)

$excludedFiles = @(
  "app\.env",
  "app\.env.local",
  "app\data\local-settings.json"
)

function Test-IsExcluded {
  param([string]$RelativePath)

  foreach ($directory in $excludedDirectories) {
    $directoryPrefix = $directory + "\"
    if ($RelativePath -eq $directory -or $RelativePath.StartsWith($directoryPrefix)) {
      return $true
    }
  }

  foreach ($file in $excludedFiles) {
    if ($RelativePath -eq $file) {
      return $true
    }
  }

  return $false
}

if (Test-Path $stagingDir) {
  Remove-Item -LiteralPath $stagingDir -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null

Get-ChildItem -LiteralPath $root -Force -Recurse | ForEach-Object {
  $itemUri = New-Object System.Uri($_.FullName)
  $relativePath = [System.Uri]::UnescapeDataString($rootUri.MakeRelativeUri($itemUri).ToString()).Replace("/", "\")

  if ($relativePath -eq ".") {
    return
  }

  if (Test-IsExcluded $relativePath) {
    return
  }

  $destination = Join-Path $stagingDir $relativePath

  if ($_.PSIsContainer) {
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    return
  }

  $destinationDirectory = Split-Path -Parent $destination
  New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
  Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
}

$readmePath = Join-Path $stagingDir "LOCAL-RUN.md"
$localRunReadme = @(
  "# Local Trial Instructions",
  "",
  "1. Install Node.js.",
  "2. Open PowerShell in the app directory:",
  "",
  "``````powershell",
  "npm install",
  "npm run start:local",
  "``````",
  "",
  "3. Open http://127.0.0.1:5173/.",
  "4. Click Settings in the web app, enter your own API key, Base URL, and Model, then click Save and test.",
  "5. To use the browser extension, load the extension folder in Chrome or Edge extension management. In extension Options, keep the backend URL as http://127.0.0.1:8787.",
  "",
  "Do not share app/data/local-settings.json, app/.env, or your own API key."
)

Set-Content -LiteralPath $readmePath -Value $localRunReadme -Encoding UTF8

if (Test-Path $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

Compress-Archive -Path (Join-Path $stagingDir "*") -DestinationPath $zipPath -Force

Write-Host "Created local release package:"
Write-Host $zipPath
