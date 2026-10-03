param(
  [switch]$Open
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtime = Join-Path $root '.runtime'
$logDirectory = Join-Path $runtime 'logs'
$modelUrl = 'http://127.0.0.1:8081'
$modelAlias = 'qwen3.5-2b'
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'

function Resolve-NodeExecutable {
  $candidates = @()
  if ($env:ASTRA_NODE) { $candidates += $env:ASTRA_NODE }

  $pathNode = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pathNode) { $candidates += $pathNode.Source }

  $wrapper = Join-Path $runtime 'bin/node.cmd'
  if (Test-Path -LiteralPath $wrapper) {
    $wrapperText = Get-Content -LiteralPath $wrapper -Raw
    $match = [regex]::Match($wrapperText, '(?im)^\s*"([^"]+node\.exe)"')
    if ($match.Success) { $candidates += $match.Groups[1].Value }
  }

  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if ([IO.Path]::GetExtension($candidate) -in @('.cmd', '.bat')) {
      if (Test-Path -LiteralPath $candidate) {
        $text = Get-Content -LiteralPath $candidate -Raw
        $match = [regex]::Match($text, '(?im)^\s*"([^"]+node\.exe)"')
        if ($match.Success -and (Test-Path -LiteralPath $match.Groups[1].Value)) { return $match.Groups[1].Value }
      }
      continue
    }
    if ((Test-Path -LiteralPath $candidate) -and [IO.Path]::GetExtension($candidate) -eq '.exe') {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  throw 'Node.js was not found. Set ASTRA_NODE to node.exe, add node.exe to PATH, or install the bundled runtime.'
}

function Test-PortFree([int]$Port) {
  $listener = [System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
  try {
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    $listener.Stop()
  }
}

function Get-PortOwners([int]$Port) {
  try {
    return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess -Unique)
  } catch {
    return @()
  }
}

function Test-ExpectedLocalModel {
  try {
    $headers = @{ Authorization = 'Bearer local-only' }
    $health = Invoke-RestMethod -Uri "$modelUrl/health" -Headers $headers -TimeoutSec 2
    if ($health.status -ne 'ok') { return $false }
    $models = Invoke-RestMethod -Uri "$modelUrl/v1/models" -Headers $headers -TimeoutSec 3
    return [bool]($models.data | Where-Object { $_.id -eq $modelAlias } | Select-Object -First 1)
  } catch {
    return $false
  }
}

function Wait-ForLocalModel([int]$Seconds) {
  for ($i = 0; $i -lt $Seconds; $i++) {
    if (Test-ExpectedLocalModel) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Start-LoggedNode([string]$Node, [string]$Script, [string]$Name) {
  $stdout = Join-Path $logDirectory "$timestamp-$Name.stdout.log"
  $stderr = Join-Path $logDirectory "$timestamp-$Name.stderr.log"
  $argument = '"' + $Script + '"'
  $process = Start-Process -FilePath $Node -ArgumentList $argument -WorkingDirectory $root `
    -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  return [pscustomobject]@{ Process = $process; Stdout = $stdout; Stderr = $stderr }
}

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$node = Resolve-NodeExecutable

if (Test-PortFree 8081) {
  $modelScript = Join-Path $PSScriptRoot 'start-model.mjs'
  $model = Start-LoggedNode $node $modelScript 'model'
  Write-Host "Started local model (PID $($model.Process.Id)); waiting for $modelAlias on port 8081..."
  if (-not (Wait-ForLocalModel 180)) {
    throw "Model did not become ready. Logs: $($model.Stdout) and $($model.Stderr)"
  }
} else {
  if (-not (Wait-ForLocalModel 60)) {
    $owners = (Get-PortOwners 8081) -join ', '
    if (-not $owners) { $owners = 'unknown process' }
    throw "Port 8081 is occupied by PID(s) $owners, but it did not serve the expected local model '$modelAlias'. No process was stopped."
  }
  Write-Host "Reusing the verified local model at $modelUrl ($modelAlias)."
}

if (-not (Test-PortFree 3080)) {
  $owners = (Get-PortOwners 3080) -join ', '
  if (-not $owners) { $owners = 'unknown process' }
  throw "Port 3080 is occupied by PID(s) $owners. Harness was not started and no process was stopped."
}

$harnessScript = Join-Path $PSScriptRoot 'start-harness.mjs'
$harness = Start-LoggedNode $node $harnessScript 'harness'
Write-Host "Started Harness (PID $($harness.Process.Id)); waiting for its authenticated URL..."
$urlPattern = 'dsh web:\s+(http://127\.0\.0\.1:3080/\S+)'
$harnessUrl = $null
for ($i = 0; $i -lt 90; $i++) {
  if (Test-Path -LiteralPath $harness.Stdout) {
    $logText = [string](Get-Content -LiteralPath $harness.Stdout -Raw)
    $match = [regex]::Match($logText, $urlPattern)
    if ($match.Success) { $harnessUrl = $match.Groups[1].Value; break }
  }
  $running = Get-Process -Id $harness.Process.Id -ErrorAction SilentlyContinue
  if (-not $running) { break }
  Start-Sleep -Seconds 1
}

if (-not $harnessUrl) {
  throw "Harness did not print its authenticated URL. Logs: $($harness.Stdout) and $($harness.Stderr)"
}

Write-Host "Harness URL: $harnessUrl"
Write-Host "Logs: $($harness.Stdout), $($harness.Stderr)"
if ($Open) { Start-Process -FilePath $harnessUrl }
